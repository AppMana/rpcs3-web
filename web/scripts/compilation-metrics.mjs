// Compilation counters are cumulative and discrete. Use observed frame endpoints;
// do not interpolate a fraction of a compilation or turn absent counters into zero.
export function compilationWindow(report, from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('invalid compilation window');
  const frames = (report.frames ?? []).filter(f => f.emuFlipId >= from && f.emuFlipId <= to);
  if (frames.length < 2) throw new Error('insufficient compilation observations');
  const counters = {
    llvmCompileElapsedMs: f => f.compilation?.compileMs,
    spuRequested: f => f.compilation?.spuRequested,
    spuCompiled: f => f.compilation?.spuCompiled,
    ppuRequested: f => f.compilation?.ppuRequested,
    ppuCompiled: f => f.compilation?.ppuCompiled,
    ppuRegistered: f => f.ppuRegistered,
  };
  const first = frames[0], last = frames.at(-1);
  const deltas = {};
  for (const [name, read] of Object.entries(counters)) {
    const values = frames.map(read);
    deltas[name] = values.every((value, i) => Number.isFinite(value) && value >= 0 && (!i || value >= values[i - 1]))
      ? values.at(-1) - values[0] : null;
  }
  const observedMax = read => {
    const values = frames.map(read);
    return values.every(Number.isFinite) ? Math.max(...values) : null;
  };
  return {
    from: first.emuFlipId, to: last.emuFlipId, observations: frames.length,
    durationMs: last.hostTimeMs - first.hostTimeMs, deltas,
    maxQueued: observedMax(f => f.compilation?.queued),
    maxPpuPending: observedMax(f => f.ppuPending),
    accounting: 'LLVM elapsed time sums completed jobs across workers; it is not CPU time and excludes browser Wasm compilation/tiering. Registration counters include runtime PPU translations. Queue maxima are sampled.',
  };
}
