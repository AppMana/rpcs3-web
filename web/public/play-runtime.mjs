import { readGamepad, samePadState } from "./rpcs3-gamepad.mjs";
import { runtimeOptions, presentationCanvas, requestRuntime, frameCount as guestFrames } from "./rpcs3-runtime-session.mjs";
import { existsInOPFS, importFromLibrary, listOPFS } from "./rpcs3-storage.mjs";

const Digital1 = Object.freeze({ select: 0x01, l3: 0x02, r3: 0x04, start: 0x08, up: 0x10, right: 0x20, down: 0x40, left: 0x80 });
const Digital2 = Object.freeze({ l2: 0x01, r2: 0x02, l1: 0x04, r1: 0x08, triangle: 0x10, circle: 0x20, cross: 0x40, square: 0x80 });
// RPCS3's own keyboard pad defaults (keyboard_pad_handler::init_config), so a session played here
// uses the same keys as the desktop emulator.
const keyControls = new Map([
  ["ArrowUp", "up"], ["ArrowRight", "right"], ["ArrowDown", "down"], ["ArrowLeft", "left"],
  ["Enter", "start"], ["Space", "select"], ["KeyZ", "square"], ["KeyX", "cross"],
  ["KeyC", "circle"], ["KeyV", "triangle"],
  ["KeyQ", "l1"], ["KeyR", "l2"], ["KeyF", "l3"], ["KeyE", "r1"], ["KeyT", "r2"], ["KeyG", "r3"],
]);
// The same defaults' stick keys. A title that walks on the left stick cannot be played from the
// d-pad, so without these no keyboard session is a gameplay session.
const keySticks = new Map([
  ["KeyW", ["leftY", 0]], ["KeyS", ["leftY", 255]], ["KeyA", ["leftX", 0]], ["KeyD", ["leftX", 255]],
  ["Home", ["rightY", 0]], ["End", ["rightY", 255]], ["Delete", ["rightX", 0]], ["PageDown", ["rightX", 255]],
]);

const canvas = document.querySelector("#gpu-output");
const statusElement = document.querySelector("#status");
const detailElement = document.querySelector("#detail");
const search = new URLSearchParams(location.search);
const bootPath = search.get("boot");
const keys = new Set();
const touches = new Map();
let directView;
let scratch;
let suspending = false;
let lastPadState;
let worker;
let stopped = false;
let frameCount = 0;
let presentedFrames = 0;
let frameWindowStart = performance.now();
let frameWindowCount = 0;
let currentStatus = { state: "booting", frames: 0, fps: 0 };
// Monotonic session timer: performance.now() is not affected by wall-clock adjustments, so it is
// the stable reference for "how long has the session been running" (movie streaming included).
const sessionStart = performance.now();
const benchmarkFrames = [];
const flipTimings = [];
const workerErrors = [];
let timingDrops = 0;
let observationDrops = 0;
let retainedTimingDrops = 0;
const benchmarkLimit = 120_000;
// Intro-skip: boot at a high guest clocks_scale so a commercial title's long movie/menu idle
// passes many guest frames per wall-second, then snap back to real time once the interactive
// 3D gameplay begins (sustained per-frame draws) so benchmarking only measures real rendering.
// Enabled by ?introSkip=1&introSkipScale=<percent>&introDrawsThreshold=<draws/frame>&introDrawsRun=<n>.
const introSkip = search.get("introSkip") === "1";
const introSkipScale = Number(search.get("introSkipScale")) || 600;
const introDrawsThreshold = Number(search.get("introDrawsThreshold")) || 900;
const introDrawsRun = Number(search.get("introDrawsRun")) || 30;
let introSkipDone = !introSkip;
let introSkipDraws = 0;
let introSkipHighCount = 0;
let gameplayAnchor = 0;

