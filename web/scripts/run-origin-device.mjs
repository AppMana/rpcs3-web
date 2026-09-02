// Runs the full RPCS3 runtime acceptance on an attached iPad from a hosted,
// cross-origin-isolated HTTPS origin (default https://rpcs3.appmana.com, an
// nginx Ingress in front of `vite preview` on this machine) instead of
// injecting the build over USB: the kit's origin lane drives the page's own
// acceptance API, so the report has the same shape as the desktop lanes.
//
//   node scripts/run-origin-device.mjs [origin] [outputDir] [fixture] [frames]
//   RPCS3_DEVICE_ORIGIN  RPCS3_DIRECT_RENDERER=1  RPCS3_DEVICE_HARD_RESET=1
//   WIP_DISCOVERY_URL  WIP_TIMEOUT_MS
//
// Requires one trusted USB device with an inspectable HTTPS Safari page.
import path from "node:path";
import { runOriginLane } from "@appmana-public/web-emulator-harness/device-lanes";
import { delay, openPage } from "@appmana-public/web-emulator-harness/webkit-inspector";

const origin = new URL(process.argv[2] || process.env.RPCS3_DEVICE_ORIGIN || "https://rpcs3.appmana.com/");
const outputDirectory = path.resolve(process.argv[3] || "device-origin-evidence");
const fixtureName = process.argv[4] || "gs_gcm_tetris.elf";
const frameCount = Math.max(1, Math.min(60, Number(process.argv[5] || 60)));
// RPCS3_DIRECT_RENDERER=1: the RSX thread renders through emdawnwebgpu and presents ImageBitmaps
const direct = process.env.RPCS3_DIRECT_RENDERER === "1";
const discoveryURL = process.env.WIP_DISCOVERY_URL;
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 180_000);
const log = (line) => process.stderr.write(`${line}\n`);

if (process.env.RPCS3_DEVICE_HARD_RESET === "1") {
  // Safari keeps a previous run's 512 MiB shared memory until its page is gone; park the tab on
  // about:blank first so the next module creation can allocate it again.
  const parked = await openPage("about:blank", { discoveryURL, timeoutMs, commandTimeoutMs: timeoutMs, log });
  parked.connection.close();
  await delay(4000);
}

const { passed, evidence } = await runOriginLane({
  emulator: "rpcs3",
  apiGlobal: "__rpcs3Runtime",
  runtimeURL: new URL("runtime.html", origin).href,
  target: `fixtures/${fixtureName}`,
  runOptions: { frames: frameCount, render: true, width: 320, height: 180, readback: false, presentLatestOnly: false, directRenderer: direct },
  // One final frame with readback for image evidence.
  captureOptions: { frames: direct ? 3 : 1, render: true, width: 320, height: 180, captureRgba: true, directRenderer: direct },
  evidenceDir: outputDirectory,
  discoveryURL,
  timeoutMs,
  log,
  judge: (summary) => {
    const adapterName = String(summary.gpu?.adapter ?? summary.gpu?.device?.vendor ?? "").toLowerCase();
    return Boolean(summary.ok) && summary.bootResult === 0 && summary.emu?.droppedPackets === 0
      && adapterName.includes("apple") && (!direct || (summary.gpu?.presented ?? 0) > 0)
      && summary.shutdown?.stoppedCleanly === true && (summary.shutdown?.liveThreadNames ?? []).length === 0;
  },
});
process.stdout.write(`${JSON.stringify({ ...evidence, result: { ...evidence.result, shutdown: evidence.result.shutdown && { ...evidence.result.shutdown, stackReport: undefined } } }, null, 2)}\n`);
if (!passed) process.exitCode = 1;
