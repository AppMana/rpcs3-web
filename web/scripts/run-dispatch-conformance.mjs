// Native oracle for the PPU/SPU dispatch conformance fixture: runs the
// native RPCS3 build headlessly in each decoder mode through the kit's
// native-oracle runner and requires identical RPCS3-DISPATCH/1 protocol lines.
//
//   node scripts/run-dispatch-conformance.mjs [--include-spu-llvm]
//   RPCS3_NATIVE  RPCS3_DISPATCH_FIXTURE  RPCS3_DISPATCH_STATE
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareOracleRuns, runNativeOracle } from "@appmana-public/web-emulator-harness/native-oracle";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, "../..");
const executable = resolve(process.env.RPCS3_NATIVE ?? join(repoRoot, "build-rpcs3-native/bin/rpcs3"));
const fixture = resolve(process.env.RPCS3_DISPATCH_FIXTURE ?? join(repoRoot, "bin/test/web_dispatch_conformance.self"));
const stateRoot = resolve(process.env.RPCS3_DISPATCH_STATE ?? join(homedir(), ".cache/rpcs3-dispatch"));
const configHome = join(stateRoot, "config");
const cacheHome = join(stateRoot, "cache");
const tty = join(cacheHome, "rpcs3/TTY.log");
const modes = [
  { name: "static-static", ppu: "Interpreter (static)", spu: "Interpreter (static)" },
  { name: "llvm-static", ppu: "Recompiler (LLVM)", spu: "Interpreter (static)" },
];
if (process.argv.includes("--include-spu-llvm")) {
  modes.push({ name: "llvm-llvm", ppu: "Recompiler (LLVM)", spu: "Recompiler (LLVM)" });
}

mkdirSync(configHome, { recursive: true });
mkdirSync(dirname(tty), { recursive: true });

const results = [];
for (const mode of modes) {
  const config = join(stateRoot, `${mode.name}.yml`);
  writeFileSync(config, `Core:\n  PPU Decoder: ${mode.ppu}\n  SPU Decoder: ${mode.spu}\nVideo:\n  Renderer: Null\nAudio:\n  Renderer: Null\nMiscellaneous:\n  Exit RPCS3 when process finishes: true\n`);
  writeFileSync(tty, "");
  const run = await runNativeOracle({
    name: mode.name,
    command: executable,
    args: ["--headless", "--allow-any-location", "--config", config, fixture],
    cwd: repoRoot,
    env: { XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome },
    outputFiles: { tty },
    protocolLinePrefix: "RPCS3-DISPATCH/1 ",
    timeoutMs: 30_000,
  });
  const terminal = run.terminal ?? "";
  if (!terminal.startsWith("RPCS3-DISPATCH/1 PASS ")) {
    throw new Error(`${mode.name} did not pass: ${terminal || (run.stdout + run.stderr).slice(-2000)}`);
  }
  results.push({ mode: mode.name, lines: run.lines, verdict: terminal.split(" ").at(-1) });
}
const comparison = compareOracleRuns(results.map((result) => ({ name: result.mode, lines: result.lines })));
if (!comparison.ok) {
  throw new Error(`${comparison.divergent.map((run) => run.name).join(", ")} output differs from ${comparison.reference}`);
}
process.stdout.write(`${JSON.stringify({ ok: true, fixture, results }, null, 2)}\n`);
