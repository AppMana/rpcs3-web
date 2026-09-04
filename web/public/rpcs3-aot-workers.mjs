// Delivers an AOT table layout to every Emscripten pthread worker, present and
// future, and waits for the idle ones to acknowledge. WebAssembly tables are
// per instance, so each worker instantiates the same modules at the same
// indices (web/host/rpcs3_web_pre.js); it does so lazily, when a PPU or SPU
// thread first runs on it, so service threads do not pay the per-instance
// JS-heap cost. A worker busy running a thread reads its queue only once idle,
// so the message waits there and is applied before any later "run".
export function broadcastAotLoad({ module, key, load, readyTimeoutMs = 60_000 }) {
  const PThread = module.PThread;
  const populated = new WeakSet();
  const pending = new Map();
  const status = new Map();
  const ready = { workersReady: 0, errors: [] };
  const readyKey = `${key}Ready`;
  const errorKey = `${key}Error`;
  const send = (worker) => {
    if (populated.has(worker)) return;
    populated.add(worker);
    // Uncaught errors forwarded by the worker hook (stays registered for the worker's lifetime)
    worker.addEventListener("message", (event) => {
      const data = event.data;
      if (data && typeof data.rpcs3WorkerError === "string") {
        console.log(`[rpcs3 worker error] ${data.rpcs3WorkerError}`);
        // An uncaught error in a pthread worker reaches the page as an opaque ErrorEvent, so the
        // stack the worker hook forwarded is the only account of what actually failed
        self.postMessage({ type: "worker-error", error: data.rpcs3WorkerError.slice(0, 2000) });
      }
    });
    const promise = new Promise((resolve) => {
      worker.addEventListener("message", function listener(event) {
        const data = event.data;
        if (data && typeof data[readyKey] === "number") {
          worker.removeEventListener("message", listener);
          ready.workersReady += 1;
          status.set(worker, "ready");
          resolve();
        } else if (data && data[errorKey]) {
          worker.removeEventListener("message", listener);
          ready.errors.push(data[errorKey]);
          resolve();
        }
      });
    });
    pending.set(worker, promise);
    // Bounded, slow resend: a worker still loading its own wasm queues early messages through
    // Emscripten's handler, which drops unknown ones.
    let attempts = 0;
    const resend = setInterval(() => {
      if (++attempts > 20) { clearInterval(resend); return; }
      worker.postMessage({ [key]: load });
    }, 3000);
    promise.then(() => clearInterval(resend));
    worker.postMessage({ [key]: load });
  };
  const idle = [...PThread.unusedWorkers];
  for (const worker of idle) send(worker);
  for (const worker of Object.values(PThread.pthreads ?? {})) if (worker && typeof worker.postMessage === "function") send(worker);
  const originalLoad = PThread.loadWasmModuleToWorker;
  PThread.loadWasmModuleToWorker = (worker) => {
    const result = originalLoad.call(PThread, worker);
    send(worker);
    return result;
  };
  const originalReturn = PThread.returnWorkerToPool;
  PThread.returnWorkerToPool = (worker) => {
    originalReturn.call(PThread, worker);
    send(worker);
  };
  return Promise.race([
    Promise.all(idle.map((worker) => pending.get(worker))),
    new Promise((resolve) => setTimeout(resolve, readyTimeoutMs)),
  ]).then(() => ({
    idleWorkers: idle.length,
    idleWorkersReady: idle.filter((worker) => status.get(worker) === "ready").length,
    workersReady: ready.workersReady,
    errors: ready.errors,
  }));
}
