import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";

const outputDirectory = path.resolve(process.argv[2] || "device-runtime-evidence");
const fixtureName = process.argv[3] || "gs_gcm_cube.elf";
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 180_000);
const chunkBytes = 128 * 1024;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
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
      const awaited = await this.command("Runtime.awaitPromise", {
        promiseObjectId: result.objectId,
        returnByValue: true,
      });
      if (awaited.wasThrown) throw new Error(awaited.result.description || "Promise rejected");
      result = awaited.result;
    }
    return result.value;
  }

  close() {
    this.socket.close();
  }
}

async function discoverPage() {
  const devices = await readJson(discoveryURL);
  if (devices.length !== 1) throw new Error(`Expected one attached device, found ${devices.length}`);
  const device = devices[0];
  const pages = await readJson(`http://${device.url}/json`);
  const page = pages.find((candidate) => candidate.title !== "ServiceWorker"
    && !candidate.url.startsWith("safari-web-extension:")
    && candidate.url.startsWith("https://"));
  if (!page) throw new Error("Open an HTTPS page in Mobile Safari and enable Web Inspector");
  return { device, page };
}

async function upload(connection, name, bytes, mimeType) {
  const base64 = bytes.toString("base64");
  await connection.evaluate(`globalThis.__rpcs3DeviceUpload[${JSON.stringify(name)}] = { mimeType: ${JSON.stringify(mimeType)}, parts: [] }`);
  for (let offset = 0; offset < base64.length; offset += chunkBytes) {
    const chunk = base64.slice(offset, offset + chunkBytes);
    await connection.evaluate(`globalThis.__rpcs3DeviceUpload[${JSON.stringify(name)}].parts.push(${JSON.stringify(chunk)})`);
  }
  process.stdout.write(`uploaded ${name}: ${bytes.byteLength} bytes\n`);
}

const root = path.resolve(import.meta.dirname, "..");
const source = async (relative) => readFile(path.join(root, "public", relative));
let coreSource = (await source("core/rpcs3-web.mjs")).toString("utf8");
const pthreadConstructor = 'new Worker(new URL("rpcs3-web.mjs", import.meta.url), {';
if (!coreSource.includes(pthreadConstructor)) throw new Error("Emscripten pthread worker constructor changed");
coreSource = coreSource.replace(pthreadConstructor, "new Worker(import.meta.url, {");

let rendererSource = (await source("rpcs3-webgpu-renderer.mjs")).toString("utf8");
rendererSource = rendererSource.replace('"./rpcs3-webgpu-packet.mjs"', '"__DEVICE_PACKET_URL__"');
if (!rendererSource.includes("__DEVICE_PACKET_URL__")) throw new Error("renderer packet import changed");

let workerSource = (await source("runtime-smoke-worker.mjs")).toString("utf8");
workerSource = workerSource
  .replace('"./rpcs3-webgpu-packet.mjs"', '"__DEVICE_PACKET_URL__"')
  .replace('await import("./core/rpcs3-web.mjs")', "await import(event.data.coreUrl)")
  .replace('new URL(`./core/${name}`, scope.location.href).href', "event.data.wasmUrl")
  .replace('new URL(`./${event.data.fixture}`, scope.location.href)', "event.data.fixtureUrl");
for (const marker of ["__DEVICE_PACKET_URL__", "event.data.coreUrl", "event.data.wasmUrl", "event.data.fixtureUrl"]) {
  if (!workerSource.includes(marker)) throw new Error(`worker rewrite failed for ${marker}`);
}

