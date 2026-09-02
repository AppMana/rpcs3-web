// Stages the served-but-untracked assets into public/ before a dev server or
// a build (the `prepare:assets` step): the COOP/COEP service worker and the
// ELF/AOT fixtures through the kit's stageAssets, the single-module PPU AOT
// manifests, and the @appmana-public/disc-images modules that
// rpcs3-storage.mjs and its import worker load by relative URL. public/ is
// served verbatim by `vite preview`, so the package cannot be reached there
// through a bare specifier or node_modules.
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageAssets } from "@appmana-public/web-emulator-harness/stage-assets";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public");
const fixtureOutput = path.join(output, "fixtures");
const testBinaries = path.join(root, "..", "bin", "test");
const fixtures = [
  "ppu_thread.elf",
  "web_dispatch_conformance.self",
  "web_dispatch_conformance-aot.wasm",
  "web_dispatch_conformance-aot.json",
  "web_dispatch_conformance-spu-aot.wasm",
  "gs_gcm_basic_triangle.elf",
  "gs_gcm_cube.elf",
  "gs_gcm_tetris.elf",
  "gs-gcm-tetris-aot.wasm",
  "gs-gcm-tetris-aot.json",
];

await stageAssets({ outputDir: output, fixtures: fixtures.map((name) => ({ from: path.join(testBinaries, name) })) });

// Single-module PPU AOT bundles for rpcs3-ppu-aot-table.mjs (one part, absolute block names).
for (const name of ["web_dispatch_conformance-aot", "gs-gcm-tetris-aot", "web_dispatch_conformance-spu-aot"]) {
  const wasm = await WebAssembly.compile(await readFile(path.join(fixtureOutput, `${name}.wasm`)));
  const blocks = WebAssembly.Module.exports(wasm).filter((entry) => entry.kind === "function" && /^__0x[0-9a-f]+$/i.test(entry.name)).length;
  const manifest = { version: 1, parts: [{ url: `${name}.wasm`, module: "fixture", relocatable: false, blocks }] };
  await writeFile(path.join(fixtureOutput, `${name}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

const discImages = path.dirname(createRequire(import.meta.url).resolve("@appmana-public/disc-images/package.json"));
const vendored = path.join(output, "vendor", "disc-images");
await rm(vendored, { recursive: true, force: true });
for (const directory of ["core", "browser"]) await cp(path.join(discImages, directory), path.join(vendored, directory), { recursive: true });
