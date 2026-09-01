function run() {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./ppu-aot-worker.mjs", { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("RPCS3 PPU AOT acceptance timed out"));
    }, 120_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.type !== "result") return;
      clearTimeout(timeout);
      worker.terminate();
      document.querySelector("#result").textContent = JSON.stringify(event.data, null, 2);
      resolve(event.data);
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || "RPCS3 PPU AOT worker failed"));
    }, { once: true });
    worker.postMessage({ type: "run" });
  });
}

window.__rpcs3PpuAot = { run };
