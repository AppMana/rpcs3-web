// Web-Worker + OPFS + Disk-Cache bootstrap for running RPCS3's unmodified browser Wasm
// modules (rpcs3-web.mjs, rpcs3-spu-llvm.mjs, runtime-smoke-worker.mjs) directly inside
// Node.js v22 worker_threads on Linux desktop without any browser.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Worker as NodeWorker, parentPort, workerData } from "node:worker_threads";

const {
  scriptUrl,
  name = "",
  originUrl,
  publicDir,
  opfsDir,
  recompCacheDir,
} = workerData;

const bootstrapFilePath = fileURLToPath(import.meta.url);

function resolveUrlToLocalPath(rawUrl) {
  const u = new URL(String(rawUrl), originUrl);
  if (u.protocol === "file:") return fileURLToPath(u);
  if (u.origin === new URL(originUrl).origin) {
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    return path.join(publicDir, rel);
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("http://127.0.0.1:") || specifier.startsWith("http://localhost:")) {
      const localPath = resolveUrlToLocalPath(specifier);
      if (localPath) {
        return nextResolve(pathToFileURL(localPath).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

// Persistent binary disk cache shared by all runs of desktop Wasm and compatible with rpcs3-spu-llvm.mjs
function installDiskCache(cacheDir) {
  if (!cacheDir) return;
  fs.mkdirSync(cacheDir, { recursive: true });
  const keyFile = (key) => {
    const hash = crypto.createHash("sha256").update(String(key)).digest("hex");
    return path.join(cacheDir, `${hash}.ps3cache`);
  };

  // Binary format:
  // Magic "RWC1" (4B) | kind (u32: 0=single, 1=recompBundle)
  // kind 0: words(u32), memSize(u32), memAlign(u32), tableSize(u32), importsTable(u32), wasmLen(u32), wasmBytes
  // kind 1: partCount(u32), repeated [memSize, memAlign, tableSize, importsTable, blocks, hleCalls, regionLinks, pairsWordLen, wasmByteLen, pairsBytes, wasmBytes]
  globalThis.__rpcs3DiskCache = {
    get(key) {
      const f = keyFile(key);
      if (!fs.existsSync(f)) return null;
      const buf = fs.readFileSync(f);
      if (buf.byteLength < 8 || buf.toString("ascii", 0, 4) !== "RWC1") return null;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const kind = dv.getUint32(4, true);
      if (kind === 0) {
        if (buf.byteLength < 32) return null;
        const words = dv.getUint32(8, true);
        const memorySize = dv.getUint32(12, true);
        const memoryAlign = dv.getUint32(16, true);
        const tableSize = dv.getUint32(20, true);
        const importsTable = dv.getUint32(24, true) !== 0;
        const wasmLen = dv.getUint32(28, true);
        if (32 + wasmLen > buf.byteLength) return null;
        const bytes = new Uint8Array(buf.buffer, buf.byteOffset + 32, wasmLen).slice();
        return { bytes, words, info: { memorySize, memoryAlign, tableSize }, importsTable };
      }
      if (kind === 1) {
        const partCount = dv.getUint32(8, true);
        let off = 12;
        const parts = [];
        for (let i = 0; i < partCount; i++) {
          if (off + 36 > buf.byteLength) return null;
          const memorySize = dv.getUint32(off, true);
          const memoryAlign = dv.getUint32(off + 4, true);
          const tableSize = dv.getUint32(off + 8, true);
          const importsTable = dv.getUint32(off + 12, true) !== 0;
          const blocks = dv.getUint32(off + 16, true);
          const hleCalls = dv.getUint32(off + 20, true);
          const regionLinks = dv.getUint32(off + 24, true);
          const pairsWords = dv.getUint32(off + 28, true);
          const wasmLen = dv.getUint32(off + 32, true);
          off += 36;
          const pairsBytes = pairsWords * 4;
          if (off + pairsBytes + wasmLen > buf.byteLength) return null;
          const pairs = new Uint32Array(pairsWords);
          if (pairsBytes) {
            new Uint8Array(pairs.buffer).set(new Uint8Array(buf.buffer, buf.byteOffset + off, pairsBytes));
          }
          off += pairsBytes;
          const bytes = new Uint8Array(buf.buffer, buf.byteOffset + off, wasmLen).slice();
          off += wasmLen;
          parts.push({
            bytes,
            info: { memorySize, memoryAlign, tableSize },
            importsTable,
            pairs,
            blocks,
            hleCalls,
            regionLinks,
          });
        }
        return { recompBundle: true, parts };
      }
      return null;
    },
    set(key, entry) {
      const f = keyFile(key);
      const tmp = `${f}.${processId}.${Math.random().toString(36).slice(2)}.tmp`;
      if (entry && entry.recompBundle === true && Array.isArray(entry.parts)) {
        let total = 12;
        for (const p of entry.parts) {
          total += 36 + p.pairs.byteLength + p.bytes.byteLength;
        }
        const out = Buffer.allocUnsafe(total);
        out.write("RWC1", 0, 4, "ascii");
        out.writeUInt32LE(1, 4);
        out.writeUInt32LE(entry.parts.length, 8);
        let off = 12;
        for (const p of entry.parts) {
          out.writeUInt32LE(p.info?.memorySize >>> 0, off);
          out.writeUInt32LE(p.info?.memoryAlign >>> 0, off + 4);
          out.writeUInt32LE(p.info?.tableSize >>> 0, off + 8);
          out.writeUInt32LE(p.importsTable ? 1 : 0, off + 12);
          out.writeUInt32LE(p.blocks >>> 0, off + 16);
          out.writeUInt32LE(p.hleCalls >>> 0, off + 20);
          out.writeUInt32LE(p.regionLinks >>> 0, off + 24);
          out.writeUInt32LE(p.pairs.length >>> 0, off + 28);
          out.writeUInt32LE(p.bytes.byteLength >>> 0, off + 32);
          off += 36;
          if (p.pairs.byteLength) {
            Buffer.from(p.pairs.buffer, p.pairs.byteOffset, p.pairs.byteLength).copy(out, off);
            off += p.pairs.byteLength;
          }
          Buffer.from(p.bytes.buffer, p.bytes.byteOffset, p.bytes.byteLength).copy(out, off);
          off += p.bytes.byteLength;
        }
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, f);
      } else if (entry && entry.bytes instanceof Uint8Array) {
        const out = Buffer.allocUnsafe(32 + entry.bytes.byteLength);
        out.write("RWC1", 0, 4, "ascii");
        out.writeUInt32LE(0, 4);
        out.writeUInt32LE(entry.words >>> 0, 8);
        out.writeUInt32LE(entry.info?.memorySize >>> 0, 12);
        out.writeUInt32LE(entry.info?.memoryAlign >>> 0, 16);
        out.writeUInt32LE(entry.info?.tableSize >>> 0, 20);
        out.writeUInt32LE(entry.importsTable ? 1 : 0, 24);
        out.writeUInt32LE(entry.bytes.byteLength >>> 0, 28);
        Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength).copy(out, 32);
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, f);
      }
    },
  };
}

const processId = process.pid;
installDiskCache(recompCacheDir);

// Host-directory-backed OPFS (Origin Private File System) for Emscripten WasmFS
function domError(name, message) {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

class HostSyncAccessHandle {
  constructor(fd, writable) {
    this._fd = fd;
    this._writable = writable;
  }
  read(bufferView, options = {}) {
    const pos = Number(options.at ?? 0);
    return fs.readSync(this._fd, bufferView, 0, bufferView.byteLength, pos);
  }
  write(bufferView, options = {}) {
    if (!this._writable) throw domError("NoModificationAllowedError", "read-only file");
    const pos = Number(options.at ?? 0);
    return fs.writeSync(this._fd, bufferView, 0, bufferView.byteLength, pos);
  }
  getSize() {
    return fs.fstatSync(this._fd).size;
  }
  truncate(newSize) {
    if (!this._writable) throw domError("NoModificationAllowedError", "read-only file");
    fs.ftruncateSync(this._fd, Number(newSize));
  }
  flush() {
    if (this._writable) {
      try { fs.fsyncSync(this._fd); } catch {}
    }
  }
  close() {
    if (this._fd >= 0) {
      try { fs.closeSync(this._fd); } catch {}
      this._fd = -1;
    }
  }
}

class FileSystemFileHandle {
  constructor(hostPath, entryName) {
    this.kind = "file";
    this.name = entryName;
    this._hostPath = hostPath;
  }
  async createSyncAccessHandle(_options) {
    try {
      const fd = fs.openSync(this._hostPath, "r+");
      return new HostSyncAccessHandle(fd, true);
    } catch {
      const fd = fs.openSync(this._hostPath, "r");
      return new HostSyncAccessHandle(fd, false);
    }
  }
  async getFile() {
    const st = fs.statSync(this._hostPath);
    const hostPath = this._hostPath;
    return {
      size: st.size,
      slice(start = 0, end = st.size) {
        const s = Math.max(0, Math.min(st.size, Number(start)));
        const e = Math.max(s, Math.min(st.size, Number(end)));
        const len = e - s;
        return {
          async arrayBuffer() {
            const out = new Uint8Array(len);
            if (len > 0) {
              const fd = fs.openSync(hostPath, "r");
              try { fs.readSync(fd, out, 0, len, s); } finally { fs.closeSync(fd); }
            }
            return out.buffer;
          },
        };
      },
    };
  }
  async createWritable(options = {}) {
    const hostPath = this._hostPath;
    if (!options.keepExistingData) fs.writeFileSync(hostPath, new Uint8Array(0));
    return {
      async write(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        fs.writeFileSync(hostPath, bytes);
      },
      async truncate(size) {
        fs.truncateSync(hostPath, Number(size));
      },
      async close() {},
    };
  }
  async move(arg1, arg2) {
    const dstPath = typeof arg1 === "string"
      ? path.join(path.dirname(this._hostPath), arg1)
      : path.join(arg1._hostPath, arg2 ?? this.name);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.renameSync(this._hostPath, dstPath);
    this._hostPath = dstPath;
    this.name = path.basename(dstPath);
  }
}

class FileSystemDirectoryHandle {
  constructor(hostPath, entryName) {
    this.kind = "directory";
    this.name = entryName;
    this._hostPath = hostPath;
  }
  async getFileHandle(entryName, options = {}) {
    const p = path.join(this._hostPath, entryName);
    let st = null;
    try { st = fs.statSync(p); } catch {}
    if (!st) {
      if (!options.create) throw domError("NotFoundError", `${entryName} not found`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.closeSync(fs.openSync(p, "a"));
      return new FileSystemFileHandle(p, entryName);
    }
    if (st.isDirectory()) throw domError("TypeMismatchError", `${entryName} is a directory`);
    return new FileSystemFileHandle(p, entryName);
  }
  async getDirectoryHandle(entryName, options = {}) {
    const p = path.join(this._hostPath, entryName);
    let st = null;
    try { st = fs.statSync(p); } catch {}
    if (!st) {
      if (!options.create) throw domError("NotFoundError", `${entryName} not found`);
      fs.mkdirSync(p, { recursive: true });
      return new FileSystemDirectoryHandle(p, entryName);
    }
    if (!st.isDirectory()) throw domError("TypeMismatchError", `${entryName} is a file`);
    return new FileSystemDirectoryHandle(p, entryName);
  }
  async removeEntry(entryName, options = {}) {
    const p = path.join(this._hostPath, entryName);
    let st = null;
    try { st = fs.lstatSync(p); } catch {
      throw domError("NotFoundError", `${entryName} not found`);
    }
    if (st.isDirectory()) {
      if (options.recursive) {
        fs.rmSync(p, { recursive: true, force: false });
      } else {
        fs.rmdirSync(p);
      }
    } else {
      fs.unlinkSync(p);
    }
  }
  async move(arg1, arg2) {
    const dstPath = typeof arg1 === "string"
      ? path.join(path.dirname(this._hostPath), arg1)
      : path.join(arg1._hostPath, arg2 ?? this.name);
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.renameSync(this._hostPath, dstPath);
    this._hostPath = dstPath;
    this.name = path.basename(dstPath);
  }
  async *entries() {
    let names = [];
    try { names = fs.readdirSync(this._hostPath); } catch { return; }
    for (const entryName of names) {
      const p = path.join(this._hostPath, entryName);
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) yield [entryName, new FileSystemDirectoryHandle(p, entryName)];
      else if (st.isFile()) yield [entryName, new FileSystemFileHandle(p, entryName)];
    }
  }
}

fs.mkdirSync(opfsDir, { recursive: true });
globalThis.FileSystemFileHandle = FileSystemFileHandle;
globalThis.FileSystemDirectoryHandle = FileSystemDirectoryHandle;

// Web Worker global environment shims so Emscripten's -sENVIRONMENT=worker modules run unmodified
class WorkerGlobalScope {}
globalThis.WorkerGlobalScope = WorkerGlobalScope;
globalThis.self = globalThis;
globalThis.name = name;
const workerHttpHref = (() => {
  const s = String(scriptUrl);
  if (s.startsWith("file:")) {
    const fpath = fileURLToPath(s);
    const rel = path.relative(publicDir, fpath).split(path.sep).join("/");
    if (!rel.startsWith("..")) return new URL(rel, originUrl).href;
  }
  return new URL(s, originUrl).href;
})();
globalThis.location = new URL(workerHttpHref);

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  writable: true,
  value: {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/135.0.0.0",
    hardwareConcurrency: os.cpus().length,
    storage: {
      async getDirectory() {
        return new FileSystemDirectoryHandle(opfsDir, "");
      },
    },
  },
});

