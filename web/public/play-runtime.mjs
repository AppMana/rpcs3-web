import { readGamepad, samePadState } from "./rpcs3-gamepad.mjs";
import { supportsSuspending } from "./rpcs3-suspending.mjs";
import { importFromLibrary, listOPFS } from "./rpcs3-storage.mjs";

const Digital1 = Object.freeze({ select: 0x01, start: 0x08, up: 0x10, right: 0x20, down: 0x40, left: 0x80 });
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
let suspending = false;
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
  const sticks = { leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
  keys.forEach((code) => {
    const deflection = keySticks.get(code);
    if (deflection) sticks[deflection[0]] = deflection[1];
  });
  const gamepad = readGamepad();
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
    // What the backend did with the draws it was given: a draw it skipped or could not translate is
    // geometry that is simply absent from the frame
    backend: frame.directStats,
    // Table entries the runtime tiers have taken, and what a compiler worker's heap reached
    ppuJit: frame.ppuJitReport && {
      registered: frame.ppuJitReport.registered,
      pending: frame.ppuJitReport.pending,
      refused: frame.ppuJitReport.refused,
      dispatches: frame.ppuJitReport.dispatches,
      bytes: frame.ppuJitReport.bytes,
    },
    spuLlvm: frame.spuLlvm && {
      compiled: frame.spuLlvm.compiled,
      peakHeapBytes: frame.spuLlvm.peakHeapBytes,
    },
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

async function prepareStorage() {
  const entries = await listOPFS(20_000).catch(() => []);
  const has = (prefix) => entries.some((entry) => entry.path.startsWith(prefix));

  if (has("rpcs3/dev_flash/sys/external")) return;
  if (!has("firmware/PS3UPDAT.PUP")) {
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
  // With a suspending core the RSX thread yields between flips, so it can render into the displayed
  // canvas itself and the frame never crosses back to this page. Without one it renders into a
  // canvas of its own and hands each frame over as an ImageBitmap, which this page displays.
  suspending = await supportsSuspending();
  // Render at the size the canvas is actually displayed at. A backing store smaller than the display
  // is upscaled, and a thin outline that falls between samples disappears rather than blurring.
  const bounds = canvas.getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 1920 / Math.max(1, bounds.width), 1080 / Math.max(1, bounds.height));
  canvas.width = Math.max(768, Math.round(bounds.width * scale));
  canvas.height = Math.max(432, Math.round(bounds.height * scale));
  const directCanvas = suspending
    ? canvas.transferControlToOffscreen()
    : new OffscreenCanvas(canvas.width, canvas.height);
  if (!suspending) directView = canvas.getContext("bitmaprenderer");
  worker = new Worker("./runtime-smoke-worker.mjs", { type: "module" });
  worker.addEventListener("message", (event) => {
    if (stopped) return;
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
    // The core has to match the canvas: only a suspending one lets the RSX thread yield, which is
    // what a transferred canvas needs before it will present.
    coreUrl: suspending ? "./core/jspi/rpcs3-web.mjs" : undefined,
    suspending,
    // The flip packet is what marks a frame; discardPackets drops the per-draw payloads with it
    returnPackets: true,
    discardPackets: true,
    presentLatestOnly: true,
    // A session is open-ended, so a frame waits as long as the runtime will allow
    packetTimeoutMs: 300_000,
    recordInputs: true,
    inputTrace,
    pad: controlState(),
    // Every tier the port has, on. A guest block starts interpreted; the PPU tier and the SPU
    // tiers compile it while the game runs, and a bundle built from an earlier profiled run
    // supplies the blocks that run before either tier can reach them. Without these a commercial
    // title is interpreted from end to end.
    ppuJit: true,
    // asmjit and llvm both add the SPU->wasm recompiler at dispatch misses; llvm adds RPCS3's own
    // LLVM SPU recompiler in the compiler workers on top of it (spu_thread::init_spu_decoder).
    spuDecoder: search.get("spuDecoder") ?? "llvm",
    spuLlvmWorkers: Number(search.get("spuLlvmWorkers")) || 2,
    ...(await bundlesFor(bootPath, search)),
    clockScale: Number(search.get("clockScale")) || undefined,
  }, [directCanvas]);
}

// A bundle is built from one disc image's code, so it is only valid for that image. local-aot's
// index says which is which; the page uses it rather than being told, and a run with no bundle for
// the title being booted simply starts with the compiling tiers alone.
async function bundlesFor(path, search) {
  const ppuAot = search.get("ppuAot");
  const spuAot = search.get("spuAot");
  if (ppuAot || spuAot) return { ppuAotBundle: ppuAot ?? undefined, spuAotBundle: spuAot ?? undefined };
  if (!path) return {};
  const index = await fetch("local-aot/index.json").then((response) => (response.ok ? response.json() : null)).catch(() => null);
  const entry = index?.titles?.find((title) => title.disc === path);
  if (!entry) return {};
  return { ppuAotBundle: entry.ppu ?? undefined, spuAotBundle: entry.spu ?? undefined };
}

function stop() {
  stopped = true;
  worker?.postMessage({ type: "shutdown" });
  worker = undefined;
  currentStatus = { ...currentStatus, state: "stopped" };
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
