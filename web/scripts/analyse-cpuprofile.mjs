// Reads the .cpuprofile set a run wrote and reports where the emulator's time went.
//   node scripts/analyse-cpuprofile.mjs <run.cpuprofile> [function] --report=<run.json> --draws=<n>
//   node scripts/analyse-cpuprofile.mjs <run.cpuprofile> [function] [--last=<seconds>]
//
// Self time is per function; the tree is also walked so a caller that spends its time in children
// (an interpreter loop dispatching, a compiled block calling a host helper) is still attributable.
//
// --report names the run's own JSON so the window is expressed as CPU milliseconds per frame at a
// stated draws per frame. That pair is the only comparable figure between two runs of a title, and
// between the browser and the desktop emulator.
//
// --draws picks the window by what was on screen rather than by the clock, which is what makes two
// runs comparable at all: a title reaches the same scene at a different flip every time — two runs
// of LittleBigPlanet 2 entered gameplay 400 flips apart — so the same --last window lands on
// different scenes and the numbers mean nothing. --last remains for a run with no report beside it.
import { readFile } from "node:fs/promises";
import { callersOf, selfTime, workSampleCount } from "./worker-profiler.mjs";

const args = process.argv.slice(2);
const reportPath = args.find((arg) => arg.startsWith("--report="))?.slice(9);
const targetDraws = Number(args.find((arg) => arg.startsWith("--draws="))?.slice(8)) || 0;
const positional = args.filter((arg) => !arg.startsWith("--"));
const base = positional[0] || "play-chrome.cpuprofile";
// A second argument asks who calls that function, pooled the same way.
const callee = positional[1];
const targets = JSON.parse(await readFile(`${base}.targets.json`, "utf8"));
let clock;

// Each frame sample carries the run time at that frame plus cumulative frame and draw counts, so a
// window's own frames, draws and duration all come from the difference across it.
async function windowFrames() {
  if (!reportPath) return undefined;
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  clock = report.clock;
  const samples = (report.result?.frames ?? report.frames ?? [])
    .map((frame) => ({ frames: frame.emuFlipId ?? frame.workingSet?.flipCounter ?? frame.frameSequence, draws: frame.directStats?.draws, ms: frame.elapsedMs, hostTimeMs: frame.hostTimeMs }))
    .filter((sample) => Number.isFinite(sample.frames) && Number.isFinite(sample.draws) && Number.isFinite(sample.ms))
    // A bounded CPU profile must not be divided by unprofiled flips from the same scene.
    // startedAt follows worker attachment; stoppedAt precedes stopping the profilers.
    .filter((sample) => (!report.profileWindow?.startedAt || sample.hostTimeMs >= report.profileWindow.startedAt)
      && (!report.profileWindow?.stoppedAt || sample.hostTimeMs <= report.profileWindow.stoppedAt));
  if (samples.length < 2) return undefined;
  const runMs = samples.at(-1).ms;

  // Local draw rate over a short span, which is what says which scene a frame belongs to.
  const span = 20;
  const rateAt = (index) => {
    const from = samples[Math.max(0, index - span)];
    const to = samples[index];
    return to.frames > from.frames ? (to.draws - from.draws) / (to.frames - from.frames) : 0;
  };

  let first = samples[0];
  if (targetDraws) {
    // The trailing run of frames whose scene matches, walked back from the end.
    let index = samples.length - 1;
    while (index > 0 && Math.abs(rateAt(index) - targetDraws) > targetDraws * 0.2) index--;
    const end = index;
    while (index > span && Math.abs(rateAt(index - 1) - targetDraws) <= targetDraws * 0.2) index--;
    if (end - index < span) return { matched: false };
    first = samples[index];
    const last = samples[end];
    return {
      startTimeUs: clock && first.hostTimeMs * 1000 + clock.offsetUs,
      endTimeUs: clock && last.hostTimeMs * 1000 + clock.offsetUs,
      matched: true, frames: last.frames - first.frames, draws: last.draws - first.draws,
      lastSeconds: (runMs - first.ms) / 1000, trailingMs: runMs - last.ms,
    };
  }

  const lastSeconds = Number(args.find((arg) => arg.startsWith("--last="))?.slice(7)) || 0;
  first = lastSeconds ? samples.find((sample) => sample.ms >= runMs - lastSeconds * 1000) ?? samples[0] : samples[0];
  const last = samples.at(-1);
  const frames = last.frames - first.frames;
  return frames > 0 ? { startTimeUs: clock && first.hostTimeMs * 1000 + clock.offsetUs, endTimeUs: clock && last.hostTimeMs * 1000 + clock.offsetUs, matched: true, frames, draws: last.draws - first.draws, lastSeconds, trailingMs: 0 } : undefined;
}

