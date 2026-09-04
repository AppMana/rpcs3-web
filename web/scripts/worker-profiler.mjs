// CPU sampling profiler across a page and every worker under it. RPCS3's threads are workers, so a
// profile of the page alone shows nothing; this attaches to each target, samples it, and ranks the
// results by the samples that are not idle or waiting on a futex.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IDLE_FRAMES = ["(idle)", "(program)", "(garbage collector)", "emscripten_futex_wait", "_do_futex_wait"];
const TRAMPOLINE_FRAMES = ["wasm-to-js", "js-to-wasm::i", "js-to-wasm::v"];

// A run reaches the part worth measuring some way into itself — a title's boot and its intro are
// not its gameplay — so every reader takes the same window: the last `lastSeconds` of the profile,
// or all of it. timeDeltas[i] is the microseconds before sample i.
function windowed(profile, lastSeconds) {
  const samples = profile.samples || [];
  if (!lastSeconds) return samples;
  const deltas = profile.timeDeltas || [];
  const cutoff = profile.endTime - lastSeconds * 1_000_000;
  let time = profile.startTime;
  let first = samples.length;
  for (let index = 0; index < samples.length; index++) {
    time += deltas[index] ?? 0;
    if (time >= cutoff) { first = index; break; }
  }
  return samples.slice(first);
}

export function workSampleCount(profile, lastSeconds = 0) {
  const waitNodes = new Set(profile.nodes
    .filter(({ callFrame }) => IDLE_FRAMES.includes(callFrame.functionName))
    .map(({ id }) => id));
  return windowed(profile, lastSeconds).reduce((count, id) => count + !waitNodes.has(id), 0);
}

// The busiest target lands at `outputPath`; the rest follow it as .1, .2 and so on, with a sidecar
// naming which is which.
export async function writeCpuProfiles(targets, outputPath, samplingIntervalUs) {
  if (!outputPath) return undefined;
  const ranked = targets
    .filter(({ profile }) => profile)
    .sort((left, right) => workSampleCount(right.profile) - workSampleCount(left.profile));
  await mkdir(path.dirname(outputPath), { recursive: true });
  const profilePaths = new Map();
  await Promise.all(ranked.map(async (target, index) => {
    const profilePath = index === 0 ? outputPath : `${outputPath}.${index}`;
    profilePaths.set(target, profilePath);
    await writeFile(profilePath, `${JSON.stringify(target.profile)}\n`);
  }));
  await writeFile(`${outputPath}.targets.json`, `${JSON.stringify({
    samplingIntervalUs,
    selected: ranked[0]?.targetInfo,
    targets: targets.map((target) => ({
      targetInfo: target.targetInfo,
      profilePath: profilePaths.get(target),
      samples: target.profile?.samples?.length || 0,
      workSamples: target.profile ? workSampleCount(target.profile) : 0,
      started: Boolean(target.started),
      recursiveAttachError: target.recursiveAttachError,
      error: target.error,
    })),
  }, null, 2)}\n`);
  return ranked[0];
}

