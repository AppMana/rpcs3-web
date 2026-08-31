import "./style.css";
import { collectCapabilities } from "./probe";
import type { CapabilityReport, CheckResult, GameStatus, Rpcs3WebApi } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
let lastReport: CapabilityReport | undefined;
let status: Rpcs3WebApi["status"] = "idle";
let activeRun: Promise<CapabilityReport> | undefined;
let gameWorker: Worker | undefined;
let gameStatus: GameStatus = { state: "idle" };
let gameStart: Promise<GameStatus> | undefined;
let touchDigital1 = 0;
let touchDigital2 = 0;
let previewUrl: string | undefined;

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}

function row(label: string, result: CheckResult): string {
  return `<div class="check"><span>${escapeHtml(label)}</span><strong class="${result.state}">${result.state}</strong><small>${escapeHtml(result.detail)}</small></div>`;
}

function baseMarkup(): string {
  return `
    <header>
      <p class="eyebrow">RPCS3 · Wasm · WebGPU · Mobile Safari</p>
      <h1>PS3 homebrew in Safari</h1>
      <p class="lede">This runs a real PS3 SDK homebrew ELF locally, interprets its PPU code, captures its RSX/GCM FIFO, and translates the first guest draw to WebGPU.</p>
      <button id="run-probe">Run PS3 homebrew</button>
    </header>
    <main>
      <section class="visual">
        <canvas id="gpu-canvas" width="768" height="432" aria-label="Worker WebGPU output"></canvas>
        <div><span>Guest PPU → GCM → WebGPU</span><strong id="visual-state">waiting</strong></div>
      </section>
      <section class="game">
        <div class="game-heading">
          <div><span>Unmodified PS3 homebrew</span><strong>Tetris · live PPU/GCM session</strong></div>
          <button id="start-tetris">Start / restart</button>
        </div>
        <div class="game-screen">
          <canvas id="game-canvas" width="768" height="432" aria-label="Live PS3 Tetris WebGPU output"></canvas>
          <img id="game-preview" alt="Live PNG read back from the WebGPU Tetris texture" />
        </div>
        <div class="game-status"><span id="game-state">waiting</span><small id="game-detail">Tetris starts automatically after the capability probe.</small></div>
        <div class="controls" aria-label="PS3 pad controls">
          <div class="dpad">
            <button data-digital1="16" aria-label="Up">▲</button>
            <button data-digital1="128" aria-label="Left">◀</button>
            <button data-digital1="64" aria-label="Down">▼</button>
            <button data-digital1="32" aria-label="Right">▶</button>
          </div>
          <button data-digital1="8" class="start" aria-label="Start">START</button>
          <button data-digital2="64" class="cross" aria-label="Cross / rotate">×</button>
        </div>
      </section>
      <section id="summary" class="summary"><p>Run the probe to collect evidence from this browser.</p></section>
      <details><summary>Evidence JSON</summary><pre id="evidence">No evidence yet.</pre></details>
    </main>
    <footer>No cloud streaming and no prerecorded frame. Geometry and colors come from the connected homebrew ELF executing on this device.</footer>
  `;
}

function renderGameStatus(value: GameStatus): void {
  gameStatus = value;
  const state = document.querySelector<HTMLElement>("#game-state");
  const detail = document.querySelector<HTMLElement>("#game-detail");
  if (state) state.textContent = value.state;
  if (detail) detail.textContent = value.detail ?? (value.state === "running"
    ? `${value.instructions ?? 0} PPU instructions · ${value.flips ?? 0} flips · ${value.draws ?? 0} RSX draws · ${value.vertices ?? 0} vertices · ${value.changedPixels ?? 0} changed pixels · ${value.format ?? "WebGPU"}${value.adapter ? ` · ${value.adapter}` : ""}`
    : "");
}

