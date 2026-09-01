import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const nativeRpcs3 = resolve(process.env.RPCS3_NATIVE ?? join(repoRoot, "build-rpcs3-native/bin/rpcs3"));
const fixture = resolve(process.env.RPCS3_SPU_AOT_FIXTURE ?? join(repoRoot, "bin/test/web_dispatch_conformance.self"));
const output = resolve(process.env.RPCS3_SPU_AOT_OUTPUT ?? join(repoRoot, "bin/test/web_dispatch_conformance-spu-aot.wasm"));
const scratch = mkdtempSync(join(tmpdir(), "rpcs3-spu-aot-fixture-"));
const irDirectory = join(scratch, "ir");
const config = join(scratch, "config.yml");

accessSync(nativeRpcs3);
accessSync(fixture);
mkdirSync(irDirectory, { recursive: true });
writeFileSync(config, `Core:
  PPU Decoder: Interpreter (static)
  SPU Decoder: Recompiler (LLVM)
  SPU Block Size: Safe
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

let child;
try {
  child = spawn(nativeRpcs3, ["--headless", "--allow-any-location", "--config", config, fixture], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RPCS3_SPU_WASM_AOT_IR: "1",
      RPCS3_SPU_WASM_AOT_DIR: irDirectory,
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
      .filter((name) => name.endsWith(".wasm.ll"))
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
      throw new Error(`native RPCS3 exited with ${child.exitCode} before emitting SPU IR`);
    }
  }
  if (!fragments.length) throw new Error("native RPCS3 did not emit SPU Wasm IR within 60 seconds");

  child.kill("SIGTERM");
  const linkedIr = join(scratch, "spu-fixture.wasm.ll");
  execFileSync(findTool("RPCS3_LLVM_LINK", "llvm-link"), ["-S", ...fragments, "-o", linkedIr], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  mkdirSync(dirname(output), { recursive: true });
  execFileSync(process.execPath, [
    join(webRoot, "scripts/compile-ppu-ir-to-wasm.mjs"),
    linkedIr,
    output,
    "--pic",
    "--export-all",
  ], { cwd: webRoot, stdio: ["ignore", "ignore", "inherit"] });

  const bytes = readFileSync(output);
  const module = new WebAssembly.Module(bytes);
  const blockExports = WebAssembly.Module.exports(module)
    .filter(({ name, kind }) => kind === "function" && /^__spu-0x[0-9a-f]+-/i.test(name));
  if (!blockExports.length) throw new Error("compiled SPU module contains no RPCS3 block exports");
  process.stdout.write(`${JSON.stringify({
    fixture,
    fragments: fragments.length,
    irBytes: statSync(linkedIr).size,
    output,
    wasmBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    blockExports: blockExports.map(({ name }) => name),
  })}\n`);
} finally {
  if (child?.exitCode === null) child.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
