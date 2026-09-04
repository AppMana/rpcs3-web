import { expect, test } from "@playwright/test";

test("a repeated range request is served without going back to the network", async ({ page }) => {
  await page.goto("/storage.html");

  const index = await page.evaluate(async () => {
    const response = await fetch("/library/index.json");
    return response.ok ? await response.json() : null;
  });
  test.skip(!index?.files?.length, "no library server on this origin");

  const name = index.files.find((file: { size: number }) => file.size > 2_000_000)?.name
    ?? index.files[0].name;

  const measured = await page.evaluate(async (name: string) => {
    const url = `/library/files/${encodeURIComponent(name)}`;
    // The same shape wasmfs_create_fetch_backend uses: a HEAD to size the file, then ranged reads
    const head = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-" } });
    const acceptRanges = head.headers.get("accept-ranges");
    const range = { headers: { Range: "bytes=0-1048575" } };
    const read = async () => {
      const response = await fetch(url, range);
      const bytes = (await response.arrayBuffer()).byteLength;
      return { status: response.status, bytes, cacheControl: response.headers.get("cache-control") };
    };
    const first = await read();
    const second = await read();
    const entries = performance.getEntriesByType("resource")
      .filter((entry) => entry.name.includes(encodeURIComponent(name)))
      .map((entry) => (entry as PerformanceResourceTiming).transferSize);
    return { first, second, acceptRanges, transferSizes: entries };
  }, name);

  expect(measured.acceptRanges).toBe("bytes");
  expect(measured.first.status).toBe(206);
  expect(measured.second.status).toBe(206);
  expect(measured.second.bytes).toBe(measured.first.bytes);
  expect(measured.first.cacheControl).toContain("immutable");

  const secondTransfer = measured.transferSizes.at(-1) ?? 0;
  expect(
    secondTransfer,
    `repeat range transferred ${secondTransfer} bytes of a ${measured.second.bytes} byte body`,
  ).toBeLessThan(measured.second.bytes / 10);
});
