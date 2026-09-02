// Drives the attached iPad's Safari page (the kit's WebKit Inspector client
// through ios_webkit_debug_proxy) to a probe page on the hosted origin and
// returns window.__probeResult.
//   node scripts/run-probe-device.mjs [origin] [page] [outFile]
import { writeFile } from "node:fs/promises";
import { openPage, waitForExpression } from "@appmana-public/web-emulator-harness/webkit-inspector";

const origin = new URL(process.argv[2] || process.env.RPCS3_DEVICE_ORIGIN || "https://rpcs3.appmana.com/");
const pageName = process.argv[3] || "probe-worker-webgpu.html";
const outFile = process.argv[4] || "probe-device.json";
const discoveryURL = process.env.WIP_DISCOVERY_URL;
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 120_000);

const url = new URL(`${pageName}?device=${Date.now()}`, origin).href;
const { device, connection } = await openPage(url, { discoveryURL, timeoutMs, commandTimeoutMs: timeoutMs });
try {
  await waitForExpression(connection, "Boolean(window.__probeResult)", { timeoutMs, pollMs: 500, what: "the probe report" });
  const result = JSON.parse(await connection.evaluate("JSON.stringify(window.__probeResult)"));
  result.device = { name: device.deviceName, id: device.deviceId, version: device.deviceOSVersion };
  await writeFile(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  connection.close();
}
