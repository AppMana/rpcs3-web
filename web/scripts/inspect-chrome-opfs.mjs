// Lists what the desktop Chrome profile's origin-private storage holds for the preview origin.
import { chromium } from "@playwright/test";
import { homedir } from "node:os";
import path from "node:path";

const baseURL = process.env.RPCS3_WEB_URL || "http://127.0.0.1:4175";
const profilePath = path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: false,
  args: ["--no-sandbox", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${baseURL}/storage.html`, { waitUntil: "domcontentloaded" });
  const listing = await page.evaluate(async () => {
    const walk = async (directory, prefix, out) => {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "file") {
          const file = await handle.getFile();
          out.push(`${prefix}/${name}  ${file.size}`);
        } else if (out.length < 200) {
          await walk(handle, `${prefix}/${name}`, out);
        }
      }
      return out;
    };
    const root = await navigator.storage.getDirectory();
    const out = await walk(root, "", []);
    const estimate = await navigator.storage.estimate();
    return { out: out.slice(0, 60), usage: estimate.usage, quota: estimate.quota };
  });
  console.log(`usage ${listing.usage} of ${listing.quota}`);
  for (const line of listing.out) console.log(line);
} finally {
  await context.close();
}
