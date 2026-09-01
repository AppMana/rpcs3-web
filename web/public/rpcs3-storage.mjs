import { DEFAULT_CHUNK_SIZE, formatRate } from "./library-import-core.mjs";

export const RPCS3_OPFS_MOUNT = "/opfs";
export { DEFAULT_CHUNK_SIZE, formatRate };

export function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.includes("\0")) throw new TypeError("Invalid storage path");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/")) throw new TypeError("Storage paths must be relative");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) throw new TypeError("Storage path escapes OPFS");
  return parts.join("/");
}

export function opfsPath(relativePath) {
  return `${RPCS3_OPFS_MOUNT}/${normalizeRelativePath(relativePath)}`;
}

export async function storageStatus() {
  const supported = Boolean(navigator.storage?.getDirectory);
  if (!supported) return { supported: false, persisted: false, quota: 0, usage: 0 };
  const [persisted, estimate] = await Promise.all([
    navigator.storage.persisted?.() ?? false,
    navigator.storage.estimate(),
  ]);
  return {
    supported,
    persisted: Boolean(persisted),
    quota: Number(estimate.quota ?? 0),
    usage: Number(estimate.usage ?? 0),
  };
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.getDirectory) throw new Error("Origin-private file storage is unavailable");
  const granted = await navigator.storage.persist?.();
  return { ...(await storageStatus()), granted: Boolean(granted) };
}

async function directoryFor(root, parts, create = true) {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

export async function writeFileToOPFS(file, relativePath, onProgress = () => {}) {
  const path = normalizeRelativePath(relativePath);
  const parts = path.split("/");
  const name = parts.pop();
  const root = await navigator.storage.getDirectory();
  const directory = await directoryFor(root, parts);
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable({ keepExistingData: false });
  let written = 0;
  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      written += value.byteLength;
      onProgress({ path, written, total: file.size });
    }
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => {});
    throw error;
  }
  return { path, size: written, mountedPath: opfsPath(path) };
}

export function gameBootPath(importedPaths) {
  for (const path of importedPaths) {
    if (/\.iso$/i.test(path)) return opfsPath(path);
    const marker = "/PS3_GAME/USRDIR/EBOOT.BIN";
    const index = path.toUpperCase().indexOf(marker);
    if (index >= 0) return opfsPath(path.slice(0, index));
  }
  return undefined;
}

export async function importFiles(files, options = {}) {
  const destination = normalizeRelativePath(options.destination ?? "games");
  const selected = Array.from(files);
  const total = selected.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  const imported = [];
  for (const file of selected) {
    const sourcePath = normalizeRelativePath(file.webkitRelativePath || file.name);
    const result = await writeFileToOPFS(file, `${destination}/${sourcePath}`, ({ written }) => {
      options.onProgress?.({ path: sourcePath, written: completed + written, total });
    });
    completed += file.size;
    imported.push(result.path);
  }
  return { files: imported, bytes: completed, bootPath: gameBootPath(imported) };
}

export async function importFirmware(file, onProgress) {
  return writeFileToOPFS(file, "firmware/PS3UPDAT.PUP", onProgress);
}

export async function listOPFS(maxEntries = 5000) {
  if (!navigator.storage?.getDirectory) return [];
  const root = await navigator.storage.getDirectory();
  const entries = [];
  async function visit(directory, prefix) {
    for await (const [name, handle] of directory.entries()) {
      if (entries.length >= maxEntries) return;
      const path = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === "directory") {
        await visit(handle, path);
      } else {
        try {
          const file = await handle.getFile();
          entries.push({ path, size: file.size, modified: file.lastModified });
        } catch (error) {
          // A file with an open sync access handle (an import in progress) is
          // locked in Safari; report it rather than failing the whole listing.
          entries.push({ path, size: undefined, modified: undefined, locked: true, error: error?.name });
        }
      }
    }
  }
  await visit(root, "");
  return entries;
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** unit)).toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

// Same-origin library imports (HTTP Range downloads written to OPFS by
// library-import-worker.mjs). Only one import runs at a time per page.

export function defaultLibraryBase() {
  return new URL("./library/", import.meta.url).href;
}

export async function fetchLibraryIndex(libraryBase = defaultLibraryBase()) {
  const response = await fetch(new URL("index.json", libraryBase), { cache: "no-store" });
  if (!response.ok) throw new Error(`Library index returned HTTP ${response.status}`);
  return response.json();
}

let activeLibraryImport;

function estimateSnapshot(state) {
  return { quota: state.quota, usage: state.usage, persisted: state.persisted };
}

/**
 * Downloads `name` from the library into OPFS `<destination>/<name>` with
 * resumable Range requests and returns the verified report. Progress is
 * available through `onProgress` and `libraryImportProgress()`.
 */
export function importFromLibrary(name, destination = "games", options = {}) {
  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\")) throw new TypeError("Library names are plain file names");
  const target = normalizeRelativePath(destination);
  if (activeLibraryImport?.running) throw new Error(`An import of ${activeLibraryImport.name} is already running`);
  if (!navigator.storage?.getDirectory) throw new Error("Origin-private file storage is unavailable");
  const state = { running: true, name, destination: target, startedAt: Date.now(), progress: undefined, result: undefined, error: undefined, worker: undefined };
  activeLibraryImport = state;
  state.promise = (async () => {
    const persistGranted = Boolean(await navigator.storage.persist?.().catch(() => false));
    const before = estimateSnapshot(await storageStatus());
    const worker = new Worker(new URL("./library-import-worker.mjs", import.meta.url), { type: "module" });
    state.worker = worker;
    try {
      const report = await new Promise((resolve, reject) => {
        worker.addEventListener("message", (event) => {
          const message = event.data;
          if (message?.type === "progress") {
            state.progress = message;
            options.onProgress?.(message);
          } else if (message?.type === "done") {
            resolve(message.report);
          } else if (message?.type === "aborted" || message?.type === "error") {
            reject(Object.assign(new Error(message.message), { name: message.type === "aborted" ? "AbortError" : "Error", report: message.report }));
          }
        });
        worker.addEventListener("error", (event) => reject(new Error(event.message || "Library import worker failed")));
        worker.postMessage({
          type: "start",
          name,
          destination: target,
          libraryBase: options.libraryBase ?? defaultLibraryBase(),
          chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
          prefetch: options.prefetch,
          restart: Boolean(options.restart),
          verify: Boolean(options.verify),
        });
      });
      const after = estimateSnapshot(await storageStatus());
      const result = {
        ...report,
        persistGranted,
        estimateBefore: before,
        estimateAfter: after,
        usageDelta: after.usage - before.usage,
        bootPath: gameBootPath([report.path]),
      };
      state.result = result;
      return result;
    } catch (error) {
      const after = estimateSnapshot(await storageStatus().catch(() => ({})));
      state.error = { name: error?.name, message: error?.message, report: error?.report, estimateBefore: before, estimateAfter: after };
      throw error;
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      worker.terminate();
    }
  })();
  return state.promise;
}

/** JSON-safe snapshot of the current or last library import for pollers such as the device runner. */
export function libraryImportProgress() {
  const state = activeLibraryImport;
  if (!state) return { running: false };
  return {
    running: state.running,
    name: state.name,
    destination: state.destination,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    progress: state.progress,
    result: state.result,
    error: state.error,
  };
}

export function abortLibraryImport() {
  const state = activeLibraryImport;
  if (!state?.running) return false;
  state.worker?.postMessage({ type: "abort" });
  return true;
}
