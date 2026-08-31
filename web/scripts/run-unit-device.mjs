import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputDirectory = path.resolve(process.argv[2] || "device-unit-evidence");
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 60_000);
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
  await connection.evaluate(`globalThis.__rpcs3UnitUpload[${JSON.stringify(name)}] = { mimeType: ${JSON.stringify(mimeType)}, parts: [] }`);
  for (let offset = 0; offset < base64.length; offset += chunkBytes) {
    const chunk = base64.slice(offset, offset + chunkBytes);
    await connection.evaluate(`globalThis.__rpcs3UnitUpload[${JSON.stringify(name)}].parts.push(${JSON.stringify(chunk)})`);
  }
  process.stdout.write(`uploaded ${name}: ${bytes.byteLength} bytes\n`);
}

const root = path.resolve(import.meta.dirname, "..");
const source = async (relative) => readFile(path.join(root, "public", relative));
const coreSource = await source("core/rpcs3-web-units.mjs");
let workerSource = (await source("unit-smoke-worker.mjs")).toString("utf8");
workerSource = workerSource.replace(
  'await import(event.data.coreUrl || "./core/rpcs3-web-units.mjs")',
  "await import(event.data.coreUrl)",
);
if (!workerSource.includes("await import(event.data.coreUrl)")) {
  throw new Error("unit worker core import rewrite failed");
}

const { device, page } = await discoverPage();
const connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
try {
  const prerequisites = JSON.parse(await connection.evaluate(`JSON.stringify({
    secureContext: isSecureContext,
    crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    wasm: typeof WebAssembly === "object",
    userAgent: navigator.userAgent,
    url: location.href
  })`));
  if (!prerequisites.secureContext || !prerequisites.crossOriginIsolated
    || !prerequisites.sharedArrayBuffer || !prerequisites.wasm) {
    throw new Error(`Safari page lacks Wasm unit prerequisites: ${JSON.stringify(prerequisites)}`);
  }

  await connection.evaluate(`
    globalThis.__rpcs3UnitDeviceWorker?.terminate();
    globalThis.__rpcs3UnitDeviceUrls?.forEach((url) => URL.revokeObjectURL(url));
    globalThis.__rpcs3UnitUpload = Object.create(null);
    globalThis.__rpcs3UnitDeviceUrls = [];
  `);
  await upload(connection, "worker", Buffer.from(workerSource), "text/javascript");
  await upload(connection, "core", coreSource, "text/javascript");
  await upload(connection, "wasm", await source("core/rpcs3-web-units.wasm"), "application/wasm");

  const result = await connection.evaluate(`(async () => {
    const decode = (parts) => {
      const chunks = parts.map((part) => Uint8Array.from(atob(part), (character) => character.charCodeAt(0)));
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    };
    const blob = (name, type) => {
      const url = URL.createObjectURL(new Blob([decode(globalThis.__rpcs3UnitUpload[name].parts)], { type }));
      globalThis.__rpcs3UnitDeviceUrls.push(url);
      return url;
    };
    const workerUrl = blob("worker", "text/javascript");
    const coreUrl = blob("core", "text/javascript");
    const wasmUrl = blob("wasm", "application/wasm");
    globalThis.__rpcs3UnitUpload = undefined;

    document.querySelector("#rpcs3-unit-device-test")?.remove();
    const panel = document.createElement("section");
    panel.id = "rpcs3-unit-device-test";
    panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#181818;color:#eee;padding:16px;font:12px monospace;overflow:auto";
    panel.innerHTML = '<h2 style="margin:0 0 8px">RPCS3 C++ units · Wasm · Mobile Safari</h2><pre>running…</pre>';
    document.body.append(panel);

    const worker = new Worker(workerUrl, { type: "module" });
    globalThis.__rpcs3UnitDeviceWorker = worker;
    const testResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("RPCS3 Wasm units timed out on Safari")), ${timeoutMs});
      worker.addEventListener("message", (event) => {
        if (event.data?.type !== "unit-result") return;
        clearTimeout(timer);
        resolve(event.data);
      });
      worker.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || "RPCS3 Wasm unit worker failed on Safari"));
      });
      worker.postMessage({ type: "run-units", coreUrl, wasmUrl });
    });
    worker.terminate();
    globalThis.__rpcs3UnitDeviceWorker = undefined;
    const fullResult = { ...testResult, prerequisites: ${JSON.stringify(prerequisites)} };
    panel.querySelector("pre").textContent = JSON.stringify(fullResult, null, 2);
    globalThis.__rpcs3UnitDeviceResult = fullResult;
    return fullResult;
  })()`, true);

  const passed = result?.ok === true
    && result.report?.target === "wasm32-emscripten"
    && result.report?.total === 114
    && result.report?.passed === 114
    && result.report?.failed === 0
    && result.report?.skipped === 0
    && result.report?.tests?.length === 114;
  const evidence = {
    capturedAt: new Date().toISOString(),
    transport: "usbmuxd / ios-webkit-debug-proxy / WebKit Inspector Protocol",
    injection: "identical local Wasm unit artifact transferred directly through WebKit Inspector",
    device: { name: device.deviceName, osVersion: device.deviceOSVersion },
    passed,
    result,
  };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const viewport = JSON.parse(await connection.evaluate("JSON.stringify({ width: innerWidth, height: innerHeight })"));
  const snapshot = await connection.command("Page.snapshotRect", {
    x: 0, y: 0, width: viewport.width, height: viewport.height, coordinateSystem: "Viewport",
  });
  const image = snapshot.dataURL?.match(/^data:image\/png;base64,(.+)$/)?.[1];
  if (image) await writeFile(path.join(outputDirectory, "page.png"), Buffer.from(image, "base64"));
  process.stdout.write(`${JSON.stringify({
    passed,
    device: evidence.device,
    total: result?.report?.total,
    passedTests: result?.report?.passed,
    failed: result?.report?.failed,
    elapsedMs: result?.report?.elapsedMs,
    report: path.join(outputDirectory, "report.json"),
    screenshot: image ? path.join(outputDirectory, "page.png") : undefined,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  connection.close();
}
