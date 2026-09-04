// Two capability checks on the attached device, both of which the suspending port depends on.
//
//   node scripts/probe-device-jspi.mjs [origin]
//
// 1. JSPI: WebAssembly.Suspending/promising exist and a real suspend-and-resume round trip through
//    a wasm module returns its value. A present constructor is not proof of a working implementation.
// 2. The blit JSPI enables: a worker that yields between frames, rendering through a canvas whose
//    control was transferred, presents without transferToImageBitmap. A worker that does not yield
//    is run alongside as the control, because that is the shape the RSX thread has today.
//
// The page cannot read a transferred canvas, so presentation is confirmed from a screenshot.
import { PNG } from "pngjs";

const origin = process.argv[2] || "https://rpcs3.appmana.com/";
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
};

class Connection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.targetId = undefined;
    this.inner = 0;
    this.outer = 0;
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
    const id = ++this.inner;
    this.socket.send(JSON.stringify({
      id: ++this.outer,
      method: "Target.sendMessageToTarget",
      params: { targetId: this.targetId, message: JSON.stringify({ id, method, params }) },
    }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.command("Runtime.evaluate", {
      expression, returnByValue: !awaitPromise, doNotPauseOnExceptionsAndMuteConsole: true,
    });
    if (result.wasThrown) throw new Error(result.result.description || "evaluation threw");
    if (!awaitPromise || !result.result.objectId) return result.result.value;
    const awaited = await this.command("Runtime.awaitPromise", { promiseObjectId: result.result.objectId, returnByValue: true });
    if (awaited.wasThrown) throw new Error(awaited.result.description || "promise rejected");
    return awaited.result.value;
  }
  close() { this.socket.close(); }
}

async function findPage(predicate) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const devices = await readJson(discoveryURL);
    if (devices.length !== 1) throw new Error(`expected one attached device, found ${devices.length}`);
    const pages = await readJson(`http://${devices[0].url}/json`);
    const page = pages.find(predicate);
    if (page) return { device: devices[0], page };
    await delay(250);
  }
  throw new Error("no inspectable Safari page matched");
}

// Renders solid magenta through a transferred canvas. `yields` decides whether the loop returns to
// the worker's event loop between frames, which is the only difference that matters here.
const workerSource = (yields) => `self.onmessage = async (event) => {
  const report = { yields: ${yields} };
  try {
    const canvas = event.data.canvas;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" });
    const block = new Int32Array(new SharedArrayBuffer(4));
    let distinct = 0;
    let previous = null;
    for (let frame = 0; frame < 60; frame++) {
      const texture = context.getCurrentTexture();
      if (texture !== previous) distinct++;
      previous = texture;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: texture.createView(), loadOp: "clear",
        clearValue: { r: 1, g: 0, b: 1, a: 1 }, storeOp: "store",
      }] });
      pass.end();
      device.queue.submit([encoder.finish()]);
      if (${yields}) await new Promise((resolve) => setTimeout(resolve, 8));
      else Atomics.wait(block, 0, 0, 8);
    }
    report.distinctTextures = distinct;
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error && error.stack ? error.stack : error).slice(0, 300);
  }
  self.postMessage(report);
};`;

const probe = (yields, left) => `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 180; canvas.height = 120;
  canvas.style.cssText = "position:fixed;top:0;left:${left}px;width:180px;height:120px;z-index:2147483647";
  document.body.appendChild(canvas);
  const offscreen = canvas.transferControlToOffscreen();
  const url = URL.createObjectURL(new Blob([${JSON.stringify(workerSource(yields))}], { type: "text/javascript" }));
  const worker = new Worker(url);
  const done = new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
    setTimeout(() => resolve({ ok: false, error: "worker timed out" }), 40000);
  });
  worker.postMessage({ canvas: offscreen }, [offscreen]);
  return JSON.stringify(await done);
})()`;

