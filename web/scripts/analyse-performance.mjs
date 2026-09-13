import { readFile, writeFile } from "node:fs/promises";
import { measureWindow } from "./performance-metrics.mjs";

const [file, from, to] = process.argv.slice(2);
if (!file || !from || !to) throw new Error("usage: analyse-performance.mjs report.json first-guest-frame last-guest-frame");
const report = JSON.parse(await readFile(file, "utf8"));
const data = report.flips ? {
  ...report,
  frames: report.flips.frames.map((frame) => ({ ...frame, hostTimeMs: frame.monotonicUs / 1000 })),
  flipTimings: report.flips.frames.map((frame) => ({ ...frame, hostTimeMs: frame.monotonicUs / 1000 })),
  timingDrops: report.flips.dropped,
  processSamples: report.processSamples.map((sample) => ({ hostTimeMs: sample.monotonicUs / 1000,
    processes: [{ id: 1, type: "native", cpuTime: sample.cpuTime }] })),
} : report;
const result = { runId: report.runId, core: report.core, ...measureWindow(data, Number(from), Number(to)) };
await writeFile(file.replace(/\.json$/, ".metrics.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
