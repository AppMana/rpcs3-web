import { describe, expect, it } from 'vitest';
import { recoverDeviceProgress } from '../scripts/device-progress.mjs';

describe('device progress recovery', () => {
  it('deduplicates overlapping snapshots, tolerates clock rounding, and excludes a reloaded page', () => {
    const flip = (emuFlipId) => ({ emuFlipId, hostTimeMs: 1000 + emuFlipId * 20 });
    const event = { type: 'runtime-progress', frameTimings: { dropped: 0, frames: [flip(10), flip(11)] } };
    const frame = { type: 'runtime-frame', emuFlipId: 11, directStats: { draws: 100 } };
    const recovered = recoverDeviceProgress([
      { phase: 'running', timeOrigin: 100.42, events: [event, frame] },
      { phase: 'running', timeOrigin: 58.5, events: [event, frame, { type: 'runtime-progress', frameTimings: { dropped: 2, frames: [flip(14)] } }] },
      { phase: 'gone', timeOrigin: 4000 },
      { phase: 'running', timeOrigin: 4000, events: [{ type: 'runtime-progress', frameTimings: { frames: [flip(1)] } }] },
    ]);
    expect(recovered.flipTimings.map((f) => f.emuFlipId)).toEqual([10, 11, 14]);
    expect(recovered.frameObservations).toEqual([{ ...frame, hostTimeMs: 1220 }]);
    expect(recovered.missingFlips).toBe(2);
    expect(recovered.timingDrops).toBe(2);
  });

  it('does not invent timings when the page never reported a flip', () => {
    expect(recoverDeviceProgress([{ phase: 'gone', timeOrigin: 1 }]).flipTimings).toEqual([]);
  });
});
