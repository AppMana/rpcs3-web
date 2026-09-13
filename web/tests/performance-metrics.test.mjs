import { expect, it } from "vitest";
import { processCpuBetween, measureWindow, hostPressureBetween } from "../scripts/performance-metrics.mjs";

it("sums CPU counters across stable processes without counting process birth history", () => {
  const samples = [
    { hostTimeMs: 1000, processes: [{ id: 1, type: "renderer", cpuTime: 50 }] },
    { hostTimeMs: 2000, processes: [{ id: 1, type: "renderer", cpuTime: 52 }, { id: 2, type: "GPU", cpuTime: 3 }] },
    { hostTimeMs: 3000, processes: [{ id: 1, type: "renderer", cpuTime: 54 }, { id: 2, type: "GPU", cpuTime: 4 }] },
  ];
  expect(processCpuBetween(samples, 1500, 2500)).toEqual({ renderer: 2000, GPU: 500 });
});

it("does not invent individual frame latency from coalesced observations", () => {
  const report = { frames: [
    { emuFlipId: 10, hostTimeMs: 1000, presented: 10, directStats: { draws: 100 } },
    { emuFlipId: 40, hostTimeMs: 2000, presented: 40, directStats: { draws: 400 } },
  ] };
  const result = measureWindow(report, 10, 40);
  expect(result.fps).toBe(30);
  expect(result.drawsPerFrame).toBe(10);
  expect(result.frameIntervals.p95).toBeNull();
  expect(result.observedCpuMsPerFrame).toBeNull();
  expect(result.cpuAccounting).toContain("Not measured");
});

it("distinguishes measured zero CPU from absent or non-overlapping counters", () => {
  const report = { frames: [
    { emuFlipId: 10, hostTimeMs: 1000 },
    { emuFlipId: 20, hostTimeMs: 2000 },
  ], processSamples: [
    { hostTimeMs: 1000, processes: [{ id: 1, type: "renderer", cpuTime: 3 }] },
    { hostTimeMs: 2000, processes: [{ id: 1, type: "renderer", cpuTime: 3 }] },
  ] };
  expect(measureWindow(report, 10, 20).observedCpuMsPerFrame).toBe(0);
  expect(measureWindow({ ...report, processSamples: report.processSamples.slice(0, 1) }, 10, 20).observedCpuMsPerFrame).toBeNull();
  const earlier = report.processSamples.map((s) => ({ ...s, hostTimeMs: s.hostTimeMs - 2000 }));
  expect(measureWindow({ ...report, processSamples: earlier }, 10, 20).observedCpuMsPerFrame).toBeNull();
});


it("measures host pressure from cumulative stalls over the overlapping window", () => {
  const samples = [
    { hostTimeMs: 1000, cpuPressure: "some avg10=99.00 avg60=0.00 avg300=0.00 total=100000\nfull avg10=0 total=0\n" },
    { hostTimeMs: 2000, cpuPressure: "some avg10=99.00 avg60=0.00 avg300=0.00 total=300000\n" },
    { hostTimeMs: 3000, cpuPressure: "some avg10=99.00 avg60=0.00 avg300=0.00 total=700000\n" },
  ];
  expect(hostPressureBetween(samples, 1500, 2500)).toEqual({ someStallPercent: 30, coveredMs: 1000 });
  expect(hostPressureBetween(samples, 0, 500)).toEqual({ someStallPercent: null, coveredMs: 0 });
});

it("does not turn missing, failed or reset pressure counters into zero contention", () => {
  const s = (hostTimeMs, cpuPressure) => ({ hostTimeMs, cpuPressure });
  for (const samples of [[], [s(1, "some total=1")],
    [s(1, "some total=100"), s(1001, { error: "ENOENT" })],
    [s(1, "some total=100"), s(1001, "some total=50")]]) {
    expect(hostPressureBetween(samples, 0, 2000)).toEqual({ someStallPercent: null, coveredMs: 0 });
  }
  expect(hostPressureBetween([s(1, "some total=100"), s(1001, "some total=100")], 0, 2000))
    .toEqual({ someStallPercent: 0, coveredMs: 1000 });
});


it("reports matching-window renderer counters without treating bitmasks or resets as counts", () => {
  const r = { frames: [
    { emuFlipId: 10, hostTimeMs: 1000, directStats: { draws: 100, textureBindGroupHits: 80, textureBindGroupCreates: 20, textureUploads: 9, unnormalizedTextureSlots: 1 } },
    { emuFlipId: 20, hostTimeMs: 2000, directStats: { draws: 200, textureBindGroupHits: 170, textureBindGroupCreates: 30, textureUploads: 2, unnormalizedTextureSlots: 7, surfaceOps: 5 } },
  ] };
  expect(measureWindow(r, 10, 20).directCounterDeltas).toEqual({ draws: 100, textureBindGroupHits: 90, textureBindGroupCreates: 10 });
});
