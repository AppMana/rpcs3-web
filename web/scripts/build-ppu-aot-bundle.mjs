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
// Absolute (EBOOT) parts link into one module so cross-part block calls resolve directly and each worker
// instantiates one module; relocatable (PRX) parts keep one module per PRX until seg0 dispatch exists.
const groups = new Map();
for (const source of sources) {
  const module = source.slice(0, source.indexOf("-"));
  const key = module.startsWith("EBOOT") ? "EBOOT" : module;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(source);
}
async function describe(wasmPath, group, members) {
  const bytes = readFileSync(wasmPath);
  const compiled = await WebAssembly.compile(bytes);
  const blockTables = WebAssembly.Module.exports(compiled).filter((entry) => entry.kind === "global" && entry.name.startsWith("__ppu_blocks_")).length;
  const guestImports = WebAssembly.Module.imports(compiled).filter((entry) => /^__0x/.test(entry.name)).length;
  return {
    url: basename(wasmPath),
    module: group,
    relocatable: group !== "EBOOT",
    parts: members.length,
    bytes: bytes.byteLength,
    irBytes: members.reduce((sum, member) => sum + statSync(join(inputDirectory, member)).size, 0),
    blockTables,
    guestImports,
    sha256: createHash("sha256").update(bytes).digest("hex"),
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
