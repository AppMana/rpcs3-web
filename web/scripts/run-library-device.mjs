// Drives a same-origin library import into the iPad's OPFS from the hosted
// origin (default https://rpcs3.appmana.com) over the WebKit Inspector
// Protocol: navigates Safari to storage.html, calls
// window.__rpcs3Storage.importFromLibrary(name, destination), polls the
// progress snapshot, and saves a report with the storage estimates before and
// after, the measured rate, the resume point, and the SHA-256 verdict.
//
//   node scripts/run-library-device.mjs [origin] [outputDir] [name] [destination]
//       [--chunk-mib N] [--restart] [--verify] [--interrupt-after SECONDS]
//
// --interrupt-after reloads the page mid-transfer (as if the user had closed
// it) and then starts the same import again, which must resume from the
// bytes already stored; both phases land in the report.
//
// Requires one trusted USB device with an inspectable Safari page. Only one
// inspector client may be attached to a Safari page at a time.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const positional = [];
const flags = { chunkMiB: undefined, restart: false, verify: false, interruptAfter: undefined };
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === "--chunk-mib") flags.chunkMiB = Number(process.argv[++i]);
  else if (argument === "--restart") flags.restart = true;
  else if (argument === "--verify") flags.verify = true;
  else if (argument === "--interrupt-after") flags.interruptAfter = Number(process.argv[++i]);
  else positional.push(argument);
}
const origin = new URL(positional[0] || process.env.RPCS3_DEVICE_ORIGIN || "https://rpcs3.appmana.com/");
const outputDirectory = path.resolve(positional[1] || "device-library-evidence");
const fileName = positional[2] || "PS3UPDAT.PUP";
const destination = positional[3] || (/\.pup$/i.test(fileName) ? "firmware" : "games");
const discoveryURL = process.env.WIP_DISCOVERY_URL || "http://127.0.0.1:9221/json";
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 180_000);
const pollMs = Number(process.env.RPCS3_LIBRARY_POLL_MS || 1000);
// The import runs in the page's worker independently of the inspector, so a
// poll that Safari fails to answer is retried over a fresh connection rather
// than abandoning a transfer that is still running.
const pollTimeoutMs = Number(process.env.RPCS3_LIBRARY_POLL_TIMEOUT_MS || 30_000);
const maxReconnects = Number(process.env.RPCS3_LIBRARY_MAX_RECONNECTS || 20);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const formatBytes = (value) => {
  const units = ["B", "KiB", "MiB", "GiB"];
  let unit = 0;
  let bytes = Number(value) || 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${bytes.toFixed(unit ? 2 : 0)} ${units[unit]}`;
};

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

  command(method, params = {}, commandTimeoutMs = timeoutMs) {
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
      }, commandTimeoutMs);
      this.pending.set(innerId, { resolve, reject, timer });
    });
  }

  async evaluate(expression, awaitPromise = false, commandTimeoutMs = timeoutMs) {
    const evaluation = await this.command("Runtime.evaluate", {
      expression,
      returnByValue: !awaitPromise,
      doNotPauseOnExceptionsAndMuteConsole: true,
    }, commandTimeoutMs);
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

async function findPage(predicate, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await discover();
    const page = found.pages.find(predicate);
    if (page) return { device: found.device, page };
    await delay(250);
  }
  throw new Error(`No inspectable Safari page matched ${description}`);
}

async function attachTo(url) {
  const navigated = await findPage((page) => page.url === url, url);
  const connection = await new WebKitConnection(navigated.page.webSocketDebuggerUrl).open();
  return { connection, device: navigated.device };
}

async function navigateTo(url) {
  const initial = await findPage((page) => page.title !== "ServiceWorker" && !page.url.startsWith("safari-web-extension:"), "any page");
  const bootstrap = await new WebKitConnection(initial.page.webSocketDebuggerUrl).open();
  await bootstrap.evaluate(`location.assign(${JSON.stringify(url)})`);
  bootstrap.close();
  const { connection, device: navigatedDevice } = await attachTo(url);
  const navigated = { device: navigatedDevice };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await connection.evaluate("Boolean(window.__rpcs3Storage && window.__rpcs3Storage.importFromLibrary)")) return { connection, device: navigated.device };
    await delay(250);
  }
  connection.close();
  throw new Error("storage.html did not expose __rpcs3Storage");
}

const options = {
  chunkSize: flags.chunkMiB ? Math.round(flags.chunkMiB * 1024 * 1024) : undefined,
  restart: flags.restart,
  verify: flags.verify,
};

// Starts the import on the page and polls until it finishes or `interruptAfterMs` elapses.
async function drive(session, { interruptAfterMs, restart }) {
  let { connection } = session;
  const environment = JSON.parse(await connection.evaluate(`JSON.stringify({
    secureContext: isSecureContext, crossOriginIsolated, userAgent: navigator.userAgent, url: location.href,
    syncAccessHandle: typeof FileSystemFileHandle === "function" && "createSyncAccessHandle" in FileSystemFileHandle.prototype,
    createWritable: typeof FileSystemFileHandle === "function" && "createWritable" in FileSystemFileHandle.prototype,
  })`));
  const before = JSON.parse(await connection.evaluate("window.__rpcs3Storage.status().then((s) => JSON.stringify(s))", true));
  await connection.evaluate(`(() => {
    window.__rpcs3LibraryRun = { settled: false };
    window.__rpcs3Storage.importFromLibrary(${JSON.stringify(fileName)}, ${JSON.stringify(destination)}, ${JSON.stringify({ ...options, restart })})
      .then((result) => { window.__rpcs3LibraryRun = { settled: true, ok: true, result }; },
            (error) => { window.__rpcs3LibraryRun = { settled: true, ok: false, name: error.name, message: error.message, report: error.report }; });
    return true;
  })()`);
  const startedAt = Date.now();
  let lastLine = "";
  let last;
  let reconnects = 0;
  const samples = [];
  for (;;) {
    let snapshot;
    try {
      snapshot = JSON.parse(await connection.evaluate("JSON.stringify({ run: window.__rpcs3LibraryRun, progress: window.__rpcs3Storage.importProgress() })", false, pollTimeoutMs));
    } catch (error) {
      if (++reconnects > maxReconnects) throw error;
      process.stderr.write(`poll failed (${error.message}); reconnecting to the page (${reconnects}/${maxReconnects})\n`);
      connection.close();
      await delay(2000);
      ({ connection } = await attachTo(environment.url));
      session.connection = connection;
      samples.push({ t: Date.now() - startedAt, reconnect: reconnects, error: error.message });
      continue;
    }
    const progress = snapshot.progress?.progress;
    if (progress) {
      last = progress;
      samples.push({ t: Date.now() - startedAt, offset: progress.offset, rate: progress.rateBytesPerSecond, instant: progress.instantRateBytesPerSecond });
      const line = `${progress.phase} ${formatBytes(progress.offset)} / ${formatBytes(progress.total)} ${((progress.offset / progress.total) * 100).toFixed(1)}% avg ${formatBytes(progress.rateBytesPerSecond)}/s now ${formatBytes(progress.instantRateBytesPerSecond ?? 0)}/s requests ${progress.requests}`;
      if (line !== lastLine) process.stderr.write(`${line}\n`);
      lastLine = line;
    }
    if (snapshot.run?.settled) {
      const after = JSON.parse(await connection.evaluate("window.__rpcs3Storage.status().then((s) => JSON.stringify(s))", true));
      return { environment, before, after, run: snapshot.run, lastProgress: last, samples, elapsedMs: Date.now() - startedAt, interrupted: false };
    }
    if (interruptAfterMs !== undefined && Date.now() - startedAt >= interruptAfterMs && progress?.phase === "downloading") {
      process.stderr.write(`interrupting at ${formatBytes(progress.offset)} by reloading the page\n`);
      await connection.evaluate("location.reload()").catch(() => {});
      return { environment, before, run: undefined, lastProgress: last, samples, elapsedMs: Date.now() - startedAt, interrupted: true };
    }
    await delay(pollMs);
  }
}

const pageUrl = new URL(`storage.html?device=${Date.now()}`, origin).href;
const session = await navigateTo(pageUrl);
let { device } = session;
const phases = [];
try {
  const first = await drive(session, { interruptAfterMs: flags.interruptAfter ? flags.interruptAfter * 1000 : undefined, restart: flags.restart });
  phases.push(first);
  if (first.interrupted) {
    session.connection.close();
    await delay(1500);
    const resumeUrl = new URL(`storage.html?device=${Date.now()}`, origin).href;
    Object.assign(session, await navigateTo(resumeUrl));
    ({ device } = session);
    phases.push(await drive(session, { restart: false }));
  }
} finally {
  session.connection.close();
}

const final = phases.at(-1);
const result = final.run?.ok ? final.run.result : undefined;
const passed = Boolean(result?.verified) && (!phases[0].interrupted || (result.resumedFrom > 0 && !result.restarted));
const evidence = {
  capturedAt: new Date().toISOString(),
  transport: "usbmuxd / ios-webkit-debug-proxy / WebKit Inspector Protocol (navigation and evaluation only)",
  origin: origin.href,
  device: { name: device.deviceName, osVersion: device.deviceOSVersion },
  file: fileName,
  destination,
  options: { ...options, interruptAfterSeconds: flags.interruptAfter },
  passed,
  phases: phases.map((phase) => ({
    environment: phase.environment,
    estimateBefore: phase.before,
    estimateAfter: phase.after,
    interrupted: phase.interrupted,
    elapsedMs: phase.elapsedMs,
    lastProgress: phase.lastProgress,
    run: phase.run,
    samples: phase.samples,
  })),
  summary: result && {
    size: result.size,
    sessionBytes: result.sessionBytes,
    resumedFrom: result.resumedFrom,
    restarted: result.restarted,
    requests: result.requests,
    chunkSize: result.chunkSize,
    elapsedMs: result.elapsedMs,
    rateBytesPerSecond: result.rateBytesPerSecond,
    rate: `${formatBytes(result.rateBytesPerSecond)}/s`,
    verified: result.verified,
    sha256: result.sha256,
    hashImplementation: result.hashImplementation,
    mountedPath: result.mountedPath,
    bootPath: result.bootPath,
    estimateBefore: result.estimateBefore,
    estimateAfter: result.estimateAfter,
    persistGranted: result.persistGranted,
  },
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...evidence, phases: evidence.phases.map((phase) => ({ ...phase, samples: `${phase.samples.length} samples` })) }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
