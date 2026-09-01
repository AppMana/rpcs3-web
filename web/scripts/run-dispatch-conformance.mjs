import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function protocolLines(text) {
  return text.split(/\r?\n/).filter((line) => line.startsWith("RPCS3-DISPATCH/1 "));
}

async function runMode(mode) {
  const config = join(stateRoot, `${mode.name}.yml`);
  writeFileSync(config, `Core:\n  PPU Decoder: ${mode.ppu}\n  SPU Decoder: ${mode.spu}\nVideo:\n  Renderer: Null\nAudio:\n  Renderer: Null\nMiscellaneous:\n  Exit RPCS3 when process finishes: true\n`);
  writeFileSync(tty, "");
  const output = [];
  const child = spawn(executable, ["--headless", "--allow-any-location", "--config", config, fixture], {
    cwd: repoRoot,
    env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_CACHE_HOME: cacheHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const deadline = Date.now() + 30_000;
  let lines = [];
  while (Date.now() < deadline) {
    await delay(20);
    try {
      lines = protocolLines(readFileSync(tty, "utf8"));
    } catch {}
    if (lines.some((line) => / (PASS|FAIL) /.test(line))) break;
    if (child.exitCode !== null) break;
  }
  if (child.exitCode === null) child.kill("SIGTERM");
  const terminal = lines.at(-1) ?? "";
  if (!terminal.startsWith("RPCS3-DISPATCH/1 PASS ")) {
    throw new Error(`${mode.name} did not pass: ${terminal || Buffer.concat(output).toString("utf8").slice(-2000)}`);
  }
  return { mode: mode.name, lines, verdict: terminal.split(" ").at(-1) };
}

const results = [];
for (const mode of modes) results.push(await runMode(mode));
const oracle = results[0].lines;
for (const result of results.slice(1)) {
  if (JSON.stringify(result.lines) !== JSON.stringify(oracle)) {
    throw new Error(`${result.mode} output differs from ${results[0].mode}`);
  }
}
process.stdout.write(`${JSON.stringify({ ok: true, fixture, results }, null, 2)}\n`);
