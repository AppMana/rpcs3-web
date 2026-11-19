// Lower a directory of RPCS3 wasm32 SPU program IR (RPCS3_SPU_WASM_AOT_IR=1
// dumps, one .wasm.ll per compiled spu_program) into a bundle the runtime loads
// through rpcs3-spu-aot-table.mjs: a few --shared modules plus manifest.json.
// Programs are exported by name (`__spu-0x<entry>-<hash>`); a module stays
// under V8's 100,000-export limit by capping programs per part.
//
//   node scripts/build-spu-aot-bundle.mjs IR_DIR OUT_DIR [--jobs=N] [--per-part=N] [--chain]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { spuProgramCatalog } from "./spu-program-catalog.mjs";
import { selectSpuRegions, emitSpuRegion } from "./spu-regions.mjs";

const [inputArg, outputArg, ...options] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("usage: build-spu-aot-bundle.mjs IR_DIR OUT_DIR [--jobs=N] [--per-part=N] [--chain]");
}
const option = (name, fallback) => {
  const found = options.find((entry) => entry.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const jobs = Math.max(1, option("jobs", availableParallelism()));
const perPart = Math.max(1, Math.min(90_000, option("per-part", 40_000)));
const inputDirectory = resolve(inputArg);
const outputDirectory = resolve(outputArg);
const compiler = join(dirname(fileURLToPath(import.meta.url)), "compile-ppu-ir-to-wasm.mjs");
mkdirSync(outputDirectory, { recursive: true });

const sources = readdirSync(inputDirectory).filter((name) => name.endsWith(".wasm.ll")).sort();
if (!sources.length) throw new Error(`no .wasm.ll programs under ${inputDirectory}`);

const startedAt = Date.now();
const pathOption = name => options.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const edgeProfilePath = pathOption("edge-profile");
const sourceHash = createHash("sha256");
for (const source of sources) sourceHash.update(source).update("\0").update(readFileSync(join(inputDirectory, source)));
const sourceSha256 = sourceHash.digest("hex");
let selectedRegions = [];
let regionProfileSha256;
const sourceBySymbol = new Map();
if (edgeProfilePath) {
  const profileBytes = readFileSync(edgeProfilePath);
  regionProfileSha256 = createHash("sha256").update(profileBytes).digest("hex");
  const profile = JSON.parse(profileBytes);
  if (profile.schemaVersion !== 1 || !Array.isArray(profile.edges)) throw new Error("unsupported SPU edge profile");
  if (profile.sourceSha256 !== sourceSha256) throw new Error("SPU edge profile source hash mismatch");
  if (!pathOption("spu-cache")) throw new Error("--edge-profile requires --spu-cache");
  const catalog = spuProgramCatalog(readFileSync(pathOption("spu-cache")));
  for (const source of sources) {
    const ir = readFileSync(join(inputDirectory, source), "utf8");
    const symbol = ir.match(/define[^\n]*@(__spu-0x[\w-]+)/)?.[1];
    const program = catalog.get(symbol);
    if (!program) throw new Error(`SPU cache does not identify ${source}`);
    program.blocks = (ir.match(/^b-0x[^\n]*:/gm) || []).length || 1;
    sourceBySymbol.set(symbol, source);
  }
  // Each region must live in one instance. Do not reorder normal program exports.
  const partBySource = new Map(sources.map((name, index) => [name, Math.floor(index / perPart)]));
  const eligible = { ...profile, edges: profile.edges.filter(edge => sourceBySymbol.has(edge.from.symbol)
    && sourceBySymbol.has(edge.to.symbol)
    && partBySource.get(sourceBySymbol.get(edge.from.symbol)) === partBySource.get(sourceBySymbol.get(edge.to.symbol))) };
  selectedRegions = selectSpuRegions(eligible, catalog);
}
const profileEdges = options.includes("--profile-edges");
const chain = options.includes("--chain") || profileEdges || !!edgeProfilePath;
const regions = options.includes("--regions") || !!edgeProfilePath;
const unarySwizzles = options.includes("--unary-swizzles");
const directExits = options.includes("--direct-exits") || !!edgeProfilePath;
const companion = [];
if (chain) {
  const source = fileURLToPath(new URL("../host/spu/chain.c", import.meta.url));
  const ir = join(outputDirectory, "spu-chain.ll");
  execFileSync(process.env.RPCS3_CLANG || "/usr/lib/llvm-22/bin/clang", [
    "--target=wasm32-unknown-unknown", "-O3", "-ffreestanding", "-matomics", "-mbulk-memory",
    "-fPIC", "-S", "-emit-llvm", source, "-o", ir,
    ...(profileEdges ? ["-DRPCS3_SPU_CHAIN_PROFILE=1"] : []),
  ], { stdio: "inherit" });
  companion.push(ir);
}
const parts = [];
for (let start = 0, index = 0; start < sources.length; start += perPart, index += 1) {
  const members = sources.slice(start, start + perPart);
  const wasmPath = join(outputDirectory, `spu-${String(index).padStart(2, "0")}.wasm`);
  const partRegions = selectedRegions.filter(region => members.includes(sourceBySymbol.get(region.members[0].symbol)));
  const grouped = new Set(), groupInputs = [];
  for (const region of partRegions) {
    const stem = join(outputDirectory, `region-${region.id}`);
    writeFileSync(`${stem}.c`, emitSpuRegion(region));
    execFileSync(process.env.RPCS3_CLANG || "/usr/lib/llvm-22/bin/clang", [
      "--target=wasm32-unknown-unknown", "-O3", "-ffreestanding", "-matomics", "-mbulk-memory", "-fPIC", "-S", "-emit-llvm",
      "-I", fileURLToPath(new URL("../host/spu", import.meta.url)), `${stem}.c`, "-o", `${stem}.wrapper.ll`,
    ], { stdio: "inherit" });
    const regionSources = region.members.map(member => sourceBySymbol.get(member.symbol));
    for (const source of regionSources) grouped.add(source);
    execFileSync(process.env.RPCS3_LLVM_LINK || "/usr/lib/llvm-22/bin/llvm-link", [
      ...regionSources.map(source => join(inputDirectory, source)), `${stem}.wrapper.ll`, "-S", "-o", `${stem}.ll`,
    ], { stdio: "inherit" });
    groupInputs.push(`${stem}.ll`);
  }
  const lowering = JSON.parse(execFileSync(process.execPath, [compiler, ...members.filter(member => !grouped.has(member)).map((member) => join(inputDirectory, member)), ...groupInputs, ...companion, wasmPath, "--pic", "--export-all", `--jobs=${jobs}`, ...(regions ? ["--regions"] : []), ...(directExits ? ["--direct-exits"] : []), ...(unarySwizzles ? ["--unary-swizzles"] : [])], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "inherit"] }));
  const bytes = readFileSync(wasmPath);
  const compiled = await WebAssembly.compile(bytes);
  const exportsList = WebAssembly.Module.exports(compiled);
  const programs = exportsList.filter((entry) => entry.kind === "function" && /^__spu-0x[0-9a-f]+-/i.test(entry.name)).length;
  const imports = WebAssembly.Module.imports(compiled).filter((entry) => entry.kind === "function").map((entry) => entry.name);
  parts.push({
    url: basename(wasmPath),
    ...(partRegions.length ? { linkedRegions: partRegions.map(region => ({ symbol: region.symbol, aliases: region.aliases,
      programs: region.members.map(member => member.symbol) })) } : {}),
    programs,
    sources: members.length,
    bytes: bytes.byteLength,
    irBytes: members.reduce((sum, member) => sum + statSync(join(inputDirectory, member)).size, 0),
    exports: exportsList.length,
    functionImports: [...new Set(imports.map((name) => (/^__spu-0x[0-9a-f]+-.+-(?:pp|chunkpp)-/i.test(name) ? "<patchpoint>" : name)))].sort(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...((regions || directExits || unarySwizzles) ? { regions: lowering.regions.reduce((total, row) => {
      for (const key of ["functions", "linkedCalls", "budgetExits", "directExits", "unarySwizzles"]) total[key] += row[key];
      return total;
    }, { functions: 0, linkedCalls: 0, budgetExits: 0, directExits: 0, unarySwizzles: 0 }) } : {}),
  });
}

const manifest = { version: 1, kind: "spu", ...(unarySwizzles ? { unarySwizzles: 1 } : {}), ...(regionProfileSha256 ? { regionProfileSha256 } : {}), ...(directExits ? { dispatchMarkerAbi: 1 } : {}), ...(chain ? { chainAbi: edgeProfilePath ? 3 : profileEdges ? 2 : 1 } : {}), ...(regions ? { regionLowering: 1 } : {}), generatedAt: new Date().toISOString(), source: basename(inputDirectory), sourceSha256, parts };
writeFileSync(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  parts: parts.length,
  programs: parts.reduce((sum, part) => sum + part.programs, 0),
  bytes: parts.reduce((sum, part) => sum + part.bytes, 0),
  functionImports: [...new Set(parts.flatMap((part) => part.functionImports))].sort(),
  seconds: (Date.now() - startedAt) / 1000,
  manifest: join(outputDirectory, "manifest.json"),
})}\n`);
