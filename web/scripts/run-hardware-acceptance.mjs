// Hardware (physical-adapter) acceptance runner: the kit's runHardwareAcceptance
// driving the same page API (`__rpcs3Runtime.run`) as the Playwright lanes and
// the hosted-origin iPad runner, from a persistent Chrome profile whose
// origin-private storage holds firmware and games. RPCS3 adds its run options,
// the packet fixture capture, and surface dumps.
//
//   node scripts/run-hardware-acceptance.mjs <fixtures/x.elf | /opfs/games/x.iso> [report.json]
//
// Environment (WEB_EMULATOR_* is accepted as a fallback for the shared ones):
//   RPCS3_WEB_URL=http://127.0.0.1:4175   origin (keep it stable: OPFS is per origin)
//   RPCS3_CHROME_PROFILE=~/.cache/rpcs3-web-chrome-profile
//   RPCS3_CHROME_PATH=/usr/bin/google-chrome   RPCS3_HEADED=1
//   RPCS3_FRAMES=1 (max 3600)   RPCS3_UNTIL_DRAW=1   RPCS3_RENDER_EVERY=1
//   RPCS3_TIMEOUT_MS=120000   RPCS3_WIDTH=1280 RPCS3_HEIGHT=720   RPCS3_READBACK=0|1
//   RPCS3_CLOCK_SCALE=<percent>   RPCS3_ACCURATE_SPU_DMA=1   RPCS3_RENDERER=webgpu|null
//   RPCS3_PACKET_CAPTURE_LEVEL=0..5   RPCS3_POOL_SIZE=12   RPCS3_CORE=release|profile
//   RPCS3_PACKET_FIXTURE=/path/frame.wgpf.gz   RPCS3_CAPTURE_RGBA=1   RPCS3_CAPTURE_SHADERS=1
//   RPCS3_CPU_PROFILE=/path/run.cpuprofile   RPCS3_CPU_INTERVAL_US=10000   RPCS3_TRACE=/path/trace.json
//   RPCS3_WATCH_ADDRESS / RPCS3_TRACE_PC / RPCS3_TRACE_DELAY_PC / RPCS3_TRACE_DELAY_MS / RPCS3_DEBUG_ADDRESSES=a,b
//   RPCS3_INPUT_TRACE=/path/trace.json   frame-indexed pad states recorded on play.html
//   RPCS3_DIRECT_RENDERER=1   RPCS3_DIAGNOSTICS=1   RPCS3_DUMP_SURFACES=1   RPCS3_SKIP_DRAWS=a,b-c
//   RPCS3_VERTEX_DIAGNOSTICS=1   RPCS3_SPU_TRACE_RANGE=a-b   RPCS3_SPU_FALLBACK_HIST=1
//   RPCS3_RESOLUTION_SCALE   RPCS3_PPU_AOT_BUNDLE   RPCS3_SPU_AOT_BUNDLE   RPCS3_TOLERATE_RENDER_ERRORS=0
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { encodePng } from "@appmana-public/web-emulator-harness/compare";
import { hardwareOptionsFromEnv, runHardwareAcceptance } from "@appmana-public/web-emulator-harness/hardware-acceptance";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: run-hardware-acceptance.mjs <fixtures/x.elf | /opfs/games/x.iso> [report.json]\n");
  process.exit(2);
}
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const env = process.env;
const options = hardwareOptionsFromEnv(env, { prefix: "RPCS3", profileName: "rpcs3-web-chrome-profile" });
if (!env.RPCS3_WEB_URL && !env.WEB_EMULATOR_WEB_URL) options.baseURL = "http://127.0.0.1:4175";
const packetFixturePath = env.RPCS3_PACKET_FIXTURE ? path.resolve(env.RPCS3_PACKET_FIXTURE) : undefined;
if (packetFixturePath && !env.RPCS3_READBACK) options.readback = true;
const number = (value) => (value ? Number(value) : undefined);
const extraRunOptions = {
  directRenderer: env.RPCS3_DIRECT_RENDERER === "1",
  capturePacketFixture: Boolean(packetFixturePath),
  ppuAotBundle: env.RPCS3_PPU_AOT_BUNDLE || undefined,
  spuAotBundle: env.RPCS3_SPU_AOT_BUNDLE || undefined,
  spuFallbackHistogram: env.RPCS3_SPU_FALLBACK_HIST === "1",
  diagnostics: env.RPCS3_DIAGNOSTICS === "1",
  dumpSurfaces: env.RPCS3_DUMP_SURFACES === "1",
  skipDraws: env.RPCS3_SKIP_DRAWS ? env.RPCS3_SKIP_DRAWS.split(",").flatMap((item) => { const [a, b] = item.split("-").map(Number); return b === undefined ? [a] : Array.from({ length: b - a + 1 }, (_, i) => a + i); }) : undefined,
  vertexDiagnostics: env.RPCS3_VERTEX_DIAGNOSTICS === "1",
  spuTraceRange: env.RPCS3_SPU_TRACE_RANGE ? env.RPCS3_SPU_TRACE_RANGE.split("-").map(Number) : undefined,
  clockScale: number(env.RPCS3_CLOCK_SCALE),
  resolutionScale: number(env.RPCS3_RESOLUTION_SCALE),
  accurateSpuDma: env.RPCS3_ACCURATE_SPU_DMA ? env.RPCS3_ACCURATE_SPU_DMA === "1" : undefined,
  packetCaptureLevel: number(env.RPCS3_PACKET_CAPTURE_LEVEL),
  coreUrl: env.RPCS3_CORE === "profile" ? "./core/profile/rpcs3-web.mjs" : undefined,
  tracePc: number(env.RPCS3_TRACE_PC),
  traceDelayPc: number(env.RPCS3_TRACE_DELAY_PC),
  traceDelayMs: number(env.RPCS3_TRACE_DELAY_MS),
  watchAddress: number(env.RPCS3_WATCH_ADDRESS),
  debugAddresses: env.RPCS3_DEBUG_ADDRESSES ? env.RPCS3_DEBUG_ADDRESSES.split(",").map(Number) : [],
};

