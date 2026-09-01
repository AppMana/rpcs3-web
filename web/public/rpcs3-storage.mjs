export const RPCS3_OPFS_MOUNT = "/opfs";

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
        const file = await handle.getFile();
        entries.push({ path, size: file.size, modified: file.lastModified });
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
