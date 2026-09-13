// Direct-backend split-reuse probe: boot a bundled homebrew fixture through the
// JSPI direct core with the two-group binding cache on secret, then report the
// split stats so a dense textured workload can be checked for texture-group and
// buffer-group reuse (the purpose the split was built for).
// Usage: node scripts/probe-direct-split-reuse.mjs [fixture] [frames] [baseURL]
import { chromium } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hardwareChromeArgs } from "./chrome-gpu.mjs";

const fixture = process.argv[2] ?? "fixtures/gs_gcm_cube.elf";
const frames = Number(process.argv[3] ?? 180);
const base = process.argv[4] ?? "http://127.0.0.1:4174/";
const outFile = resolve(`./test-results/split-reuse-${fixture.replace(/[^\w.-]+/g, "-")}.json`);

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: false, args: hardwareChromeArgs("shared-vulkan") });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(new URL("runtime.html", base).href);
  await page.waitForFunction(() => Boolean(window.__rpcs3Runtime));
  const result = await page.evaluate(async ({ fixture, frames }) => {
    const runtime = window.__rpcs3Runtime;
    return runtime.run(fixture, {
      frames, render: true, directRenderer: true, suspending: true, presentationYield: "message",
      bindGroupCache: true, readback: false, captureRgba: false, benchmark: true,
    });
  }, { fixture, frames });
  const stats = result.directStats;
  const summary = {
    ok: result.ok, detail: result.detail, flips: result.emuFlipId, presented: result.gpu?.presented,
    draws: stats?.draws, clears: stats?.clears, programs: stats?.programs, pipelines: stats?.pipelines,
    bindGroupCreates: stats?.bindGroupCreates, bindGroupHits: stats?.bindGroupHits,
    textureBindGroupCreates: stats?.textureBindGroupCreates, textureBindGroupHits: stats?.textureBindGroupHits,
    textureUploads: stats?.textureUploads, translationFailures: stats?.translationFailures,
    unsupported: stats?.unsupported, timingDrops: result.timingDrops,
    frameHash: result.gpu?.frameHash, shutdown: result.shutdown?.stoppedCleanly,
    pageErrors: errors.slice(0, 8),
  };
  console.log(JSON.stringify({ fixture, frames, summary }, null, 2));
  await writeFile(outFile, JSON.stringify(summary, null, 2));
  if (!stats) process.exitCode = 2;
} finally {
  await browser.close();
}