const framed = await windowFrames();
if (framed && framed.matched === false) {
  console.error(`no stretch of at least 20 frames near ${targetDraws} draws per frame in ${reportPath}`);
  process.exit(1);
}
const lastSeconds = framed?.lastSeconds ?? Number(args.find((arg) => arg.startsWith("--last="))?.slice(7)) ?? 0;
const trailingSeconds = (framed?.trailingMs ?? 0) / 1000;
const startTimeUs = framed?.startTimeUs;
const endTimeUs = framed?.endTimeUs;
const slice = { lastSeconds, trailingSeconds, startTimeUs, endTimeUs };
if (reportPath && !clock) console.error("Legacy report: no clock alignment; sample estimates are not comparable CPU measurements.");

const rows = [];
for (const target of targets.targets) {
  if (!target.profilePath || !target.workSamples) continue;
  const profile = JSON.parse(await readFile(target.profilePath, "utf8"));
  rows.push({ target, profile, work: workSampleCount(profile, lastSeconds, trailingSeconds, startTimeUs, endTimeUs) });
}
rows.sort((left, right) => right.work - left.work);

const window = targetDraws ? `${lastSeconds.toFixed(1)}s at ~${targetDraws} draws/frame`
  : lastSeconds ? `last ${lastSeconds}s` : "whole run";
console.log(`${rows.length} workers with work samples, ${targets.samplingIntervalUs} us interval, ${window}`);

const totalWork = rows.reduce((sum, row) => sum + row.work, 0);
const cpuMs = (totalWork * targets.samplingIntervalUs) / 1000;
if (framed) {
  console.log(`${(cpuMs / framed.frames).toFixed(1)} estimated sampled-work ms per guest flip at ${(framed.draws / framed.frames).toFixed(0)} draws per frame`
    + ` (${framed.frames} frames, ${(cpuMs / 1000).toFixed(1)} estimated sampled-work seconds)`);
} else {
  console.log(`${(cpuMs / 1000).toFixed(1)} estimated sampled-work seconds; pass --report=<run.json> for estimated sampled-work ms per guest flip`);
}
console.log();
const categories = new Map();
for (const { profile } of rows) {
  for (const row of selfTime(profile, 10_000, { ...slice, includeUnknown: true, includeWaits: true })) {
    const category = row.name === "(program)" ? "unknown" : row.name === "(garbage collector)" ? "GC"
      : ["(idle)", "emscripten_futex_wait", "_do_futex_wait"].includes(row.name) ? "wait/idle" : "attributed";
    categories.set(category, (categories.get(category) ?? 0) + row.samples);
  }
}
console.log(`sample categories: ${JSON.stringify(Object.fromEntries(categories))}`);

// What every worker spends its time in, pooled: one thread's hot function is not the whole picture
// when the same loop runs on many.
const pooled = new Map();
let pooledSamples = 0;
for (const { profile } of rows) {
  for (const row of selfTime(profile, 10_000, slice)) {
    const key = `${row.name}`;
    pooled.set(key, (pooled.get(key) ?? 0) + row.samples);
    pooledSamples += row.samples;
  }
}

console.log(`pooled across workers (${pooledSamples} work samples)`);
for (const [name, samples] of [...pooled].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  const percent = (samples / pooledSamples) * 100;
  console.log(`  ${percent.toFixed(1).padStart(5)}%  ${samples.toString().padStart(6)}  ${name}`);
}

if (callee) {
  const callers = new Map();
  let calleeSamples = 0;
  for (const { profile } of rows) {
    for (const row of callersOf(profile, callee, 10_000, { depth: 3, ...slice })) {
      callers.set(row.caller, (callers.get(row.caller) ?? 0) + row.samples);
      calleeSamples += row.samples;
    }
  }
  console.log(`\ncallers of ${callee} (${calleeSamples} samples)`);
  for (const [caller, samples] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${((samples / calleeSamples) * 100).toFixed(1).padStart(5)}%  ${samples.toString().padStart(6)}  ${caller}`);
  }
}

console.log(`\nbusiest workers`);
for (const { target, profile, work } of rows.slice(0, 5)) {
  console.log(`\n  ${target.profilePath.split("/").pop()} — ${work} work of ${profile.samples.length} samples`);
  for (const row of selfTime(profile, 6, slice)) {
    console.log(`    ${row.percent.toFixed(1).padStart(5)}%  ${row.name}`);
  }
}
