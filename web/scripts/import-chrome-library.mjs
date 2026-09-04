// Imports a file from the library server into the desktop Chrome profile's origin-private storage.
//   node scripts/import-chrome-library.mjs "<name>" [games|firmware]
import { chromium } from "@playwright/test";
import { homedir } from "node:os";
import path from "node:path";

const name = process.argv[2];
const destination = process.argv[3] || "games";
if (!name) throw new Error('usage: import-chrome-library.mjs "<name>" [games|firmware]');
const baseURL = process.env.RPCS3_WEB_URL || "http://127.0.0.1:4175";
const profilePath = path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: false,
  args: ["--no-sandbox"],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") process.stderr.write(`[error] ${message.text()}\n`);
  });
  await page.goto(`${baseURL}/storage.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__rpcs3Storage), null, { timeout: 60_000 });

  const started = Date.now();
  const report = await page.evaluate(async ({ name, destination }) => {
    try {
      return await window.__rpcs3Storage.importFromLibrary(name, destination);
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }, { name, destination }, { timeout: 0 });
  console.log(JSON.stringify(report, null, 2));
  console.log(`elapsed ${Math.round((Date.now() - started) / 1000)}s`);
} finally {
  await context.close();
}
