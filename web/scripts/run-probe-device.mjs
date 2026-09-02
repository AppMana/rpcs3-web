// Drives the attached iPad's Safari page (WebKit inspector protocol through ios_webkit_debug_proxy)
// to a probe page on the hosted origin and returns window.__probeResult.
//   node scripts/run-probe-device.mjs [origin] [page] [outFile]
import { writeFile } from "node:fs/promises";
const origin = new URL(process.argv[2] || process.env.RPCS3_DEVICE_ORIGIN || "https://rpcs3.appmana.com/");
const pageName = process.argv[3] || "probe-worker-webgpu.html";
const outFile = process.argv[4] || "probe-device.json";
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 120_000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function readJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url} returned ${r.status}`); return r.json(); }
async function discover() { const devices = await readJson(discoveryURL); if (devices.length !== 1) throw new Error(`Expected one attached device, found ${devices.length}`); const device = devices[0]; return { device, pages: await readJson(`http://${device.url}/json`) }; }
class WebKitConnection {
  constructor(url) { this.socket = new WebSocket(url); this.targetId = undefined; this.innerId = 0; this.outerId = 0; this.pending = new Map(); }
  async open() {
    this.socket.addEventListener("message", (event) => this.onMessage(event));
    await new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", reject, { once: true }); });
    const deadline = Date.now() + 15_000;
    while (!this.targetId && Date.now() < deadline) await delay(25);
    if (!this.targetId) throw new Error("WebKit did not announce a page target");
    return this;
  }
  onMessage(event) {
    const message = JSON.parse(event.data);
    if (message.method === "Target.targetCreated") { const info = message.params.targetInfo; if (!this.targetId && info.type === "page" && !info.isProvisional) this.targetId = info.targetId; }
    if (message.method === "Target.didCommitProvisionalTarget" && message.params.oldTargetId === this.targetId) this.targetId = message.params.newTargetId;
    if (message.method !== "Target.dispatchMessageFromTarget") return;
    const inner = JSON.parse(message.params.message);
    const pending = this.pending.get(inner.id);
    if (!pending) return;
    this.pending.delete(inner.id); clearTimeout(pending.timer);
    if (inner.error) pending.reject(new Error(inner.error.message)); else pending.resolve(inner.result);
  }
  command(method, params = {}) {
    const innerId = ++this.innerId;
    this.socket.send(JSON.stringify({ id: ++this.outerId, method: "Target.sendMessageToTarget", params: { targetId: this.targetId, message: JSON.stringify({ id: innerId, method, params }) } }));
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(innerId); reject(new Error(`${method} timed out`)); }, timeoutMs); this.pending.set(innerId, { resolve, reject, timer }); });
  }
  async evaluate(expression) {
    const evaluation = await this.command("Runtime.evaluate", { expression, returnByValue: true, doNotPauseOnExceptionsAndMuteConsole: true });
    if (evaluation.wasThrown) throw new Error(evaluation.result.description || "Evaluation failed");
    return evaluation.result.value;
  }
  close() { this.socket.close(); }
}
async function findPage(predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const found = await discover(); const page = found.pages.find(predicate); if (page) return { device: found.device, page }; await delay(250); }
  throw new Error("No inspectable Safari page matched");
}
const url = new URL(`${pageName}?device=${Date.now()}`, origin).href;
const initial = await findPage((page) => page.title !== "ServiceWorker" && !page.url.startsWith("safari-web-extension:"));
let connection = await new WebKitConnection(initial.page.webSocketDebuggerUrl).open();
await connection.evaluate(`location.assign(${JSON.stringify(url)})`);
connection.close();
const navigated = await findPage((page) => page.url === url);
connection = await new WebKitConnection(navigated.page.webSocketDebuggerUrl).open();
const deadline = Date.now() + timeoutMs;
let result;
while (Date.now() < deadline) {
  const json = await connection.evaluate("window.__probeResult ? JSON.stringify(window.__probeResult) : ''");
  if (json) { result = JSON.parse(json); break; }
  await delay(500);
}
connection.close();
if (!result) throw new Error("probe did not report");
result.device = { name: navigated.device.deviceName, id: navigated.device.deviceId, version: navigated.device.deviceOSVersion };
await writeFile(outFile, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
