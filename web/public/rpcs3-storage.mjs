// RPCS3's view of origin-private storage: the @appmana-public/disc-images
// page API mounted at /opfs, plus the two rules only RPCS3 knows, which
// imported file boots and where firmware goes. The package is staged under
// ./vendor/ by scripts/stage-coi.mjs because public/ is served verbatim; its
// import worker (vendor/disc-images/browser/import-worker.js) is a plain
// same-origin module resolved relative to the staged index.
import {
  DEFAULT_CHUNK_SIZE,
  abortImport,
  fetchIndex,
  formatBytes,
  formatRate,
  importFile,
  importFiles as importFilesIntoStorage,
  importFromURL,
  importProgress,
  list,
  mountPath,
  normalizeRelativePath,
  requestPersistentStorage,
  resolveIndexEntry,
  storageStatus,
} from "./vendor/disc-images/browser/index.js";

export const RPCS3_OPFS_MOUNT = "/opfs";
export { DEFAULT_CHUNK_SIZE, formatBytes, formatRate, normalizeRelativePath, requestPersistentStorage, storageStatus };
export { abortImport as abortLibraryImport, importProgress as libraryImportProgress };

export function opfsPath(relativePath) {
  return mountPath(relativePath, RPCS3_OPFS_MOUNT);
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
  const result = await importFilesIntoStorage(files, { destination: "games", ...options, mountRoot: RPCS3_OPFS_MOUNT });
  return { ...result, bootPath: gameBootPath(result.files) };
}

export async function importFirmware(file, onProgress = () => {}) {
  const path = "firmware/PS3UPDAT.PUP";
  const result = await importFile(file, path, {
    mountRoot: RPCS3_OPFS_MOUNT,
    onProgress: (message) => onProgress({ path, written: message.offset, total: message.total }),
  });
  return { path: result.path, size: result.size, mountedPath: result.mountedPath };
}

export function listOPFS(options = {}) {
  if (!navigator.storage?.getDirectory) return Promise.resolve([]);
  return list({ includeManifests: true, ...options });
}

// Same-origin library imports: /library/ on this origin (an Ingress path or
// the preview server's proxy to scripts/serve-library.mjs).
export function defaultLibraryBase() {
  return new URL("./library/", import.meta.url).href;
}

export function fetchLibraryIndex(libraryBase = defaultLibraryBase()) {
  return fetchIndex(libraryBase);
}

/**
 * Downloads `name` from the library into OPFS `<destination>/<name>` with
 * resumable Range requests and returns the verified report. Progress is
 * available through `onProgress` and `libraryImportProgress()`.
 */
export async function importFromLibrary(name, destination = "games", options = {}) {
  if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\")) throw new TypeError("Library names are plain file names");
  const target = normalizeRelativePath(destination);
  const libraryBase = options.libraryBase ?? defaultLibraryBase();
  // The server hashes large files in the background after start-up; wait for
  // the digest rather than importing something that cannot be verified.
  const entry = await resolveIndexEntry(libraryBase, name, {
    onWaiting: (waiting) => options.onProgress?.({ type: "progress", phase: "waiting-for-hash", offset: 0, total: waiting.size, sessionBytes: 0, elapsedMs: 0, rateBytesPerSecond: 0 }),
  });
  const report = await importFromURL(entry.url, `${target}/${name}`, {
    size: entry.size,
    sha256: entry.sha256,
    etag: entry.etag ?? null,
    chunkSize: options.chunkSize,
    prefetch: options.prefetch,
    restart: Boolean(options.restart),
    verify: Boolean(options.verify),
    mountRoot: RPCS3_OPFS_MOUNT,
    onProgress: options.onProgress,
  });
  return { ...report, bootPath: gameBootPath([report.path]) };
}