const { completed } = await runHardwareAcceptance({
  target,
  outputPath,
  apiGlobal: "__rpcs3Runtime",
  emulator: "rpcs3",
  options,
  extraRunOptions,
  onResult: async (result, report) => {
    const { packetFixture, ...resultWithoutFixture } = result;
    const surfaceDumps = result.gpu?.surfaceDumps;
    if (outputPath) {
      for (const dump of surfaceDumps ?? []) {
        await writeFile(`${outputPath.replace(/\.json$/, "")}.${dump.key.replace(/[^a-z0-9]+/gi, "_")}.png`, encodePng({ width: dump.width, height: dump.height, data: new Uint8Array(Buffer.from(dump.rgbaBase64, "base64")) }));
      }
      if (packetFixture || surfaceDumps) {
        // The kit wrote the report with the raw fixture bytes and surface dumps
        // inside; those live in their own files, so rewrite it without them.
        report.packetFixture = packetFixture && { path: packetFixturePath, ...packetFixture, base64: undefined };
        report.result = resultWithoutFixture.gpu ? { ...resultWithoutFixture, gpu: { ...resultWithoutFixture.gpu, rgbaBase64: undefined, surfaceDumps: undefined } } : resultWithoutFixture;
        await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
      }
    }
    if (packetFixturePath) {
      if (!packetFixture) throw new Error("the requested packet fixture frame was not captured");
      await mkdir(path.dirname(packetFixturePath), { recursive: true });
      const fixture = gzipSync(Buffer.from(packetFixture.base64, "base64"), { level: 9 });
      await writeFile(packetFixturePath, fixture);
      await writeFile(`${packetFixturePath}.json`, `${JSON.stringify({
        target,
        adapter: report.adapter,
        frameSequence: packetFixture.frameSequence,
        packetCount: packetFixture.packetCount,
        drawPacketCount: packetFixture.drawPacketCount,
        uncompressedBytes: packetFixture.bytes,
        compressedBytes: fixture.byteLength,
        gpu: result.gpu && { draws: result.gpu.draws, vertices: result.gpu.vertices, frameHash: result.gpu.frameHash, changedPixels: result.gpu.changedPixels, timings: result.gpu.timings, pipelineCache: result.gpu.pipelineCache, textureCache: result.gpu.textureCache },
      }, null, 2)}\n`);
    }
  },
});
if (!completed) process.exitCode = 1;
