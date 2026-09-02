// Transfers the compiled RPCS3 GoogleTest artifact to an attached iPad
// through WebKit Inspector (the kit's unit lane) and requires every test to
// pass in Mobile Safari.
//
//   node scripts/run-unit-device.mjs [outputDir]
//   WIP_DISCOVERY_URL  WIP_TIMEOUT_MS
import { readFile } from "node:fs/promises";
import path from "node:path";
import { applyRewrites, runUnitLane } from "@appmana-public/web-emulator-harness/device-lanes";

const outputDirectory = path.resolve(process.argv[2] || "device-unit-evidence");
const discoveryURL = process.env.WIP_DISCOVERY_URL;
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 60_000);
const expectedTotal = 114;
const root = path.resolve(import.meta.dirname, "..");
const source = (relative) => readFile(path.join(root, "public", relative));

const workerSource = applyRewrites((await source("unit-smoke-worker.mjs")).toString("utf8"), [
  { from: 'await import(event.data.coreUrl || "./core/rpcs3-web-units.mjs")', to: "await import(event.data.coreUrl)" },
]);

const { passed, evidence, paths } = await runUnitLane({
  emulator: "rpcs3",
  evidenceDir: outputDirectory,
  discoveryURL,
  timeoutMs,
  uploadSlot: "__rpcs3UnitUpload",
  urlsSlot: "__rpcs3UnitDeviceUrls",
  log: (line) => process.stdout.write(`${line}\n`),
  modules: [
    { name: "worker", bytes: Buffer.from(workerSource), mime: "text/javascript" },
    { name: "core", bytes: await source("core/rpcs3-web-units.mjs"), mime: "text/javascript" },
    { name: "wasm", bytes: await source("core/rpcs3-web-units.wasm"), mime: "application/wasm" },
  ],
  expectedTotal,
  judge: (result) => result?.ok === true
    && result.report?.target === "wasm32-emscripten"
    && result.report?.total === expectedTotal
    && result.report?.passed === expectedTotal
    && result.report?.failed === 0
    && result.report?.skipped === 0
    && result.report?.tests?.length === expectedTotal,
});
const result = evidence.result;
process.stdout.write(`${JSON.stringify({
  passed,
  device: evidence.device,
  total: result?.report?.total,
  passedTests: result?.report?.passed,
  failed: result?.report?.failed,
  elapsedMs: result?.report?.elapsedMs,
  report: paths.report,
  screenshot: paths.page,
}, null, 2)}\n`);
if (!passed) process.exitCode = 1;
