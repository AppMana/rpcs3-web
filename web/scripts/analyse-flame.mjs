#!/usr/bin/env node
// analyse-flame.mjs — aggregates INCLUSIVE (stacked) CPU attribution from the CDP
// per-thread profiles a bench run leaves in test-results/performance/<report>/.
// Reaches into the rpcs3 level: every sample's full call chain (root -> leaf) is
// counted once per frame, so each function's inclusive share = all samples whose
// stack contains it. Emits (a) the top-N functions by inclusive share with their
// role from the wasm name section, and (b) a flame-graph.folded-style stack file
// (root;child;...;leaf N) that can be pasted into flamegraph.pl for the real chart.
//
// Usage: node scripts/analyse-flame.mjs <report-dir> [topN]

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyWorkerProfile, isSpinWaitFunction } from "./worker-profiler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");

const dir = process.argv[2];
const topN = Number(process.argv[3] || 20);
if (!dir) { console.error("usage: node scripts/analyse-flame.mjs <report-dir> [topN]"); process.exit(2); }

function buildParentMap(nodes) {
  const parentById = new Map();
  for (const n of nodes) {
    if (n.parent !== undefined) parentById.set(n.id, n.parent);
    for (const childId of n.children || []) {
      parentById.set(childId, n.id);
    }
  }
  return parentById;
}

function stackOf(node, byId, parentById) {
  // Build root->leaf by walking parents via parentById built from node.children
  const chain = [];
  const visited = new Set();
  let cur = node;
  for (let i = 0; i < 96 && cur && !visited.has(cur.id); i++) {
    visited.add(cur.id);
    const cf = cur.callFrame || {};
    const fn = cf.functionName || "?";
    const url = cf.url || "";
    const label = url.includes("wasm-function")
      ? fn.replace(/^wasm-function\[(\d+)\]$/, (_, n) => `wasm[${n}]`)
      : (fn || "?");
    if (label !== "(root)") chain.unshift(label);
    const parentId = parentById.get(cur.id);
    cur = parentId !== undefined ? byId.get(parentId) : undefined;
  }
  return chain;
}

