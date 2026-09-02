import { execFile, execFileSync } from "node:child_process";
import { accessSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

// One or more IR parts lower to one wasm module: every part is lowered to an
// object in parallel and a single wasm-ld link resolves the __0x blocks across
// parts as direct calls. A per-part module would import the shared function
// table separately, and V8 keeps a table-sized dispatch table per importing
// instance, which is what made a 114-instance bundle exhaust a worker's heap.
const args = process.argv.slice(2);
const inputArgs = args.filter((argument) => argument.endsWith(".ll"));
const outputArg = args.find((argument) => argument.endsWith(".wasm"));
const options = args.filter((argument) => argument.startsWith("--"));
if (!inputArgs.length || !outputArg) {
  throw new Error("usage: compile-ppu-ir-to-wasm.mjs INPUT.ll [MORE.ll ...] OUTPUT.wasm [--pic] [--export=NAME | --export-all] [--jobs=N]");
}
const execFileAsync = promisify(execFile);

function findTool(environmentName, name) {
  const explicit = process.env[environmentName];
  if (explicit) return explicit;

  for (const root of ["/usr/lib/llvm-22/bin", "/usr/lib/llvm-18/bin", "/usr/bin"]) {
    const candidate = join(root, name);
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next installed LLVM toolchain.
    }
  }
  throw new Error(`${name} was not found; set ${environmentName}`);
}

function existing(paths) {
  return paths.filter((candidate) => {
    try {
      accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function findRuntimeArchives() {
  const explicit = options
    .filter((option) => option.startsWith("--runtime="))
    .map((option) => resolve(option.slice("--runtime=".length)));
  if (explicit.length) return explicit;

  const sysroots = existing([
    process.env.EMSDK ? join(process.env.EMSDK, "upstream/emscripten/cache/sysroot") : "",
    join(homedir(), ".cache/emsdk-6.0.8/upstream/emscripten/cache/sysroot"),
  ].filter(Boolean));
  for (const sysroot of sysroots) {
    const libraryDirectory = join(sysroot, "lib/wasm32-emscripten");
    const archives = existing([
      join(libraryDirectory, "libclang_rt.builtins-wasmsjlj.a"),
      join(libraryDirectory, "libc.a"),
    ]);
    if (archives.length === 2) return archives;
  }
  return [];
}

const inputs = inputArgs.map((argument) => resolve(argument));
const output = resolve(outputArg);
const jobsOption = options.find((option) => option.startsWith("--jobs="));
const jobs = Math.max(1, Number(jobsOption?.slice("--jobs=".length)) || Math.min(8, availableParallelism()));
const exports = options.filter((option) => option.startsWith("--export="));
// Shared (PIC) modules export their visible symbols by default: the per-part block tables. Named
// block exports are only for the JS dispatcher fixtures (--export-all).
const exportAll = options.includes("--export-all") || (!options.includes("--pic") && exports.length === 0);
const pic = options.includes("--pic");
const llvmAs = findTool("RPCS3_LLVM_AS", "llvm-as");
const llc = findTool("RPCS3_LLC", "llc");
const wasmLd = findTool("RPCS3_WASM_LD", "wasm-ld");
const runtimeArchives = findRuntimeArchives();
const scratch = mkdtempSync(join(tmpdir(), "rpcs3-ppu-aot-"));

async function lower(input, index) {
  const bitcode = join(scratch, `${index}-${basename(input)}.bc`);
  const object = join(scratch, `${index}-${basename(input)}.o`);
  await execFileAsync(llvmAs, [input, "-o", bitcode], { maxBuffer: 1 << 24 });
  await execFileAsync(llc, [
    "-mtriple=wasm32-unknown-unknown",
    "-mattr=+atomics,+bulk-memory,+mutable-globals,+sign-ext,+simd128,+tail-call",
    pic ? "-relocation-model=pic" : undefined,
    "-O2",
    "-filetype=obj",
    bitcode,
    "-o",
    object,
  ].filter(Boolean), { maxBuffer: 1 << 24 });
  rmSync(bitcode, { force: true });
  return object;
}

try {
  const objects = new Array(inputs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, inputs.length) }, async () => {
    while (next < inputs.length) {
      const index = next++;
      objects[index] = await lower(inputs[index], index);
    }
  }));

  const linkOptions = [
    pic ? "--shared" : "--no-entry",
    "--import-memory",
    "--shared-memory",
    pic ? undefined : "--initial-memory=16777216",
    "--max-memory=2147483648",
    pic ? undefined : "--global-base=12582912",
    "--allow-undefined",
    exportAll ? "--export-all" : undefined,
    ...exports,
    ...objects,
    ...runtimeArchives,
    "-o",
    output,
  ].filter(Boolean);
  execFileSync(wasmLd, linkOptions, { stdio: "inherit" });

  const bytes = readFileSync(output);
  const module = new WebAssembly.Module(bytes);
  process.stdout.write(`${JSON.stringify({
    inputs,
    output,
    pic,
    bytes: bytes.byteLength,
    runtimeArchives,
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
