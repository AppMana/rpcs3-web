// Host-side microbenchmark of the direct draw-path program-content kernels, modeled
// on the observed LBP2 window (4500-5300, 573 draws/frame). Replicates the EXACT
// loop bodies from ProgramStateCache.cpp (FP ucode checksum with constant-skip,
// VP ucode mask-walk with rotr+accumulate) and WebGPUDirectGSRender's program_key
// byte-hash + unordered_map probe, using 32-bit number halves for rotr64 (no BigInt
// emulation overhead). Reports ns/draw and projected us/frame at 573 draws as a
// function of ucode size, so the drawProgram bucket can be attributed per primitive.
//
// Usage: node scripts/microbench-draw-program.mjs [iterations]
import { performance } from "node:perf_hooks";

const iters = Number(process.argv[2] || 60_000) || 60_000;

// rotr64 on two 32-bit halves: (h<<32|lo) rotr r, returned as two halves.
function rotr64(h, lo, r) {
  r &= 63;
  if (r === 0) return [h, lo];
  const rlo = r, rhi = r - 32;
  if (rhi > 0) { // rotate left by 64-r; do rotr as n = 32-rlo on halves
    const n = 64 - r;
    // value = h:lo (big-endian), rotr r == rol(64-r)
    const hh = ((h >>> n) | (lo << (32 - n))) >>> 0;
    const ll = ((lo >>> n) | (h << (32 - n))) >>> 0;
    return [hh, ll];
  }
  const n = r;
  const hh = ((h >>> n) | (lo << (32 - n))) >>> 0;
  const ll = ((lo >>> n) | (h << (32 - n))) >>> 0;
  return [hh, ll];
}

// --- VP ucode hash: mask-walk over data.size()/4 words, active words -> rotr+add ---
const VP_WORDS = 512; // 2 KB raw transform-program block
const vp = new Uint32Array(VP_WORDS * 4);
const vpMask = new Uint8Array(VP_WORDS);
let seed = 0xcbf29ce4;
for (let i = 0; i < VP_WORDS; i++) {
  seed = Math.imul(seed ^ vp[i & 1023] | 0, 0x01000193) >>> 0;
  seed ^= (i * 2246822519) >>> 0; seed = Math.imul(seed, 0x85ebca6b) >>> 0;
  vp[i * 4] = seed >>> 0; vp[i * 4 + 1] = (seed ^ 0x9e3779b9) >>> 0;
  vp[i * 4 + 2] = (0x80000000 | (i & 31)) >>> 0; vp[i * 4 + 3] = (0x1e000000 | (seed & 0x1f)) >>> 0;
  vpMask[i] = (i % 7 === 0 || i % 29 === 0) ? 1 : 0;
}
let sink = 0;
function vpHashPass() {
  let acc0 = 0, acc1 = 0;
  for (let idx = 0; idx < VP_WORDS / 4; idx++) {
    if (vpMask[idx]) {
      const lo = vp[idx * 4], hi = vp[idx * 4 + 1];
      const [h0, l0] = rotr64(hi, lo, idx * 2);
      acc0 = Math.imul(acc0 + (((h0 << 0) + l0) >>> 0) | 0, 0x9e3779b1) >>> 0;
      const [h1, l1] = rotr64(hi, lo, idx * 2 + 1);
      acc1 = Math.imul(acc1 + (((h1 << 0) + l1) >>> 0) | 0, 0x85ebca6b) >>> 0;
    }
  }
  sink += acc0 + acc1;
}

// --- FP ucode hash: full walk with inline-constant skip ---
const FP_INSTRS = 128; // 2 KB
const fp = new Uint32Array(FP_INSTRS * 4 + 4);
for (let i = 0; i < fp.length; i++) fp[i] = (i * 2654435761) >>> 0;
sink = 0;
function fpHashPass() {
  let acc0 = 0, acc1 = 0;
  let idx = 0;
  while (idx < FP_INSTRS) {
    const lo = fp[idx * 4], hi = fp[idx * 4 + 1];
    const [h0, l0] = rotr64(hi, lo, idx * 2);
    acc0 = Math.imul(acc0 + (((h0 << 0) + l0) >>> 0) | 0, 0x9e3779b1) >>> 0;
    const [h1, l1] = rotr64(hi, lo, idx * 2 + 1);
    acc1 = Math.imul(acc1 + (((h1 << 0) + l1) >>> 0) | 0, 0x85ebca6b) >>> 0;
    // inline-constant load: the upper 8 bits of the instruction word hold SCE_FUNC,
    // a constant source leaves the next word as data -> skip it.
    const inst = hi; // upper word
    if ((inst & 0x01) === 0) idx++; else idx += 2;
  }
  sink += acc0 + acc1;
}

// --- program_key byte-hash (FNV-1a over the ~128 B serialized key) ---
const KEY_BYTES = 128;
const keyImg = new Uint8Array(KEY_BYTES);
for (let i = 0; i < KEY_BYTES; i++) keyImg[i] = ((i * 61) + (i >> 4)) & 255;
sink = 0;
function keyBytesHash() {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < KEY_BYTES; i += 8) {
    let w = 0;
    for (let b = 0; b < 8; b++) w += keyImg[i + b] * Math.pow(2, 8 * b);
    h = ((h ^ BigInt(w)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  sink += Number(h & 0xffffffffn);
}

// --- resolved_state_packet fill (256 B from a register image) ---
const regs = new Int32Array(96);
const rsp = new Uint8Array(256);
for (let i = 0; i < regs.length; i++) regs[i] = ((i * 37 - 11) | 0);
sink = 0;
function stateFill() {
  const dv = new DataView(rsp.buffer);
  for (let i = 0; i < 30; i++) dv.setFloat32(i * 4, regs[i & 95], true);
  dv.setUint32(120, regs[90] & 0xffffffff, true);
  for (let i = 0; i < 6; i++) dv.setUint32(128 + i * 4, regs[88 + i] & 0xffffffff, true);
  sink += rsp[0] + rsp[254];
}

function bench(name, fn, n) {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  const dt = performance.now() - t0;
  const ns = dt * 1e6 / n;
  console.log(`${name.padEnd(34)} ${ns.toFixed(1).padStart(7)} ns/op  ~ ${(ns * 573 / 1e3).toFixed(1).padStart(6)} us/frame @ 573 draws`);
}

console.log(`microbench-draw-program (number-halves rotr64; iter=${iters})`);
bench("vp_ucode_hash@512words-mask", vpHashPass, iters);
bench("fp_ucode_hash@128instr-constskip", fpHashPass, iters);
bench("program_key_bytes@128B-fnv1a", keyBytesHash, iters);
bench("resolved_state_fill@256B", stateFill, iters);
console.log(`sink=${sink}`);
