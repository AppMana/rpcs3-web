import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";

test("captures a raw WebGPU frame for native differential validation", async ({ page }, testInfo) => {
  test.skip(process.env.RPCS3_CAPTURE_FRAME !== "1", "set RPCS3_CAPTURE_FRAME=1 for a raw differential artifact");
  test.setTimeout(180_000);
  const fixture = process.env.RPCS3_CAPTURE_FIXTURE ?? "fixtures/gs_gcm_basic_triangle.elf";
  const width = Number(process.env.RPCS3_CAPTURE_WIDTH ?? 320);
  const height = Number(process.env.RPCS3_CAPTURE_HEIGHT ?? 180);
  await page.goto("/runtime.html");
  const result = await page.evaluate(async ({ fixture, width, height }) => {
    const runtime = (window as Window & {
      __rpcs3Runtime?: { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };
    }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    return runtime.run(fixture, { render: true, captureRgba: true, width, height });
  }, { fixture, width, height });
  const gpu = result.gpu as { presented?: boolean; rgbaBase64?: string; changedPixels?: number; adapter?: string } | undefined;
  const output = testInfo.outputPath("browser-frame.json");
  writeFileSync(output, JSON.stringify(result));
  await testInfo.attach("browser-frame.json", { path: output, contentType: "application/json" });
  expect(result.ok, JSON.stringify({ ...result, gpu: gpu && { ...gpu, rgbaBase64: undefined } }, null, 2)).toBe(true);
  expect(result.bootResult).toBe(0);
  expect(gpu?.presented).toBe(true);
  expect(gpu?.changedPixels).toBeGreaterThan(100);
  expect(Buffer.from(gpu?.rgbaBase64 ?? "", "base64")).toHaveLength(width * height * 4);
});
