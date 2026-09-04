// Screenshots whatever the attached device is showing, and reports what the page thinks it is doing.
//   node scripts/capture-device-screen.mjs <out.png> [width] [height]
import { writeFile } from "node:fs/promises";
import { PNG } from "pngjs";

const outputPath = process.argv[2] || "device-screen.png";
const width = Number(process.argv[3] || 900);
const height = Number(process.argv[4] || 620);
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (url) => (await fetch(url)).json();

const devices = await readJson(discoveryURL);
if (devices.length !== 1) throw new Error(`expected one attached device, found ${devices.length}`);
const pages = await readJson(`http://${devices[0].url}/json`);
const page = pages.find((candidate) => candidate.url.includes("play.html"))
  ?? pages.find((candidate) => candidate.title !== "ServiceWorker" && !candidate.url.startsWith("safari-web-extension:"));
if (!page) throw new Error("no inspectable page");

const socket = new WebSocket(page.webSocketDebuggerUrl);
let targetId;
let inner = 0;
let outer = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Target.targetCreated") {
    const info = message.params.targetInfo;
    if (!targetId && info.type === "page" && !info.isProvisional) targetId = info.targetId;
  }
  if (message.method !== "Target.dispatchMessageFromTarget") return;
  const reply = JSON.parse(message.params.message);
  const waiter = pending.get(reply.id);
  if (!waiter) return;
  pending.delete(reply.id);
  waiter(reply.result);
});
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
const deadline = Date.now() + 15_000;
while (!targetId && Date.now() < deadline) await delay(25);
if (!targetId) throw new Error("WebKit did not announce a page target");

const command = (method, params = {}) => {
  const id = ++inner;
  socket.send(JSON.stringify({
    id: ++outer,
    method: "Target.sendMessageToTarget",
    params: { targetId, message: JSON.stringify({ id, method, params }) },
  }));
  return new Promise((resolve) => pending.set(id, resolve));
};
const evaluate = async (expression) =>
  (await command("Runtime.evaluate", { expression, returnByValue: true })).result.value;

console.log(`device: ${devices[0].deviceName} (iPadOS ${devices[0].deviceOSVersion})`);
console.log(`page:   ${page.url.slice(0, 110)}`);
console.log(`status: ${await evaluate("JSON.stringify(window.__rpcs3Playable?.status() ?? null)")}`);
console.log(`pads:   ${await evaluate('JSON.stringify((navigator.getGamepads?.()??[]).filter(Boolean).map((p) => `${p.id} / ${p.mapping}`))')}`);
console.log(`on-screen pad hidden: ${await evaluate('document.body.classList.contains("has-gamepad")')}`);

const snapshot = await command("Page.snapshotRect", { x: 0, y: 0, width, height, coordinateSystem: "Viewport" });
const dataURL = snapshot.dataURL || "";
const bytes = Buffer.from(dataURL.slice(dataURL.indexOf(",") + 1), "base64");
await writeFile(outputPath, bytes);
const png = PNG.sync.read(bytes);
let lit = 0;
for (let i = 0; i < png.data.length; i += 4) {
  if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 60) lit++;
}
console.log(`screenshot ${png.width}x${png.height}: ${lit} lit pixels -> ${outputPath}`);
process.exit(0);
