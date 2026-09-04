// CPU sampling profiler across a page and every worker under it. RPCS3's threads are workers, so a
// profile of the page alone shows nothing; this attaches to each target, samples it, and ranks the
// results by the samples that are not idle or waiting on a futex.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IDLE_FRAMES = ["(idle)", "(program)", "(garbage collector)", "emscripten_futex_wait", "_do_futex_wait"];

export function workSampleCount(profile) {
  const waitNodes = new Set(profile.nodes
    .filter(({ callFrame }) => IDLE_FRAMES.includes(callFrame.functionName))
    .map(({ id }) => id));
  return (profile.samples || []).reduce((count, id) => count + !waitNodes.has(id), 0);
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

// Flattens a profile into self-time per function, which is what says where the frame went.
export function selfTime(profile, limit = 25) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const counts = new Map();
  for (const id of profile.samples || []) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const total = (profile.samples || []).length || 1;
  const rows = [];
  for (const [id, count] of counts) {
    const node = byId.get(id);
    if (!node) continue;
    const { functionName, url } = node.callFrame;
    rows.push({
      name: functionName || "(anonymous)",
      where: (url || "").split("/").pop(),
      samples: count,
      percent: (count / total) * 100,
    });
  }
  return rows.sort((left, right) => right.samples - left.samples).slice(0, limit);
}
