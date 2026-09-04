// Reads the .cpuprofile set a run wrote and reports where the emulator's time went.
//   node scripts/analyse-cpuprofile.mjs [play-chrome.cpuprofile] [function] [--last=<seconds>]
//
// Self time is per function; the tree is also walked so a caller that spends its time in children
// (an interpreter loop dispatching, a compiled block calling a host helper) is still attributable.
// --last restricts every figure to the end of the run, which is how a title's gameplay is measured
// without its boot and intro in the same numbers.
import { readFile } from "node:fs/promises";
import { callersOf, selfTime, workSampleCount } from "./worker-profiler.mjs";

const args = process.argv.slice(2);
const lastSeconds = Number(args.find((arg) => arg.startsWith("--last="))?.slice(7)) || 0;
const positional = args.filter((arg) => !arg.startsWith("--"));
const base = positional[0] || "play-chrome.cpuprofile";
// A second argument asks who calls that function, pooled the same way.
const callee = positional[1];
const targets = JSON.parse(await readFile(`${base}.targets.json`, "utf8"));

const rows = [];
for (const target of targets.targets) {
  if (!target.profilePath || !target.workSamples) continue;
  const profile = JSON.parse(await readFile(target.profilePath, "utf8"));
  rows.push({ target, profile, work: workSampleCount(profile, lastSeconds) });
}
rows.sort((left, right) => right.work - left.work);

const window = lastSeconds ? `last ${lastSeconds}s` : "whole run";
console.log(`${rows.length} workers with work samples, ${targets.samplingIntervalUs} us interval, ${window}\n`);

// What every worker spends its time in, pooled: one thread's hot function is not the whole picture
// when the same loop runs on many.
const pooled = new Map();
let pooledSamples = 0;
for (const { profile } of rows) {
  for (const row of selfTime(profile, 10_000, { lastSeconds })) {
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
    for (const row of callersOf(profile, callee, 10_000, { depth: 3, lastSeconds })) {
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
  for (const row of selfTime(profile, 6, { lastSeconds })) {
    console.log(`    ${row.percent.toFixed(1).padStart(5)}%  ${row.name}`);
  }
}
