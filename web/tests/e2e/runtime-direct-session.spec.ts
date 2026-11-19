import { test, expect } from "@playwright/test";

// Determinism pin across presentation/yield/binding policies: the binding-cache
// split must never change the rendered frame. Each headed run records its
// capture hash; the final test asserts all policies render the same frame.
// Exact-hash and pixel-granularity assertions apply only under
// RPCS3_TEST_STRICT_PIXELS=1 (known-good hardware capture), because software
// (SwiftShader/llvmpipe) capture readback is a documented blank and must not be
// mistaken for either a pass or a rendering regression.
const designs = [
  { suspending: false, presentationYield: "timer", bindGroupCache: false },
  { suspending: true, presentationYield: "timer", bindGroupCache: false },
  { suspending: true, presentationYield: "message", bindGroupCache: false },
  { suspending: true, presentationYield: "message", bindGroupCache: true },
];
const captured: { design: string; frameHash: number; colored: number }[] = [];

for (const { suspending, presentationYield, bindGroupCache } of designs) {
  test(`direct session presents and captures real flips (${suspending ? "JSPI" : "bitmap"}, ${presentationYield}, cache=${bindGroupCache})`, async ({ page }) => {
    await page.goto("/runtime.html");
    await page.waitForFunction(() => Boolean((window as any).__rpcs3Runtime));
    const report = await page.evaluate(async ({ suspending, presentationYield, bindGroupCache, coreUrl }) => {
      const result = await (window as any).__rpcs3Runtime.run("fixtures/gs_gcm_tetris.elf", {
        frames: 60, render: true, directRenderer: true, width: 320, height: 180,
        suspending, presentationYield, bindGroupCache, coreUrl: coreUrl ?? (suspending ? "./core/jspi/rpcs3-web.mjs" : "./core/rpcs3-web.mjs"),
        readback: false, captureRgba: true, benchmark: true,
      });
      const pixels = atob(result.gpu?.rgbaBase64 ?? "");
      let colored = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels.charCodeAt(i) + pixels.charCodeAt(i + 1) + pixels.charCodeAt(i + 2) > 60) colored++;
      }
      return { ok: result.ok, flips: result.emuFlipId, timings: result.flipTimings,
        stats: result.directStats, bindGroupCache: result.directGpu?.bindGroupCache, presentationYield: result.directGpu?.presentationYield,
        timingDrops: result.timingDrops, presented: result.gpu?.presented,
        frameHash: result.gpu?.frameHash, colored, shutdown: result.shutdown?.stoppedCleanly };
    }, { suspending, presentationYield, bindGroupCache, coreUrl: process.env.RPCS3_TEST_CORE_URL });
    if (suspending) captured.push({ design: `${presentationYield}:${bindGroupCache}`, frameHash: report.frameHash, colored: report.colored });
    expect(report.ok).toBe(true);
    // The bitmap fallback has no suspending stack and no cache policy of its own,
    // so it reports neither policy; only the JSPI core echoes what was selected.
    if (suspending) {
      expect(report.presentationYield).toBe(presentationYield);
      expect(report.bindGroupCache).toBe(bindGroupCache);
    }
    // The bitmap fallback hosts no direct WebGPU backend, so it reports neither
    // stats nor policies; it is a presentation smoke path only.
    if (suspending) {
      expect(report.stats.bindGroupCreates).toBeGreaterThan(0);
      // This fixture has one draw per flip: cache lifetime must end at submission.
      expect(report.stats.bindGroupHits).toBe(0);
      if (process.env.RPCS3_TEST_SPLIT_BINDINGS === "1") {
        expect(report.stats.textureBindGroupHits).toBe(0);
        expect(report.stats.textureBindGroupCreates).toBe(bindGroupCache ? report.stats.bindGroupCreates : 0);
      }
      if (process.env.RPCS3_TEST_TEXTURE_BIND_CACHE === "1") {
        expect(report.stats.textureBindGroupHits).toBeGreaterThan(0);
        expect(report.stats.textureBindGroupCreates).toBeGreaterThan(0);
      }
    }
    expect(report.flips).toBeGreaterThanOrEqual(60);
    expect(report.presented).toBeGreaterThan(0);
    expect(Number.isInteger(report.frameHash)).toBe(true);
    if (process.env.RPCS3_TEST_STRICT_PIXELS === "1") {
      // Pin to the hardware-rendered Tetris frame hash (2236050885 was the FNV-1a
      // hash of a 320x180 all-zero transparent canvas when createImageBitmap failed
      // to extract the OffscreenCanvas swapchain texture).
      expect(report.frameHash).toBe(3241800133);
      expect(report.colored).toBeGreaterThan(100);
    }
    expect(report.timingDrops).toBe(0);
    expect(report.timings.length).toBeGreaterThan(0);
    if (process.env.RPCS3_TEST_DRAW_PHASES === "1") {
      for (const name of ["draw", "drawSetup", "drawTextures", "drawProgram", "drawClause", "drawVertex", "drawUniform", "drawBind", "drawEncode", "drawEnd"]) {
        expect(report.timings.every((sample: any) => Number.isFinite(sample.phasesUs?.[name]))).toBe(true);
        expect(report.timings.reduce((sum: number, sample: any) => sum + sample.phasesUs[name], 0)).toBeGreaterThan(0);
      }
    }
    for (let i = 1; i < report.timings.length; i++) {
      expect(report.timings[i].emuFlipId).toBe(report.timings[i - 1].emuFlipId + 1);
      expect(report.timings[i].hostTimeMs).toBeGreaterThan(report.timings[i - 1].hostTimeMs);
    }
    expect(report.shutdown).toBe(true);
  });
}

test("every JSPI presentation and binding policy renders the same deterministic frame", () => {
  const jspl = designs.filter((d) => d.suspending);
  expect(captured.length).toBe(jspl.length);
  const reference = captured[0]?.frameHash;
  expect(reference).not.toBeUndefined();
  for (const entry of captured.slice(1)) {
    expect(entry.frameHash).toBe(reference);
  }
});
