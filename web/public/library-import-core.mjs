// Pure logic shared by the library import worker, the page, and the unit tests:
// a resumable streaming SHA-256, HTTP range bookkeeping, and the sidecar rules
// that decide how much of an existing OPFS file can be trusted on resume.
// Plain ESM with no DOM dependency so Vitest and Safari load the same file.

export const LIBRARY_IMPORT_SIDECAR_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/**
 * Incremental SHA-256 (FIPS 180-4) whose state can be exported after any
 * update and restored later, so a download interrupted between chunks resumes
 * hashing exactly where the sidecar left off. The digest matches `sha256sum`.
 */
export class StreamingSha256 {
  constructor() {
    this.h = new Uint32Array(INITIAL_STATE);
    this.w = new Uint32Array(64);
    this.block = new Uint8Array(64);
    this.blockLength = 0;
    this.length = 0;
    this.finalized = false;
  }

  static fromState(state) {
    const hash = new StreamingSha256();
    if (!state || !Array.isArray(state.h) || state.h.length !== 8) throw new TypeError("Invalid SHA-256 state");
    if (!Number.isSafeInteger(state.length) || state.length < 0) throw new TypeError("Invalid SHA-256 length");
    const block = Array.isArray(state.block) ? state.block : [];
    if (block.length !== state.length % 64) throw new TypeError("SHA-256 state block does not match its length");
    hash.h.set(state.h.map((value) => value >>> 0));
    hash.block.set(block);
    hash.blockLength = block.length;
    hash.length = state.length;
    return hash;
  }

  exportState() {
    if (this.finalized) throw new Error("Cannot export a finalized SHA-256 state");
    return {
      h: Array.from(this.h),
      block: Array.from(this.block.subarray(0, this.blockLength)),
      length: this.length,
    };
  }

  update(input) {
    if (this.finalized) throw new Error("Cannot update a finalized SHA-256");
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let offset = 0;
    const end = bytes.length;
    this.length += end;
    if (this.blockLength) {
      const take = Math.min(64 - this.blockLength, end);
      this.block.set(bytes.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength < 64) return this;
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    while (end - offset >= 64) {
      this.compress(bytes, offset);
      offset += 64;
    }
    if (offset < end) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLength = end - offset;
    }
    return this;
  }

  compress(bytes, offset) {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4;
      w[i] = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.h;
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }

  digest() {
    if (this.finalized) throw new Error("SHA-256 already finalized");
    const bitLength = this.length * 8;
    const padding = new Uint8Array(((this.blockLength + 8) >> 6 << 6) + 64 - this.blockLength);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    // Lengths stay below 2^53 bits, so the high word fits in a double exactly.
    view.setUint32(padding.length - 8, Math.floor(bitLength / 2 ** 32));
    view.setUint32(padding.length - 4, bitLength >>> 0);
    const totalLength = this.length;
    this.update(padding);
    this.length = totalLength;
    this.finalized = true;
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = this.h[i] >>> 24;
      out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff;
      out[i * 4 + 3] = this.h[i] & 0xff;
    }
    return out;
  }

  digestHex() {
    return toHex(this.digest());
  }
}

export function toHex(bytes) {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function sha256Hex(bytes) {
  return new StreamingSha256().update(bytes).digestHex();
}

/** Parses `Content-Range: bytes <start>-<end>/<total>`; rejects the `*` forms the client never accepts. */
export function parseContentRange(header) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(header ?? "").trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total) return undefined;
  return { start, end, total, length: end - start + 1 };
}

/** Parses a single-range `Range: bytes=<start>-<end>` request header against a known size. */
export function parseRangeRequest(header, size) {
  if (header === undefined || header === null || header === "") return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (match[1] === "" && match[2] === "")) return { kind: "ignore" };
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - suffix);
    return size === 0 ? { kind: "unsatisfiable" } : { kind: "range", start, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: "ignore" };
  if (start >= size) return { kind: "unsatisfiable" };
  if (end < start) return { kind: "ignore" };
  return { kind: "range", start, end };
}

/** Splits [start, size) into consecutive Range requests of at most chunkSize bytes. */
export function planChunks(start, size, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0) throw new RangeError("Invalid chunk plan bounds");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError("Invalid chunk size");
  const chunks = [];
  for (let offset = start; offset < size; offset += chunkSize) {
    const end = Math.min(size, offset + chunkSize) - 1;
    chunks.push({ start: offset, end, length: end - offset + 1 });
  }
  return chunks;
}

export function sourceMatches(source, entry) {
  return Boolean(source && entry)
    && source.size === entry.size
    && source.sha256 === entry.sha256
    && (source.etag ?? null) === (entry.etag ?? null);
}

/**
 * Decides how to continue an import given the library entry, the sidecar (or
 * undefined), and the bytes already in OPFS.
 *
 * - `restart` means the existing bytes cannot be trusted (a different source,
 *   a file longer than the source, or a sidecar whose hash progress claims more
 *   than the file holds) and the file is truncated to zero.
 * - `hashed` is the byte count the restored hash state already covers; bytes
 *   between `hashed` and `existingSize` are re-hashed from OPFS before any
 *   network request so the final digest is exact.
 */
