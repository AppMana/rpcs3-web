#!/usr/bin/env node
// bench-fullstack.mjs — reproducible full-stack gameplay benchmark for the browser
// transpile/rendering stack. Runs the frozen configuration (the same flags behind
// rounds 15-20: jspi core, giga SPU blocks, hot-threshold 8, PPU hot-threshold 8,
// PPU inline reads ON, SPU dispatch cache ON, 5300-frame budget) and reports the
// longest-contiguous sustained render band (300-700 draws/frame) with its fps.
//
// Usage:
//   node scripts/bench-fullstack.mjs <iso> <report-name> [profileWindow]  (run from web/)
//
// Env overrides:
//   RPCS3_CHROME_PROFILE  clone-source profile dir (default /tmp/rpcs3-bench-ltosimd)
//   RPCS3_WEB_URL         ingress origin (default https://rpcs3.appmana.com)
//
// Exit code 0 on a 0-failure completed replay with a measured sustained band.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const [iso, name, rawWindow] = process.argv.slice(2);
if (!iso || !name) {
  console.error("usage: node scripts/bench-fullstack.mjs <iso> <report-name> [profileWindow=4600-5200]");
  process.exit(2);
}

const profileWin = rawWindow ? rawWindow.split("-").map(Number) : [4600, 5200];
const sourceProfile = process.env.RPCS3_CHROME_PROFILE || "/tmp/rpcs3-bench-ltosimd";
const profileDir = `/tmp/rpcs3-fs-${Date.now()}`;
execFileSync("cp", ["-ra", sourceProfile, profileDir], { stdio: "inherit" });

const outDir = join(root, "test-results", "performance", name);
const env = {
  ...process.env,
  RPCS3_WEB_URL: process.env.RPCS3_WEB_URL || "https://rpcs3.appmana.com",
  RPCS3_CORE: process.env.RPCS3_CORE || "jspi",
  RPCS3_CHROME_PROFILE: profileDir,
  RPCS3_FRAMES: "5300",
  RPCS3_TIMEOUT_MS: "1500000",
  RPCS3_SPU_DISPATCH_CACHE: "1",
  RPCS3_SPU_EXECUTION_SLICES: "1",
  RPCS3_SPU_BLOCK_SIZE: "giga",
  RPCS3_SPU_HOT_THRESHOLD: "8",
  RPCS3_PPU_JIT_THRESHOLD: "8",
  RPCS3_PPU_INLINE_READS: "1",
};

// Run the replay through the standard runner; parse profile from the report's
// sustained band exactly like analyse-gameplay does (longest contiguous 300-700 dpf).
execFileSync("node", ["scripts/run-performance.mjs", iso, outDir], { cwd: root, env, stdio: "inherit" });

const report = JSON.parse(await readFile(join(outDir, "report.json"), "utf8"));
const st = report.status || {};
const fr = report.frames || [];
let prev = null, run = [], best = [];
for (const f of fr) {
  const eid = f.emuFlipId, h = f.hostTimeMs, dr = (f.directStats || {}).draws || 0;
  if (prev && eid && h && h > prev[2]) {
    const de = eid - prev[0], dtms = h - prev[2];
    if (de > 0 && dtms > 0) {
      const pd = (dr - prev[1]) / de;
      if (pd >= 300 && pd <= 700) run.push([eid, h, pd]);
      else { if (run.length > best.length) best = run; run = []; }
    }
  }
  prev = [eid, dr, h];
}
if (run.length > best.length) best = run;
if (!best.length) { console.error("no sustained band measured"); process.exit(1); }
const f0 = best[0][0], f1 = best[best.length - 1][0];
const dt = (best[best.length - 1][1] - best[0][1]) / 1000.0;
const median = best.map((r) => r[2]).sort((a, b) => a - b)[(best.length / 2) | 0];
const fps = dt > 0 ? (f1 - f0) / dt : null;
// Optional profile-leaf attribution: when the runner produced run.cpuprofile files
// (RPCS3_PROFILE=1 window), report the top-5 sampled leaves (function, count, % of
// samples) so a landing is validated against BOTH the content-anchored frame band
// and where guest CPU actually goes.
const profPath = join(outDir, "run.cpuprofile");
const leaves = [];
if (existsSync(profPath)) {
  try {
    const prof = JSON.parse(await readFile(profPath, "utf8"));
    const byid = new Map((prof.nodes || []).map((n) => [n.id, n]));
    const counts = new Map();
    for (const s of prof.samples || []) {
      const cf = (byid.get(s) || {}).callFrame || {};
      const fn = cf.functionName || "?";
      counts.set(fn, (counts.get(fn) || 0) + 1);
    }
    const total = Math.max(1, (prof.samples || []).length);
    for (const [fn, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      leaves.push([fn, c, Math.round((100.0 * c / total) * 10) / 10]);
    }
  } catch (_) {
    leaves.length = 0;
  }
}
const summary = {
  frames: st.frames,
  fails: (report.failures || []).length,
  fpsOverall: st.fps,
  sustained: { span: [f0, f1, best.length], fps: fps !== null ? Math.round(fps * 100) / 100 : null, dpf: Math.round((median ?? 0) * 10) / 10 },
  ...(leaves.length ? { profileLeaves: leaves } : {}),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
