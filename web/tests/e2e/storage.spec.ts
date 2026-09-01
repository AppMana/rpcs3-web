import { expect, test } from "@playwright/test";

test("streams files into persistent OPFS and retains them across reload", async ({ page }) => {
  await page.goto("/storage.html");
  const first = await page.evaluate(async () => {
    const storage = (window as typeof window & { __rpcs3Storage: any }).__rpcs3Storage;
    const payload = new File([new Uint8Array([0x52, 0x50, 0x43, 0x53, 0x33])], "EBOOT.BIN");
    const result = await storage.importFiles([payload], { destination: "games/opfs-test/PS3_GAME/USRDIR" });
    return { result, files: await storage.list() };
  });
  expect(first.result.bootPath).toBe("/opfs/games/opfs-test");
  expect(first.files).toContainEqual(expect.objectContaining({
    path: "games/opfs-test/PS3_GAME/USRDIR/EBOOT.BIN",
    size: 5,
  }));

  await page.reload();
  const files = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: any }).__rpcs3Storage.list());
  expect(files).toContainEqual(expect.objectContaining({
    path: "games/opfs-test/PS3_GAME/USRDIR/EBOOT.BIN",
    size: 5,
  }));
});
