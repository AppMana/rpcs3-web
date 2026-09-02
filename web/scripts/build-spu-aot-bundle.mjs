// Lower a directory of RPCS3 wasm32 SPU program IR (RPCS3_SPU_WASM_AOT_IR=1
// dumps, one .wasm.ll per compiled spu_program) into a bundle the runtime loads
// through rpcs3-spu-aot-table.mjs: a few --shared modules plus manifest.json.
// Programs are exported by name (`__spu-0x<entry>-<hash>`); a module stays
// under V8's 100,000-export limit by capping programs per part.
//
//   node scripts/build-spu-aot-bundle.mjs IR_DIR OUT_DIR [--jobs=N] [--per-part=N]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";

const [inputArg, outputArg, ...options] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("usage: build-spu-aot-bundle.mjs IR_DIR OUT_DIR [--jobs=N] [--per-part=N]");
}
const option = (name, fallback) => {
  const found = options.find((entry) => entry.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const jobs = Math.max(1, option("jobs", Math.min(8, availableParallelism())));
const perPart = Math.max(1, Math.min(90_000, option("per-part", 40_000)));
const inputDirectory = resolve(inputArg);
const outputDirectory = resolve(outputArg);
const compiler = join(dirname(fileURLToPath(import.meta.url)), "compile-ppu-ir-to-wasm.mjs");
mkdirSync(outputDirectory, { recursive: true });

const sources = readdirSync(inputDirectory).filter((name) => name.endsWith(".wasm.ll")).sort();
if (!sources.length) throw new Error(`no .wasm.ll programs under ${inputDirectory}`);

const startedAt = Date.now();
const parts = [];
for (let start = 0, index = 0; start < sources.length; start += perPart, index += 1) {
  const members = sources.slice(start, start + perPart);
  const wasmPath = join(outputDirectory, `spu-${String(index).padStart(2, "0")}.wasm`);
  execFileSync(process.execPath, [compiler, ...members.map((member) => join(inputDirectory, member)), wasmPath, "--pic", "--export-all", `--jobs=${jobs}`], { stdio: ["ignore", "ignore", "inherit"] });
  const bytes = readFileSync(wasmPath);
  const compiled = await WebAssembly.compile(bytes);
  const exportsList = WebAssembly.Module.exports(compiled);
  const programs = exportsList.filter((entry) => entry.kind === "function" && /^__spu-0x[0-9a-f]+-/i.test(entry.name)).length;
  const imports = WebAssembly.Module.imports(compiled).filter((entry) => entry.kind === "function").map((entry) => entry.name);
  parts.push({
    url: basename(wasmPath),
    programs,
    sources: members.length,
    bytes: bytes.byteLength,
    irBytes: members.reduce((sum, member) => sum + statSync(join(inputDirectory, member)).size, 0),
    exports: exportsList.length,
    functionImports: [...new Set(imports.map((name) => (/^__spu-0x[0-9a-f]+-.+-(?:pp|chunkpp)-/i.test(name) ? "<patchpoint>" : name)))].sort(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

const manifest = { version: 1, kind: "spu", generatedAt: new Date().toISOString(), source: basename(inputDirectory), parts };
writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  parts: parts.length,
  programs: parts.reduce((sum, part) => sum + part.programs, 0),
  bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
  functionImports: [...new Set(parts.flatMap((part) => part.functionImports))].sort(),
  seconds: (Date.now() - startedAt) / 1000,
  manifest: join(outputDirectory, "manifest.json"),
})}\n`);
