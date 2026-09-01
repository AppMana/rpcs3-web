import {
  formatBytes,
  importFiles,
  importFirmware,
  listOPFS,
  requestPersistentStorage,
  storageStatus,
} from "./rpcs3-storage.mjs";

const capacity = document.querySelector("#capacity");
const progress = document.querySelector("#progress");
const transfer = document.querySelector("#transfer");
const boot = document.querySelector("#boot");
let firmwareWorker;

async function updateCapacity() {
  const state = await storageStatus();
  const free = Math.max(0, state.quota - state.usage);
  capacity.className = state.supported ? "good" : "warn";
  capacity.textContent = state.supported
    ? `${formatBytes(state.usage)} used · ${formatBytes(free)} available · ${formatBytes(state.quota)} quota · ${state.persisted ? "persistent" : "best-effort"}`
    : "This browser does not expose origin-private file storage.";
  return state;
}

async function refreshFiles() {
  const entries = await listOPFS();
  document.querySelector("#files").textContent = entries.length
    ? entries.map((entry) => `${formatBytes(entry.size).padStart(11)}  ${entry.path}`).join("\n")
    : "None";
}

function report({ path, written, total }) {
  progress.max = Math.max(1, total);
  progress.value = written;
  transfer.textContent = `${path} · ${formatBytes(written)} / ${formatBytes(total)}`;
}

async function runImport(action) {
  boot.hidden = true;
  progress.value = 0;
  try {
    const result = await action();
    transfer.className = "good";
    transfer.textContent = `Stored ${formatBytes(result.bytes ?? result.size)} successfully`;
    if (result.bootPath) {
      boot.href = `./play.html?boot=${encodeURIComponent(result.bootPath)}`;
      boot.hidden = false;
    }
    await Promise.all([updateCapacity(), refreshFiles()]);
    return result;
  } catch (error) {
    transfer.className = "warn";
    transfer.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

document.querySelector("#persist").addEventListener("click", async () => {
  const state = await requestPersistentStorage();
  await updateCapacity();
  transfer.textContent = state.persisted
    ? "The browser granted persistent storage."
    : "Storage remains best-effort; keep ample free device space and retain the source files.";
});

document.querySelector("#firmware").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) void runImport(() => importFirmware(file, report));
});

document.querySelector("#install-firmware").addEventListener("click", () => {
  firmwareWorker?.terminate();
  firmwareWorker = new Worker("./firmware-install-worker.mjs", { type: "module" });
  transfer.className = "";
  transfer.textContent = "Validating and installing firmware with RPCS3…";
  firmwareWorker.addEventListener("message", (event) => {
    if (event.data?.type === "rpcs3-firmware-started") {
      progress.max = event.data.value;
      progress.value = 0;
      return;
    }
    if (event.data?.type === "rpcs3-firmware-progress") {
      progress.value = event.data.value;
      transfer.textContent = `Installing firmware package ${event.data.value} / ${progress.max}`;
      return;
    }
    if (event.data?.type !== "firmware-result") return;
    window.__rpcs3FirmwareResult = event.data;
    firmwareWorker = undefined;
    transfer.className = event.data.ok ? "good" : "warn";
    transfer.textContent = event.data.ok
      ? `Firmware installed: ${event.data.progress} packages in ${(event.data.elapsedMs / 1000).toFixed(1)} s`
      : `Firmware installation failed (RPCS3 result ${event.data.result ?? "worker"}): ${event.data.detail ?? event.data.logs?.at(-1) ?? "unknown error"}`;
    void Promise.all([updateCapacity(), refreshFiles()]);
  });
  firmwareWorker.addEventListener("error", (event) => {
    firmwareWorker = undefined;
    transfer.className = "warn";
    transfer.textContent = event.message || "Firmware worker failed";
  });
  firmwareWorker.postMessage({ type: "install-firmware", path: "/opfs/firmware/PS3UPDAT.PUP" });
});

document.querySelector("#iso").addEventListener("change", (event) => {
  if (event.target.files.length) void runImport(() => importFiles(event.target.files, { destination: "games", onProgress: report }));
});

document.querySelector("#directory").addEventListener("change", (event) => {
  if (event.target.files.length) void runImport(() => importFiles(event.target.files, { destination: "games", onProgress: report }));
});

document.querySelector("#refresh").addEventListener("click", refreshFiles);

window.__rpcs3Storage = {
  status: storageStatus,
  persist: requestPersistentStorage,
  list: listOPFS,
  importFiles,
  importFirmware,
};

await Promise.all([updateCapacity(), refreshFiles()]);
