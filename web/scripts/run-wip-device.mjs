// Drives the deployed capability page on an attached iPad (the kit's WIP
// lane): waits for the probe, reads the smoke report, plays the Tetris
// homebrew with a keyboard event, and judges the capability and gameplay
// evidence in Node.
//
//   node scripts/run-wip-device.mjs [url] [outputDir]
//   WIP_DISCOVERY_URL  WIP_TIMEOUT_MS
import path from "node:path";
import { runWipLane } from "@appmana-public/web-emulator-harness/device-lanes";

const destination = new URL(process.argv[2] || "https://appmana.github.io/rpcs3-web/");
const outputDirectory = path.resolve(process.argv[3] || "device-evidence");
const discoveryURL = process.env.WIP_DISCOVERY_URL;
const timeoutMs = Number(process.env.WIP_TIMEOUT_MS || 90_000);

// The lane polls `ready` and then reads `collect`; the whole page-side flow
// (probe, gameplay, input, snapshot framing) runs once from the first poll
// and parks its outcome for `collect`.
const ready = `(() => {
  if (!globalThis.__rpcs3WipRun) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const gameStatus = () => JSON.parse(JSON.stringify(window.__rpcs3Web?.gameStatus?.() ?? { state: "unavailable", detail: "This deployed build does not expose gameStatus" }));
    globalThis.__rpcs3WipRun = (async () => {
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline && !(window.__rpcs3Web && window.__rpcs3Web.status !== "probing")) await delay(250);
      const report = window.__rpcs3Web.capabilities() ?? await window.__rpcs3Web.runSmokeTest();
      while (Date.now() < deadline) {
        const status = window.__rpcs3Web?.gameStatus();
        if (status?.state === "running" && (status.flips ?? 0) >= 30) break;
        await delay(250);
      }
      const gameBeforeInput = gameStatus();
      if (gameBeforeInput.state === "running") {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
        const inputDeadline = Date.now() + ${timeoutMs};
        while (Date.now() < inputDeadline && Number(window.__rpcs3Web?.gameStatus?.()?.flips || 0) < (gameBeforeInput.flips ?? 0) + 30) await delay(250);
        window.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }));
      }
      const gameAfterInput = gameStatus();
      document.querySelector("#game-preview")?.scrollIntoView({ block: "center" });
      await delay(250);
      return { report, gameBeforeInput, gameAfterInput };
    })().then((collected) => { globalThis.__rpcs3WipCollected = collected; }, (error) => { globalThis.__rpcs3WipCollected = { error: String(error) }; });
  }
  return Boolean(globalThis.__rpcs3WipCollected);
})()`;

const { passed, evidence } = await runWipLane({
  emulator: "rpcs3",
  url: destination.href,
  evidenceDir: outputDirectory,
  discoveryURL,
  timeoutMs,
  ready,
  collect: "JSON.stringify(globalThis.__rpcs3WipCollected)",
  judge: ({ report, gameBeforeInput, gameAfterInput }) => {
    const gamePassed = gameBeforeInput?.state === "running"
      && (gameBeforeInput.flips ?? 0) >= 30
      && (gameBeforeInput.draws ?? 0) >= 9
      && (gameBeforeInput.vertices ?? 0) >= 36
      && (gameBeforeInput.changedPixels ?? 0) > 100
      && (gameBeforeInput.clearPixels ?? 0) > 100
      && (gameBeforeInput.expectedSamples ?? 0) >= 4
      && gameBeforeInput.matchedSamples === gameBeforeInput.expectedSamples
      && (gameAfterInput?.activeCenterX ?? -Infinity) > (gameBeforeInput.activeCenterX ?? Infinity) + 0.02;
    return Boolean(report?.coreProbe?.loaded) && report.coreProbe.memoryTestMask === 0 && report.coreProbe.ppuTestMask === 0 && gamePassed;
  },
});
console.log(JSON.stringify(evidence, null, 2));
if (!passed) process.exitCode = 1;