const jspiProbe = `(async () => {
  const out = {
    hasSuspending: typeof WebAssembly.Suspending === "function",
    hasPromising: typeof WebAssembly.promising === "function",
    // A memory section whose limits flag marks the index type as i64
    memory64: WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,5,3,1,4,1])),
  };
  if (out.hasSuspending && out.hasPromising) {
    try {
      // (module (import "e" "f" (func $f (result i32))) (func (export "g") (result i32) (call $f)))
      const bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,2,7,1,1,101,1,102,0,0,3,2,1,0,7,5,1,1,103,0,1,10,6,1,4,0,16,0,11]);
      const { instance } = await WebAssembly.instantiate(bytes, { e: { f: new WebAssembly.Suspending(async () => 42) } });
      out.roundTrip = await WebAssembly.promising(instance.exports.g)();
      out.works = out.roundTrip === 42;
    } catch (error) { out.works = false; out.error = String(error).slice(0, 200); }
  } else out.works = false;
  return JSON.stringify(out);
})()`;

// The request shape wasmfs_create_fetch_backend uses: a HEAD to size the file, then ranged reads.
// A repeated range that reports transferSize 0 was served from the browser's cache.
const rangeCacheProbe = `(async () => {
  const out = {};
  try {
    const index = await (await fetch("/library/index.json")).json();
    const file = index.files.find((entry) => entry.size > 2000000) ?? index.files[0];
    out.name = file.name;
    const url = "/library/files/" + encodeURIComponent(file.name);
    const head = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-" } });
    out.acceptRanges = head.headers.get("accept-ranges");
    out.cacheControl = head.headers.get("cache-control");
    const read = async () => {
      const response = await fetch(url, { headers: { Range: "bytes=0-1048575" } });
      return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
    };
    out.first = await read();
    out.second = await read();
    const entries = performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes(encodeURIComponent(file.name)))
      .map((entry) => entry.transferSize);
    out.transferSizes = entries;
    const secondTransfer = entries.at(-1) ?? 0;
    out.cached = out.second.bytes > 0 && secondTransfer < out.second.bytes / 10;
    out.revalidates = out.cached && secondTransfer > 0;
  } catch (error) { out.error = String(error && error.message ? error.message : error).slice(0, 200); }
  return JSON.stringify(out);
})()`;

const initial = await findPage((page) => page.title !== "ServiceWorker" && !page.url.startsWith("safari-web-extension:"));
let connection = await new Connection(initial.page.webSocketDebuggerUrl).open();
await connection.evaluate(`location.assign(${JSON.stringify(`${origin}?jspi-probe=${Date.now()}`)})`);
connection.close();
await delay(5_000);

const landed = await findPage((page) => page.url.startsWith(origin));
connection = await new Connection(landed.page.webSocketDebuggerUrl).open();
console.log(`device: ${landed.device.deviceName} (iPadOS ${landed.device.deviceOSVersion})`);
console.log(`jspi:      ${await connection.evaluate(jspiProbe, true)}`);
console.log(`ranges:    ${await connection.evaluate(rangeCacheProbe, true)}`);

// The yielding worker sits at x=0 and the non-yielding control at x=200, so one screenshot shows both
const yielding = JSON.parse(await connection.evaluate(probe(true, 0), true));
const blocking = JSON.parse(await connection.evaluate(probe(false, 200), true));
console.log(`yielding:  ${JSON.stringify(yielding)}`);
console.log(`blocking:  ${JSON.stringify(blocking)}`);

const magentaIn = async (x) => {
  const snapshot = await connection.command("Page.snapshotRect", { x, y: 0, width: 180, height: 120, coordinateSystem: "Viewport" });
  const dataURL = snapshot.dataURL || "";
  const png = PNG.sync.read(Buffer.from(dataURL.slice(dataURL.indexOf(",") + 1), "base64"));
  let magenta = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] > 200 && png.data[i + 1] < 80 && png.data[i + 2] > 200) magenta++;
  }
  return { magenta, total: png.width * png.height };
};

try {
  const shown = await magentaIn(0);
  const control = await magentaIn(200);
  const displayed = (result) => result.magenta > result.total * 0.5;
  console.log(`displayed: yielding ${displayed(shown)} (${shown.magenta}/${shown.total}), blocking ${displayed(control)} (${control.magenta}/${control.total})`);
} catch (error) {
  console.log(`screenshot unavailable: ${String(error.message).slice(0, 120)}`);
}
connection.close();
process.exit(0);
