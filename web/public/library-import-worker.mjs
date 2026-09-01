// Dedicated worker that copies one file from the same-origin library server
// into OPFS with HTTP Range requests, writing every body piece straight into a
// FileSystemSyncAccessHandle (Safari has no createWritable) and hashing it on
// the way. Nothing larger than one network read is held in memory, requests
// are `cache: "no-store"` so Safari keeps no second copy, and a sidecar JSON
// records the source identity plus the running SHA-256 state so an
// interrupted import resumes from the bytes already on disk.
import {
  DEFAULT_CHUNK_SIZE,
  LIBRARY_IMPORT_SIDECAR_VERSION,
  createSha256,
  parseContentRange,
  planChunks,
  planResume,
  sidecarPathFor,
} from "./library-import-core.mjs";

const scope = self;
const LOCAL_READ_SIZE = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 200;

let abortController;
let abortRequested = false;

class ImportAbort extends Error {
  constructor() {
    super("Import aborted");
    this.name = "AbortError";
  }
}

function errorDetail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function directoryFor(root, parts, create) {
  let directory = root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create });
  return directory;
}

async function openSidecar(root, path, create) {
  const parts = path.split("/");
  const name = parts.pop();
  try {
    const directory = await directoryFor(root, parts, create);
    return await directory.getFileHandle(name, { create });
  } catch (error) {
    if (!create && (error?.name === "NotFoundError" || error?.name === "TypeMismatchError")) return undefined;
    throw error;
  }
}

