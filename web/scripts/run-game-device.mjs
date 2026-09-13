// Boots a disc image already present in the attached iPad's origin-private storage and saves a
// screenshot and per-frame timings. This is the device counterpart of run-hardware-acceptance.mjs.
//
//   node device-game.mjs <origin> <outputDir> <opfsPath> [frames] [width] [height]
//
// Environment: RPCS3_SPU_DECODER, RPCS3_INPUT_TRACE, RPCS3_CLOCK_SCALE, RPCS3_NO_AOT=1
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { WebKitConnection } from "./webkit-connection.mjs";
import { recoverDeviceProgress } from "./device-progress.mjs";

const origin = new URL(process.argv[2] || "https://rpcs3.appmana.com/");
const outputDirectory = path.resolve(process.argv[3] || "device-game-evidence");
const bootPath = process.argv[4];
const frameCount = Math.max(1, Number(process.argv[5] || 120));
const width = Number(process.argv[6] || 1280);
const height = Number(process.argv[7] || 720);
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 3_600_000);
const spuDecoder = process.env.RPCS3_SPU_DECODER || "llvm";
const clockScale = Number(process.env.RPCS3_CLOCK_SCALE || 100);
const useAot = process.env.RPCS3_NO_AOT !== "1";
const inputTrace = process.env.RPCS3_INPUT_TRACE
  ? JSON.parse(await readFile(path.resolve(process.env.RPCS3_INPUT_TRACE), "utf8")).entries
  : undefined;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Readers may inspect progress while the next snapshot is being written.
// Publish one complete file by rename rather than exposing a truncated JSON file.
async function publishSnapshot(name, value) {
  const destination = path.join(outputDirectory, name);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function discover() {
  const devices = await readJson(discoveryURL);
  if (devices.length !== 1) throw new Error(`Expected one attached device, found ${devices.length}`);
  const device = devices[0];
  return { device, pages: await readJson(`http://${device.url}/json`) };
}

async function findPage(predicate) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const found = await discover();
    const page = found.pages.find(predicate);
    if (page) return { device: found.device, page };
    await delay(250);
  }
  throw new Error("no inspectable Safari page matched");
}

const runtimeUrl = new URL(`runtime.html?device=${Date.now()}`, origin).href;
const initial = await findPage((page) => page.title !== "ServiceWorker" && !page.url.startsWith("safari-web-extension:"));
let connection = await new WebKitConnection(initial.page.webSocketDebuggerUrl, timeoutMs).open();
// The runtime's memory is shared, so it reserves its maximum when it is created rather than as it
// grows, and a same-origin navigation leaves the previous run's reservation in place: WebKit keeps
// the process. A cross-origin round trip swaps the process and gives the memory back, without which
// a second run on a device fails in the WebAssembly.Memory constructor before RPCS3 starts.
await connection.evaluate(`location.assign("https://example.com/?rpcs3-reset=${Date.now()}")`);
connection.close();
await delay(4_000);
const blanked = await findPage((page) => page.url.startsWith("https://example.com/"));
connection = await new WebKitConnection(blanked.page.webSocketDebuggerUrl, timeoutMs).open();
await connection.evaluate(`location.assign(${JSON.stringify(runtimeUrl)})`);
connection.close();
const navigated = await findPage((page) => page.url.startsWith(new URL("runtime.html", origin).href));
const { device } = navigated;
connection = await new WebKitConnection(navigated.page.webSocketDebuggerUrl, timeoutMs).open();
for (let i = 0; i < 240; i++) {
  if (await connection.evaluate(`Boolean(window.__rpcs3Runtime)`)) break;
  await delay(500);
}

const options = {
  ppuJit: process.env.RPCS3_PPU_JIT !== "0", benchmark: true,
  ppuReturnDispatch: process.env.RPCS3_PPU_RETURN_DISPATCH === "1",
  spuPortableCalls: process.env.RPCS3_SPU_PORTABLE_CALLS === "1",
  ppuBatchedDiagnostics: process.env.RPCS3_PPU_BATCHED_DIAGNOSTICS !== "0",
  suspending: process.env.RPCS3_JSPI === "0" ? false : undefined,
  coreUrl: process.env.RPCS3_CORE_URL || undefined,
  memoryMaximumMiB: Number(process.env.RPCS3_MEMORY_MAX_MIB) || undefined,
  frames: frameCount, render: true, width, height, readback: false, directRenderer: true,
  renderEvery: 1, timeoutMs: timeoutMs - 60_000, clockScale, spuDecoder,
  // Each compiler worker holds its own LLVM instance, and the device's memory ceiling is far tighter
  // than the desktop's, so how many it can afford is a per-device answer
  spuLlvmWorkers: Number(process.env.RPCS3_SPU_LLVM_WORKERS) || 2,
  ppuAotBundle: useAot && process.env.RPCS3_NO_PPU_AOT !== "1" ? (process.env.RPCS3_PPU_AOT_BUNDLE || undefined) : null,
  spuAotBundle: useAot && process.env.RPCS3_NO_SPU_AOT !== "1" ? (process.env.RPCS3_SPU_AOT_BUNDLE || undefined) : null,
  bindGroupCache: process.env.RPCS3_BIND_GROUP_CACHE === "1",
  presentationYield: process.env.RPCS3_PRESENTATION_YIELD ?? "timer",
  inputTrace, captureRgba: process.env.RPCS3_CAPTURE_RGBA !== "0", keepRuntime: false,
  pthreadPoolSize: Number(process.env.RPCS3_POOL_SIZE) || undefined,
};