function sendPad(): void {
  if (!gameWorker) return;
  let digital1 = touchDigital1;
  let digital2 = touchDigital2;
  const pad = navigator.getGamepads?.()[0];
  if (pad) {
    if (pad.buttons[12]?.pressed || (pad.axes[1] ?? 0) < -0.5) digital1 |= 0x10;
    if (pad.buttons[13]?.pressed || (pad.axes[1] ?? 0) > 0.5) digital1 |= 0x40;
    if (pad.buttons[14]?.pressed || (pad.axes[0] ?? 0) < -0.5) digital1 |= 0x80;
    if (pad.buttons[15]?.pressed || (pad.axes[0] ?? 0) > 0.5) digital1 |= 0x20;
    if (pad.buttons[9]?.pressed) digital1 |= 0x08;
    if (pad.buttons[0]?.pressed) digital2 |= 0x40;
  }
  gameWorker.postMessage({
    type: "pad", digital1, digital2,
    leftX: pad ? Math.round(128 + (pad.axes[0] ?? 0) * 127) : 128,
    leftY: pad ? Math.round(128 + (pad.axes[1] ?? 0) * 127) : 128,
    rightX: pad ? Math.round(128 + (pad.axes[2] ?? 0) * 127) : 128,
    rightY: pad ? Math.round(128 + (pad.axes[3] ?? 0) * 127) : 128,
  });
}

function startTetris(): Promise<GameStatus> {
  if (gameStart) return gameStart;
  if (gameWorker) gameWorker.terminate();
  const oldCanvas = document.querySelector<HTMLCanvasElement>("#game-canvas")!;
  const canvas = oldCanvas.cloneNode(false) as HTMLCanvasElement;
  oldCanvas.replaceWith(canvas);
  renderGameStatus({ state: "loading", detail: "Loading and executing gs_gcm_tetris.elf…" });
  gameWorker = new Worker(new URL("./game-worker.ts", import.meta.url), { type: "module" });
  gameStart = new Promise<GameStatus>((resolve) => {
    const timeout = window.setTimeout(() => {
      const failed: GameStatus = { state: "failed", detail: "Tetris startup timed out after 30 seconds" };
      renderGameStatus(failed);
      resolve(failed);
      gameStart = undefined;
    }, 30_000);
    gameWorker!.addEventListener("message", (event: MessageEvent<GameStatus & { type?: string; preview?: ArrayBuffer }>) => {
      if (event.data.type !== "status") return;
      const { type: _type, preview, ...next } = event.data;
      if (preview) {
        const nextUrl = URL.createObjectURL(new Blob([preview], { type: "image/png" }));
        const image = document.querySelector<HTMLImageElement>("#game-preview");
        if (image) image.src = nextUrl;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = nextUrl;
      }
      renderGameStatus(next);
      if (next.state === "running" || next.state === "failed") {
        window.clearTimeout(timeout);
        resolve(next);
        gameStart = undefined;
      }
    });
    gameWorker!.addEventListener("error", (event) => {
      const failed: GameStatus = { state: "failed", detail: event.message || "Tetris worker failed" };
      window.clearTimeout(timeout);
      renderGameStatus(failed);
      resolve(failed);
      gameStart = undefined;
    }, { once: true });
  });
  const offscreen = canvas.transferControlToOffscreen();
  gameWorker.postMessage({ type: "start", canvas: offscreen }, [offscreen]);
  sendPad();
  return gameStart;
}

function stopTetris(): void {
  gameWorker?.postMessage({ type: "stop" });
  gameWorker?.terminate();
  gameWorker = undefined;
  renderGameStatus({ state: "stopped" });
}

