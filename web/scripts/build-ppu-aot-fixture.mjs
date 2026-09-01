import { execFileSync, spawn } from "node:child_process";
import { accessSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..");
const nativeRpcs3 = resolve(process.env.RPCS3_NATIVE ?? join(repoRoot, "build-rpcs3-native/bin/rpcs3"));
const elf = resolve(process.env.RPCS3_PPU_AOT_ELF ?? join(repoRoot, "bin/test/ppu_thread.elf"));
const fixtureDirectory = join(webRoot, "public/fixtures");
const output = resolve(process.env.RPCS3_PPU_AOT_OUTPUT ?? join(fixtureDirectory, "ppu-thread-aot.wasm"));
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
  let ir;
  let lastCandidate = "";
  let lastSize = -1;
  while (!ir && Date.now() < deadline) {
    await delay(100);
    const candidates = readdirSync(irDirectory, { recursive: true })
      .map(String)
      .filter((name) => name.startsWith(`${basename(elf)}-`) && name.endsWith(".wasm.ll"));
    if (candidates.length) {
      const candidate = join(irDirectory, candidates[0]);
      const size = statSync(candidate).size;
      if (candidate === lastCandidate && size === lastSize && size > 0) ir = candidate;
      lastCandidate = candidate;
      lastSize = size;
    }
    if (child.exitCode !== null && !ir) {
      throw new Error(`native RPCS3 exited with ${child.exitCode} before emitting ${basename(elf)} IR`);
    }
  }
  if (!ir) throw new Error(`native RPCS3 did not emit ${basename(elf)} IR within 60 seconds`);

  child.kill("SIGTERM");
  execFileSync(process.execPath, [
    join(webRoot, "scripts/compile-ppu-ir-to-wasm.mjs"),
    ir,
    output,
    "--pic",
    "--export-all",
  ], { cwd: webRoot, stdio: ["ignore", "ignore", "inherit"] });
  copyFileSync(elf, join(fixtureDirectory, basename(elf)));
  process.stdout.write(`${JSON.stringify({ elf, ir, output })}\n`);
} finally {
  if (child?.exitCode === null) child.kill("SIGTERM");
  rmSync(scratch, { recursive: true, force: true });
}
