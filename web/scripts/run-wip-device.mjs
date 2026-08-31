import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const destination = new URL(process.argv[2] || "https://appmana.github.io/rpcs3-web/");
const outputDirectory = path.resolve(process.argv[3] || "device-evidence");
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 90_000);
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
  throw new Error(`No inspectable Safari page matched ${destination.href}`);
}

const initial = await findPage((page) => page.title !== "ServiceWorker" && !page.url.startsWith("safari-web-extension:"));
let connection = await new WebKitConnection(initial.page.webSocketDebuggerUrl).open();
await connection.evaluate(`location.assign(${JSON.stringify(destination.href)})`);
connection.close();

const navigated = await findPage((page) => page.url === destination.href);
connection = await new WebKitConnection(navigated.page.webSocketDebuggerUrl).open();
try {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connection.evaluate("Boolean(window.__rpcs3Web && window.__rpcs3Web.status !== 'probing')")) break;
    await delay(250);
  }
  const report = await connection.evaluate(`(async () =>
    window.__rpcs3Web.capabilities() ?? await window.__rpcs3Web.runSmokeTest())()`, true);
  while (Date.now() < deadline) {
    const ready = await connection.evaluate(`(() => {
      const status = window.__rpcs3Web?.gameStatus();
      return status?.state === "running" && (status.flips ?? 0) >= 30;
    })()`);
    if (ready) break;
    await delay(250);
  }
  const gameBeforeInput = JSON.parse(await connection.evaluate(
    "JSON.stringify(window.__rpcs3Web?.gameStatus?.() ?? { state: 'unavailable', detail: 'This deployed build does not expose gameStatus' })",
  ));
  if (gameBeforeInput.state === "running") {
    await connection.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }))`);
    const inputDeadline = Date.now() + timeoutMs;
    while (Date.now() < inputDeadline) {
      const flips = Number(await connection.evaluate("window.__rpcs3Web?.gameStatus?.()?.flips || 0"));
      if (flips >= (gameBeforeInput.flips ?? 0) + 30) break;
      await delay(250);
    }
    await connection.evaluate(`window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }))`);
  }
  const gameAfterInput = JSON.parse(await connection.evaluate(
    "JSON.stringify(window.__rpcs3Web?.gameStatus?.() ?? { state: 'unavailable', detail: 'This deployed build does not expose gameStatus' })",
  ));
  await connection.evaluate(`document.querySelector("#game-preview")?.scrollIntoView({ block: "center" })`);
  await delay(250);
  const viewport = JSON.parse(await connection.evaluate("JSON.stringify({width: innerWidth, height: innerHeight})"));
  const snapshot = await connection.command("Page.snapshotRect", {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
    coordinateSystem: "Viewport",
  });
  const image = snapshot.dataURL?.match(/^data:image\/png;base64,(.+)$/)?.[1];
  await mkdir(outputDirectory, { recursive: true });
  const evidence = {
    capturedAt: new Date().toISOString(),
    transport: "ios-webkit-debug-proxy / WebKit Inspector Protocol",
    device: { name: navigated.device.deviceName, osVersion: navigated.device.deviceOSVersion },
    url: destination.href,
    report,
    gameBeforeInput,
    gameAfterInput,
  };
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  if (image) await writeFile(path.join(outputDirectory, "page.png"), Buffer.from(image, "base64"));
  console.log(JSON.stringify(evidence, null, 2));
  const gamePassed = gameBeforeInput.state === "running"
    && (gameBeforeInput.flips ?? 0) >= 30
    && (gameBeforeInput.draws ?? 0) >= 9
    && (gameBeforeInput.vertices ?? 0) >= 36
    && (gameBeforeInput.changedPixels ?? 0) > 100
    && (gameBeforeInput.clearPixels ?? 0) > 100
    && (gameBeforeInput.expectedSamples ?? 0) >= 4
    && gameBeforeInput.matchedSamples === gameBeforeInput.expectedSamples
    && (gameAfterInput.activeCenterX ?? -Infinity) > (gameBeforeInput.activeCenterX ?? Infinity) + 0.02;
  if (!report?.coreProbe?.loaded || report.coreProbe.memoryTestMask !== 0 || report.coreProbe.ppuTestMask !== 0 || !gamePassed) process.exitCode = 1;
} finally {
  connection.close();
}
