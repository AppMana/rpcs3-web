// Analyse a performance run on its real-3D-gameplay content instead of a fixed
// frame window. LBP2's boot plays a long movie/menu stretch at low per-frame draw
// counts before entering the interactive 3D gameplay, whose stable per-frame draw
// count is far higher (LBP2 ~1163 draws/frame vs ~1-573 during the movie). A fixed
// "4500-5300" window therefore measures whatever content the machine reached in
// that span, which differed between core builds (movie for the keeper, gameplay
// for a faster build), so cross-build f/f comparisons were measuring different
// scenes. This helper selects, from a single captured report, the first sustained
// gameplay run (per-flip draws/frame above a threshold for K consecutive flips),
// skips its first `skip` flips, and reports the steady-state gameplay window —
// the content-matched basis the project rule requires ("compare at matched draws
// per frame").
//
// Usage: node scripts/analyse-gameplay.mjs report.json [--threshold=900] [--run=40] [--skip=120] [--len=800]
import { readFile, writeFile } from "node:fs/promises";
import { measureWindow } from "./performance-metrics.mjs";

const [file] = process.argv.slice(2);
const arg = (name, fallback) => {
  const match = process.argv.find((a) => a.startsWith(`--${name}=`));
  return match ? Number(match.split("=")[1]) : fallback;
};
if (!file) throw new Error("usage: analyse-gameplay.mjs report.json [--threshold=..] [--run=..] [--skip=..] [--len=..]");
const threshold = arg("threshold", 900);
const runLen = arg("run", 40);
const skip = arg("skip", 150);
const windowLen = arg("len", 800);

const report = JSON.parse(await readFile(file, "utf8"));
const data = report.flips ? { ...report, frames: report.flips.frames } : report;
const ft = data.frames ?? [];
if (!ft.length) throw new Error("report has no frame observations");

// Per-flip draws/frame from deltas of the cumulative backend draw counter.
const dpf = new Array(ft.length).fill(0);
let previous = null;
for (let i = 0; i < ft.length; ++i) {
  const drew = (ft[i].directStats ?? {}).draws;
  if (previous !== null && drew !== undefined && ft[i].emuFlipId !== undefined) {
    const de = ft[i].emuFlipId - previous.id;
    dpf[i] = de > 0 ? Math.max(0, (drew - previous.d).valueOf()) / de : 0;
  }
  previous = { id: ft[i].emuFlipId, d: drew };
}

// Rolling median of per-flip draws/frame; anchor = first flip whose window is >= threshold.
const half = 15;
const med = [];
for (let i = 0; i < ft.length; ++i) {
  const lo = Math.max(0, i - half), hi = Math.min(ft.length, i + half + 1);
  const s = dpf.slice(lo, hi).sort((a, b) => a - b);
  med.push(s[Math.floor(s.length / 2)]);
}
let anchor = -1, run = 0;
for (let i = 0; i < ft.length; ++i) {
  run = med[i] >= threshold ? run + 1 : 0;
  if (run >= runLen) { anchor = i - runLen + 1; break; }
}
if (anchor < 0) {
  writeFile(file.replace(/\.json$/, ".gameplay.json"), JSON.stringify({
    runId: report.runId, core: report.core, gameplay: false,
    reason: `no sustained gameplay (>=${threshold} draws/frame for ${runLen} flips)`,
    maxDrawsPerFrame: Math.max(...dpf), captures: ft.length,
  }, null, 2));
  console.log(JSON.stringify({ gameplay: false, reason: "no sustained gameplay found" }));
  process.exit(0);
}
const from = ft[Math.min(anchor + skip, ft.length - 1)].emuFlipId;
const to = ft[Math.min(anchor + skip + windowLen, ft.length - 1)].emuFlipId;
const gameplayReport = {
  runId: report.runId, core: report.core,
  gameplayAnchorFlip: ft[anchor].emuFlipId, gameplayAnchorDrawsPerFrame: Math.round(med[anchor]),
  window: { from, to, frames: to - from, skippedAfterAnchor: skip, requestedLen: windowLen },
  ...measureWindow(data, from, to),
};
await writeFile(file.replace(/\.json$/, ".gameplay.json"), JSON.stringify(gameplayReport, null, 2));
console.log(JSON.stringify(gameplayReport, null, 2));
