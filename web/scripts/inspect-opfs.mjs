import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const prefix = (process.argv[2] || "").replace(/^\/+/, "");
const readPath = (process.env.RPCS3_OPFS_READ || "").replace(/^\/+/, "");
const outputPath = process.env.RPCS3_OPFS_EXPORT
  ? path.resolve(process.env.RPCS3_OPFS_EXPORT)
  : undefined;
const profilePath = process.env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile");
const baseURL = process.env.RPCS3_WEB_URL || "http://127.0.0.1:4175";

const context = await chromium.launchPersistentContext(profilePath, {
  executablePath: process.env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${baseURL}/storage.html`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async ({ selectedPrefix, selectedPath }) => {
    const root = await navigator.storage.getDirectory();
    const entries = [];

    async function visit(directory, currentPath) {
      for await (const [name, handle] of directory.entries()) {
        const entryPath = currentPath ? `${currentPath}/${name}` : name;
        if (handle.kind === "directory") {
          await visit(handle, entryPath);
        } else if (!selectedPrefix || entryPath.startsWith(selectedPrefix)) {
          const file = await handle.getFile();
          entries.push({ path: entryPath, size: file.size, modified: file.lastModified });
        }
      }
    }

    await visit(root, "");
    if (!selectedPath) return { entries };

    const parts = selectedPath.split("/").filter(Boolean);
    const fileName = parts.pop();
    let directory = root;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    return { entries, bytes: [...new Uint8Array(await file.arrayBuffer())] };
  }, { selectedPrefix: prefix, selectedPath: readPath });

  if (result.bytes) {
    const bytes = Uint8Array.from(result.bytes);
    delete result.bytes;
    result.read = { path: readPath, size: bytes.byteLength };
    if (outputPath) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, bytes);
      result.read.output = outputPath;
    } else {
      result.read.text = new TextDecoder().decode(bytes);
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await context.close();
}
