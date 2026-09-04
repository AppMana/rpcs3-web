// Static "library" server for same-origin OPFS imports. It serves an explicit
// allowlist of files (and every regular file of allowlisted directories) with
// exact HTTP Range semantics, HEAD, strong ETags, `Cache-Control: no-store`,
// and `Cross-Origin-Resource-Policy: same-origin`, plus a JSON index carrying
// each file's size and SHA-256. The Ingress mounts it under /library/ on the
// same origin as the app; `vite preview` proxies the same prefix locally.
//
//   node scripts/serve-library.mjs [--port 4181] [--host 0.0.0.0] [--prefix /library]
//                                  [--dir <directory>]... [--file <file>]... [--cache <hashes.json>]
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRangeRequest } from "../public/library-import-core.mjs";

export const DEFAULT_PORT = 4181;
export const DEFAULT_PREFIX = "/library";
const STREAM_HIGH_WATER_MARK = 1024 * 1024;

export function strongETag(fileStat) {
  return `"${fileStat.size}-${Math.floor(fileStat.mtimeMs)}"`;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const piece of createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 })) hash.update(piece);
  return hash.digest("hex");
}

async function collectEntries({ files = [], directories = [] }, log) {
  const entries = new Map();
  const add = async (filePath) => {
    const resolved = await realpath(filePath);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) return;
    const name = path.basename(resolved);
    if (name.startsWith(".")) return;
    if (entries.has(name)) {
      if (entries.get(name).path !== resolved) log(`library: ignoring ${resolved}; "${name}" already maps to ${entries.get(name).path}`);
      return;
    }
    entries.set(name, { name, path: resolved, size: fileStat.size, mtimeMs: fileStat.mtimeMs, modified: fileStat.mtime.toISOString(), etag: strongETag(fileStat), sha256: null });
  };
  for (const directory of directories) {
    const resolved = await realpath(directory);
    const names = (await readdir(resolved, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
    for (const name of names) await add(path.join(resolved, name));
  }
  for (const file of files) await add(file);
  return entries;
}

async function loadHashCache(cacheFile) {
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function createLibraryServer(options = {}) {
  const prefix = (options.prefix ?? DEFAULT_PREFIX).replace(/\/+$/, "");
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  const cacheFile = options.cacheFile ?? path.join(homedir(), ".cache", "rpcs3-web-library", "hashes.json");
  const entries = await collectEntries(options, log);
  const cache = await loadHashCache(cacheFile);
  for (const entry of entries.values()) {
    const cached = cache[entry.path];
    if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs && /^[0-9a-f]{64}$/.test(cached.sha256 ?? "")) entry.sha256 = cached.sha256;
  }

  // Digests are computed sequentially in the background; the index reports
  // `hashing: true` and a null sha256 until each one is ready. Files are
  // re-examined on every request: a changed size or mtime replaces the entry
  // (new ETag, digest recomputed) instead of serving bytes under a stale hash.
  const queue = [];
  let hashingActive = false;
  const idleWaiters = [];
  const notifyIdle = () => { if (!hashingActive && !queue.length) while (idleWaiters.length) idleWaiters.shift()(); };
  const whenIdle = () => new Promise((resolve) => { idleWaiters.push(resolve); notifyIdle(); });
  async function pump() {
    if (hashingActive) return;
    hashingActive = true;
    while (queue.length) {
      const entry = queue.shift();
      try {
        const startedAt = Date.now();
        const sha256 = await hashFile(entry.path);
        const fileStat = await stat(entry.path);
        if (fileStat.size === entry.size && fileStat.mtimeMs === entry.mtimeMs) {
          entry.sha256 = sha256;
          cache[entry.path] = { size: entry.size, mtimeMs: entry.mtimeMs, sha256, computedAt: new Date().toISOString() };
          await mkdir(path.dirname(cacheFile), { recursive: true });
          await writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
          log(`library: sha256 ${sha256} ${entry.name} (${entry.size} bytes, ${((Date.now() - startedAt) / 1000).toFixed(1)} s)`);
        } else {
          log(`library: ${entry.name} changed while hashing; retrying`);
        }
      } catch (error) {
        log(`library: hashing ${entry.name} failed: ${error?.message ?? error}`);
      }
      entry.hashing = false;
      if (!entry.sha256 && !entry.missing) await refreshEntry(entry);
    }
    hashingActive = false;
    notifyIdle();
  }
  function scheduleHash(entry) {
    if (entry.sha256 || entry.hashing || entry.missing) return;
    entry.hashing = true;
    queue.push(entry);
    void pump();
  }
  async function refreshEntry(entry) {
    let fileStat;
    try {
      fileStat = await stat(entry.path);
    } catch {
      entry.missing = true;
      return entry;
    }
    if (!fileStat.isFile()) {
      entry.missing = true;
      return entry;
    }
    entry.missing = false;
    if (fileStat.size !== entry.size || fileStat.mtimeMs !== entry.mtimeMs || !entry.etag) {
      Object.assign(entry, { size: fileStat.size, mtimeMs: fileStat.mtimeMs, modified: fileStat.mtime.toISOString(), etag: strongETag(fileStat), sha256: null });
      const cached = cache[entry.path];
      if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs && /^[0-9a-f]{64}$/.test(cached.sha256 ?? "")) entry.sha256 = cached.sha256;
    }
    entry.lastModifiedHeader = fileStat.mtime.toUTCString();
    if (!entry.sha256) scheduleHash(entry);
    return entry;
  }
  for (const entry of entries.values()) await refreshEntry(entry);
  const ready = whenIdle();

  const baseHeaders = {
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  };

  async function indexDocument() {
    for (const entry of entries.values()) await refreshEntry(entry);
    return {
      generatedAt: new Date().toISOString(),
      hashing: hashingActive || queue.length > 0,
      files: Array.from(entries.values()).filter((entry) => !entry.missing).map((entry) => ({
        name: entry.name,
        size: entry.size,
        modified: entry.modified,
        etag: entry.etag,
        sha256: entry.sha256,
        url: `files/${encodeURIComponent(entry.name)}`,
      })),
    };
  }

  function route(url) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(url, "http://library.invalid").pathname);
    } catch {
      return undefined;
    }
    if (prefix && pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length);
    else if (prefix && pathname === prefix) pathname = "/";
    if (pathname === "/" || pathname === "/index.json") return { kind: "index" };
    const match = /^\/files\/([^/]+)$/.exec(pathname);
    if (match && entries.has(match[1])) return { kind: "file", entry: entries.get(match[1]) };
    return undefined;
  }

  const server = createServer(async (request, response) => {
    const method = request.method ?? "GET";
    const startedAt = Date.now();
    const finish = (status, detail = "") => log(`library: ${method} ${request.url} ${status} ${detail} ${Date.now() - startedAt}ms`);
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { ...baseHeaders, Allow: "GET, HEAD" }).end();
      finish(405);
      return;
    }
    const target = route(request.url ?? "/");
    if (!target) {
      response.writeHead(404, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" }).end(method === "HEAD" ? undefined : "not found\n");
      finish(404);
      return;
    }
    if (target.kind === "index") {
      const body = `${JSON.stringify(await indexDocument(), null, 2)}\n`;
      response.writeHead(200, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
      response.end(method === "HEAD" ? undefined : body);
      finish(200, `index ${entries.size} files`);
      return;
    }

    const { entry } = target;
    await refreshEntry(entry);
    if (entry.missing) {
      response.writeHead(404, baseHeaders).end();
      finish(404, "vanished");
      return;
    }
    const headers = {
      ...baseHeaders,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      ETag: entry.etag,
      "Last-Modified": entry.lastModifiedHeader,
    };
    if (entry.sha256) headers["X-Content-Sha256"] = entry.sha256;
    const ifRange = request.headers["if-range"];
    const rangeHeader = ifRange && ifRange !== entry.etag ? undefined : request.headers.range;
    const range = parseRangeRequest(rangeHeader, entry.size);
    if (range.kind === "unsatisfiable") {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${entry.size}`, "Content-Length": 0 }).end();
      finish(416, request.headers.range);
      return;
    }
    let start = 0;
    let end = entry.size - 1;
    let status = 200;
    if (range.kind === "range") {
      ({ start, end } = range);
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${entry.size}`;
    }
    const length = entry.size === 0 ? 0 : end - start + 1;
    headers["Content-Length"] = length;
    response.writeHead(status, headers);
    if (method === "HEAD" || length === 0) {
      response.end();
      finish(status, `${start}-${end} head`);
      return;
    }
    const stream = createReadStream(entry.path, { start, end, highWaterMark: STREAM_HIGH_WATER_MARK });
    response.on("close", () => stream.destroy());
    stream.on("error", (error) => {
      log(`library: read error ${entry.path}: ${error.message}`);
      response.destroy(error);
    });
    stream.on("end", () => finish(status, `${start}-${end} ${length}B`));
    stream.pipe(response);
  });

  const listen = (port = DEFAULT_PORT, host = "0.0.0.0") => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address()));
  });
  const close = () => new Promise((resolve) => server.close(() => resolve()));
  return { server, entries, ready, whenIdle, listen, close, prefix, cacheFile };
}

function parseArguments(argv) {
  const options = { files: [], directories: [], port: DEFAULT_PORT, host: "0.0.0.0", prefix: DEFAULT_PREFIX };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--port": options.port = Number(value); i++; break;
      case "--host": options.host = value; i++; break;
      case "--prefix": options.prefix = value; i++; break;
      case "--cache": options.cacheFile = value; i++; break;
      case "--dir": options.directories.push(value); i++; break;
      case "--file": options.files.push(value); i++; break;
      default: throw new Error(`Unknown argument ${flag}`);
    }
  }
  if (!options.files.length && !options.directories.length) {
    options.directories.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "fixtures"));
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArguments(process.argv.slice(2));
  const library = await createLibraryServer(options);
  const address = await library.listen(options.port, options.host);
  process.stderr.write(`library: listening on http://${address.address}:${address.port}${library.prefix}/ with ${library.entries.size} files\n`);
  for (const entry of library.entries.values()) process.stderr.write(`library:   ${entry.name} (${entry.size} bytes)${entry.sha256 ? "" : " hashing…"}\n`);
  const shutdown = () => { library.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