function controlState(gamepad = readGamepad()) {
  const controls = new Set([...keys].map((code) => keyControls.get(code)).filter(Boolean));
  touches.forEach((control) => controls.add(control));
  let digital1 = 0;
  let digital2 = 0;
  controls.forEach((control) => {
    digital1 |= Digital1[control] ?? 0;
    digital2 |= Digital2[control] ?? 0;
  });
  // A connected controller adds to the keys and touch buttons rather than replacing them, and it is
  // the only thing here that can move a stick. A controller that has gone to sleep simply stops
  // being reported, which lands here as the neutral state rather than as a stuck button or stick.
  const sticks = { leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
  keys.forEach((code) => {
    const deflection = keySticks.get(code);
    if (deflection) sticks[deflection[0]] = deflection[1];
  });
  if (!gamepad) return { digital1, digital2, ...sticks };
  // A stick the keyboard is not deflecting stays at the controller's value, and the other way
  // round, so neither input source pins the other to centre.
  const axis = (name) => (sticks[name] === 128 ? gamepad[name] : sticks[name]);
  return {
    digital1: digital1 | gamepad.digital1,
    digital2: digital2 | gamepad.digital2,
    leftX: axis("leftX"), leftY: axis("leftY"), rightX: axis("rightX"), rightY: axis("rightY"),
  };
}

function sendPad(state = controlState()) {
  if (search.has("trace")) return; // Scheduled guest-frame replay owns the controller.
  lastPadState = state;
  worker?.postMessage({ type: "pad", state });
  document.querySelectorAll("[data-control]").forEach((button) => {
    const pressed = [...touches.values()].includes(button.dataset.control) ||
      [...keys].some((code) => keyControls.get(code) === button.dataset.control);
    button.classList.toggle("pressed", pressed);
  });
}

function updateStatus(frame) {
  const count = guestFrames(frame);
  frameWindowCount += Math.max(0, count - frameCount);
  frameCount = count;
  if (!introSkipDone) {
    const drew = frame.directStats?.draws ?? 0;
    const pd = drew - introSkipDraws;
    introSkipDraws = drew;
    if (pd > introDrawsThreshold) {
      introSkipHighCount += 1;
      if (introSkipHighCount >= introDrawsRun) {
        introSkipDone = true;
        gameplayAnchor = count;
        detailElement.textContent = `gameplay at guest-frame ${count} (dpf=${Math.round(pd)}/${introDrawsRun}); snapping clocks_scale to 100`;
        worker.postMessage({ type: "set-clock-scale", percent: 100 });
        // Restart the FPS window at the gameplay anchor so the movie is excluded from timing.
        frameWindowStart = performance.now();
        frameWindowCount = 0;
      }
    } else if (pd > 0) {
      introSkipHighCount = 0;
    }
  }
  if (search.has("benchmark") && benchmarkFrames.length >= benchmarkLimit) observationDrops++;
  if (search.has("benchmark") && benchmarkFrames.length < benchmarkLimit) benchmarkFrames.push({
    emuFlipId: count, sampleSequence: frame.frameSequence,
    hostTimeMs: frame.hostTimeMs, elapsedMs: frame.elapsedMs,
    bindGroupCache: frame.directGpu?.bindGroupCache,
    presentationYield: frame.directGpu?.presentationYield,
    presented: presentedFrames, directStats: frame.directStats, dispatchProfile: frame.dispatchProfile,
    debugWords: frame.debugWords,
    // Preserve execution-tier counts already supplied by the worker. Program
    // compilation counts alone do not show which tier actually runs the game.
    spuDispatches: frame.spuAotTable?.dispatches,
    spuHotDispatches: frame.spuHotReport?.dispatches,
    spuLlvmDispatches: frame.spuHotReport?.llvm?.dispatches,
    // Retain cumulative compilation counters at the same guest-frame boundary as
    // execution counters: final totals cannot distinguish startup from hot play.
    compilation: frame.spuLlvm && {
      compileMs: frame.spuLlvm.compileMs,
      ppuInlineReads: frame.spuLlvm.policy?.ppuInlineReads,
      compilerUrl: frame.spuLlvm.policy?.moduleUrl,
      queued: frame.spuLlvm.queued,
      spuRequested: frame.spuLlvm.spu?.requested,
      spuCompiled: frame.spuLlvm.spu?.compiled,
      ppuRequested: frame.spuLlvm.ppu?.requested,
      ppuCompiled: frame.spuLlvm.ppu?.compiled,
    },
    ppuRegistered: frame.ppuJitReport?.registered,
    ppuPending: frame.ppuJitReport?.pending,
  });
  const now = performance.now();
  const elapsed = now - frameWindowStart;
  if (elapsed >= 500) {
    currentStatus.fps = frameWindowCount * 1000 / elapsed;
    frameWindowStart = now;
    frameWindowCount = 0;
  }
  const draws = frame.directStats?.draws ?? 0;
  currentStatus = {
    state: draws > 0 ? "running" : "starting",
    frames: frameCount,
    presented: presentedFrames,
    fps: currentStatus.fps,
    draws,
    ppuInstructions: frame.ppuInstructions,
    spuInstructions: frame.spuInstructions,
    ppuLastPc: frame.ppuLastPc,
    ppuLastFunction: frame.ppuLastFunction,
    traceHits: frame.traceHits,
    threads: frame.threads,
    droppedPackets: frame.droppedPackets,
    padScheduleApplied: frame.padScheduleApplied,
    // Whether a title's compiled blocks are in play, which is the difference between a title
    // running and a title crawling through the interpreter
    ppuAotBlocks: frame.ppuAotTable?.blocks,
    ppuAotDispatches: frame.ppuAotTable?.dispatches,
    spuAotPrograms: frame.spuAotTable?.programs,
    // What the backend did with the draws it was given: a draw it skipped or could not translate is
    // geometry that is simply absent from the frame
    backend: frame.directStats,
    // Table entries the runtime tiers have taken, and what a compiler worker's heap reached
    ppuJit: frame.ppuJitReport && {
      backend: frame.ppuJitReport.backend,
      failClosed: frame.ppuJitReport.failClosed,
      semanticsVersion: frame.ppuJitReport.semanticsVersion,
      registered: frame.ppuJitReport.registered,
      pending: frame.ppuJitReport.pending,
      refused: frame.ppuJitReport.refused,
      dispatches: frame.ppuJitReport.dispatches,
      bytes: frame.ppuJitReport.bytes,
    },
    spuLlvm: frame.spuLlvm && {
      compiled: frame.spuLlvm.compiled,
      peakHeapBytes: frame.spuLlvm.peakHeapBytes,
      workers: frame.spuLlvm.workers,
      queued: frame.spuLlvm.queued,
      ppu: frame.spuLlvm.ppu,
    },
  };
  statusElement.textContent = `${currentStatus.state} · ${currentStatus.fps.toFixed(1)} fps`;
  const elapsedSec = Math.max(0, performance.now() - sessionStart) / 1000;
  const elapsedMin = Math.floor(elapsedSec / 60);
  detailElement.textContent = `${draws.toLocaleString()} draws · ${(frame.ppuInstructions ?? 0).toLocaleString()} PPU`
    + `${currentStatus.ppuAotBlocks ? ` · ${currentStatus.ppuAotDispatches?.toLocaleString() ?? 0} compiled dispatches` : " · interpreted"}`
    + ` · t+${String(elapsedMin).padStart(2, "0")}:${(elapsedSec % 60).toFixed(1).padStart(4, "0")}`;
}

function fail(detail) {
  currentStatus = { ...currentStatus, state: "failed", detail };
  statusElement.textContent = "failed";
  detailElement.textContent = detail;
}

async function prepareStorage() {
  if (await existsInOPFS("rpcs3/dev_flash/sys/external/liblv2.sprx")) return;
  if (!(await existsInOPFS("firmware/PS3UPDAT.PUP"))) {
    statusElement.textContent = "fetching firmware";
    await importFromLibrary("PS3UPDAT.PUP", "firmware", {
      onProgress: ({ offset, total }) => {
        const percent = total ? Math.round((offset / total) * 100) : 0;
        detailElement.textContent = `firmware ${percent}% (${(offset / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`;
      },
    });
  }
  statusElement.textContent = "installing firmware";
  const installer = new Worker("./firmware-install-worker.mjs", { type: "module" });
  try {
    await new Promise((resolve, reject) => {
      installer.addEventListener("message", (event) => {
        if (event.data?.type !== "firmware-result") return;
        if (event.data.ok) resolve();
        else reject(new Error(event.data.detail ?? `firmware installation failed (${event.data.result})`));
      });
      installer.addEventListener("error", (event) => reject(new Error(event.message)));
      installer.postMessage({ type: "install-firmware", path: "/opfs/firmware/PS3UPDAT.PUP" });
    });
  } finally {
    installer.terminate();
  }
}

async function start() {
  if (worker) return;
  stopped = false;
  presentedFrames = 0;
  await prepareStorage();
  const localAotDisabled = search.get("localAot") === "0";
  // With a suspending core the RSX thread yields between flips, so it can render into the displayed
  // canvas itself and the frame never crosses back to this page. Without one it renders into a
  // canvas of its own and hands each frame over as an ImageBitmap, which this page displays.
  const options = await runtimeOptions(bootPath, {
    directRenderer: true, ppuJit: true, spuDecoder: search.get("spuDecoder") ?? "llvm",
    ppuBackend: search.get("ppuBackend") ?? undefined,
    ppuFailClosed: search.has("ppuFailClosed") ? search.get("ppuFailClosed") !== "0" : undefined,
    spuLlvmWorkers: Number(search.get("spuLlvmWorkers")) || undefined,
    ppuAotBundle: localAotDisabled ? null : search.get("ppuAot") ?? undefined,
    ppuBatchedDiagnostics: search.get("ppuBatchedDiagnostics") !== "0",
    spuAotBundle: localAotDisabled ? null : search.get("spuAot") ?? undefined,
    clockScale: Number(search.get("clockScale")) || (introSkip ? introSkipScale : 100),
    suspending: search.get("core") === "release" || search.get("core") === "profile" ? false : undefined,
    coreUrl: search.has("core") ? `./core/${search.get("core") === "release" ? "" : search.get("core") + "/"}rpcs3-web.mjs` : undefined,
  });
  suspending = options.suspending;
  // Render at the size the canvas is actually displayed at. A backing store smaller than the display
  // is upscaled, and a thin outline that falls between samples disappears rather than blurring.
  const bounds = canvas.getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 1920 / Math.max(1, bounds.width), 1080 / Math.max(1, bounds.height));
  canvas.width = Math.max(768, Math.round(bounds.width * scale));
  canvas.height = Math.max(432, Math.round(bounds.height * scale));
  if (search.has("benchmark")) { canvas.width = 1280; canvas.height = 720; }
  // Real-pixel capture. With a suspending core the RSX thread renders into the transferred
  // OffscreenCanvas and presents it itself, and Chromium/headless does not composite that
  // transferred worker surface into page.screenshot(), so #gpu-output stays black on this path.
  // The C++ snapshots the OffscreenCanvas via createImageBitmap at capture.frame / capture.every
  // and posts runtime-capture; the page blits each snapshot onto a scratch canvas whose PNG is
  // exposed through window.__rpcs3Playable.capturePng() for the host to write to its output dir.
  const wantsCapture = search.has("benchmark") || search.has("capture");
  const presentation = presentationCanvas(canvas, suspending && !wantsCapture);
  const directCanvas = presentation.gpuCanvas;
  directView = presentation.view;
  if (wantsCapture) {
    scratch = document.createElement("canvas");
    scratch.width = canvas.width;
    scratch.height = canvas.height;
  }
  workerErrors.length = 0;
  worker = new Worker("./runtime-smoke-worker.mjs", { type: "module" });
  worker.addEventListener("message", (event) => {
    if (stopped) return;
    if (event.data?.type === "worker-error") {
      workerErrors.push(event.data.error);
      console.error(`[rpcs3 worker error] ${event.data.error}`);
      return;
    }
    if (event.data?.type === "runtime-progress") {
      currentStatus = {
        ...currentStatus,
        frames: event.data.emuFlipId ?? currentStatus.frames,
        ppuLastPc: event.data.ppuLastPc ?? currentStatus.ppuLastPc,
        ppuLastFunction: event.data.ppuLastFunction ?? currentStatus.ppuLastFunction,
        traceHits: event.data.traceHits ?? currentStatus.traceHits,
        threads: event.data.threads || currentStatus.threads,
      };
      return;
    }
    if (event.data?.frameTimings) {
      const batch = event.data.frameTimings.frames;
      const available = Math.max(0, benchmarkLimit - flipTimings.length);
      flipTimings.push(...batch.slice(0, available));
      retainedTimingDrops += Math.max(0, batch.length - available);
      timingDrops = event.data.frameTimings.dropped;
    }
    if (event.data?.type === "runtime-capture") {
      // Preserve a real-pixel snapshot (the suspending core's transferred OffscreenCanvas is not
      // composited by Chromium/headless, so page.screenshot() of #gpu-output is otherwise black).
      if (scratch) scratch.getContext("2d", { willReadFrequently: false }).drawImage(event.data.bitmap, 0, 0);
      // Also blit the same frame onto the DOM display canvas so page.screenshot() composites real
      // pixels. drawImage copies before transferFromImageBitmap consumes the ImageBitmap.
      directView?.transferFromImageBitmap(event.data.bitmap);
      return;
    }
    if (event.data?.type === "runtime-present") {
      presentedFrames += 1;
      directView?.transferFromImageBitmap(event.data.bitmap);
      return;
    }
    if (event.data?.type === "runtime-presented") {
      presentedFrames += 1;
      return;
    }
    if (event.data?.type !== "runtime-result" && event.data?.type !== "runtime-frame") return;
    // A frame that took too long is not a failed session: a title can go a long time between flips
    // while it loads. Only a runtime that has actually stopped ends the run.
    if (!event.data.ok && (event.data.bootResult !== 0 || event.data.status === 0)) {
      if (event.data.rpcs3Log) console.error(`[rpcs3 runtime stopped]\n${event.data.rpcs3Log}`);
      fail(event.data.detail);
      return;
    }
    updateStatus(event.data);
    worker.postMessage({ type: "next-frame", discardPackets: true });
  });
  worker.addEventListener("error", (event) => fail(event.message));
  // ?trace=<url> replays a recorded input trace; inputs are always recorded
  // so a session can be exported with __rpcs3Playable.exportInputTrace().
  const traceUrl = search.get("trace");
  const trace = traceUrl ? await (async () => {
    const response = await fetch(traceUrl);
    if (!response.ok) throw new Error(`input trace fetch returned ${response.status}`);
    return response.json();
  })() : null;
  worker.postMessage({
    type: "boot",
    ...(bootPath ? { path: bootPath } : { fixture: search.get("fixture") ?? "fixtures/gs_gcm_tetris.elf" }),
    directRenderer: true,
    gpuCanvas: directCanvas,
    // The core has to match the canvas: only a suspending one lets the RSX thread yield, which is
    // what a transferred canvas needs before it will present.
    coreUrl: suspending ? "./core/jspi/rpcs3-web.mjs" : undefined,
    suspending,
    diagnostics: search.get("diagnostics") === "1",
    // The flip packet is what marks a frame; discardPackets drops the per-draw payloads with it
    returnPackets: true,
    discardPackets: true,
    presentLatestOnly: true,
    // A session is open-ended, so a frame waits as long as the runtime will allow
    packetTimeoutMs: 300_000,
    recordInputs: true,
    benchmark: search.has("benchmark"),
    spuDispatchCache: search.get("spuDispatchCache") !== "0",
    spuExecutionSlices: search.get("spuExecutionSlices") !== "0",
    ppuReturnDispatch: search.get("ppuReturnDispatch") === "1",
    ppuInlineReads: search.get("ppuInlineReads") === "1",
    bindGroupCache: search.get("bindGroupCache") !== "0",
    presentationYield: search.get("presentationYield") ?? "message",
    // Snapshot periodically in benchmark mode (or every frame when ?capture is explicit) so the
    // scratch holds a recent real rendered frame without stalling every benchmark flip.
    capture: wantsCapture ? { frame: 0, every: Number(search.get("captureEvery")) || (search.has("capture") ? 1 : 20) } : undefined,
    llvmCompilerUrl: search.get("llvmCompiler") || undefined,
    spuBlockSize: ["safe", "mega", "giga"].includes(search.get("spuBlockSize")) ? search.get("spuBlockSize") : undefined,
    spuFallbackHistogram: search.get("spuFallbackHistogram") === "1",
    spuHotThreshold: Number(search.get("spuHotThreshold")) || 0,
    ppuJit: search.has("ppuJit") ? search.get("ppuJit") === "1" : undefined,
    ppuJitThreshold: Number(search.get("ppuJitThreshold")) || 0,
    autoRecomp: search.has("autoRecomp") ? search.get("autoRecomp") === "1" : undefined,
    // The schedule is applied before guest threads start. Updating it through a
    // separate worker message can race asynchronous boot and corrupt execution.
    inputTrace: trace?.entries,
    pad: controlState(),
    autoStartSec: Number(search.get("autoStartSec")) || 0,
    autoStartUntilFrame: Number(search.get("autoStartUntilFrame")) || undefined,
    autoStartIntervalFrames: Number(search.get("autoStartIntervalFrames")) || undefined,
    debugAddresses: (search.get("debugAddresses") || "").split(",").filter(Boolean).map((value) => Number(value)),
    tracePc: Number(search.get("tracePc")) || 0,
    traceDelayPc: Number(search.get("traceDelayPc")) || 0,
    traceDelayMs: Number(search.get("traceDelayMs")) || 0,
    watchAddress: Number(search.get("watchAddress")) || 0,
    // Every tier the port has, on. A guest block starts interpreted; the PPU tier and the SPU
    // tiers compile it while the game runs, and a bundle built from an earlier profiled run
    // supplies the blocks that run before either tier can reach them. Without these a commercial
    // title is interpreted from end to end.
    ppuJit: true,
    // asmjit and llvm both add the SPU->wasm recompiler at dispatch misses; llvm adds RPCS3's own
    // LLVM SPU recompiler in the compiler workers on top of it (spu_thread::init_spu_decoder).
    spuDecoder: search.get("spuDecoder") ?? "llvm",
    spuLlvmWorkers: Number(search.get("spuLlvmWorkers")) || 2,
    ...options,
  }, [directCanvas]);
}

