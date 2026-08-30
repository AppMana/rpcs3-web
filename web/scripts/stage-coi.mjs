import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public");

await mkdir(output, { recursive: true });
await copyFile(
  path.join(root, "node_modules", "coi-serviceworker", "coi-serviceworker.min.js"),
  path.join(output, "coi-serviceworker.js"),
);