function renderReport(report: CapabilityReport): void {
  const worker = report.worker;
  const core = report.coreProbe;
  const checks: Array<[string, CheckResult]> = [
    ["Cross-origin isolation", report.crossOriginIsolated ? { state: "passed", detail: "window.crossOriginIsolated" } : { state: "failed", detail: "required for pthreads" }],
    ["SharedArrayBuffer", report.sharedArrayBuffer ? { state: "passed", detail: "available" } : { state: "failed", detail: "unavailable" }],
    ["Native Memory64", report.memory64 ? { state: "passed", detail: "supported" } : { state: "unsupported", detail: "software guest mapping required" }],
    ["Dedicated worker", worker.worker],
    ["Dynamic Wasm", worker.dynamicWasm],
    ["Shared Wasm memory", worker.sharedWasmMemory],
    ["Worker OPFS", worker.opfs],
    ["Worker WebGPU", worker.webGpu],
    ["Offscreen WebGPU", worker.offscreenWebGpu],
    ["PS3 homebrew → GCM → WebGPU", worker.guestHomebrew],
    ["Sparse core probe", core?.loaded
      ? { state: core.memoryTestMask === 0 ? "passed" : "failed", detail: core.detail }
      : { state: "unsupported", detail: core?.detail ?? "not built" }],
    ["PPU guest execution", core?.loaded
      ? {
          state: core.ppuTestMask === 0 ? "passed" : "failed",
          detail: `${core.ppuInstructions ?? 0} guest instructions · result ${core.ppuResult ?? "?"} · ${core.ppuSupportedOpcodes ?? 0} opcodes`,
        }
      : { state: "unsupported", detail: "compiled core not loaded" }],
    ["RPCS3 PPU ELF fixture", core?.elfProbe?.loaded
      ? {
          state: core.elfProbe.testMask === 0 && (core.elfProbe.instructions ?? 0) > 0 ? "passed" : "failed",
          detail: core.elfProbe.detail,
        }
      : { state: "unsupported", detail: core?.elfProbe?.detail ?? "fixture unavailable" }],
  ];
  document.querySelector<HTMLElement>("#summary")!.innerHTML = checks.map(([label, result]) => row(label, result)).join("");
  document.querySelector<HTMLElement>("#evidence")!.textContent = JSON.stringify(report, null, 2);
  document.querySelector<HTMLElement>("#visual-state")!.textContent = worker.guestHomebrew.state;
}

async function collectAndRender(): Promise<CapabilityReport> {
  status = "probing";
  const oldCanvas = document.querySelector<HTMLCanvasElement>("#gpu-canvas")!;
  const canvas = oldCanvas.cloneNode(false) as HTMLCanvasElement;
  oldCanvas.replaceWith(canvas);
  const report = await collectCapabilities(canvas);
  lastReport = report;
  const hardFailures = [
    report.crossOriginIsolated,
    report.sharedArrayBuffer,
    report.worker.worker.state === "passed",
    report.worker.webGpu.state === "passed",
    report.worker.offscreenWebGpu.state === "passed",
    report.worker.guestHomebrew.state === "passed",
  ];
  status = hardFailures.every(Boolean) ? "passed" : "failed";
  renderReport(report);
  return report;
}

function run(): Promise<CapabilityReport> {
  if (activeRun) return activeRun;
  activeRun = collectAndRender().finally(() => {
    activeRun = undefined;
  });
  return activeRun;
}

app.innerHTML = baseMarkup();
document.querySelector("#run-probe")?.addEventListener("click", () => void run());
document.querySelector("#start-tetris")?.addEventListener("click", () => void startTetris());
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-digital1], [data-digital2]")) {
  const update = (pressed: boolean) => {
    const d1 = Number(button.dataset.digital1 ?? 0);
    const d2 = Number(button.dataset.digital2 ?? 0);
    touchDigital1 = pressed ? touchDigital1 | d1 : touchDigital1 & ~d1;
    touchDigital2 = pressed ? touchDigital2 | d2 : touchDigital2 & ~d2;
    sendPad();
  };
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    update(true);
  });
  button.addEventListener("pointerup", () => update(false));
  button.addEventListener("pointercancel", () => update(false));
}
const keys = new Map<string, [number, number]>([
  ["ArrowUp", [0x10, 0]], ["ArrowDown", [0x40, 0]], ["ArrowLeft", [0x80, 0]], ["ArrowRight", [0x20, 0]],
  ["Enter", [0x08, 0]], [" ", [0, 0x40]],
]);
for (const eventName of ["keydown", "keyup"] as const) window.addEventListener(eventName, (event) => {
  const mapped = keys.get(event.key);
  if (!mapped) return;
  event.preventDefault();
  const pressed = eventName === "keydown";
  touchDigital1 = pressed ? touchDigital1 | mapped[0] : touchDigital1 & ~mapped[0];
  touchDigital2 = pressed ? touchDigital2 | mapped[1] : touchDigital2 & ~mapped[1];
  sendPad();
});
const pollGamepad = () => {
  sendPad();
  window.requestAnimationFrame(pollGamepad);
};
window.requestAnimationFrame(pollGamepad);

window.__rpcs3Web = {
  schemaVersion: 1,
  get status() { return status; },
  capabilities: () => lastReport,
  runSmokeTest: run,
  exportEvidence: () => lastReport,
  startTetris,
  stopTetris,
  gameStatus: () => gameStatus,
};

void run().finally(() => void startTetris());
