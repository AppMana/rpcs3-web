// Usage: run-native-performance.mjs <ISO-or-ELF> <output-directory> <config.yml>
// Close the native window normally to finish early and flush the flip report.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const [target, directory, config] = process.argv.slice(2);
if (!target || !directory || !config) throw new Error("usage: run-native-performance.mjs target output-directory config.yml");
const output = path.resolve(directory);
await mkdir(output, { recursive: true });
const executable = path.resolve(process.env.RPCS3_NATIVE || fileURLToPath(new URL("../../build-rpcs3-native-stock/bin/rpcs3", import.meta.url)));
const frameFile = path.join(output, "native-flips.json");
const durationMs = Number(process.env.RPCS3_DURATION_MS || 240_000);
const args = ["--benchmark-duration", String(durationMs), "--no-gui", "--allow-any-location", "--config", path.resolve(config), "--benchmark-report", frameFile];
const perfFromFrame = Number(process.env.RPCS3_PERF_FROM_FRAME || 0);
const perfToFrame = Number(process.env.RPCS3_PERF_TO_FRAME || 0);
if (![perfFromFrame, perfToFrame].every((v) => Number.isSafeInteger(v) && v >= 0)
    || (perfToFrame && (!perfFromFrame || perfToFrame <= perfFromFrame))) throw new Error("invalid native perf frame window");
const progressFile = path.join(output, "native-progress.json");
if (perfFromFrame) {
  // Clear stale progress before spawning when an output directory is reused.
  await writeFile(progressFile, JSON.stringify({ frame: 0 }));
  args.push("--benchmark-progress", progressFile);
}
if (process.env.RPCS3_INPUT_TRACE) args.push("--input-trace", path.resolve(process.env.RPCS3_INPUT_TRACE));
const captureFrame = Number(process.env.RPCS3_CAPTURE_RSX_FRAME || 0);
if (!Number.isSafeInteger(captureFrame) || captureFrame < 0 || captureFrame > 0xffffffff)
  throw new Error("RPCS3_CAPTURE_RSX_FRAME must be an unsigned 32-bit frame number");
const nativeConfigDirectory = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "rpcs3");
if (captureFrame) {
  await mkdir(path.join(nativeConfigDirectory, "captures"), { recursive: true });
  args.push("--benchmark-capture-frame", String(captureFrame));
}
if (/\.rrc(?:\.gz|\.zst)?$/.test(target)) args.push("--rsx-capture");
args.push(path.resolve(target));
const report = { schemaVersion: 2, runId: randomUUID(), target: path.resolve(target), executable, args,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  config: await readFile(config, "utf8"),
  configHome: process.env.XDG_CONFIG_HOME, display: process.env.DISPLAY,
  diagnosticCaptureFrame: captureFrame || null,
  configHash: createHash("sha256").update(await readFile(config)).digest("hex"),
  executableHash: createHash("sha256").update(await readFile(executable)).digest("hex"),
  processSamples: [], hostSamples: [], failures: [] };