async function stop(options = {}) {
  stopped = true;
  const active = worker;
  if (!active) return;
  const saveState = Boolean(options?.saveState || search.get("saveState") === "1");
  const saveStatePath = options?.saveStatePath || search.get("saveStatePath") || "";
  let report;
  try {
    report = await requestRuntime(
      active,
      { type: "shutdown", saveState, saveStatePath },
      "runtime-shutdown",
      saveState ? 60_000 : 8_000,
    );
  }
  catch (error) { report = { ok: false, timedOut: true, detail: error instanceof Error ? error.message : String(error) }; }
  finally { active.terminate(); }
  worker = undefined;
  currentStatus = { ...currentStatus, state: "stopped" };
  return report;
}

for (const type of ["keydown", "keyup"]) {
  addEventListener(type, (event) => {
    if (!keyControls.has(event.code) && !keySticks.has(event.code)) return;
    event.preventDefault();
    if (type === "keydown") keys.add(event.code);
    else keys.delete(event.code);
    sendPad();
  });
}
addEventListener("blur", () => { keys.clear(); touches.clear(); sendPad(); });

// The Gamepad API has no events for button or stick state and cannot be reached from a worker, so
// the page has to read the controller. RPCS3 keeps its own cadence -- pad_thread calls
// web_pad_handler::process() every g_cfg.io.pad_sleep microseconds and reads the last state set --
// so this only has to keep that snapshot fresh. It is deliberately not tied to the frame: a title
// running at 30 fps would otherwise sample the stick 30 times a second. Posting only on a change
// keeps a held button or a resting stick off the worker's queue.
const padPollIntervalMs = 8;
if (!search.has("trace")) {
  setInterval(() => {
    const gamepad = readGamepad();
    // A real controller is the better input, so the on-screen pad gets out of the picture. A pad that
    // has gone to sleep brings it back, and waking the pad takes it away again.
    document.body.classList.toggle("has-gamepad", Boolean(gamepad));
    const state = controlState(gamepad);
    if (!samePadState(state, lastPadState)) sendPad(state);
  }, padPollIntervalMs);
}

