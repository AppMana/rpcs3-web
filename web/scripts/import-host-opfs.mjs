import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const sourceArgument = process.argv[2];
const destinationArgument = process.argv[3];
if (!sourceArgument || !destinationArgument) {
  process.stderr.write("usage: npm run storage:import-host -- <host-file-or-directory> <opfs-relative-path>\n");
  process.exit(2);
}

function normalizeDestination(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new TypeError("OPFS destination must be a relative path without traversal");
  }
  return parts.join("/");
}

async function collectFiles(source) {
  const sourcePath = await realpath(source);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isDirectory()) return [{ sourcePath, relativePath: path.basename(sourcePath), size: sourceStat.size }];

  const files = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(entryPath, relativePath);
      else if (entry.isFile()) files.push({ sourcePath: entryPath, relativePath, size: (await stat(entryPath)).size });
    }
  }
  await visit(sourcePath, "");
  return files;
}

const destination = normalizeDestination(destinationArgument);
const files = await collectFiles(sourceArgument);
const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
const server = createServer((request, response) => {
  const match = /^\/file\/(\d+)$/.exec(request.url || "");
  const file = match ? files[Number(match[1])] : undefined;
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Length": file.size,
    "Content-Type": "application/octet-stream",
  });
  createReadStream(file.sourcePath).pipe(response);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const fileServerURL = `http://127.0.0.1:${address.port}`;

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
  let completedBytes = 0;
  for (const [index, file] of files.entries()) {
    const opfsPath = path.posix.join(destination, file.relativePath);
    await page.evaluate(async ({ targetPath, sourceURL }) => {
      const parts = targetPath.split("/");
      const fileName = parts.pop();
      let directory = await navigator.storage.getDirectory();
      for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
      const handle = await directory.getFileHandle(fileName, { create: true });
      const response = await fetch(sourceURL);
      if (!response.ok || !response.body) throw new Error(`Host import failed with HTTP ${response.status}`);
      const writable = await handle.createWritable({ keepExistingData: false });
      await response.body.pipeTo(writable);
    }, { targetPath: opfsPath, sourceURL: `${fileServerURL}/file/${index}` });
    completedBytes += file.size;
    process.stderr.write(`${index + 1}/${files.length} ${opfsPath} ${completedBytes}/${totalBytes}\n`);
  }
  process.stdout.write(`${JSON.stringify({ destination, files: files.length, bytes: completedBytes })}\n`);
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
