// Boots a disc image already present in the attached iPad's origin-private storage and saves a
// screenshot and per-frame timings. This is the device counterpart of run-hardware-acceptance.mjs.
//
//   node device-game.mjs <origin> <outputDir> <opfsPath> [frames] [width] [height]
//
// Environment: RPCS3_SPU_DECODER, RPCS3_INPUT_TRACE, RPCS3_CLOCK_SCALE, RPCS3_NO_AOT=1
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const origin = new URL(process.argv[2] || "https://rpcs3.appmana.com/");
const outputDirectory = path.resolve(process.argv[3] || "device-game-evidence");
const bootPath = process.argv[4];
const frameCount = Math.max(1, Number(process.argv[5] || 120));
const width = Number(process.argv[6] || 480);
const height = Number(process.argv[7] || 270);
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 3_600_000);
const spuDecoder = process.env.RPCS3_SPU_DECODER || "asmjit";
const clockScale = Number(process.env.RPCS3_CLOCK_SCALE || 100);
const useAot = process.env.RPCS3_NO_AOT !== "1";
const inputTrace = process.env.RPCS3_INPUT_TRACE
  ? JSON.parse(await readFile(path.resolve(process.env.RPCS3_INPUT_TRACE), "utf8")).entries
  : undefined;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

class WebKitConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.targetId = undefined;
    this.innerId = 0;
    this.outerId = 0;
    this.pending = new Map();
  }

  async open() {
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    const deadline = Date.now() + 15_000;
    while (!this.targetId && Date.now() < deadline) await delay(25);
    if (!this.targetId) throw new Error("WebKit did not announce a page target");
    return this;
  }

  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.method === "Target.targetCreated") {
      const info = message.params.targetInfo;
      if (!this.targetId && info.type === "page" && !info.isProvisional) this.targetId = info.targetId;
    }
    if (message.method === "Target.didCommitProvisionalTarget" && message.params.oldTargetId === this.targetId) {
      this.targetId = message.params.newTargetId;
    }
    if (message.method !== "Target.dispatchMessageFromTarget") return;
    const inner = JSON.parse(message.params.message);
    const pending = this.pending.get(inner.id);
    if (!pending) return;
    this.pending.delete(inner.id);
    clearTimeout(pending.timer);
    if (inner.error) pending.reject(new Error(inner.error.message));
    else pending.resolve(inner.result);
  }

  command(method, params = {}) {
    const innerId = ++this.innerId;
    this.socket.send(JSON.stringify({
      id: ++this.outerId,
      method: "Target.sendMessageToTarget",
      params: { targetId: this.targetId, message: JSON.stringify({ id: innerId, method, params }) },
    }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(innerId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(innerId, { resolve, reject, timer });
    });
  }

  async evaluate(expression, awaitPromise = false) {
    const evaluation = await this.command("Runtime.evaluate", {
      expression,
      returnByValue: !awaitPromise,
      doNotPauseOnExceptionsAndMuteConsole: true,
    });
    if (evaluation.wasThrown) throw new Error(evaluation.result.description || "Evaluation failed");
    let result = evaluation.result;
    if (awaitPromise && result.objectId) {
      const awaited = await this.command("Runtime.awaitPromise", { promiseObjectId: result.objectId, returnByValue: true });
      if (awaited.wasThrown) throw new Error(awaited.result.description || "Promise rejected");
      result = awaited.result;
    }
    return result.value;
  }

  close() {
    this.socket.close();
  }
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
let connection = await new WebKitConnection(initial.page.webSocketDebuggerUrl).open();
// The runtime's memory is shared, so it reserves its maximum when it is created rather than as it
// grows, and a same-origin navigation leaves the previous run's reservation in place: WebKit keeps
// the process. A cross-origin round trip swaps the process and gives the memory back, without which
// a second run on a device fails in the WebAssembly.Memory constructor before RPCS3 starts.
await connection.evaluate(`location.assign("https://example.com/?rpcs3-reset=${Date.now()}")`);
connection.close();
await delay(4_000);
const blanked = await findPage((page) => page.url.startsWith("https://example.com/"));
connection = await new WebKitConnection(blanked.page.webSocketDebuggerUrl).open();
await connection.evaluate(`location.assign(${JSON.stringify(runtimeUrl)})`);
connection.close();
const navigated = await findPage((page) => page.url.startsWith(new URL("runtime.html", origin).href));
const { device } = navigated;
connection = await new WebKitConnection(navigated.page.webSocketDebuggerUrl).open();
for (let i = 0; i < 240; i++) {
  if (await connection.evaluate(`Boolean(window.__rpcs3Runtime)`)) break;
  await delay(500);
}

const options = {
  frames: frameCount, render: true, width, height, readback: false, directRenderer: true,
  renderEvery: 1, timeoutMs: timeoutMs - 60_000, clockScale, spuDecoder,
  // Each compiler worker holds its own LLVM instance, and the device's memory ceiling is far tighter
  // than the desktop's, so how many it can afford is a per-device answer
  spuLlvmWorkers: Number(process.env.RPCS3_SPU_LLVM_WORKERS) || 2,
  ppuAotBundle: useAot && process.env.RPCS3_NO_PPU_AOT !== "1" ? (process.env.RPCS3_PPU_AOT_BUNDLE || "local-aot/lbp2/manifest.json") : undefined,
  spuAotBundle: useAot && process.env.RPCS3_NO_SPU_AOT !== "1" ? "local-aot/lbp2-spu/manifest.json" : undefined,
  inputTrace, captureRgba: true, keepRuntime: false,
  pthreadPoolSize: Number(process.env.RPCS3_POOL_SIZE) || undefined,
};

await connection.evaluate(`(() => {
  // The result is summarised on the page and written to storage, so a run outlives the inspector
  // connection that started it: a first boot is long and the connection does not always survive it.
  window.__rpcs3Summarise = (run) => {
    const frames = run.frames ?? [];
    const times = frames.map((f) => f.elapsedMs).filter((v) => typeof v === "number");
    const deltas = []; for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
    const sorted = [...deltas].sort((a, b) => a - b);
    const at = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
    const last = frames.at(-1) ?? {};
    return JSON.stringify({
      ok: run.ok, detail: String(run.detail ?? "").slice(0, 400), bootResult: run.bootResult,
      moduleCreateMs: run.moduleCreateMs, frames: frames.length,
      msPerFrame: { p50: at(0.5), p95: at(0.95), mean: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null },
      directStats: last.directStats, device: last.gpu?.device ?? run.gpu?.device,
      presented: run.gpu?.presented, frameHash: run.gpu?.frameHash,
      spuInstructions: run.spuInstructions, ppuInstructions: run.ppuInstructions,
      ppuAotTable: run.ppuAotTable, spuHotReport: run.spuHotReport, workingSet: last.workingSet,
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
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
await connection.evaluate(`(async () => {
  window.__rpcs3DeviceState = { phase: "running" };
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry("device-run.json");
  } catch (error) { /* nothing saved yet */ }
  const save = async (payload) => {
    try {
      const stamped = JSON.stringify({ ...JSON.parse(payload), runId: ${JSON.stringify(runId)} });
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("device-run.json", { create: true });
      const writable = await handle.createWritable();
      await writable.write(stamped);
      await writable.close();
    } catch (error) { /* the reader falls back to the live page */ }
  };
  window.__rpcs3DeviceRun = window.__rpcs3Runtime.run(${JSON.stringify(bootPath)}, ${JSON.stringify(options)})
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
      await save(JSON.stringify({ ok: false, detail: "RUN FAILED " + message }));
      throw error;
    });
  return true;
})()`);
// Watch from fresh connections: the run keeps going in the page whether or not this one survives.
let result;
for (let tick = 0; tick * 10_000 < timeoutMs; tick++) {
  await delay(10_000);
  try {
    if (!connection) {
      const page = await findPage((candidate) => candidate.url.startsWith(new URL("runtime.html", origin).href));
      connection = await new WebKitConnection(page.page.webSocketDebuggerUrl).open();
    }
    const state = await connection.evaluate(`(async () => {
      let saved = "";
      try {
        const root = await navigator.storage.getDirectory();
        saved = await (await (await root.getFileHandle("device-run.json")).getFile()).text();
      } catch (error) { saved = ""; }
      return JSON.stringify({ phase: window.__rpcs3DeviceState?.phase ?? "gone", saved });
    })()`, true);
    const parsedState = JSON.parse(state);
    const savedRunId = parsedState.saved ? JSON.parse(parsedState.saved).runId : undefined;
    const mine = savedRunId === runId;
    process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${parsedState.phase} saved=${parsedState.saved.length}${parsedState.saved && !mine ? " (an earlier run's, ignored)" : ""}\n`);
    if (parsedState.saved && mine) { result = parsedState.saved; break; }
  } catch (error) {
    process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] connection lost: ${String(error.message).slice(0, 80)}\n`);
    try { connection?.close(); } catch (_) {}
    connection = undefined;
  }
}
if (!result) throw new Error("the device produced no result within the timeout");

const parsed = JSON.parse(result);
const rgba = Buffer.from(parsed.capture?.rgbaBase64 ?? "", "base64");
delete parsed.capture?.rgbaBase64;
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify({
  capturedAt: new Date().toISOString(), origin: origin.href,
  device: { name: device.deviceName, osVersion: device.deviceOSVersion },
  bootPath, frames: frameCount, width, height, spuDecoder, clockScale,
  elapsedMs: Date.now() - startedAt, result: parsed,
}, null, 2)}\n`);
if (rgba.length === (parsed.capture?.width ?? 0) * (parsed.capture?.height ?? 0) * 4) {
  const image = new PNG({ width: parsed.capture.width, height: parsed.capture.height });
  rgba.copy(image.data);
  await writeFile(path.join(outputDirectory, "frame.png"), PNG.sync.write(image));
}
console.log(JSON.stringify({ ok: parsed.ok, bootResult: parsed.bootResult, frames: parsed.frames, msPerFrame: parsed.msPerFrame, draws: parsed.directStats?.draws, presented: parsed.presented, detail: parsed.detail?.slice(0, 200) }));
connection.close();
process.exit(parsed.ok ? 0 : 1);
