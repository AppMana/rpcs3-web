import { readGamepad, samePadState } from "./rpcs3-gamepad.mjs";

const Digital1 = Object.freeze({ select: 0x01, start: 0x08, up: 0x10, right: 0x20, down: 0x40, left: 0x80 });
const Digital2 = Object.freeze({ l2: 0x01, r2: 0x02, l1: 0x04, r1: 0x08, triangle: 0x10, circle: 0x20, cross: 0x40, square: 0x80 });
const keyControls = new Map([
  ["ArrowUp", "up"], ["ArrowRight", "right"], ["ArrowDown", "down"], ["ArrowLeft", "left"],
  ["Enter", "start"], ["ShiftLeft", "select"], ["KeyZ", "cross"], ["KeyX", "circle"],
  ["KeyA", "square"], ["KeyS", "triangle"], ["KeyQ", "l1"], ["KeyW", "r1"],
]);

const canvas = document.querySelector("#gpu-output");
const statusElement = document.querySelector("#status");
const detailElement = document.querySelector("#detail");
const search = new URLSearchParams(location.search);
const bootPath = search.get("boot");
const keys = new Set();
const touches = new Map();
// The RSX thread renders into an OffscreenCanvas and hands back one ImageBitmap per flip; this
// canvas only displays it.
const directView = canvas.getContext("bitmaprenderer");
let lastPadState;
let worker;
let stopped = false;
let frameCount = 0;
let presentedFrames = 0;
let frameWindowStart = performance.now();
let frameWindowCount = 0;
let currentStatus = { state: "booting", frames: 0, fps: 0 };

function controlState() {
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
  const gamepad = readGamepad();
  if (!gamepad) return { digital1, digital2, leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
  return {
    digital1: digital1 | gamepad.digital1,
    digital2: digital2 | gamepad.digital2,
    leftX: gamepad.leftX, leftY: gamepad.leftY, rightX: gamepad.rightX, rightY: gamepad.rightY,
  };
}

function sendPad(state = controlState()) {
  lastPadState = state;
  worker?.postMessage({ type: "pad", state });
  document.querySelectorAll("[data-control]").forEach((button) => {
    const pressed = [...touches.values()].includes(button.dataset.control) ||
      [...keys].some((code) => keyControls.get(code) === button.dataset.control);
    button.classList.toggle("pressed", pressed);
  });
}

function updateStatus(frame) {
  frameCount += 1;
  frameWindowCount += 1;
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
    droppedPackets: frame.droppedPackets,
    // Whether a title's compiled blocks are in play, which is the difference between a title
    // running and a title crawling through the interpreter
    ppuAotBlocks: frame.ppuAotTable?.blocks,
    ppuAotDispatches: frame.ppuAotTable?.dispatches,
    spuAotPrograms: frame.spuAotTable?.programs,
  };
  statusElement.textContent = `${currentStatus.state} · ${currentStatus.fps.toFixed(1)} fps`;
  detailElement.textContent = `${draws.toLocaleString()} draws · ${(frame.ppuInstructions ?? 0).toLocaleString()} PPU`
    + `${currentStatus.ppuAotBlocks ? ` · ${currentStatus.ppuAotDispatches?.toLocaleString() ?? 0} compiled dispatches` : " · interpreted"}`;
}

function fail(detail) {
  currentStatus = { ...currentStatus, state: "failed", detail };
  statusElement.textContent = "failed";
  detailElement.textContent = detail;
}

async function start() {
  if (worker) return;
  stopped = false;
  presentedFrames = 0;
  const directCanvas = new OffscreenCanvas(canvas.width, canvas.height);
  worker = new Worker("./runtime-smoke-worker.mjs", { type: "module" });
  worker.addEventListener("message", (event) => {
    if (stopped) return;
    if (event.data?.type === "runtime-present") {
      presentedFrames += 1;
      directView.transferFromImageBitmap(event.data.bitmap);
      return;
    }
    if (event.data?.type !== "runtime-result" && event.data?.type !== "runtime-frame") return;
    // A frame that took too long is not a failed session: a title can go a long time between flips
    // while it loads. Only a runtime that has actually stopped ends the run.
    if (!event.data.ok && (event.data.bootResult !== 0 || event.data.status === 0)) {
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
  let inputTrace;
  if (traceUrl) {
    const response = await fetch(traceUrl);
    if (!response.ok) throw new Error(`input trace fetch returned ${response.status}`);
    inputTrace = (await response.json()).entries;
  }
  worker.postMessage({
    type: "boot",
    ...(bootPath ? { path: bootPath } : { fixture: "fixtures/gs_gcm_tetris.elf" }),
    directRenderer: true,
    gpuCanvas: directCanvas,
    // The flip packet is what marks a frame; discardPackets drops the per-draw payloads with it
    returnPackets: true,
    discardPackets: true,
    presentLatestOnly: true,
    // A session is open-ended, so a frame waits as long as the runtime will allow
    packetTimeoutMs: 300_000,
    recordInputs: true,
    inputTrace,
    pad: controlState(),
    // Which bundle belongs to which disc image is the caller's to say
    ppuAotBundle: search.get("ppuAot") ?? undefined,
    spuAotBundle: search.get("spuAot") ?? undefined,
    spuDecoder: search.get("spuDecoder") ?? undefined,
    spuLlvmWorkers: Number(search.get("spuLlvmWorkers")) || undefined,
    clockScale: Number(search.get("clockScale")) || undefined,
  }, [directCanvas]);
}

function stop() {
  stopped = true;
  worker?.postMessage({ type: "shutdown" });
  worker = undefined;
  currentStatus = { ...currentStatus, state: "stopped" };
}

for (const type of ["keydown", "keyup"]) {
  addEventListener(type, (event) => {
    if (!keyControls.has(event.code)) return;
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
setInterval(() => {
  const gamepad = readGamepad();
  // A real controller is the better input, so the on-screen pad gets out of the picture. A pad that
  // has gone to sleep brings it back, and waking the pad takes it away again.
  document.body.classList.toggle("has-gamepad", Boolean(gamepad));
  const state = controlState();
  if (!samePadState(state, lastPadState)) sendPad(state);
}, padPollIntervalMs);

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
  status: () => ({ ...currentStatus }),
  setPad: (state) => worker?.postMessage({ type: "pad", state }),
  exportInputTrace,
};

void start().catch((error) => fail(error instanceof Error ? error.message : String(error)));