function readLebU32(binary, state) {
  let result = 0;
  let shift = 0;
  while (state.off < binary.length) {
    const b = binary[state.off++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return result >>> 0;
}

function nameSectionMap(binary) {
  // Parse the WebAssembly custom "name" section (section id 0, name === "name", subsection id 1 = function names)
  const map = new Map();
  const decoder = new TextDecoder();
  const state = { off: 8 }; // skip 8-byte Wasm header (magic + version)
  while (state.off < binary.length) {
    const id = binary[state.off++];
    const size = readLebU32(binary, state);
    const end = Math.min(binary.length, state.off + size);
    if (id === 0) {
      const secNameLen = readLebU32(binary, state);
      const secName = decoder.decode(binary.subarray(state.off, state.off + secNameLen));
      state.off += secNameLen;
      if (secName === "name") {
        while (state.off < end) {
          const sid = binary[state.off++];
          const ssize = readLebU32(binary, state);
          const send = Math.min(end, state.off + ssize);
          if (sid === 1) { // subsection 1: function names
            const count = readLebU32(binary, state);
            for (let i = 0; i < count && state.off < send; i++) {
              const idx = readLebU32(binary, state);
              const nl = readLebU32(binary, state);
              const name = decoder.decode(binary.subarray(state.off, state.off + nl));
              state.off += nl;
              map.set(idx, name);
            }
          }
          state.off = send;
        }
      }
    }
    state.off = end;
  }
  return map;
}

const dirExists = existsSync(dir);
if (!dirExists) { console.error(`no such dir: ${dir}`); process.exit(1); }

// Resolve wasm function names from the runtime's wasm binary (shared across threads).
const wasmName = await (async () => {
  for (const candidate of [
    join(webRoot, "public/core/jspi/rpcs3-web.wasm"),
    join(webRoot, "dist/core/jspi/rpcs3-web.wasm"),
    join(webRoot, "public/core/profile-jspi/rpcs3-web.wasm"),
    join(webRoot, "public/core/rpcs3-web.wasm"),
  ]) {
    try {
      if (existsSync(candidate)) {
        const m = nameSectionMap(new Uint8Array(await readFile(candidate)));
        if (m.size > 0) return m;
      }
    } catch { /* ignore */ }
  }
  return new Map();
})();

// Collect ALL per-thread .cpuprofile files and their roles from run.cpuprofile.targets.json
const files = (await readdirSafe(dir))
  .filter((f) => /^run\.cpuprofile(?:\.\d+)?$/.test(f))
  .sort((a, b) => {
    const ia = a === "run.cpuprofile" ? 0 : Number(a.split(".").pop());
    const ib = b === "run.cpuprofile" ? 0 : Number(b.split(".").pop());
    return ia - ib;
  });

if (!files.length) { console.error("no run.cpuprofile core found in " + dir); process.exit(1); }

let roleByFile = new Map();
const targetsPath = join(dir, "run.cpuprofile.targets.json");
if (existsSync(targetsPath)) {
  try {
    const targetsMeta = JSON.parse(await readFile(targetsPath, "utf8"));
    for (const t of targetsMeta.targets || []) {
      if (t.profilePath) roleByFile.set(t.profilePath.split("/").pop(), t.role || "Worker");
    }
  } catch { /* ignore */ }
}

const stacks = new Map(); // folded string -> count
const activeStacks = new Map(); // excluding idle/futex/spin-wait leaves
const roleTotals = new Map();
let totalSamples = 0;
let activeSamples = 0;

for (const f of files) {
  let core;
  try { core = JSON.parse(await readFile(join(dir, f), "utf8")); }
  catch { continue; }
  const nodes = core.nodes || [];
  const samples = core.samples || [];
  if (!samples.length) continue;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parentById = buildParentMap(nodes);
  const role = roleByFile.get(f) || classifyWorkerProfile(core);

  for (const s of samples) {
    const leafNode = byId.get(s);
    if (!leafNode) continue;
    const leafFn = leafNode.callFrame?.functionName || "?";
    const isIdle = ["(idle)", "emscripten_futex_wait", "_do_futex_wait", "(program)"].includes(leafFn);
    const isSpin = isSpinWaitFunction(leafFn);
    const chain = stackOf(leafNode, byId, parentById).map((frame) => {
      const m = frame.match(/^wasm\[(\d+)\]$/);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (wasmName.has(idx)) return `wasm(${wasmName.get(idx)})`;
      }
      return frame;
    });
    const folded = `[${role}];${chain.join(";")}`;
    stacks.set(folded, (stacks.get(folded) || 0) + 1);
    totalSamples++;
    if (!isIdle && !isSpin) {
      activeStacks.set(folded, (activeStacks.get(folded) || 0) + 1);
      roleTotals.set(role, (roleTotals.get(role) || 0) + 1);
      activeSamples++;
    }
  }
}

// Inclusive per-function attribution over ACTIVE (non-idle, non-spin) samples.
const sourceStacks = activeSamples > 0 ? activeStacks : stacks;
const denom = Math.max(1, activeSamples > 0 ? activeSamples : totalSamples);
const inclusive = new Map();
for (const [folded, count] of sourceStacks) {
  const frames = folded.split(";");
  const seenInStack = new Set();
  for (const fn of frames) {
    if (seenInStack.has(fn)) continue;
    seenInStack.add(fn);
    inclusive.set(fn, (inclusive.get(fn) || 0) + count);
  }
}

const sorted = [...inclusive.entries()].sort((a, b) => b[1] - a[1]);
console.log(`workers=${files.length} total-samples=${totalSamples} active-samples=${activeSamples} distinct-active-stacks=${sourceStacks.size}`);
console.log(`active samples by role: ${JSON.stringify(Object.fromEntries(roleTotals))}`);
let printed = 0;
for (const [fn, n] of sorted) {
  if (fn.startsWith("[") && fn.endsWith("]")) continue;
  if (++printed > topN) break;
  console.log(`  ${String(n).padStart(6)} (${(100.0 * n / denom).toFixed(1).padStart(5)}%) ${fn.slice(0, 96)}`);
}

// Flame-graph folded output (active stacks + full stacks).
const foldedPath = join(dir, "flame.folded");
const lines = [...sourceStacks.entries()].sort((a, b) => b[1] - a[1]);
await writeFile(foldedPath, lines.map(([f, c]) => `${f} ${c}`).join("\n") + "\n");
console.log(`folded stack file: ${foldedPath} (${sourceStacks.size} stacks) — paste into flamegraph.pl for the chart`);

async function readdirSafe(p) {
  const { readdir } = await import("node:fs/promises");
  try { return await readdir(p); } catch { return []; }
}