globalThis.XMLHttpRequest = class XMLHttpRequest {
  open(_method, url, asyncFlag = true) {
    this._url = url;
    this._async = asyncFlag;
  }
  send() {
    const localPath = resolveUrlToLocalPath(this._url);
    if (!localPath || !fs.existsSync(localPath)) {
      this.status = 404;
      throw new Error(`XMLHttpRequest 404: ${this._url}`);
    }
    const buf = fs.readFileSync(localPath);
    this.status = 200;
    this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
};

// Web Worker wrapper around node:worker_threads
class WebWorkerShim {
  constructor(targetUrl, options = {}) {
    const resolvedHttp = new URL(String(targetUrl), globalThis.location.href).href;
    const localTarget = resolveUrlToLocalPath(resolvedHttp);
    const entryScript = localTarget ? pathToFileURL(localTarget).href : String(targetUrl);
    this._listeners = { message: new Set(), error: new Set() };
    this.onmessage = null;
    this.onerror = null;
    this._nodeWorker = new NodeWorker(bootstrapFilePath, {
      name: options.name || "",
      resourceLimits: { maxOldGenerationSizeMb: 8192, maxYoungGenerationSizeMb: 512 },
      workerData: {
        scriptUrl: entryScript,
        name: options.name || "",
        originUrl,
        publicDir,
        opfsDir,
        recompCacheDir,
      },
    });
    this._nodeWorker.on("message", (data) => {
      const ev = { data };
      if (typeof this.onmessage === "function") this.onmessage(ev);
      for (const fn of this._listeners.message) fn(ev);
    });
    this._nodeWorker.on("error", (err) => {
      const ev = { message: err?.message ?? String(err), error: err, filename: entryScript, lineno: 0, colno: 0 };
      if (typeof this.onerror === "function") this.onerror(ev);
      for (const fn of this._listeners.error) fn(ev);
    });
  }
  postMessage(value, transferList) {
    const transfers = Array.isArray(transferList) ? transferList.filter(Boolean) : undefined;
    this._nodeWorker.postMessage(value, transfers);
  }
  addEventListener(type, fn) {
    this._listeners[type]?.add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners[type]?.delete(fn);
  }
  terminate() {
    return this._nodeWorker.terminate();
  }
}
globalThis.Worker = WebWorkerShim;

const selfListeners = { message: new Set(), error: new Set(), unhandledrejection: new Set() };
globalThis.onmessage = null;
globalThis.onunhandledrejection = null;
globalThis.addEventListener = (type, fn) => { selfListeners[type]?.add(fn); };
globalThis.removeEventListener = (type, fn) => { selfListeners[type]?.delete(fn); };
globalThis.postMessage = (value, transferList) => {
  const transfers = Array.isArray(transferList) ? transferList.filter(Boolean) : undefined;
  parentPort.postMessage(value, transfers);
};
globalThis.close = () => {
  parentPort.close();
};

// Buffer messages arriving while the entry ES module is still importing (just like browser Workers!)
let moduleReady = false;
const bufferedMessages = [];
function deliverSelfMessage(data) {
  const ev = { data };
  if (typeof globalThis.onmessage === "function") globalThis.onmessage(ev);
  for (const fn of selfListeners.message) fn(ev);
}
parentPort.on("message", (data) => {
  if (!moduleReady) {
    bufferedMessages.push(data);
    return;
  }
  deliverSelfMessage(data);
});

// Mask Node's global `process` before importing Emscripten's -sENVIRONMENT=worker bundles
const savedProcess = globalThis.process;
Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });

try {
  const localEntry = resolveUrlToLocalPath(scriptUrl);
  const importHref = localEntry ? pathToFileURL(localEntry).href : String(scriptUrl);
  await import(importHref);
  moduleReady = true;
  while (bufferedMessages.length > 0) {
    deliverSelfMessage(bufferedMessages.shift());
  }
} catch (err) {
  savedProcess.stderr.write(`[desktop-worker-bootstrap ${name || scriptUrl}] fatal import error: ${err?.stack ?? err}\n`);
  throw err;
}
