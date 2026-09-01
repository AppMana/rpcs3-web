import {
  abortLibraryImport,
  fetchLibraryIndex,
  formatBytes,
  formatRate,
  importFiles,
  importFirmware,
  importFromLibrary,
  libraryImportProgress,
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
    ? entries.map((entry) => `${(entry.locked ? "(importing)" : formatBytes(entry.size)).padStart(11)}  ${entry.path}`).join("\n")
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

const libraryFile = document.querySelector("#library-file");
const libraryDestination = document.querySelector("#library-destination");
const libraryImportButton = document.querySelector("#library-import");
const libraryAbortButton = document.querySelector("#library-abort");
const libraryStatus = document.querySelector("#library-status");

async function refreshLibrary() {
  try {
    const index = await fetchLibraryIndex();
    libraryFile.replaceChildren(...index.files.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.name;
      option.textContent = `${entry.name} · ${formatBytes(entry.size)}${entry.sha256 ? "" : " · hashing…"}`;
      return option;
    }));
    if (!index.files.length) libraryFile.replaceChildren(new Option("Library is empty", ""));
    return index;
  } catch (error) {
    libraryFile.replaceChildren(new Option(`Library unavailable: ${error.message}`, ""));
    return undefined;
  }
}

function describeProgress(message) {
  const percent = message.total ? ((message.offset / message.total) * 100).toFixed(1) : "0.0";
  const phase = message.phase === "verifying-local" ? "verifying stored bytes" : message.phase === "waiting-for-hash" ? "waiting for server hash" : "downloading";
  const rate = message.instantRateBytesPerSecond ? ` · now ${formatRate(message.instantRateBytesPerSecond)}` : "";
  return `${phase} · ${formatBytes(message.offset)} / ${formatBytes(message.total)} · ${percent}% · avg ${formatRate(message.rateBytesPerSecond ?? 0)}${rate} · ${message.requests ?? 0} requests`;
}

async function runLibraryImport(name, destination, options = {}) {
  libraryImportButton.disabled = true;
  libraryAbortButton.disabled = false;
  transfer.className = "";
  libraryStatus.className = "";
  libraryStatus.textContent = `Preparing ${name}…`;
  try {
    const result = await runImport(() => importFromLibrary(name, destination, {
      ...options,
      onProgress: (message) => {
        progress.max = Math.max(1, message.total);
        progress.value = message.offset;
        transfer.textContent = `${destination}/${name} · ${describeProgress(message)}`;
        libraryStatus.textContent = describeProgress(message);
        options.onProgress?.(message);
      },
    }));
    libraryStatus.className = result.verified ? "good" : "warn";
    libraryStatus.textContent = result.alreadyComplete
      ? `${result.path} was already imported and verified (${formatBytes(result.size)})`
      : `${result.path} · ${formatBytes(result.sessionBytes)} downloaded in ${(result.elapsedMs / 1000).toFixed(1)} s (${formatRate(result.rateBytesPerSecond)}) · resumed from ${formatBytes(result.resumedFrom)} · ${result.requests} range requests · SHA-256 ${result.verified ? "verified" : "MISMATCH"} · usage ${formatBytes(result.estimateBefore.usage)} → ${formatBytes(result.estimateAfter.usage)}`;
    return result;
  } catch (error) {
    libraryStatus.className = "warn";
    const partial = error?.report;
    libraryStatus.textContent = `${error.name === "AbortError" ? "Aborted" : "Failed"}: ${error.message}${partial ? ` · ${formatBytes(partial.offset ?? 0)} stored; run again to resume` : ""}`;
    throw error;
  } finally {
    libraryImportButton.disabled = false;
    libraryAbortButton.disabled = true;
  }
}

libraryImportButton.addEventListener("click", () => {
  if (libraryFile.value) void runLibraryImport(libraryFile.value, libraryDestination.value).catch(() => {});
});
libraryAbortButton.addEventListener("click", () => abortLibraryImport());

window.__rpcs3Storage = {
  status: storageStatus,
  persist: requestPersistentStorage,
  list: listOPFS,
  importFiles,
  importFirmware,
  libraryIndex: fetchLibraryIndex,
  importFromLibrary: (name, destination, options) => runLibraryImport(name, destination, options),
  importProgress: libraryImportProgress,
  abortImport: abortLibraryImport,
};

await Promise.all([updateCapacity(), refreshFiles(), refreshLibrary()]);

const parameters = new URLSearchParams(location.search);
const autoImport = parameters.get("import");
if (autoImport) {
  const destination = parameters.get("destination") || (/\.pup$/i.test(autoImport) ? "firmware" : "games");
  libraryFile.value = autoImport;
  libraryDestination.value = destination;
  window.__rpcs3AutoImport = runLibraryImport(autoImport, destination, {
    restart: parameters.get("restart") === "1",
    verify: parameters.get("verify") === "1",
    chunkSize: parameters.get("chunk") ? Number(parameters.get("chunk")) : undefined,
  }).catch((error) => ({ failed: true, error: error.message }));
}
