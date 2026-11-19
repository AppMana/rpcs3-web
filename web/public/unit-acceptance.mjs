const worker = new Worker("./unit-smoke-worker.mjs", { type: "module" });
const filter = new URL(location.href).searchParams.get("gtest_filter") || undefined;
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("RPCS3 Wasm units timed out")), 60_000);
  worker.addEventListener("message", (event) => {
    if (event.data?.type !== "unit-result") return;
    clearTimeout(timer);
    resolve(event.data);
  });
  worker.addEventListener("error", (event) => {
    clearTimeout(timer);
    reject(new Error(event.message || "RPCS3 Wasm unit worker failed"));
  });
  worker.postMessage({ type: "run-units", filter });
});

globalThis.__rpcs3UnitResult = {
  ...result,
  userAgent: navigator.userAgent,
  crossOriginIsolated,
};
document.querySelector("#status").textContent = JSON.stringify(globalThis.__rpcs3UnitResult, null, 2);
worker.terminate();
