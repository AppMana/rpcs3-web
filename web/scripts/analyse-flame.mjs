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

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const topN = Number(process.argv[3] || 12);
if (!dir) { console.error("usage: node scripts/analyse-flame.mjs <report-dir> [topN]"); process.exit(2); }

function stackOf(node, byId) {
  // Build root->leaf by walking parents; wasm frames have url https://.../rpcs3-web.wasm:wasm-function[N]
  const chain = [];
  let cur = node;
  for (let i = 0; i < 64 && cur; i++) {
    const cf = cur.callFrame || {};
    const fn = cf.functionName || "?";
    const url = cf.url || "";
    const label = url.includes("wasm-function")
      ? fn.replace(/^wasm-function\[(\d+)\]$/, (_, n) => `wasm[${n}]`)
      : (fn || "?");
    chain.unshift(label);
    cur = byId.get(cur.parent);
  }
  return chain;
}

function nameSectionMap(binary) {
  // Parse enough of the custom "name" section to map function index -> name.
  const dv = new DataView(binary);
  const map = new Map();
  let off = 8; // magic + version
  while (off < binary.length) {
    const id = binary[off++];
    let size = 0, len = 0;
    do { len = binary[off]; size |= (len & 0x7f) << (7 * 0); } while (0); // placeholder
    // proper LEB read:
    let shift = 0; size = 0; let b;
    do { b = binary[off++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const end = off + size;
    if (id === 0) { // "name" section
      // subsection id, subsection size, then name map
      while (off < end) {
        const sid = binary[off++];
        let sshift = 0, ssize = 0, sb;
        do { sb = binary[off++]; ssize |= (sb & 0x7f) << sshift; sshift += 7; } while (sb & 0x80);
        const send = off + ssize;
        if (sid === 0) { // FUNCTION_NAMES
          let rshift = 0, rsize = 0, rb;
          do { rb = binary[off++]; rsize |= (rb & 0x7f) << rshift; rshift += 7; } while (rb & 0x80);
          for (let i = 0; i < rsize; i++) {
            let idx = 0, is = 0, ib;
            do { ib = binary[off++]; idx |= (ib & 0x7f) << is; is += 7; } while (ib & 0x80);
            let nl = 0, ns = 0, nb;
            do { nb = binary[off++]; nl |= (nb & 0x7f) << ns; ns += 7; } while (nb & 0x80);
            const name = new TextDecoder().decode(binary.subarray(off, off + nl)); off += nl;
            map.set(idx, name);
          }
        } else off = send;
      }
    } else off = end;
  }
  return map;
}

const dirExists = existsSync(dir);
if (!dirExists) { console.error(`no such dir: ${dir}`); process.exit(1); }

// Collect per-thread cores. run.cpuprofile is the aggregated profile; run.cpuprofile.N are thread slices.
const files = (await readdirSafe(dir));
let profile = null;
let coring = null;
for (const f of files) {
  if (f.startsWith("run.cpuprofile") && !f.endsWith(".targets.json")) {
    try { const core = JSON.parse(await readFile(join(dir, f), "utf8")); coring = core; break; }
    catch { /* try next */ }
  }
}
if (!coring) { console.error("no run.cpuprofile core found in " + dir); process.exit(1); }

const nodes = coring.nodes || [];
const byId = new Map(nodes.map((n) => [n.id, n]));
// Resolve wasm function names from the runtime's wasm binary (shared across threads).
const wasmName = await (async () => {
  try {
    const wasmPath = join("web/dist/core/jspi/rpcs3-web.wasm");
    if (existsSync(wasmPath)) return nameSectionMap(new Uint8Array(await readFile(wasmPath)));
  } catch { /* ignore */ }
  return new Map();
})();

const samples = coring.samples || [];
const stacks = new Map(); // folded string -> count
for (const s of samples) {
  const chain = stackOf(byId.get(s), byId);
  const folded = chain.map((f) => wasmName.has(parseInt((f.match(/wasm\[(\d+)\]/) || [])[1] ?? "", 10))
    && f.startsWith("wasm[")
    ? `wasm(${wasmName.get(parseInt(f.slice(5, -1), 10))})`
    : f).join(";");
  stacks.set(folded, (stacks.get(folded) || 0) + 1);
}

// Inclusive per-function attribution.
const inclusive = new Map();
for (const [folded, count] of stacks) {
  const frames = folded.split(";");
  let acc = "";
  for (const fn of frames) {
    acc = acc ? `${acc};${fn}` : fn;
    inclusive.set(acc, (inclusive.get(acc) || 0) + count);
  }
}
const total = samples.length;
const sorted = [...inclusive.entries()].sort((a, b) => b[1] - a[1]);
console.log(`inclusive samples=${total} distinct-stacks=${stacks.size} distinct-paths=${inclusive.size}`);
const seenFns = new Set();
for (const [path, n] of sorted.slice(0, Math.min(topN * 4, sorted.length))) {
  const leaf = path.split(";").pop();
  if (seenFns.has(leaf)) continue;
  seenFns.add(leaf);
  if (seenFns.size > topN) break;
  console.log(`  ${String(n).padStart(6)} (${(100.0 * n / total).toFixed(1).padStart(4)}%) ${leaf.slice(0, 76)}`);
}
// Flame-graph folded output.
const foldedPath = join(dir, "flame.folded");
await import("node:fs/promises")
  .then(async ({ writeFile }) => { const lines = [...stacks.entries()].sort((a, b) => b[1] - a[1]); await writeFile(foldedPath, lines.map(([f, c]) => `${f} ${c}`).join("\n")); });
console.log(`folded stack file: ${foldedPath} (${stacks.size} stacks) — paste into flamegraph.pl for the chart`);

async function readdirSafe(p) {
  const { readdir } = await import("node:fs/promises");
  try { return await readdir(p); } catch { return []; }
}