export function planResume({ entry, sidecar, existingSize }) {
  if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new TypeError("Library entry has no size");
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new TypeError("Library entry has no SHA-256");
  if (!Number.isSafeInteger(existingSize) || existingSize < 0) throw new TypeError("Invalid existing size");
  const base = { restart: false, hashed: 0, hashState: undefined, alreadyComplete: false, reason: "" };
  if (existingSize === 0) return { ...base, reason: sidecar ? "empty file; sidecar ignored" : "no existing data" };
  if (existingSize > entry.size) return { ...base, restart: true, reason: `existing ${existingSize} bytes exceed source size ${entry.size}` };
  if (!sidecar) return { ...base, reason: `no sidecar; re-hashing ${existingSize} existing bytes locally` };
  if (sidecar.version !== LIBRARY_IMPORT_SIDECAR_VERSION) return { ...base, reason: `sidecar version ${sidecar.version} unsupported; re-hashing locally` };
  if (!sourceMatches(sidecar.source, entry)) return { ...base, restart: true, reason: "source changed since the sidecar was written" };
  if (sidecar.complete && existingSize === entry.size && sidecar.sha256 === entry.sha256) {
    return { ...base, hashed: existingSize, alreadyComplete: true, reason: "sidecar records a verified complete import" };
  }
  const hashed = Number(sidecar.hashed);
  if (!Number.isSafeInteger(hashed) || hashed < 0 || !sidecar.hashState) return { ...base, reason: "sidecar has no hash state; re-hashing locally" };
  if (hashed > existingSize) return { ...base, restart: true, reason: `sidecar hashed ${hashed} bytes but only ${existingSize} exist` };
  if (hashed !== sidecar.hashState.length) return { ...base, restart: true, reason: "sidecar hash state is inconsistent" };
  return { ...base, hashed, hashState: sidecar.hashState, reason: `resuming from ${hashed} hashed of ${existingSize} existing bytes` };
}

export function sidecarPathFor(destination, name) {
  return `.rpcs3-imports/${destination}/${name}.json`;
}

export function formatRate(bytesPerSecond) {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value <= 0) return "0 B/s";
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

// Freestanding wasm32 build of web/host/sha256/sha256_wasm.c (see
// web/scripts/build-sha256-wasm.sh). It exposes the same resumable state as
// StreamingSha256 and is about 1.5x faster than the JavaScript path; the
// JavaScript class remains the fallback and the reference the tests compare.
export const SHA256_WASM_BASE64 = "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";

function decodeBase64(text) {
  if (typeof atob === "function") {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(text, "base64"));
}

const STATE_H = 0, STATE_LENGTH = 32, STATE_BLOCK_LENGTH = 40, STATE_BLOCK = 44;

class WasmSha256 {
  constructor(exports) {
    this.exports = exports;
    this.memory = new Uint8Array(exports.memory.buffer);
    this.view = new DataView(exports.memory.buffer);
    this.input = exports.sha256_input();
    this.capacity = exports.sha256_input_capacity();
    this.state = exports.sha256_state();
    this.finalized = false;
    exports.sha256_init();
  }

  update(input) {
    if (this.finalized) throw new Error("Cannot update a finalized SHA-256");
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (let offset = 0; offset < bytes.length; offset += this.capacity) {
      const piece = bytes.subarray(offset, Math.min(bytes.length, offset + this.capacity));
      this.memory.set(piece, this.input);
      this.exports.sha256_update(piece.length);
    }
    return this;
  }

  exportState() {
    if (this.finalized) throw new Error("Cannot export a finalized SHA-256 state");
    const h = [];
    for (let i = 0; i < 8; i++) h.push(this.view.getUint32(this.state + STATE_H + i * 4, true));
    const blockLength = this.view.getUint32(this.state + STATE_BLOCK_LENGTH, true);
    const length = Number(this.view.getBigUint64(this.state + STATE_LENGTH, true)) + blockLength;
    return { h, block: Array.from(this.memory.subarray(this.state + STATE_BLOCK, this.state + STATE_BLOCK + blockLength)), length };
  }

  importState(state) {
    // Validate through the reference implementation so both paths accept the same states.
    StreamingSha256.fromState(state);
    for (let i = 0; i < 8; i++) this.view.setUint32(this.state + STATE_H + i * 4, state.h[i] >>> 0, true);
    const blockLength = state.block.length;
    this.view.setBigUint64(this.state + STATE_LENGTH, BigInt(state.length - blockLength), true);
    this.view.setUint32(this.state + STATE_BLOCK_LENGTH, blockLength, true);
    this.memory.set(state.block, this.state + STATE_BLOCK);
    this.finalized = false;
    return this;
  }

  digest() {
    if (this.finalized) throw new Error("SHA-256 already finalized");
    this.exports.sha256_final();
    this.finalized = true;
    const out = this.exports.sha256_digest_out();
    return this.memory.slice(out, out + 32);
  }

  digestHex() {
    return toHex(this.digest());
  }
}

let wasmModulePromise;

/**
 * Returns a resumable SHA-256 hasher: the wasm implementation when
 * WebAssembly is available (default), otherwise the JavaScript one. Pass a
 * previously exported state to continue hashing.
 */
export async function createSha256(state, { preferWasm = true } = {}) {
  if (preferWasm && typeof WebAssembly === "object") {
    try {
      wasmModulePromise ??= WebAssembly.compile(decodeBase64(SHA256_WASM_BASE64));
      const instance = await WebAssembly.instantiate(await wasmModulePromise, {});
      const hasher = new WasmSha256(instance.exports);
      hasher.implementation = "wasm";
      return state ? hasher.importState(state) : hasher;
    } catch (error) {
      if (typeof console !== "undefined") console.warn("SHA-256 wasm unavailable, using JavaScript", error);
    }
  }
  const hasher = state ? StreamingSha256.fromState(state) : new StreamingSha256();
  hasher.implementation = "js";
  return hasher;
}