// Safari does not report a controller until a button on it has been pressed, so this is also how a
// player finds out the pad was seen at all
addEventListener("gamepadconnected", (event) => {
  detailElement.textContent = `controller: ${event.gamepad.id} · ${event.gamepad.mapping || "non-standard"} mapping`;
});

document.querySelectorAll("[data-control]").forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touches.set(event.pointerId, button.dataset.control);
    sendPad();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(type, (event) => { touches.delete(event.pointerId); sendPad(); });
  }
});

function exportInputTrace() {
  const active = worker;
  if (!active) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onTrace = (event) => {
      if (event.data?.type !== "input-trace") return;
      active.removeEventListener("message", onTrace);
      resolve({ schema: 1, target: bootPath ?? "fixtures/gs_gcm_tetris.elf", entries: event.data.entries, flipCounter: event.data.flipCounter });
    };
    active.addEventListener("message", onTrace);
    active.postMessage({ type: "export-input-trace" });
  });
}

document.querySelector("#export-trace")?.addEventListener("click", async () => {
  const trace = await exportInputTrace();
  if (!trace) return;
  const json = JSON.stringify(trace);
  try { await navigator.clipboard.writeText(json); } catch {}
  detailElement.textContent = `input trace: ${trace.entries.length} entries through flip ${trace.flipCounter} (copied to clipboard)`;
});

