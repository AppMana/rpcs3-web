// Gameplay-sequence runner: boots LBP2 via the hardware-acceptance lane, replays a
// deterministic intro-skip trace, and reports the steady-state heavy-draw gameplay fps.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const runId = `gameplay-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const out = path.resolve(process.env.RPCS3_OUT || path.join(root, "test-results", "gameplay-sequence", runId));
await mkdir(out, { recursive: true });

const game = process.env.RPCS3_GAME
  || "/opfs/games/LittleBigPlanet 2 - Special Edition (USA) (En,Fr,Es,Pt).iso";
const frames = Number(process.env.RPCS3_FRAMES || 5300);
const anchorDpf = Number(process.env.RPCS3_GAMEPLAY_ANCHOR_DPF); // defaults below
const captureEvery = Number(process.env.RPCS3_CAPTURE_EVERY || 60);
const url = process.env.RPCS3_WEB_URL || "https://rpcs3.appmana.com";
const profile = process.env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");

// Deterministic, frame-indexed intro skip. Cross (digital2 0x40) pulses through the
// movie/menu; START (digital1 0x08) confirms the level. All pad fields are 0..255 so the
// input protocol stays valid, and the whole trace is replayed on exact guest frames.
const entries = [];
const cross = 0x40;
const start = 0x08;
const neutral = 128;
for (let frame = 20; frame < 3000; frame += 90) {
  entries.push({ frame, digital1: 0, digital2: cross, leftX: neutral, leftY: neutral, rightX: neutral, rightY: neutral });
  entries.push({ frame: frame + 8, digital1: 0, digital2: 0, leftX: neutral, leftY: neutral, rightX: neutral, rightY: neutral });
}
entries.push({ frame: 3300, digital1: start, digital2: 0, leftX: neutral, leftY: neutral, rightX: neutral, rightY: neutral });
entries.push({ frame: 3340, digital1: 0, digital2: 0, leftX: neutral, leftY: neutral, rightX: neutral, rightY: neutral });

const tracePath = path.join(out, "trace.json");
await writeFile(tracePath, JSON.stringify({ schema: 1, target: "LittleBigPlanet 2 - Special Edition", entries }) + "\n");

const env = {
  ...process.env,
  RPCS3_WEB_URL: url,
  RPCS3_CHROME_PROFILE: profile,
  RPCS3_FRAMES: String(frames),
  RPCS3_CAPTURE_RGBA: "1",
  RPCS3_CAPTURE_EVERY: String(captureEvery),
  RPCS3_CORE: process.env.RPCS3_CORE || "jspi",
  RPCS3_CLOCK_SCALE: process.env.RPCS3_CLOCK_SCALE || "100",
  RPCS3_READBACK: process.env.RPCS3_READBACK || "0",
  RPCS3_INPUT_TRACE: tracePath,
  ...(process.env.RPCS3_CPU_PROFILE ? { RPCS3_CPU_PROFILE: process.env.RPCS3_CPU_PROFILE } : {}),
  RPCS3_TIMEOUT_MS: String(process.env.RPCS3_TIMEOUT_MS || 1_500_000),
};

const reportPath = path.join(out, "report.json");
const runner = path.join(here, "run-hardware-acceptance.mjs");
console.log(`booting ${game} (${frames} frames, trace ${entries.length} entries) -> ${reportPath}`);
const child = spawn(process.execPath, [runner, game, reportPath], { env, stdio: "inherit" });
const code = await new Promise((resolve) => child.on("exit", resolve));

// Analyse heavy-draw (>= gameplay) frames. Movie/menu is ~573 dpf; 3D gameplay is >= ~700 dpf.
const gameplayAnchor = Number.isFinite(anchorDpf) && anchorDpf > 0 ? anchorDpf : 300;
const report = JSON.parse(await readFile(reportPath, "utf8"));
const list = [...(report?.frames ?? []), ...(report?.result?.frames ?? [])]
  .filter((f) => Number.isFinite(f?.emuFlipId) && Number.isFinite(f?.hostTimeMs))
  .sort((a, b) => a.emuFlipId - b.emuFlipId);

const gameplay = [];
const intervals = [];
let maxDpf = 0;
for (let i = 1; i < list.length; i++) {
  const a = list[i - 1];
  const b = list[i];
  const de = b.emuFlipId - a.emuFlipId;
  const dt = b.hostTimeMs - a.hostTimeMs;
  if (de <= 0 || dt <= 0) continue;
  const dpf = ((b.directStats?.draws ?? 0) - (a.directStats?.draws ?? 0)) / de;
  if (dpf > maxDpf) maxDpf = dpf;
  if (dpf >= gameplayAnchor) {
    gameplay.push({ emuFlipId: b.emuFlipId, hostTimeMs: b.hostTimeMs, dpf });
    intervals.push(dt / de);
  }
}

const sorted = intervals.slice().sort((x, y) => x - y);
const pct = (q) => sorted.length ? sorted[Math.floor(q * sorted.length)] : null;
const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;
const summary = {
  ok: code === 0,
  runId,
  out,
  report: reportPath,
  traceEntries: entries.length,
  gameplayFrames: gameplay.length,
  stretchFrames: intervals.length,
  anchorFlip: gameplay[0]?.emuFlipId ?? null,
  dpfMax: Math.round(maxDpf * 10) / 10,
  drawsTotal: list.at(-1)?.directStats?.draws ?? report.summary?.lastGpu?.draws ?? 0,
  ppuInstructions: report.summary?.lastPpuInstructions ?? null,
  spuInstructions: report.summary?.lastSpuInstructions ?? null,
  recomp: report.result?.spuLlvm?.recomp ?? null,
  spuWgsl: report.result?.spuLlvm?.spuWgsl ?? null,
  lastGpu: report.summary?.lastGpu ?? null,
  framePng: reportPath.replace(/\.json$/, "") + ".frame.png",
  workerErrors: report.workerErrors ?? [],
  msPerFrame: { p50: pct(0.5), p95: pct(0.95), mean },
  fps: mean ? 1000 / mean : null,
};
await writeFile(path.join(out, "gameplay-summary.json"), JSON.stringify(summary, null, 2) + "\n");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(summary.ok && summary.stretchFrames > 0 ? 0 : 1);
