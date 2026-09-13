import { readFile, readdir } from "node:fs/promises";

// Linux stat fields are in USER_HZ units. The caller records `getconf CLK_TCK`;
// the start time distinguishes a reused TID from the previous thread's counters.
export function parseThreadStat(stat, pid, ticksPerSecond) {
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const tid = Number(stat.slice(0, stat.indexOf(" ")));
  if (close < 0 || fields.length < 20 || !Number.isFinite(tid) || !(ticksPerSecond > 0)) {
    throw new Error("invalid Linux thread stat");
  }
  return { pid, tid, name: stat.slice(stat.indexOf("(") + 1, close), state: fields[0],
    cpuTime: (Number(fields[11]) + Number(fields[12])) / ticksPerSecond,
    startTicks: fields[19] };
}

export async function sampleThreads(pids, ticksPerSecond) {
  const groups = await Promise.all(pids.map(async (pid) => {
    let tids;
    try { tids = await readdir(`/proc/${pid}/task`); } catch { return []; }
    return Promise.all(tids.map(async (tid) => {
      try { return parseThreadStat(await readFile(`/proc/${pid}/task/${tid}/stat`, "utf8"), pid, ticksPerSecond); }
      catch { return undefined; } // A thread can exit between enumeration and reading.
    }));
  }));
  return groups.flat().filter(Boolean);
}