window.__rpcs3Playable = {
  start,
  stop,
  status: () => ({ ...currentStatus, workerErrorCount: workerErrors.length }),
  benchmark: () => ({ schemaVersion: 2, frames: benchmarkFrames.slice(), flipTimings: flipTimings.slice(), workerErrors: workerErrors.slice(0, 100), timingDrops: timingDrops + retainedTimingDrops, observationDrops, status: { ...currentStatus } }),
  benchmarkLatest: () => ({ lastFrame: benchmarkFrames.at(-1), workerErrorCount: workerErrors.length, status: { ...currentStatus } }),
  setPad: (state) => worker?.postMessage({ type: "pad", state }),
  setClockScale: (percent) => worker?.postMessage({ type: "set-clock-scale", percent }),
  exportInputTrace,
  exportSpuChainEdges: () => worker ? requestRuntime(worker, { type: "spu-chain-edges" }, "spu-chain-edges") : Promise.resolve(undefined),
  exportSpuMisses: () => worker ? requestRuntime(worker, { type: "spu-misses" }, "spu-misses") : Promise.resolve(undefined),
  exportPpuProfile: () => worker ? requestRuntime(worker, { type: "ppu-profile" }, "ppu-profile") : Promise.resolve(undefined),
  threadSnapshot: () => worker ? requestRuntime(worker, { type: "snapshot" }, "progress") : Promise.resolve(undefined),
  // The scratch holds the most recent real rendered frame (a transferred worker OffscreenCanvas
  // is not composited by Chromium/headless, so page.screenshot() of it is black). Return it as a
  // PNG data URL for the host to write to its output directory.
  capturePng: () => scratch ? scratch.toDataURL("image/png") : undefined,
};

void start().catch((error) => fail(error instanceof Error ? error.message : String(error)));