const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
const log = await open(path.join(output, "native.log"), "w");
const child = spawn(executable, args, { detached: true, env: { ...process.env, QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM || "xcb" }, stdio: ["ignore", log.fd, log.fd] });
const exited = new Promise((resolve) => {
  child.once("error", (error) => { report.failures.push(error.message); resolve({ error: error.message }); });
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
let perf;
let perfExited;
const startPerf = (observedFrame = 0) => {
  report.perfWindow = { requestedFromFrame: perfFromFrame, requestedToFrame: perfToFrame,
    startedAtFrame: observedFrame, startedMonotonicUs: Number(process.hrtime.bigint()) / 1000 };
  perf = spawn("perf", ["record", "-F", "99", "-k", "1", "--call-graph", "dwarf,4096", "-m", "2048",
    "-e", "cycles:u", "-o", path.join(output, "native.perf"), "-p", String(child.pid)],
    { stdio: ["ignore", log.fd, log.fd] });
  perfExited = new Promise((resolve) => {
    perf.once("error", (error) => { report.failures.push(`perf: ${error.message}`); resolve(); });
    perf.once("exit", (code) => { if (code) report.failures.push(`perf exited ${code}`); resolve(); });
  });
};
if (process.env.RPCS3_PERF === "1" && child.pid && !perfFromFrame) startPerf();
let perfStopped = false;
let captured = false;
let done = false;
exited.then(() => { done = true; });
const deadline = Date.now() + durationMs + 30_000;
try {
  while (!done && Date.now() < deadline) {
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
      // comm may contain spaces and parentheses; fields after the final ')' start at field 3.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      report.processSamples.push({ monotonicUs: Number(process.hrtime.bigint()) / 1000,
        cpuTime: (Number(fields[11]) + Number(fields[12])) / ticks });
      const pressure = await Promise.allSettled(["/proc/pressure/cpu", "/proc/loadavg"]
        .map((file) => readFile(file, "utf8")));
      report.hostSamples.push({ hostTimeMs: Number(process.hrtime.bigint()) / 1e6,
        ...Object.fromEntries(pressure.map((result, i) => [["cpuPressure", "loadavg"][i],
          result.status === "fulfilled" ? result.value : { error: result.reason?.code ?? String(result.reason) }])),
      });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (process.env.RPCS3_PERF === "1" && perfFromFrame && !perfStopped) {
      let progress;
      try { progress = JSON.parse(await readFile(progressFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      if (progress && !perf && progress.frame >= perfFromFrame) startPerf(progress.frame);
      if (progress && perf && perfToFrame && progress.frame >= perfToFrame) {
        report.perfWindow.stoppedAtFrame = progress.frame;
        report.perfWindow.stoppedMonotonicUs = Number(process.hrtime.bigint()) / 1000;
        perf.kill("SIGINT");
        await perfExited;
        perfStopped = true;
      }
    }
    if (!captured && Date.now() >= deadline - 40_000) {
      captured = true;
      try {
        const windows = execFileSync("xdotool", ["search", "--all", "--pid", String(child.pid), "."], { encoding: "utf8" }).trim().split(/\s+/);
        report.windows = [];
        for (const window of windows) {
          const owner = Number(execFileSync("xdotool", ["getwindowpid", window], { encoding: "utf8" }));
          if (owner !== child.pid) continue;
          const title = execFileSync("xdotool", ["getwindowname", window], { encoding: "utf8" }).trim();
          if (!title.includes("FPS:")) continue;
          const info = execFileSync("xwininfo", ["-id", window], { encoding: "utf8" });
          report.windows.push({ window, title, info });
          if (info.includes("IsViewable")) execFileSync("import", ["-window", window, path.join(output, "frame.png")], { timeout: 5000 });
        }
      } catch (error) { report.failures.push(`capture: ${error.message}`); }
    }
    if (report.processSamples.length % 10 === 0) await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!done) {
    const windows = execFileSync("xdotool", ["search", "--all", "--pid", String(child.pid), "."], { encoding: "utf8" }).trim().split(/\s+/);
    for (const [index, window] of windows.entries()) {
      const owner = Number(execFileSync("xdotool", ["getwindowpid", window], { encoding: "utf8" }).trim());
      if (owner !== child.pid) throw new Error(`refusing to close window owned by PID ${owner}`);
      const title = execFileSync("xdotool", ["getwindowname", window], { encoding: "utf8" });
      if (!title.includes("FPS:")) continue;
      try { execFileSync("import", ["-window", window, path.join(output, `frame-${index}.png`)], { timeout: 10_000 }); }
      catch (error) { report.failures.push(`screenshot: ${error.message}`); }
      execFileSync("wmctrl", ["-i", "-c", window]);
    }
    const graceful = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 30_000))]);
    if (!graceful) throw new Error("native window did not close within 30 seconds");
  }
  report.exit = await exited;
  report.flips = JSON.parse(await readFile(frameFile, "utf8"));
  if (captureFrame) {
    const nativeLog = await readFile(path.join(nativeConfigDirectory, "RPCS3.log"), "utf8");
    const capturePath = nativeLog.match(/Capture successful: ([^\r\n]+\.rrc\.gz)/)?.[1];
    if (!capturePath) throw new Error(`no successful RSX capture after requested guest flip ${captureFrame}`);
    const capture = await readFile(capturePath);
    report.rsxCapture = { path: capturePath, bytes: capture.length,
      sha256: createHash("sha256").update(capture).digest("hex") };
  }
  if (report.exit.code !== 0 || !report.flips.frames.length) throw new Error("native benchmark did not finish with guest frames");
} catch (error) {
  report.failures.push(error.stack);
  process.exitCode = 1;
} finally {
  if (!done) { child.kill("SIGTERM"); await exited; }
  // RPCS3 can spawn an error dialog that inherits game sockets. Retire this run’s
  // process group so a failed run cannot contaminate the next fixture.
  if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") report.failures.push(error.message); } }
  if (perf && !perfStopped) { perf.kill("SIGINT"); await perfExited; }
  if (process.env.RPCS3_PERF === "1" && !perf) report.failures.push("native perf start frame was never reached");
  if (process.env.RPCS3_PERF_MAP) {
    try { await writeFile(path.join(output, "jit.map"), await readFile(`/tmp/perf-${child.pid}.map`)); }
    catch (error) { report.failures.push(`JIT map: ${error.message}`); }
  }
  if (!report.flips) {
    try { report.flips = JSON.parse(await readFile(frameFile, "utf8")); } catch {}
  }
  await log.close();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
console.log(JSON.stringify({ output, frames: report.flips?.frames.length, failures: report.failures }));