export function createWorkerProfiler(session, samplingIntervalUs) {
  let commandId = 0;
  const pending = new Map();
  const targets = new Map();
  const parents = new Map();
  const starts = [];

  const send = async (sessionId, method, params = {}) => {
    const id = ++commandId;
    const key = `${sessionId}:${id}`;
    const response = new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
    response.catch(() => {});
    const message = JSON.stringify({ id, method, params });
    try {
      const parentSessionId = parents.get(sessionId);
      if (parentSessionId) {
        await send(parentSessionId, "Target.sendMessageToTarget", { sessionId, message });
      } else {
        await session.send("Target.sendMessageToTarget", { sessionId, message });
      }
    } catch (error) {
      pending.delete(key);
      throw error;
    }
    return response;
  };

  const handleDetached = (sessionId) => {
    const target = targets.get(sessionId);
    if (target && !target.profile) target.error ??= "target detached before profile collection";
    for (const [key, waiter] of pending) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      pending.delete(key);
      waiter.reject(new Error("target detached"));
    }
  };

  const handleAttached = (sessionId, targetInfo, parentSessionId) => {
    if (targetInfo.type !== "worker" || targets.has(sessionId)) return;
    parents.set(sessionId, parentSessionId);
    const target = { sessionId, targetInfo };
    targets.set(sessionId, target);
    starts.push((async () => {
      try {
        await send(sessionId, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: false,
        });
      } catch (error) {
        target.recursiveAttachError = error instanceof Error ? error.message : String(error);
      }
      try {
        await send(sessionId, "Profiler.enable");
        await send(sessionId, "Profiler.setSamplingInterval", { interval: samplingIntervalUs });
        await send(sessionId, "Profiler.start");
        target.started = true;
      } catch (error) {
        target.error = error instanceof Error ? error.message : String(error);
      }
    })());
  };

  const handleMessage = (sessionId, message) => {
    const payload = JSON.parse(message);
    if (payload.id) {
      const waiter = pending.get(`${sessionId}:${payload.id}`);
      if (!waiter) return;
      pending.delete(`${sessionId}:${payload.id}`);
      if (payload.error) waiter.reject(new Error(`${payload.error.code}: ${payload.error.message}`));
      else waiter.resolve(payload.result || {});
      return;
    }
    if (payload.method === "Target.receivedMessageFromTarget") {
      handleMessage(payload.params.sessionId, payload.params.message);
    } else if (payload.method === "Target.attachedToTarget") {
      handleAttached(payload.params.sessionId, payload.params.targetInfo, sessionId);
    } else if (payload.method === "Target.detachedFromTarget") {
      handleDetached(payload.params.sessionId);
    }
  };
  session.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
    handleMessage(sessionId, message);
  });
  session.on("Target.detachedFromTarget", ({ sessionId }) => handleDetached(sessionId));
  session.on("Target.attachedToTarget", ({ sessionId, targetInfo }) => {
    handleAttached(sessionId, targetInfo, undefined);
  });

  return {
    async start() {
      await session.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
    },
    async stop() {
      await Promise.allSettled(starts);
      await Promise.all([...targets.values()].map(async (target) => {
        if (!target.started) return;
        try {
          const { profile } = await send(target.sessionId, "Profiler.stop");
          target.profile = profile;
        } catch (error) {
          target.error = error instanceof Error ? error.message : String(error);
        }
      }));
      await session.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: false,
      });
      return [...targets.values()];
    },
  };
}

// Self time names the cost; the callers name the code to change. Walks the sample tree upwards from
// every node whose function is `name` and reports the callers by the samples they account for.
export function callersOf(profile, name, limit = 8, { depth = 1, lastSeconds = 0 } = {}) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children || []) parents.set(child, node.id);
  }
  const counts = new Map();
  let total = 0;
  for (const id of windowed(profile, lastSeconds)) {
    if (byId.get(id)?.callFrame.functionName !== name) continue;
    // Every wasm call into a JS import goes through a trampoline frame; the code that wanted the
    // import is above it. A thin wrapper is not an answer either, so `depth` frames are reported.
    const chain = [];
    let parent = byId.get(parents.get(id));
    while (parent && chain.length < depth) {
      if (!TRAMPOLINE_FRAMES.includes(parent.callFrame.functionName)) {
        chain.push(parent.callFrame.functionName || "(anonymous)");
      }
      parent = byId.get(parents.get(parent.id));
    }
    const caller = chain.length ? chain.join(" <- ") : "(root)";
    counts.set(caller, (counts.get(caller) ?? 0) + 1);
    total++;
  }
  return [...counts]
    .map(([caller, samples]) => ({ caller, samples, percent: (samples / (total || 1)) * 100 }))
    .sort((left, right) => right.samples - left.samples)
    .slice(0, limit);
}

// Flattens a profile into self-time per function, which is what says where the frame went. One
// function reached down several call paths gets a node per path, so the rows are merged by name:
// unmerged, an interpreter helper called from four opcodes reads as four small entries. Waiting is
// excluded unless asked for, and percentages are over what is included — a worker that spends its
// life in a futex would otherwise report nothing but the futex.
export function selfTime(profile, limit = 25, { includeWaits = false, lastSeconds = 0 } = {}) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const merged = new Map();
  let total = 0;
  for (const id of windowed(profile, lastSeconds)) {
    const node = byId.get(id);
    if (!node) continue;
    const { functionName, url } = node.callFrame;
    const name = functionName || "(anonymous)";
    if (!includeWaits && IDLE_FRAMES.includes(name)) continue;
    const row = merged.get(name) ?? { name, where: (url || "").split("/").pop(), samples: 0 };
    row.samples++;
    merged.set(name, row);
    total++;
  }
  return [...merged.values()]
    .map((row) => ({ ...row, percent: (row.samples / (total || 1)) * 100 }))
    .sort((left, right) => right.samples - left.samples)
    .slice(0, limit);
}
