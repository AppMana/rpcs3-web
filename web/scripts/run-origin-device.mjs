// Runs the full RPCS3 runtime acceptance on an attached iPad from a hosted,
// cross-origin-isolated HTTPS origin (default https://rpcs3.appmana.com, an
// nginx Ingress in front of `vite preview` on this machine) instead of
// injecting the build over USB. The page's own acceptance API drives the run,
// so the report has the same shape as the desktop lanes: frames, per-frame
// timings, working set, and the cooperative shutdown report.
//
//   node scripts/run-origin-device.mjs [origin] [outputDir] [fixture] [frames]
//
// Requires one trusted USB device with an inspectable HTTPS Safari page.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const origin = new URL(process.argv[2] || process.env.RPCS3_DEVICE_ORIGIN || "https://rpcs3.appmana.com/");
const outputDirectory = path.resolve(process.argv[3] || "device-origin-evidence");
const fixtureName = process.argv[4] || "gs_gcm_tetris.elf";
const frameCount = Math.max(1, Math.min(60, Number(process.argv[5] || 60)));
// RPCS3_DIRECT_RENDERER=1: the RSX thread renders through emdawnwebgpu and presents ImageBitmaps
const direct = process.env.RPCS3_DIRECT_RENDERER === "1";
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 180_000);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await discover();
    const page = found.pages.find(predicate);
    if (page) return { device: found.device, page };
    await delay(250);
  }
  throw new Error(`No inspectable Safari page matched ${origin.href}`);
}

const runtimeUrl = new URL(`runtime.html?device=${Date.now()}`, origin).href;
const initial = await findPage((page) => page.title !== "ServiceWorker" && !page.url.startsWith("safari-web-extension:"));
let connection = await new WebKitConnection(initial.page.webSocketDebuggerUrl).open();
if (process.env.RPCS3_DEVICE_HARD_RESET === "1") {
  // Safari keeps a previous run's 512 MiB shared memory until its page is gone; park the tab on
  // about:blank first so the next module creation can allocate it again.
  await connection.evaluate(`location.assign("about:blank")`);
  connection.close();
  await delay(4000);
  const blank = await findPage((page) => page.url === "about:blank");
  connection = await new WebKitConnection(blank.page.webSocketDebuggerUrl).open();
}
await connection.evaluate(`location.assign(${JSON.stringify(runtimeUrl)})`);
connection.close();
const navigated = await findPage((page) => page.url === runtimeUrl);
const { device } = navigated;
connection = await new WebKitConnection(navigated.page.webSocketDebuggerUrl).open();
try {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connection.evaluate("Boolean(window.__rpcs3Runtime)")) break;
    await delay(250);
  }
  const prerequisites = JSON.parse(await connection.evaluate(`JSON.stringify({
    secureContext: isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    webGpu: Boolean(navigator.gpu),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    url: location.href
  })`));
  if (!prerequisites.secureContext || !prerequisites.crossOriginIsolated || !prerequisites.sharedArrayBuffer || !prerequisites.webGpu) {
    throw new Error(`Safari page lacks runtime prerequisites: ${JSON.stringify(prerequisites)}`);
  }
  const startedAt = Date.now();
  const result = await connection.evaluate(`(async () => {
    const result = await window.__rpcs3Runtime.run(${JSON.stringify(`fixtures/${fixtureName}`)}, {
      frames: ${frameCount}, render: true, width: 320, height: 180, readback: false, presentLatestOnly: false, directRenderer: ${direct}, keepRuntime: ${direct},
    });
    // Capture one final frame with readback for image evidence.
    const capture = await window.__rpcs3Runtime.run(${JSON.stringify(`fixtures/${fixtureName}`)}, {
      frames: ${direct ? 3 : 1}, render: true, width: 320, height: 180, captureRgba: true, directRenderer: ${direct}, keepRuntime: ${direct},
    });
    const frames = result.frames ?? [];
    const percentile = (values, fraction) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]; };
    const steady = frames.slice(1);
    return {
      ok: result.ok && capture.ok,
      detail: result.detail,
      bootResult: result.bootResult,
      moduleCreateMs: result.moduleCreateMs,
      frames: frames.length,
      adapter: frames.at(-1)?.gpu?.adapter,
      draws: frames.at(-1)?.gpu?.draws,
      presented: frames.at(-1)?.gpu?.presented,
      presentedHash: capture.gpu?.frameHash,
      directDevice: frames.at(-1)?.gpu?.device,
      vertices: frames.at(-1)?.gpu?.vertices,
      droppedPackets: frames.reduce((sum, frame) => sum + frame.droppedPackets, 0),
      waitForPacketsMs: { p50: percentile(steady.map((f) => f.hostTimings.waitForPacketsMs), 0.5), p95: percentile(steady.map((f) => f.hostTimings.waitForPacketsMs), 0.95) },
      renderMs: { p50: percentile(steady.map((f) => f.hostTimings.renderMs), 0.5), p95: percentile(steady.map((f) => f.hostTimings.renderMs), 0.95) },
      captureMs: { p50: percentile(steady.map((f) => f.captureMs), 0.5), p95: percentile(steady.map((f) => f.captureMs), 0.95) },
      gpuTimings: frames.at(-1)?.gpu?.timings,
      workingSet: frames.at(-1)?.workingSet,
      captureModuleCreateMs: capture.moduleCreateMs,
      shutdown: result.shutdown && { kept: result.shutdown.kept, stoppedCleanly: result.shutdown.stoppedCleanly, stopMs: result.shutdown.stopMs, liveThreadNames: result.shutdown.liveThreadNames, stackReport: result.shutdown.stackReport, workingSet: result.shutdown.workingSet },
      capture: { frameHash: capture.gpu?.frameHash, changedPixels: capture.gpu?.changedPixels, width: capture.gpu?.width, height: capture.gpu?.height, rgbaBase64: capture.gpu?.rgbaBase64 },
    };
  })()`, true);
  const rgba = Buffer.from(result.capture?.rgbaBase64 ?? "", "base64");
  delete result.capture?.rgbaBase64;
  const adapterName = String(result.adapter ?? result.directDevice?.vendor ?? "").toLowerCase();
  const passed = Boolean(result.ok) && result.bootResult === 0 && result.droppedPackets === 0
    && adapterName.includes("apple") && (!direct || (result.presented ?? 0) > 0)
    && result.shutdown?.stoppedCleanly === true && (result.shutdown?.liveThreadNames ?? []).length === 0;
  const evidence = {
    capturedAt: new Date().toISOString(),
    transport: "usbmuxd / ios-webkit-debug-proxy / WebKit Inspector Protocol (navigation and evaluation only)",
    origin: origin.href,
    device: { name: device.deviceName, osVersion: device.deviceOSVersion },
    fixture: fixtureName,
    prerequisites,
    elapsedMs: Date.now() - startedAt,
    passed,
    result,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  if (rgba.length === (result.capture?.width ?? 0) * (result.capture?.height ?? 0) * 4) {
    const frame = new PNG({ width: result.capture.width, height: result.capture.height });
    if (rgba) frame.data.set(rgba);
    await writeFile(path.join(outputDirectory, "frame.png"), PNG.sync.write(frame));
  }
  process.stdout.write(`${JSON.stringify({ ...evidence, result: { ...evidence.result, shutdown: evidence.result.shutdown && { ...evidence.result.shutdown, stackReport: undefined } } }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  connection.close();
}
