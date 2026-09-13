import { expect, it } from "vitest";
import { parseThreadStat } from "../scripts/linux-thread-sampler.mjs";

it("reads CPU and lifetime fields despite spaces and parentheses in a Linux thread name", () => {
  const line = "345 (PPU (main)) R 1 2 3 4 5 6 7 8 9 10 123 45 0 0 20 0 1 0 9999 10000";
  expect(parseThreadStat(line, 100, 100)).toEqual({ pid: 100, tid: 345, name: "PPU (main)",
    state: "R", cpuTime: 1.68, startTicks: "9999" });
});

it("rejects truncated counters instead of reporting invented CPU time", () => {
  expect(() => parseThreadStat("345 (worker) R 1", 100, 100)).toThrow();
});

it("does not attribute the CPU history of a reused TID to the previous thread", async () => {
  const { measureWindow } = await import("../scripts/performance-metrics.mjs");
  const report = { frames: [{ emuFlipId: 1, hostTimeMs: 1000 }, { emuFlipId: 2, hostTimeMs: 2000 }],
    threadSamples: [
      { hostTimeMs: 1000, threads: [{ pid: 1, tid: 2, name: "worker", startTicks: "10", cpuTime: 1 }] },
      { hostTimeMs: 2000, threads: [{ pid: 1, tid: 2, name: "worker", startTicks: "20", cpuTime: 3 }] },
    ] };
  expect(measureWindow(report, 1, 2).threadCpuMs).toEqual({});
});
