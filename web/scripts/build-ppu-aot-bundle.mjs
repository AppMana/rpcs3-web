// Lower a directory of RPCS3 wasm32 PPU IR parts (RPCS3_PPU_WASM_AOT_IR=1 dumps,
// one .wasm.ll per module part) into a bundle the runtime loads through
// rpcs3-ppu-aot-table.mjs: one .wasm per part plus manifest.json.
//
//   node scripts/build-ppu-aot-bundle.mjs IR_DIR OUT_DIR [--jobs N]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";

const [inputArg, outputArg, ...options] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("usage: build-ppu-aot-bundle.mjs IR_DIR OUT_DIR [--jobs N]");
}
const jobsOption = options.find((option) => option.startsWith("--jobs="));
const jobs = Math.max(1, Number(jobsOption?.slice("--jobs=".length)) || Math.min(8, availableParallelism()));
const inputDirectory = resolve(inputArg);
const outputDirectory = resolve(outputArg);
const compiler = join(dirname(fileURLToPath(import.meta.url)), "compile-ppu-ir-to-wasm.mjs");
mkdirSync(outputDirectory, { recursive: true });

const sources = readdirSync(inputDirectory).filter((name) => name.endsWith(".wasm.ll")).sort();
if (!sources.length) throw new Error(`no .wasm.ll parts under ${inputDirectory}`);

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

const startedAt = Date.now();
// Relocatable (PRX) parts keep one module per PRX until seg0 dispatch exists. The absolute (EBOOT)
// parts used to link into a single module so cross-part block calls could resolve directly, but a
// title's EBOOT reaches a size no browser will compile (LittleBigPlanet 2's is 156 MB, and Mobile
// Safari does not finish compiling it), so they are split into groups. --eboot-parts=N sets how
// many; the manifest records the guest imports each group ends up with, which is what tells you
// whether a split cut a direct call.
const ebootGroupsOption = options.find((option) => option.startsWith("--eboot-parts="));
const ebootGroups = Math.max(1, Number(ebootGroupsOption?.slice("--eboot-parts=".length)) || 1);
const groups = new Map();
const ebootSources = [];
for (const source of sources) {
  const module = source.slice(0, source.indexOf("-"));
  if (module.startsWith("EBOOT")) { ebootSources.push(source); continue; }
  if (!groups.has(module)) groups.set(module, []);
  groups.get(module).push(source);
}
if (ebootSources.length) {
  const perGroup = Math.ceil(ebootSources.length / ebootGroups);
  for (let index = 0, group = 0; index < ebootSources.length; index += perGroup, group += 1) {
    const name = ebootGroups === 1 ? "EBOOT" : `EBOOT-${String(group).padStart(2, "0")}`;
    groups.set(name, ebootSources.slice(index, index + perGroup));
  }
}
// The (guest address, table index) pairs a part contributes. The runtime used to get these by
// instantiating every part on its module thread, which costs a function reference per table entry
// and is what a phone runs out of room for; extracting them here lets that thread register the
// blocks without instantiating anything, and leaves instantiation to the workers that run PPU
// threads, which already do it lazily. Indices are relative to the part's element base, which only
// the runtime knows.
async function extractBlocks(compiled) {
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 32768, shared: true });
  const table = new WebAssembly.Table({ initial: 1 << 16, element: "anyfunc" });
  const memoryBase = 1 << 16;
  const env = {
    memory,
    __indirect_function_table: table,
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 1 << 24),
  };
  for (const imported of WebAssembly.Module.imports(compiled)) {
    if (imported.module !== "env" || imported.name in env) continue;
    if (imported.kind === "function") env[imported.name] = () => 0;
    else if (imported.kind === "global") env[imported.name] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
  }
  const instance = new WebAssembly.Instance(compiled, { env });
  if (typeof instance.exports.__wasm_apply_data_relocs === "function") instance.exports.__wasm_apply_data_relocs();
  const heap = new Uint32Array(memory.buffer);
  const blocks = [];
  for (const [name, value] of Object.entries(instance.exports)) {
    if (!name.startsWith("__ppu_blocks_") || !(value instanceof WebAssembly.Global)) continue;
    const indexOf = instance.exports[`__ppu_block_index_${name.slice("__ppu_blocks_".length)}`];
    if (typeof indexOf !== "function") throw new Error(`${name} has no index function`);
    const address = (memoryBase + (value.value >>> 0)) >>> 0;
    const count = heap[address >>> 2];
    for (let entry = 0; entry < count; entry += 1) {
      blocks.push(heap[(address >>> 2) + 1 + entry] >>> 0, indexOf(entry) >>> 0);
    }
  }
  return blocks;
}

async function describe(wasmPath, group, members) {
  const bytes = readFileSync(wasmPath);
  const compiled = await WebAssembly.compile(bytes);
  const blockTables = WebAssembly.Module.exports(compiled).filter((entry) => entry.kind === "global" && entry.name.startsWith("__ppu_blocks_")).length;
  const guestImports = WebAssembly.Module.imports(compiled).filter((entry) => /^__0x/.test(entry.name)).length;
  return {
    url: basename(wasmPath),
    module: group,
    relocatable: !group.startsWith("EBOOT"),
    parts: members.length,
    bytes: bytes.byteLength,
    irBytes: members.reduce((sum, member) => sum + statSync(join(inputDirectory, member)).size, 0),
    blockTables,
    guestImports,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    blocks: Buffer.from(new Uint32Array(await extractBlocks(compiled)).buffer).toString("base64"),
  };
}
const parts = [];
for (const [group, members] of groups) {
  const wasmPath = join(outputDirectory, `${group}.wasm`);
  execFileSync(process.execPath, [compiler, ...members.map((member) => join(inputDirectory, member)), wasmPath, "--pic", `--jobs=${jobs}`], { stdio: ["ignore", "ignore", "inherit"] });
  parts.push(await describe(wasmPath, group, members));
}

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  source: basename(inputDirectory),
  parts,
};
writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const totalBytes = parts.reduce((sum, part) => sum + part.bytes, 0);
const totalBlockTables = parts.filter((part) => !part.relocatable).reduce((sum, part) => sum + part.blockTables, 0);
process.stdout.write(`${JSON.stringify({
  parts: parts.length,
  relocatable: parts.filter((part) => part.relocatable).length,
  blockTables: totalBlockTables,
  guestImports: parts.reduce((sum, part) => sum + part.guestImports, 0),
  modules: parts.length,
  bytes: totalBytes,
  seconds: (Date.now() - startedAt) / 1000,
  manifest: join(outputDirectory, "manifest.json"),
})}\n`);
