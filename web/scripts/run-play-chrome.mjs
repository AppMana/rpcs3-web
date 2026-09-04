// Drives play.html in desktop Chrome and reports what the page is doing, so the interactive page
// can be checked against a real title without a device.
//
//   RPCS3_BOOT=/opfs/games/<title>.iso RPCS3_PPU_AOT=local-aot/<title>/manifest.json \
//   node scripts/run-play-chrome.mjs [seconds]
import { chromium } from "@playwright/test";
import { homedir } from "node:os";
import path from "node:path";

const env = process.env;
const seconds = Number(process.argv[2] || 120);
const baseURL = env.RPCS3_WEB_URL || "http://127.0.0.1:4175";
// The same profile the other runners use: it is where the origin-private file system holding
// firmware and disc images lives.
const profilePath = env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");
const headed = env.RPCS3_HEADED === "1";

const query = new URLSearchParams();
if (env.RPCS3_BOOT) query.set("boot", env.RPCS3_BOOT);
if (env.RPCS3_PPU_AOT) query.set("ppuAot", env.RPCS3_PPU_AOT);
if (env.RPCS3_SPU_AOT) query.set("spuAot", env.RPCS3_SPU_AOT);
if (env.RPCS3_SPU_DECODER) query.set("spuDecoder", env.RPCS3_SPU_DECODER);
if (env.RPCS3_SPU_LLVM_WORKERS) query.set("spuLlvmWorkers", env.RPCS3_SPU_LLVM_WORKERS);
if (env.RPCS3_CLOCK_SCALE) query.set("clockScale", env.RPCS3_CLOCK_SCALE);

// Same flags and rejection rule as the other hardware runners.
const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: !headed,
  args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-webgpu-developer-features",
    "--ignore-gpu-blocklist", "--enable-features=Vulkan", "--use-angle=vulkan"],
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") process.stderr.write(`[error] ${message.text()}\n`);
  });
  page.on("pageerror", (error) => process.stderr.write(`[pageerror] ${error.message}\n`));

  // The page boots as soon as it loads, and the RSX worker asks for its own adapter, so the GPU
  // process has to be up before that: probe from a page that is not the one under test.
  await page.goto(`${baseURL}/units.html`, { waitUntil: "domcontentloaded" });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const adapter = await page.evaluate(async () => {
      const found = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" })
        ?? await navigator.gpu?.requestAdapter();
      return found ? (found.info?.description || found.info?.vendor || "adapter") : null;
    });
    if (adapter) { process.stdout.write(`adapter: ${adapter}\n`); break; }
    if (attempt === 5) throw new Error("no WebGPU adapter in Chrome");
    await page.waitForTimeout(1_000);
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  await page.goto(`${baseURL}/play.html?${query}`, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5_000);
    const status = await page.evaluate(() => window.__rpcs3Playable?.status() ?? null);
    if (!status) continue;
    last = status;
    process.stdout.write(`${JSON.stringify(status)}\n`);
    if (status.state === "failed") break;
  }
  process.stdout.write(`\nfinal: ${JSON.stringify(last)}\n`);
  process.exitCode = last && last.state === "running" ? 0 : 1;
} finally {
  await context.close();
}