await connection.evaluate(`(() => {
  // The result is summarised on the page and written to storage, so a run outlives the inspector
  // connection that started it: a first boot is long and the connection does not always survive it.
  window.__rpcs3Summarise = (run) => {
    const frames = run.frames ?? [];
    const timings = run.flipTimings ?? [];
    const deltas = []; for (let i = 1; i < timings.length; i++) {
      if (timings[i].emuFlipId === timings[i - 1].emuFlipId + 1) deltas.push(timings[i].hostTimeMs - timings[i - 1].hostTimeMs);
    }
    const sorted = [...deltas].sort((a, b) => a - b);
    const at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
    const last = frames.at(-1) ?? {};
    return JSON.stringify({
      ok: run.ok, detail: String(run.detail ?? "").slice(0, 400), bootResult: run.bootResult,
      moduleCreateMs: run.moduleCreateMs, frames: frames.at(-1)?.emuFlipId ?? 0, observations: frames.length,
      flipTimings: timings, timingDrops: run.timingDrops,
      diagnostics: run.ok ? undefined : run.events,
      msPerFrame: { p50: at(0.5), p95: at(0.95), mean: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null },
      directStats: last.directStats, device: last.gpu?.device ?? run.gpu?.device,
      presented: run.gpu?.presented, frameHash: run.gpu?.frameHash,
      spuInstructions: run.spuInstructions, ppuInstructions: run.ppuInstructions,
      ppuAotTable: run.ppuAotTable ?? last.ppuAotTable, spuHotReport: run.spuHotReport ?? last.spuHotReport, workingSet: last.workingSet,
      capture: { width: run.gpu?.width, height: run.gpu?.height, rgbaBase64: run.gpu?.rgbaBase64 },
    });
  };
  return true;
})()`);

