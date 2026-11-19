import { describe, expect, it } from "vitest";
import { windowed, selfTime, workSampleCount, activeWorkSampleCount, classifyWorkerProfile } from "../scripts/worker-profiler.mjs";
import { frameCount } from "../public/rpcs3-runtime-session.mjs";

const profile = (endTime = 1000) => ({
  startTime: 100, endTime,
  nodes: ["guest", "(idle)", "(garbage collector)", "(program)"].map((functionName, index) => ({ id: index + 1, callFrame: { functionName } })),
  samples: [1, 2, 3, 4, 1], timeDeltas: [100, 100, 200, 100, 200],
});

describe("benchmark accounting", () => {
  it("selects the same absolute samples despite staggered profiler stops", () => {
    expect(windowed(profile(), 0, 0, 300, 600)).toEqual([2, 3, 4]);
    expect(windowed(profile(9000), 0, 0, 300, 600)).toEqual([2, 3, 4]);
  });
  it("retains GC and unknown program time, excluding only known waits", () => {
    expect(workSampleCount(profile())).toBe(3);
    expect(selfTime(profile()).map((row) => row.name)).toContain("(garbage collector)");
    expect(selfTime(profile(), 25, { includeUnknown: true }).map((row) => row.name)).toContain("(program)");
  });
  it("counts coalesced guest flips rather than telemetry messages", () => {
    expect(frameCount({ emuFlipId: 105, frameSequence: 70 })).toBe(105);
    expect(frameCount({ workingSet: { flipCounter: 83 }, frameSequence: 70 })).toBe(83);
    expect(frameCount({ emuFlipId: 0, frameSequence: 70 })).toBe(0);
  });
  it("separates spin-wait frames from active work and classifies worker roles", () => {
    const spinProfile = {
      startTime: 0, endTime: 500,
      nodes: [
        { id: 1, callFrame: { functionName: "semaphore_acquire" } },
        { id: 2, callFrame: { functionName: "spin_on_cacheline_once" } },
        { id: 3, callFrame: { functionName: "WebGPUDirectGSRender::do_local_task" } },
      ],
      samples: [1, 2, 1, 3], timeDeltas: [100, 100, 100, 100],
    };
    expect(workSampleCount(spinProfile)).toBe(4);
    expect(activeWorkSampleCount(spinProfile)).toBe(1);
    expect(classifyWorkerProfile(spinProfile)).toBe("RSX");
    expect(selfTime(spinProfile, 10, { excludeSpinWaits: true }).map((r) => r.name)).toEqual(["WebGPUDirectGSRender::do_local_task"]);
  });
});
