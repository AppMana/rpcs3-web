import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const nativeRpcs3 = resolve(process.env.RPCS3_NATIVE ?? join(repoRoot, "build-rpcs3-native/bin/rpcs3"));
const elf = resolve(process.env.RPCS3_PPU_AOT_ELF ?? join(repoRoot, "bin/test/ppu_thread.elf"));
const fixtureDirectory = join(webRoot, "public/fixtures");
const output = resolve(process.env.RPCS3_PPU_AOT_OUTPUT ?? join(fixtureDirectory, "ppu-thread-aot.wasm"));
const manifestOutput = resolve(process.env.RPCS3_PPU_AOT_MANIFEST ?? `${output}.json`);
const scratch = mkdtempSync(join(tmpdir(), "rpcs3-ppu-aot-fixture-"));
const irDirectory = join(scratch, "ir");
const config = join(scratch, "config.yml");

accessSync(nativeRpcs3);
accessSync(elf);
mkdirSync(irDirectory, { recursive: true });
mkdirSync(fixtureDirectory, { recursive: true });
writeFileSync(config, `Core:
  PPU Decoder: Recompiler (LLVM)
  Save LLVM logs: false
  SPU Decoder: Interpreter (fast)
Video:
  Renderer: Null
Audio:
  Renderer: Null
`);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let child;
try {
  child = spawn(nativeRpcs3, ["--headless", "--config", config, elf], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RPCS3_PPU_WASM_AOT_IR: "1",
      RPCS3_PPU_WASM_AOT_DIR: irDirectory,
    },
    stdio: "ignore",
  });

  const deadline = Date.now() + 60_000;
  let fragments = [];
  let lastSignature = "";
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await delay(100);
    const candidates = readdirSync(irDirectory, { recursive: true })
      .map(String)
      .filter((name) => basename(name).startsWith(`${basename(elf)}-`) && name.endsWith(".wasm.ll"))
      .map((name) => join(irDirectory, name))
      .sort();
    const signature = candidates.map((candidate) => {
      const stat = statSync(candidate);
      return `${candidate}:${stat.size}:${stat.mtimeMs}`;
    }).join("\n");
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastChange = Date.now();
    }
    if (candidates.length && candidates.every((candidate) => statSync(candidate).size > 0) &&
        Date.now() - lastChange >= 2_000) {
      fragments = candidates;
      break;
    }
    if (child.exitCode !== null && !candidates.length) {
      throw new Error(`native RPCS3 exited with ${child.exitCode} before emitting ${basename(elf)} IR`);
    }
  }
  if (!fragments.length) throw new Error(`native RPCS3 did not finish emitting ${basename(elf)} IR within 60 seconds`);

  child.kill("SIGTERM");
  const linkedIr = join(scratch, `${basename(elf)}.wasm.ll`);
  execFileSync(findTool("RPCS3_LLVM_LINK", "llvm-link"), ["-S", ...fragments, "-o", linkedIr], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (process.env.RPCS3_PPU_AOT_IR_OUTPUT) {
    copyFileSync(linkedIr, resolve(process.env.RPCS3_PPU_AOT_IR_OUTPUT));
  }
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(process.execPath, [
    join(webRoot, "scripts/compile-ppu-ir-to-wasm.mjs"),
    linkedIr,
    output,
    "--pic",
    "--export-all",
  ], { cwd: webRoot, stdio: ["ignore", "ignore", "inherit"] });
  copyFileSync(elf, join(fixtureDirectory, basename(elf)));
  const bytes = readFileSync(output);
  const module = new WebAssembly.Module(bytes);
  const moduleExports = WebAssembly.Module.exports(module);
  const manifest = {
    schema: 1,
    source: basename(elf),
    sourceSha256: sha256(elf),
    fragmentCount: fragments.length,
    fragmentBytes: fragments.map((fragment) => statSync(fragment).size),
    linkedIrBytes: statSync(linkedIr).size,
    wasmBytes: bytes.byteLength,
    wasmSha256: sha256(output),
    imports: WebAssembly.Module.imports(module),
    exportCount: moduleExports.length,
    guestBlockExportCount: moduleExports.filter(({ name }) => /^__0x[0-9a-f]+$/i.test(name)).length,
    runtimeExports: moduleExports.filter(({ name }) => !/^__0x[0-9a-f]+$/i.test(name)),
  };
  mkdirSync(dirname(manifestOutput), { recursive: true });
  writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ elf, fragments: fragments.length, output, manifestOutput })}\n`);
} finally {
  if (child?.exitCode === null) child.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