const startedAt = Date.now();
// Kick the run off without blocking on it, so the boot can be watched while it happens: a first
// boot on a device downloads the ahead-of-time bundles and compiles them before a frame appears.
// The saved result outlives the page, so a run must be able to tell its own result from the one the
// previous run left behind: without this the reader takes the stale file on its first poll and
// reports the previous run's outcome as this one's.
await mkdir(outputDirectory, { recursive: true });
const observations = [];
const memoryEvents = [];
const trackMemory = async (inspector) => {
  if (process.env.RPCS3_MEMORY_PROFILE !== "1") return;
  inspector.onNotification = (event) => {
    if (event.method.startsWith("Memory.")) memoryEvents.push({ at: Date.now(), ...event });
  };
  try {
    await inspector.command("Memory.enable");
    await inspector.command("Memory.startTracking");
  } catch (error) {
    memoryEvents.push({ at: Date.now(), error: error.message });
    process.stderr.write(`Memory profiling unavailable: ${error.message}\n`);
  }
};
await trackMemory(connection);
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
await connection.evaluate(`(async () => {
  window.__rpcs3DeviceState = { phase: "running", runId: ${JSON.stringify(runId)}, events: [] };
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("device-run.json");
  } catch (error) { /* nothing saved yet */ }
  const save = async (payload) => {
    try {
      const stamped = JSON.stringify({ ...JSON.parse(payload), runId: ${JSON.stringify(runId)} });
      window.__rpcs3DeviceSaved = stamped;
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("device-run.json", { create: true });
      const writable = await handle.createWritable();
      await writable.write(stamped);
      await writable.close();
    } catch (error) { /* the reader falls back to the live page */ }
  };
  window.__rpcs3DeviceRun = window.__rpcs3Runtime.run(${JSON.stringify(bootPath)}, { ...${JSON.stringify(options)}, onEvent(event) {
    window.__rpcs3DeviceState.events.push(event);
    if (window.__rpcs3DeviceState.events.length > 40) window.__rpcs3DeviceState.events.shift();
  } })
    .then(async (value) => {
      window.__rpcs3DeviceValue = value;
      window.__rpcs3DeviceState = { phase: "done" };
      await save(window.__rpcs3Summarise(value));
      return value;
    })
    .catch(async (error) => {
      // A failure carries the events that led to it, and the ones that say why are the last
      const message = String((error && error.message) || error).slice(0, 8000);
      window.__rpcs3DeviceState = { phase: "failed", error: message };
      await save(error?.partial ? window.__rpcs3Summarise(error.partial) : JSON.stringify({ ok: false, detail: "RUN FAILED " + message }));
      throw error;
    });
  return true;
})()`);
// Watch from fresh connections: the run keeps going in the page whether or not this one survives.
let result;
let goneCount = 0;
let lastDraws = 0;
const deadline = startedAt + timeoutMs;
for (let tick = 0; Date.now() < deadline; tick++) {
  await delay(1_000);
  try {
    const discovered = await discover();
    const crashed = discovered.pages.find((page) => page.title === "Webpage Crashed");
    if (crashed) {
      result = JSON.stringify({ ok: false, detail: "Safari inspector reports Webpage Crashed", runId });
      break;
    }
    if (!connection) {
      const page = await findPage((candidate) => candidate.url.startsWith(new URL("runtime.html", origin).href));
      connection = await new WebKitConnection(page.page.webSocketDebuggerUrl, timeoutMs).open();
      await trackMemory(connection);
    }
    connection.timeoutMs = 10_000;
    const state = await connection.evaluate(`JSON.stringify({
      phase: window.__rpcs3DeviceState?.phase ?? "gone", events: window.__rpcs3DeviceState?.events,
      runId: window.__rpcs3DeviceState?.runId,
      timeOrigin: performance.timeOrigin, saved: window.__rpcs3DeviceSaved ?? ""
    })`);
    const parsedState = JSON.parse(state);
    observations.push({ at: Date.now(), ...parsedState, saved: undefined });
    await publishSnapshot("progress.json", observations);
    if (memoryEvents.length) await publishSnapshot("memory.json", memoryEvents);
    const savedRunId = parsedState.saved ? JSON.parse(parsedState.saved).runId : undefined;
    const mine = savedRunId === runId;
    goneCount = parsedState.phase === "gone" && !mine ? goneCount + 1 : 0;
    if (goneCount >= 10) {
      result = JSON.stringify({ ok: false, detail: "Safari lost the active run without persisting a result (page terminated or reloaded)", runId });
      break;
    }
    if (tick % 10 === 0) {
      const frame = parsedState.events?.findLast((event) => event.type === "runtime-frame" || event.type === "runtime-progress");
      const rendered = parsedState.events?.findLast((event) => event.directStats);
      lastDraws = rendered?.directStats?.draws ?? lastDraws;
      process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${parsedState.phase} frame=${frame?.emuFlipId ?? frame?.workingSet?.flipCounter ?? 0} draws=${lastDraws} ppuDispatches=${frame?.ppuAotDispatches ?? 0}${parsedState.saved && !mine ? " (earlier result ignored)" : ""}\n`);
    }
    if (parsedState.saved && mine) { result = parsedState.saved; break; }
  } catch (error) {
    process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] connection lost: ${String(error.message).slice(0, 80)}\n`);
    try { connection?.close(); } catch (_) {}
    connection = undefined;
  }
}
if (!result) {
  result = JSON.stringify({ ok: false, detail: "the device produced no result within the timeout", runId,
    lastFrame: observations.at(-1)?.events?.findLast((event) => event.type === "runtime-frame") });
  try { await connection?.evaluate("void window.__rpcs3Runtime?.stop()"); } catch {}
}

const parsed = JSON.parse(result);
if (memoryEvents.length) await publishSnapshot("memory.json", memoryEvents);
if (!parsed.ok && !parsed.flipTimings?.length) parsed.partial = recoverDeviceProgress(observations);
const rgba = Buffer.from(parsed.capture?.rgbaBase64 ?? "", "base64");
delete parsed.capture?.rgbaBase64;
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify({
  capturedAt: new Date().toISOString(), origin: origin.href,
  device: { name: device.deviceName, osVersion: device.deviceOSVersion },
  bootPath, frames: frameCount, width, height, spuDecoder, clockScale, options,
  elapsedMs: Date.now() - startedAt, result: parsed,
}, null, 2)}\n`);
if (parsed.capture?.width > 0 && parsed.capture?.height > 0 && rgba.length === parsed.capture.width * parsed.capture.height * 4) {
  const image = new PNG({ width: parsed.capture.width, height: parsed.capture.height });
  rgba.copy(image.data);
  await writeFile(path.join(outputDirectory, "frame.png"), PNG.sync.write(image));
}
console.log(JSON.stringify({ ok: parsed.ok, bootResult: parsed.bootResult, frames: parsed.frames, msPerFrame: parsed.msPerFrame, draws: parsed.directStats?.draws, presented: parsed.presented, detail: parsed.detail?.slice(0, 200) }));
connection?.close();
process.exit(parsed.ok ? 0 : 1);
