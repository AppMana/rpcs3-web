import { execFileSync } from "node:child_process";
import { accessSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const [inputArg, outputArg, ...options] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("usage: compile-ppu-ir-to-wasm.mjs INPUT.ll OUTPUT.wasm [--pic] [--export=NAME | --export-all]");
}

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

const input = resolve(inputArg);
const output = resolve(outputArg);
const exports = options.filter((option) => option.startsWith("--export="));
const exportAll = options.includes("--export-all") || exports.length === 0;
const pic = options.includes("--pic");
const llvmAs = findTool("RPCS3_LLVM_AS", "llvm-as");
const llc = findTool("RPCS3_LLC", "llc");
const wasmLd = findTool("RPCS3_WASM_LD", "wasm-ld");
const runtimeArchives = findRuntimeArchives();
const scratch = mkdtempSync(join(tmpdir(), "rpcs3-ppu-aot-"));

try {
  const bitcode = join(scratch, `${basename(input)}.bc`);
  const object = join(scratch, `${basename(input)}.o`);
  execFileSync(llvmAs, [input, "-o", bitcode], { stdio: "inherit" });
  execFileSync(llc, [
    "-mtriple=wasm32-unknown-unknown",
    "-mattr=+atomics,+bulk-memory,+mutable-globals,+sign-ext,+simd128",
    pic ? "-relocation-model=pic" : undefined,
    "-O2",
    "-filetype=obj",
    bitcode,
    "-o",
    object,
  ].filter(Boolean), { stdio: "inherit" });

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
    object,
    ...runtimeArchives,
    "-o",
    output,
  ].filter(Boolean);
  execFileSync(wasmLd, linkOptions, { stdio: "inherit" });

  const bytes = readFileSync(output);
  const module = new WebAssembly.Module(bytes);
  process.stdout.write(`${JSON.stringify({
    input,
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
