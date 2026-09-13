// Inspector snapshots overlap. Recover only timestamped emulator flips; a page reload
// must never merge a new run's frame numbers into the terminated run's measurements.
export function recoverDeviceProgress(observations) {
  const first = observations.find((sample) => sample.phase === "running" && sample.events?.length);
  const origin = first?.timeOrigin;
  let started = false;
  const timings = new Map(), frames = new Map();
  let workingSet, timingDrops = 0;
  for (const sample of observations) {
    if (sample === first) started = true;
    if (!started) continue;
    // Safari timeOrigin can shift by tens of milliseconds during a single run.
    // Use run identity and the observed end of page state, never clock equality.
    if (sample.phase !== "running" || (first.runId && sample.runId !== first.runId)) break;
    for (const event of sample.events ?? []) {
      if (event.workingSet) workingSet = event.workingSet;
      timingDrops = Math.max(timingDrops, event.frameTimings?.dropped ?? 0);
      for (const frame of event.frameTimings?.frames ?? []) {
        if (Number.isFinite(frame.emuFlipId) && Number.isFinite(frame.hostTimeMs)) timings.set(frame.emuFlipId, frame);
      }
      if (event.type === "runtime-frame" && Number.isFinite(event.emuFlipId)) frames.set(event.emuFlipId, event);
    }
  }
  const flipTimings = [...timings.values()].sort((a, b) => a.emuFlipId - b.emuFlipId);
  let missingFlips = 0;
  for (let i = 1; i < flipTimings.length; i++) missingFlips += Math.max(0, flipTimings[i].emuFlipId - flipTimings[i - 1].emuFlipId - 1);
  const measuredFrames = [...frames.values()].filter((frame) => timings.has(frame.emuFlipId))
    .sort((a, b) => a.emuFlipId - b.emuFlipId)
    .map((frame) => ({ ...frame, hostTimeMs: timings.get(frame.emuFlipId).hostTimeMs }));
  return { recoveredFromProgress: true, timeOrigin: origin, flipTimings, frameObservations: measuredFrames,
    timingDrops, missingFlips, workingSet };
}
