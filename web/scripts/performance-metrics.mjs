export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function processCpuBetween(samples, startMs, endMs) {
  const totals = new Map();
  for (let i = 1; i < samples.length; ++i) {
    const before = samples[i - 1], after = samples[i];
    const duration = after.hostTimeMs - before.hostTimeMs;
    const overlap = Math.max(0, Math.min(endMs, after.hostTimeMs) - Math.max(startMs, before.hostTimeMs));
    if (!overlap || duration <= 0) continue;
    const previous = new Map(before.processes.map((process) => [process.id, process]));
    for (const process of after.processes) {
      const old = previous.get(process.id);
      // A newly observed process includes CPU used since birth, not just this interval.
      if (!old || old.type !== process.type || process.cpuTime < old.cpuTime) continue;
      totals.set(process.type, (totals.get(process.type) ?? 0) + (process.cpuTime - old.cpuTime) * 1000 * overlap / duration);
    }
  }
  return Object.fromEntries(totals);
}

// Host-wide pressure is contextual evidence, not CPU charged to the emulator.
// Interpolate boundary intervals just as for process counters; retain coverage so
// a short measured fragment cannot silently stand in for the entire frame window.
export function hostPressureBetween(samples, startMs, endMs) {
  let stalledMs = 0, coveredMs = 0;
  const total = (sample) => {
    if (typeof sample.cpuPressure !== "string") return NaN;
    const match = sample.cpuPressure.match(/^some\s+[^\n]*\btotal=(\d+)\s*$/m);
    return match ? Number(match[1]) : NaN;
  };
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1], after = samples[i];
    const duration = after.hostTimeMs - before.hostTimeMs;
    const overlap = Math.max(0, Math.min(endMs, after.hostTimeMs) - Math.max(startMs, before.hostTimeMs));
    const deltaUs = total(after) - total(before);
    if (!(duration > 0 && overlap > 0 && Number.isFinite(deltaUs) && deltaUs >= 0)) continue;
    stalledMs += deltaUs / 1000 * overlap / duration;
    coveredMs += overlap;
  }
  return { someStallPercent: coveredMs ? 100 * stalledMs / coveredMs : null, coveredMs };
}

export function measureWindow(report, from, to) {
  const samples = report.frames.filter((frame) => frame.emuFlipId >= from && frame.emuFlipId <= to);
  if (samples.length < 2) throw new Error("insufficient frame observations for requested window");
  const first = samples[0], last = samples.at(-1);
  const durationMs = last.hostTimeMs - first.hostTimeMs;
  const frames = last.emuFlipId - first.emuFlipId;
  if (!(durationMs > 0 && frames > 0)) throw new Error("invalid frame window");
  // Counter deltas cover the same guest window as timing and CPU accounting.
  // Missing/reset diagnostics remain absent rather than becoming fabricated zeroes.
  const directCounterDeltas = Object.fromEntries(Object.entries(last.directStats ?? {})
    .filter(([key, value]) => /^(draws|drawsSkipped|clears|programs|pipelines|textureUploads|textureInvalidations|textureHits|surfaceHits|surfaceOps|translationFailures|unsupported|textureBindGroupHits|textureBindGroupCreates|bindGroupHits|bindGroupCreates)$/.test(key)
      && Number.isFinite(value) && Number.isFinite(first.directStats?.[key]) && value >= first.directStats[key])
    .map(([key, value]) => [key, value - first.directStats[key]]));
  const timings = (report.flipTimings ?? []).filter((frame) => frame.emuFlipId >= first.emuFlipId && frame.emuFlipId <= last.emuFlipId);
  const intervals = [];
  for (let i = 1; i < timings.length; ++i) {
    if (timings[i].emuFlipId === timings[i - 1].emuFlipId + 1) intervals.push(timings[i].hostTimeMs - timings[i - 1].hostTimeMs);
  }
  const cpuByProcessTypeMs = processCpuBetween(report.processSamples ?? [], first.hostTimeMs, last.hostTimeMs);
  const hasCpuObservations = Object.keys(cpuByProcessTypeMs).length > 0;
  const cpuMs = Object.values(cpuByProcessTypeMs).reduce((a, b) => a + b, 0);
  const threadCpu = report.threadSamples && processCpuBetween(report.threadSamples.map((sample) => ({
    hostTimeMs: sample.hostTimeMs,
    processes: sample.threads.map((thread) => ({ id: `${thread.pid}:${thread.tid}:${thread.startTicks}`,
      type: `${thread.pid}:${thread.tid} ${thread.name}`, cpuTime: thread.cpuTime })),
  })), first.hostTimeMs, last.hostTimeMs);
  return {
    from: first.emuFlipId, to: last.emuFlipId, frames, durationMs, fps: frames * 1000 / durationMs,
    drawsPerFrame: Number.isFinite(last.directStats?.draws) && Number.isFinite(first.directStats?.draws) ? (last.directStats.draws - first.directStats.draws) / frames : null,
    presentationHandoffsPerSecond: Number.isFinite(last.presented) && Number.isFinite(first.presented) ? (last.presented - first.presented) * 1000 / durationMs : null,
    frameIntervals: { samples: intervals.length, p50: percentile(intervals, 0.5), p95: percentile(intervals, 0.95), p99: percentile(intervals, 0.99), max: intervals.length ? Math.max(...intervals) : null },
    ...(threadCpu ? { threadCpuMs: Object.fromEntries(Object.entries(threadCpu).sort((a, b) => b[1] - a[1])) } : {}),
    hostCpuPressure: hostPressureBetween(report.hostSamples ?? [], first.hostTimeMs, last.hostTimeMs),
    directCounterDeltas,
    cpuByProcessTypeMs, observedCpuMsPerFrame: hasCpuObservations ? cpuMs / frames : null,
    cpuAccounting: hasCpuObservations
      ? "OS process CPU counters; boundary intervals interpolated; process birth/death tails excluded"
      : "Not measured: no comparable process CPU counters overlap this window",
    timingDrops: report.timingDrops ?? null,
  };
}