let { device, page } = await discoverPage();
let connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
const originalPageUrl = page.url;
if (process.env.RPCS3_DEVICE_HARD_RESET === "1") {
  // A cross-origin round trip forces WebKit to discard orphaned workers from
  // older harness versions that had no cooperative pthread shutdown command.
  await connection.evaluate(`location.assign("https://example.com/?rpcs3-reset=${Date.now()}")`);
  connection.close();
  await delay(4_000);
  ({ device, page } = await discoverPage());
  connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
  await connection.evaluate(`location.assign(${JSON.stringify(originalPageUrl)})`);
  connection.close();
  await delay(5_000);
  ({ device, page } = await discoverPage());
  connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
}
if (await connection.evaluate("Boolean(globalThis.__rpcs3DeviceWorker || globalThis.__rpcs3FullDeviceResult)")) {
  await connection.evaluate(`new Promise((resolve) => {
    const worker = globalThis.__rpcs3DeviceWorker;
    if (!worker) { resolve(false); return; }
    const timer = setTimeout(() => resolve(false), 5_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.type !== "runtime-shutdown") return;
      clearTimeout(timer);
      resolve(Boolean(event.data.ok));
    }, { once: true });
    worker.postMessage({ type: "shutdown" });
  })`, true);
  // WebKit may retain a large SharedArrayBuffer after a same-origin reload
  // even when every pthread acknowledged shutdown. A cross-origin process
  // swap reliably releases the 512 MiB Wasm reservation before reinjection.
  await connection.evaluate(`location.assign("https://example.com/?rpcs3-reset=${Date.now()}")`);
  connection.close();
  await delay(4_000);
  ({ device, page } = await discoverPage());
  connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
  await connection.evaluate(`location.assign(${JSON.stringify(originalPageUrl)})`);
  connection.close();
  await delay(5_000);
  ({ device, page } = await discoverPage());
  connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
}
try {
  const prerequisites = await connection.evaluate(`JSON.stringify({
    secureContext: isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    webGpu: Boolean(navigator.gpu),
    userAgent: navigator.userAgent,
    url: location.href
  })`);
  const parsedPrerequisites = JSON.parse(prerequisites);
  if (!parsedPrerequisites.secureContext || !parsedPrerequisites.crossOriginIsolated
    || !parsedPrerequisites.sharedArrayBuffer || !parsedPrerequisites.webGpu) {
    throw new Error(`Safari page lacks runtime prerequisites: ${prerequisites}`);
  }

  await connection.evaluate(`
    globalThis.__rpcs3DeviceUrls?.forEach((url) => URL.revokeObjectURL(url));
    globalThis.__rpcs3DeviceWorker?.terminate();
    globalThis.__rpcs3DeviceUpload = Object.create(null);
    globalThis.__rpcs3DeviceUrls = [];
  `);
  await upload(connection, "packet", await source("rpcs3-webgpu-packet.mjs"), "text/javascript");
  await upload(connection, "renderer", Buffer.from(rendererSource), "text/javascript");
  await upload(connection, "worker", Buffer.from(workerSource), "text/javascript");
  await upload(connection, "core", Buffer.from(coreSource), "text/javascript");
  await upload(connection, "wasm", await source("core/rpcs3-web.wasm"), "application/wasm");
  await upload(connection, "fixture", await source(`fixtures/${fixtureName}`), "application/octet-stream");

  const result = await connection.evaluate(`(async () => {
    const decode = (parts) => {
      const chunks = parts.map((part) => Uint8Array.from(atob(part), (character) => character.charCodeAt(0)));
      const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      return result;
    };
    const text = (name) => new TextDecoder().decode(decode(globalThis.__rpcs3DeviceUpload[name].parts));
    const blob = (parts, type) => {
      const url = URL.createObjectURL(new Blob(parts, { type }));
      globalThis.__rpcs3DeviceUrls.push(url);
      return url;
    };
    const packetUrl = blob([decode(globalThis.__rpcs3DeviceUpload.packet.parts)], "text/javascript");
    const rendererUrl = blob([text("renderer").replaceAll("__DEVICE_PACKET_URL__", packetUrl)], "text/javascript");
    const coreUrl = blob([decode(globalThis.__rpcs3DeviceUpload.core.parts)], "text/javascript");
    const wasmUrl = blob([decode(globalThis.__rpcs3DeviceUpload.wasm.parts)], "application/wasm");
    const fixtureUrl = blob([decode(globalThis.__rpcs3DeviceUpload.fixture.parts)], "application/octet-stream");
    const workerUrl = blob([text("worker").replaceAll("__DEVICE_PACKET_URL__", packetUrl)], "text/javascript");
    globalThis.__rpcs3DeviceUpload = undefined;

    const old = document.querySelector("#full-rpcs3-device-test");
    old?.remove();
    const panel = document.createElement("section");
    panel.id = "full-rpcs3-device-test";
    panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#202020;color:white;padding:12px;font:12px monospace;overflow:auto";
    panel.innerHTML = '<h2 style="margin:0 0 8px">Full RPCS3 Wasm → WebGPU · ${fixtureName}</h2><canvas id="full-rpcs3-device-output" width="320" height="180" style="width:min(100%,960px);image-rendering:auto"></canvas><pre id="full-rpcs3-device-log">booting…</pre>';
    document.body.append(panel);
    const canvas = panel.querySelector("canvas");
    const log = panel.querySelector("pre");
    const [{ decodeDrawPacket }, renderer] = await Promise.all([import(packetUrl), import(rendererUrl)]);
    const prepared = await renderer.prepareWebGPU(canvas);
    globalThis.__rpcs3DeviceGpu = prepared;

    const worker = new Worker(workerUrl, { type: "module" });
    globalThis.__rpcs3DeviceWorker = worker;
    const receiveFrame = (expectedType, captureRgba) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("full RPCS3 device runtime timed out")), ${timeoutMs});
      const onError = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || "full RPCS3 device worker failed"));
      };
      const onMessage = async (event) => {
        if (event.data?.type !== expectedType) return;
        clearTimeout(timer);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("message", onMessage);
        try {
          const { packetBuffers = [], ...runtimeResult } = event.data;
          if (!runtimeResult.ok) throw new Error(runtimeResult.detail);
          const gpu = await renderer.renderPacketsToWebGPU(
            prepared,
            packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer))),
            { captureRgba },
          );
          resolve({ ...runtimeResult, gpu });
        } catch (error) { reject(error); }
      };
      worker.addEventListener("error", onError, { once: true });
      worker.addEventListener("message", onMessage);
    });
    const firstFrame = receiveFrame("runtime-result", false);
    worker.postMessage({
        type: "boot",
        fixture: "fixtures/${fixtureName}",
        fixtureUrl,
        coreUrl,
        wasmUrl,
        returnPackets: true,
        debugAddresses: [],
    });
    const frames = [await firstFrame];
    for (let index = 1; index < 3; index += 1) {
      const nextFrame = receiveFrame("runtime-frame", index === 2);
      worker.postMessage({ type: "next-frame" });
      frames.push(await nextFrame);
    }
    const animationFrames = frames.map((frame) => ({
      frameSequence: frame.frameSequence,
      ppuInstructions: frame.ppuInstructions,
      elapsedMs: frame.elapsedMs,
      droppedPackets: frame.droppedPackets,
      frameHash: frame.gpu.frameHash,
      timings: frame.gpu.timings,
      changedBounds: frame.gpu.changedBounds,
      cubeClipBounds: frame.gpu.drawDiagnostics[0]?.clipBounds,
    }));
    const runtime = { ...frames[0], gpu: frames.at(-1).gpu, animationFrames };
    const rgba = Uint8Array.from(atob(runtime.gpu.rgbaBase64), (character) => character.charCodeAt(0));
    const colors = new Set();
    let magentaPixels = 0;
    let textPixels = 0;
    let lightTextPixels = 0;
    for (let y = 0; y < runtime.gpu.height; y += 1) {
      for (let x = 0; x < runtime.gpu.width; x += 1) {
        const offset = (y * runtime.gpu.width + x) * 4;
        const red = rgba[offset], green = rgba[offset + 1], blue = rgba[offset + 2];
        colors.add((red << 16) | (green << 8) | blue);
        magentaPixels += red > green + 20 && blue > green + 20 && red > 80 && blue > 80 ? 1 : 0;
        if (x < 140 && y < 40 && (red !== 32 || green !== 32 || blue !== 32)) {
          textPixels += 1;
          lightTextPixels += red > 96 && green > 96 && blue > 96 ? 1 : 0;
        }
      }
    }
    runtime.rgbaBase64 = runtime.gpu.rgbaBase64;
    delete runtime.gpu.rgbaBase64;
    runtime.imageEvidence = { colors: colors.size, magentaPixels, textPixels, lightTextPixels };
    runtime.prerequisites = ${JSON.stringify(parsedPrerequisites)};
    log.textContent = JSON.stringify(runtime, null, 2);
    globalThis.__rpcs3FullDeviceResult = runtime;
    return runtime;
  })()`, true);

  const rawRgba = Buffer.from(result?.rgbaBase64 ?? "", "base64");
  delete result?.rgbaBase64;
  const passed = result?.ok
    && result.bootResult === 0
    && result.gpu?.adapter?.toLowerCase().includes("apple")
    && result.gpu?.draws === 2
    && result.gpu?.vertices === 162
    && result.gpu?.depthStates?.[0]?.comparison === "less"
    && result.gpu?.targetStates?.[1]?.blendEnabled === true
    && result.animationFrames?.length === 3
    && result.animationFrames[1]?.ppuInstructions > result.animationFrames[0]?.ppuInstructions
    && result.animationFrames[2]?.ppuInstructions > result.animationFrames[1]?.ppuInstructions
    && new Set(result.animationFrames.map((frame) => frame.frameHash)).size === result.animationFrames.length
    && new Set(result.animationFrames.map((frame) => JSON.stringify(frame.cubeClipBounds))).size === result.animationFrames.length
    && result.animationFrames.every((frame) => frame.droppedPackets === 0)
    && result.imageEvidence?.colors > 128
    && result.imageEvidence?.magentaPixels > 1_000
    && result.imageEvidence?.textPixels > 100
    && result.imageEvidence?.textPixels < 1_000
    && result.imageEvidence?.lightTextPixels > 50;
  const evidence = {
    capturedAt: new Date().toISOString(),
    transport: "usbmuxd / ios-webkit-debug-proxy / WebKit Inspector Protocol",
    injection: "local build transferred directly through WebKit Inspector; no deployment or cloud execution",
    device: { name: device.deviceName, osVersion: device.deviceOSVersion },
    fixture: fixtureName,
    passed,
    result,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  if (rawRgba.length === result.gpu?.width * result.gpu?.height * 4) {
    const frame = new PNG({ width: result.gpu.width, height: result.gpu.height });
    frame.data.set(rawRgba);
    await writeFile(path.join(outputDirectory, "frame.png"), PNG.sync.write(frame));
  }
  const viewport = JSON.parse(await connection.evaluate("JSON.stringify({ width: innerWidth, height: innerHeight })"));
  const snapshot = await connection.command("Page.snapshotRect", {
    x: 0, y: 0, width: viewport.width, height: viewport.height, coordinateSystem: "Viewport",
  });
  const image = snapshot.dataURL?.match(/^data:image\/png;base64,(.+)$/)?.[1];
  if (image) await writeFile(path.join(outputDirectory, "page.png"), Buffer.from(image, "base64"));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  connection.close();
}
