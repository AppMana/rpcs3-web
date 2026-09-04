import { expect, test } from "@playwright/test";

// The runtime PPU tier alongside an ahead-of-time bundle, which is the combination neither the
// bundle test nor the tier's own coverage exercises. A bundle block reaches another through the
// guest-address table, so it can read a slot the tier owns and branch into a block the tier
// compiled; the bundle here carries every second block so that path is taken rather than hoped for.
//
// The bundle module is a pre-existing artifact, built before the tier did, and that is the point: a
// block compiled then knows nothing of the tier's slots and must still reach the interpreter rather
// than call whatever it finds. Rebuilding it would weaken this test.
//
// The oracle is the same program run by the interpreter: the native dispatch verdict.

type Runtime = { run(fixture?: string, options?: Record<string, unknown>): Promise<Record<string, unknown>> };

const partialBundle = "fixtures/web_dispatch_conformance-partial.manifest.json";

// public/fixtures is generated, not tracked, so say which command makes this one rather than
// failing inside the runtime on an HTML 404 body
async function requireBundle(page: import("@playwright/test").Page) {
  // A missing file comes back as the page's own HTML with a 200, so parse rather than trust the status
  const present = await page.evaluate(async (url) => {
    try {
      const response = await fetch(url);
      return response.ok && (await response.json()).version === 1;
    } catch {
      return false;
    }
  }, partialBundle);
  test.skip(!present, `${partialBundle} is missing; build it with:\n  node scripts/build-partial-ppu-bundle.mjs public/fixtures/web_dispatch_conformance-aot.wasm public/${partialBundle} 2`);
}

async function runFixture(page: import("@playwright/test").Page, fixture: string, options: Record<string, unknown>) {
  return page.evaluate(async ([fixtureName, runOptions]) => {
    const runtime = (window as Window & { __rpcs3Runtime?: Runtime }).__rpcs3Runtime;
    if (!runtime) return { ok: false, detail: "runtime acceptance API is unavailable" };
    try {
      return await runtime.run(fixtureName as string, runOptions as Record<string, unknown>);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
    }
  }, [fixture, options] as const);
}

test("matches the native oracle with a partial bundle and the runtime PPU tier together", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  await requireBundle(page);
  const result = await runFixture(page, "fixtures/web_dispatch_conformance.self", {
    completion: "dispatch",
    renderer: "null",
    ppuAotBundle: partialBundle,
    ppuJit: true,
    ppuJitThreshold: 4,
    expectedVerdict: "76ec98ba0e352b1c",
    dispatchTimeoutMs: 60_000,
  });
  await testInfo.attach("ppu-jit-with-bundle.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  const table = result.ppuAotTable as { blocks: number; dispatches: number };
  const tier = result.ppuJitReport as { enabled: number; registered: number; refused: number; unplaced: number; dispatches: number };
  expect(table.blocks, JSON.stringify(table)).toBeGreaterThan(0);
  expect(tier.enabled, JSON.stringify(tier)).toBe(1);
  // A block the tier cannot place is one a compiled block could have branched into
  expect(tier.unplaced, JSON.stringify(tier)).toBe(0);
  expect(tier.dispatches, JSON.stringify(tier)).toBeGreaterThan(0);
});

test("leaves blocks interpreted when the tier's table region is full", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.goto("/runtime.html");
  await requireBundle(page);
  const result = await runFixture(page, "fixtures/web_dispatch_conformance.self", {
    completion: "dispatch",
    renderer: "null",
    ppuAotBundle: partialBundle,
    ppuJit: true,
    ppuJitThreshold: 4,
    ppuJitCapacity: 8,
    expectedVerdict: "76ec98ba0e352b1c",
    dispatchTimeoutMs: 60_000,
  });
  await testInfo.attach("ppu-jit-capacity.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
  expect(result.verdict).toBe("76ec98ba0e352b1c");
  const tier = result.ppuJitReport as { registered: number; refused: number; unplaced: number; capacity: number };
  expect(tier.capacity, JSON.stringify(tier)).toBe(8);
  expect(tier.registered, JSON.stringify(tier)).toBeLessThanOrEqual(8);
  expect(tier.unplaced, JSON.stringify(tier)).toBe(0);
});
