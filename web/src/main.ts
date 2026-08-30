import "./style.css";
import { collectCapabilities } from "./probe";
import type { CapabilityReport, CheckResult, Rpcs3WebApi } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
let lastReport: CapabilityReport | undefined;
let status: Rpcs3WebApi["status"] = "idle";
let activeRun: Promise<CapabilityReport> | undefined;

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
      <h1>PS3 browser bring-up</h1>
      <p class="lede">A local execution probe for the pieces RPCS3 needs before the first PPU instruction or RSX draw can run in Safari.</p>
      <button id="run-probe">Run capability probe</button>
    </header>
    <main>
      <section class="visual">
        <canvas id="gpu-canvas" width="768" height="432" aria-label="Worker WebGPU output"></canvas>
        <div><span>Worker WebGPU output</span><strong id="visual-state">waiting</strong></div>
      </section>
      <section id="summary" class="summary"><p>Run the probe to collect evidence from this browser.</p></section>
      <details><summary>Evidence JSON</summary><pre id="evidence">No evidence yet.</pre></details>
    </main>
    <footer>No cloud streaming. The triangle, storage test, and Wasm modules execute on this device.</footer>
  `;
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
    ["Sparse core probe", core?.loaded
      ? { state: core.memoryTestMask === 0 ? "passed" : "failed", detail: core.detail }
      : { state: "unsupported", detail: core?.detail ?? "not built" }],
  ];
  document.querySelector<HTMLElement>("#summary")!.innerHTML = checks.map(([label, result]) => row(label, result)).join("");
  document.querySelector<HTMLElement>("#evidence")!.textContent = JSON.stringify(report, null, 2);
  document.querySelector<HTMLElement>("#visual-state")!.textContent = worker.offscreenWebGpu.state;
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

window.__rpcs3Web = {
  schemaVersion: 1,
  get status() { return status; },
  capabilities: () => lastReport,
  runSmokeTest: run,
  exportEvidence: () => lastReport,
};

void run();
