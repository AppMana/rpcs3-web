import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public");
const fixtureOutput = path.join(output, "fixtures");

await mkdir(output, { recursive: true });
await mkdir(fixtureOutput, { recursive: true });
await copyFile(
  path.join(root, "node_modules", "coi-serviceworker", "coi-serviceworker.min.js"),
  path.join(output, "coi-serviceworker.js"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "ppu_thread.elf"),
  path.join(fixtureOutput, "ppu_thread.elf"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "web_dispatch_conformance.self"),
  path.join(fixtureOutput, "web_dispatch_conformance.self"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "web_dispatch_conformance-aot.wasm"),
  path.join(fixtureOutput, "web_dispatch_conformance-aot.wasm"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "web_dispatch_conformance-aot.json"),
  path.join(fixtureOutput, "web_dispatch_conformance-aot.json"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "gs_gcm_basic_triangle.elf"),
  path.join(fixtureOutput, "gs_gcm_basic_triangle.elf"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "gs_gcm_cube.elf"),
  path.join(fixtureOutput, "gs_gcm_cube.elf"),
);
await copyFile(
  path.join(root, "..", "bin", "test", "gs_gcm_tetris.elf"),
  path.join(fixtureOutput, "gs_gcm_tetris.elf"),
);