async function readSidecar(root, path) {
  const handle = await openSidecar(root, path, false);
  if (!handle) return undefined;
  try {
    const text = await (await handle.getFile()).text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

async function writeSidecar(root, path, record) {
  const handle = await openSidecar(root, path, true);
  const access = await handle.createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
    // Overwrite in place and trim afterwards: WebKit accounts quota by the
    // handle's capacity, which never shrinks, so emptying first would make
    // every rewrite request fresh capacity.
    let written = 0;
    while (written < bytes.length) {
      const count = access.write(bytes.subarray(written), { at: written });
      if (!count) throw new Error("Sidecar write made no progress");
      written += count;
    }
    access.truncate(bytes.length);
    access.flush();
  } finally {
    access.close();
  }
}

function writeAll(access, bytes, at) {
  let written = 0;
  while (written < bytes.length) {
    const count = access.write(written ? bytes.subarray(written) : bytes, { at: at + written });
    if (!count) throw new Error(`OPFS write made no progress at ${at + written}`);
    written += count;
  }
  return written;
}

async function fetchIndex(libraryBase, name, signal) {
  const response = await fetch(new URL("index.json", libraryBase), { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Library index returned HTTP ${response.status}`);
  const index = await response.json();
  const entry = (index.files ?? []).find((file) => file.name === name);
  if (!entry) throw new Error(`"${name}" is not in the library index`);
  return { entry, hashing: Boolean(index.hashing) };
}

async function resolveEntry(libraryBase, name, signal, post) {
  // The server hashes large files in the background after start-up; wait for
  // the digest rather than importing something that cannot be verified.
  const deadline = Date.now() + 30 * 60 * 1000;
  for (;;) {
    const { entry } = await fetchIndex(libraryBase, name, signal);
    if (typeof entry.sha256 === "string") return entry;
    if (Date.now() > deadline) throw new Error(`Library has not finished hashing "${name}"`);
    post({ type: "progress", phase: "waiting-for-hash", offset: 0, total: entry.size, sessionBytes: 0, elapsedMs: 0 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new ImportAbort()); }, { once: true });
    });
  }
}

function fetchChunk(url, chunk, signal) {
  return fetch(url, {
    method: "GET",
    headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
    cache: "no-store",
    credentials: "same-origin",
    signal,
  });
}

async function run(request) {
  const startedAt = performance.now();
  const name = String(request.name);
  const destination = String(request.destination);
  const chunkSize = Number.isSafeInteger(request.chunkSize) && request.chunkSize > 0 ? request.chunkSize : DEFAULT_CHUNK_SIZE;
  const prefetch = request.prefetch === false ? 0 : 1;
  const libraryBase = new URL(request.libraryBase);
  const relativePath = `${destination}/${name}`;
  const sidecarPath = sidecarPathFor(destination, name);
  abortController = new AbortController();
  const { signal } = abortController;
  if (abortRequested) abortController.abort();

  let lastPost = 0;
  const report = {
    name,
    destination,
    path: relativePath,
    mountedPath: `/opfs/${relativePath}`,
    sidecarPath,
    chunkSize,
    requests: 0,
    sessionBytes: 0,
    localRehashedBytes: 0,
    resumedFrom: 0,
    restarted: false,
    resumeReason: "",
    hashImplementation: undefined,
    verified: false,
    alreadyComplete: false,
  };
  const post = (message) => scope.postMessage({ ...message, name, destination });
  const progress = (phase, offset, total, extra = {}, force = false) => {
    const now = performance.now();
    if (!force && now - lastPost < PROGRESS_INTERVAL_MS) return;
    lastPost = now;
    const elapsedMs = now - startedAt;
    post({
      type: "progress",
      phase,
      offset,
      total,
      sessionBytes: report.sessionBytes,
      elapsedMs,
      rateBytesPerSecond: elapsedMs > 0 ? report.sessionBytes / (elapsedMs / 1000) : 0,
      requests: report.requests,
      ...extra,
    });
  };

  const entry = await resolveEntry(libraryBase, name, signal, post);
  const sourceURL = new URL(entry.url ?? `files/${encodeURIComponent(name)}`, libraryBase).href;
  const source = { url: sourceURL, size: entry.size, sha256: entry.sha256, etag: entry.etag ?? null };
  Object.assign(report, { size: entry.size, expectedSha256: entry.sha256, etag: source.etag, sourceURL });

  const root = await navigator.storage.getDirectory();
  const directory = await directoryFor(root, destination.split("/"), true);
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const access = await fileHandle.createSyncAccessHandle();
  let sidecar = { version: LIBRARY_IMPORT_SIDECAR_VERSION, name, destination, path: relativePath, source, chunkSize, hashed: 0, hashState: undefined, complete: false, sha256: undefined, updatedAt: undefined };
  let hasher;
  let offset = 0;
  const persistSidecar = async (extra = {}) => {
    sidecar = { ...sidecar, hashed: offset, hashState: hasher && !hasher.finalized ? hasher.exportState() : undefined, updatedAt: new Date().toISOString(), ...extra };
    await writeSidecar(root, sidecarPath, sidecar);
  };

  try {
    const existingSidecar = await readSidecar(root, sidecarPath);
    const existingSize = access.getSize();
    const plan = request.restart
      ? { restart: true, hashed: 0, hashState: undefined, alreadyComplete: false, reason: "restart requested" }
      : planResume({ entry: source, sidecar: existingSidecar, existingSize });
    report.resumeReason = plan.reason;
    report.existingBytes = existingSize;

    if (plan.alreadyComplete && !request.verify) {
      report.alreadyComplete = true;
      report.verified = true;
      report.sha256 = existingSidecar.sha256;
      report.resumedFrom = existingSize;
      report.elapsedMs = performance.now() - startedAt;
      return report;
    }

    if (plan.restart) {
      access.truncate(0);
      report.restarted = true;
    }
    hasher = await createSha256(plan.alreadyComplete ? undefined : plan.hashState);
    report.hashImplementation = hasher.implementation;
    offset = plan.alreadyComplete ? 0 : plan.hashed;
    const trustedSize = plan.restart ? 0 : existingSize;

    // Bytes on disk beyond the sidecar's hash state are re-hashed locally so the
    // final digest covers exactly what the file holds.
    if (offset < trustedSize) {
      const buffer = new Uint8Array(LOCAL_READ_SIZE);
      while (offset < trustedSize) {
        if (signal.aborted) throw new ImportAbort();
        const count = access.read(buffer, { at: offset });
        if (!count) throw new Error(`OPFS read made no progress at ${offset}`);
        const piece = buffer.subarray(0, Math.min(count, trustedSize - offset));
        hasher.update(piece);
        offset += piece.length;
        report.localRehashedBytes += piece.length;
        progress("verifying-local", offset, entry.size);
      }
    }
    report.resumedFrom = offset;
    if (offset < trustedSize) throw new Error("Local verification did not reach the existing size");
    if (existingSize > offset) access.truncate(offset);
    await persistSidecar();

    const chunks = planChunks(offset, entry.size, chunkSize);
    report.chunks = chunks.length;
    const pending = [];
    const schedule = (index) => {
      if (index < chunks.length && !pending.some((item) => item.index === index)) {
        const response = fetchChunk(sourceURL, chunks[index], signal);
        // A prefetched request may be abandoned by an abort or error before it is awaited.
        response.catch(() => {});
        pending.push({ index, response });
        report.requests += 1;
      }
    };
    let windowStart = performance.now();
    let windowBytes = 0;
    let instantRate = 0;
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      schedule(index);
      for (let ahead = 1; ahead <= prefetch; ahead++) schedule(index + ahead);
      const current = pending.shift();
      const response = await current.response;
      if (response.status !== 206) throw new Error(`Range request for bytes ${chunk.start}-${chunk.end} returned HTTP ${response.status}`);
      const contentRange = parseContentRange(response.headers.get("content-range"));
      if (!contentRange || contentRange.start !== chunk.start || contentRange.end !== chunk.end || contentRange.total !== entry.size) {
        throw new Error(`Unexpected Content-Range "${response.headers.get("content-range")}" for bytes ${chunk.start}-${chunk.end}`);
      }
      const etag = response.headers.get("etag");
      if (source.etag && etag && etag !== source.etag) throw new Error(`Source changed during import (ETag ${etag} != ${source.etag})`);
      if (!response.body) throw new Error("Range response has no body stream");
      const reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset !== chunk.start + received) throw new Error("Write offset diverged from the chunk position");
        if (received + value.length > chunk.length) throw new Error(`Server sent more than ${chunk.length} bytes for one range`);
        writeAll(access, value, offset);
        hasher.update(value);
        offset += value.length;
        received += value.length;
        report.sessionBytes += value.length;
        windowBytes += value.length;
        const now = performance.now();
        if (now - windowStart >= 1000) {
          instantRate = windowBytes / ((now - windowStart) / 1000);
          windowStart = now;
          windowBytes = 0;
        }
        progress("downloading", offset, entry.size, { chunk: index + 1, chunks: chunks.length, instantRateBytesPerSecond: instantRate });
      }
      if (received !== chunk.length) throw new Error(`Range for bytes ${chunk.start}-${chunk.end} ended after ${received} of ${chunk.length} bytes`);
      access.flush();
      await persistSidecar();
      progress("downloading", offset, entry.size, { chunk: index + 1, chunks: chunks.length, instantRateBytesPerSecond: instantRate }, true);
    }

    access.flush();
    const finalSize = access.getSize();
    if (finalSize !== entry.size || offset !== entry.size) throw new Error(`Final size ${finalSize} does not match the library size ${entry.size}`);
    const digest = hasher.digestHex();
    report.sha256 = digest;
    if (digest !== entry.sha256) {
      access.truncate(0);
      offset = 0;
      hasher = undefined;
      await persistSidecar({ complete: false, sha256: undefined, lastError: `SHA-256 mismatch: got ${digest}, expected ${entry.sha256}` });
      throw new Error(`SHA-256 mismatch after download: got ${digest}, expected ${entry.sha256}; the file was truncated`);
    }
    report.verified = true;
    hasher = undefined;
    await persistSidecar({ complete: true, sha256: digest, lastError: undefined });
    report.elapsedMs = performance.now() - startedAt;
    report.rateBytesPerSecond = report.elapsedMs > 0 ? report.sessionBytes / (report.elapsedMs / 1000) : 0;
    return report;
  } catch (error) {
    abortController.abort();
    // Whatever reached the disk is recorded with its exact hash state so the
    // next attempt continues from here; the file never exists without a sidecar.
    try {
      access.flush();
      if (hasher && !hasher.finalized) await persistSidecar({ complete: false, lastError: errorDetail(error) });
    } catch (sidecarError) {
      console.warn("Could not persist the import sidecar", sidecarError);
    }
    report.elapsedMs = performance.now() - startedAt;
    report.rateBytesPerSecond = report.elapsedMs > 0 ? report.sessionBytes / (report.elapsedMs / 1000) : 0;
    report.offset = offset;
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  } finally {
    access.close();
  }
}

scope.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.type === "abort") {
    abortRequested = true;
    abortController?.abort();
    return;
  }
  if (message?.type !== "start") return;
  try {
    const report = await run(message);
    scope.postMessage({ type: "done", report });
  } catch (error) {
    const aborted = error?.name === "AbortError" || abortRequested;
    scope.postMessage({ type: aborted ? "aborted" : "error", message: errorDetail(error), report: error?.report });
  }
});
