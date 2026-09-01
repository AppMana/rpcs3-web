import { decodeDrawPacket } from "./rpcs3-webgpu-packet.mjs";
import { prepareWebGPU, renderPacketsToWebGPU, stopWebGPUPresentation } from "./rpcs3-webgpu-renderer.mjs";

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
const bootPath = new URLSearchParams(location.search).get("boot");
const keys = new Set();
const touches = new Map();
let worker;
let gpu;
let stopped = false;
let renderBusy = false;
let frameCount = 0;
let frameWindowStart = performance.now();
let frameWindowCount = 0;
let currentStatus = { state: "booting", frames: 0, fps: 0, activeCenterX: undefined };

function controlState() {
  const controls = new Set([...keys].map((code) => keyControls.get(code)).filter(Boolean));
  touches.forEach((control) => controls.add(control));
  let digital1 = 0;
  let digital2 = 0;
  controls.forEach((control) => {
    digital1 |= Digital1[control] ?? 0;
    digital2 |= Digital2[control] ?? 0;
  });
  return { digital1, digital2, leftX: 128, leftY: 128, rightX: 128, rightY: 128 };
}

function sendPad() {
  worker?.postMessage({ type: "pad", state: controlState() });
  document.querySelectorAll("[data-control]").forEach((button) => {
    const pressed = [...touches.values()].includes(button.dataset.control) ||
      [...keys].some((code) => keyControls.get(code) === button.dataset.control);
    button.classList.toggle("pressed", pressed);
  });
}

function activeCenter(drawDiagnostics) {
  if (!Array.isArray(drawDiagnostics) || drawDiagnostics.length < 9) return undefined;
  const activeBlocks = drawDiagnostics.slice(-4);
  return activeBlocks.reduce((sum, draw) => sum + (draw.clipBounds.min[0] + draw.clipBounds.max[0]) / 2, 0) / activeBlocks.length;
}

function updateStatus(frame, rendered) {
  frameCount += 1;
  frameWindowCount += 1;
  const now = performance.now();
  const elapsed = now - frameWindowStart;
  if (elapsed >= 500) {
    currentStatus.fps = frameWindowCount * 1000 / elapsed;
    frameWindowStart = now;
    frameWindowCount = 0;
  }
  const gameReady = rendered.draws >= 9;
  currentStatus = {
    state: gameReady ? "running" : "starting",
    frames: frameCount,
    fps: currentStatus.fps,
    draws: rendered.draws,
    vertices: rendered.vertices,
    activeCenterX: activeCenter(rendered.drawDiagnostics),
    ppuInstructions: frame.ppuInstructions,
    droppedPackets: frame.droppedPackets,
    adapter: rendered.adapter,
    renderMs: rendered.timings.totalMs,
    pipelineCache: rendered.pipelineCache,
  };
  statusElement.textContent = `${currentStatus.state} · ${currentStatus.fps.toFixed(1)} fps`;
  detailElement.textContent = `${rendered.draws} draws · ${rendered.vertices} vertices · ${frame.ppuInstructions.toLocaleString()} PPU instructions · ${frame.droppedPackets} dropped`;
}

async function renderFrame(message) {
  if (stopped || renderBusy) return;
  renderBusy = true;
  try {
    const packets = message.packetBuffers.map((buffer) => decodeDrawPacket(new Uint8Array(buffer)));
    const rendered = await renderPacketsToWebGPU(gpu, packets, {
      readback: false,
      vertexDiagnostics: true,
      // The guest and RSX threads continue immediately; this only keeps the
      // latest GPU frame available to the browser compositor between flips.
      replayPresentation: true,
    });
    updateStatus(message, rendered);
    worker.postMessage({ type: "next-frame" });
  } catch (error) {
    currentStatus = { ...currentStatus, state: "failed", detail: String(error) };
    statusElement.textContent = "failed";
    detailElement.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    renderBusy = false;
  }
}

async function start() {
  if (worker) return;
  stopped = false;
  gpu = await prepareWebGPU(canvas);
  worker = new Worker("./runtime-smoke-worker.mjs", { type: "module" });
  worker.addEventListener("message", (event) => {
    if (event.data?.type === "runtime-result" || event.data?.type === "runtime-frame") {
      if (!event.data.ok) {
        currentStatus = { ...currentStatus, state: "failed", detail: event.data.detail };
        statusElement.textContent = "failed";
        detailElement.textContent = event.data.detail;
        return;
      }
      void renderFrame(event.data);
    }
  });
  worker.addEventListener("error", (event) => {
    currentStatus = { ...currentStatus, state: "failed", detail: event.message };
    statusElement.textContent = "failed";
    detailElement.textContent = event.message;
  });
  worker.postMessage({
    type: "boot",
    ...(bootPath ? { path: bootPath } : { fixture: "fixtures/gs_gcm_tetris.elf" }),
    returnPackets: true,
    pad: controlState(),
  });
}

function stop() {
  stopped = true;
  stopWebGPUPresentation();
  worker?.postMessage({ type: "shutdown" });
  worker = undefined;
  gpu = undefined;
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

window.__rpcs3Playable = {
  start,
  stop,
  status: () => ({ ...currentStatus }),
  setPad: (state) => worker?.postMessage({ type: "pad", state }),
};

void start().catch((error) => {
  currentStatus = { state: "failed", detail: String(error), frames: 0, fps: 0 };
  statusElement.textContent = "failed";
  detailElement.textContent = error instanceof Error ? error.message : String(error);
});
