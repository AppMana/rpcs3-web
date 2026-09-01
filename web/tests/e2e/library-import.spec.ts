import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

type StorageAPI = {
  libraryIndex: () => Promise<{ files: Array<{ name: string; size: number; sha256: string | null }> }>;
  importFromLibrary: (name: string, destination: string, options?: Record<string, unknown>) => Promise<any>;
  importProgress: () => any;
  abortImport: () => boolean;
  list: () => Promise<Array<{ path: string; size?: number }>>;
};

const fixtureSha256 = (name: string) => createHash("sha256").update(readFileSync(`public/fixtures/${name}`)).digest("hex");

test("imports a library file into OPFS through range requests and verifies its SHA-256", async ({ page }) => {
  await page.goto("/storage.html");
  const index = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.libraryIndex());
  const cube = index.files.find((file) => file.name === "gs_gcm_cube.elf");
  expect(cube?.sha256).toBe(fixtureSha256("gs_gcm_cube.elf"));

  const result = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary("gs_gcm_cube.elf", "games", { chunkSize: 65536, restart: true }));
  expect(result.verified).toBe(true);
  expect(result.sha256).toBe(fixtureSha256("gs_gcm_cube.elf"));
  expect(result.size).toBe(cube!.size);
  expect(result.sessionBytes).toBe(cube!.size);
  expect(result.requests).toBe(Math.ceil(cube!.size / 65536));
  expect(result.restarted).toBe(true);
  expect(result.bootPath).toBeUndefined();
  expect(result.mountedPath).toBe("/opfs/games/gs_gcm_cube.elf");
  expect(result.estimateAfter.usage).toBeGreaterThanOrEqual(result.estimateBefore.usage);

  const files = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.list());
  expect(files).toContainEqual(expect.objectContaining({ path: "games/gs_gcm_cube.elf", size: cube!.size }));
  expect(files.some((file) => file.path === ".rpcs3-imports/games/gs_gcm_cube.elf.json")).toBe(true);

  // A second run is satisfied from the verified sidecar without any network transfer.
  const again = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary("gs_gcm_cube.elf", "games"));
  expect(again.alreadyComplete).toBe(true);
  expect(again.sessionBytes).toBe(0);
  expect(again.verified).toBe(true);
});

test("resumes an aborted import after a reload from the bytes already stored", async ({ page, context }) => {
  // Slow every range response down so the abort lands mid-transfer. Worker
  // requests are only intercepted by context-level routes.
  await context.route("**/library/files/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The abort cancels in-flight requests, so continuing may no longer be possible.
    await route.continue().catch(() => {});
  });
  await page.goto("/storage.html");
  const index = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.libraryIndex());
  const tetris = index.files.find((file) => file.name === "gs_gcm_tetris.elf")!;

  const aborted = await page.evaluate(() => new Promise<any>((resolve) => {
    let aborted = false;
    (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary("gs_gcm_tetris.elf", "games", {
      chunkSize: 32768,
      restart: true,
      onProgress: (message: any) => {
        if (!aborted && message.offset >= 32768 * 3) {
          aborted = true;
          (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.abortImport();
        }
      },
    }).then((result) => resolve({ ok: true, result }), (error) => resolve({ ok: false, name: error.name, message: error.message, report: error.report }));
  }));
  expect(aborted.ok).toBe(false);
  expect(aborted.name).toBe("AbortError");
  const partial = aborted.report.offset as number;
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(tetris.size);

  const stored = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.list());
  expect(stored).toContainEqual(expect.objectContaining({ path: "games/gs_gcm_tetris.elf", size: partial }));
  expect(stored.some((file) => file.path === ".rpcs3-imports/games/gs_gcm_tetris.elf.json")).toBe(true);

  await context.unroute("**/library/files/**");
  await page.reload();
  const resumed = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary("gs_gcm_tetris.elf", "games", { chunkSize: 32768 }));
  expect(resumed.verified).toBe(true);
  expect(resumed.sha256).toBe(fixtureSha256("gs_gcm_tetris.elf"));
  expect(resumed.resumedFrom).toBe(partial);
  expect(resumed.sessionBytes).toBe(tetris.size - partial);
  expect(resumed.requests).toBe(Math.ceil((tetris.size - partial) / 32768));
  expect(resumed.restarted).toBe(false);
});

test("re-hashes stored bytes locally when the sidecar is missing and restarts on a changed source", async ({ page }) => {
  await page.goto("/storage.html");
  const index = await page.evaluate(() => (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.libraryIndex());
  const triangle = index.files.find((file) => file.name === "gs_gcm_basic_triangle.elf")!;
  // Simulate a crash before the sidecar was written: keep the data, drop the sidecar.
  const kept = await page.evaluate(async ({ name, size }) => {
    await (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary(name, "games", { restart: true });
    const root = await navigator.storage.getDirectory();
    const imports = await root.getDirectoryHandle(".rpcs3-imports");
    const games = await imports.getDirectoryHandle("games");
    await games.removeEntry(`${name}.json`);
    const truncatedTo = Math.floor(size / 2);
    const worker = new Worker(URL.createObjectURL(new Blob([`
      self.onmessage = async ({ data }) => {
        const root = await navigator.storage.getDirectory();
        const games = await root.getDirectoryHandle("games");
        const handle = await games.getFileHandle(data.name);
        const access = await handle.createSyncAccessHandle();
        access.truncate(data.size);
        access.flush();
        access.close();
        postMessage("ok");
      };
    `], { type: "text/javascript" })));
    await new Promise((resolve) => { worker.onmessage = resolve; worker.postMessage({ name, size: truncatedTo }); });
    worker.terminate();
    const result = await (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary(name, "games", { chunkSize: 65536 });
    return { truncatedTo, result };
  }, { name: triangle.name, size: triangle.size });
  expect(kept.result.verified).toBe(true);
  expect(kept.result.localRehashedBytes).toBe(kept.truncatedTo);
  expect(kept.result.resumedFrom).toBe(kept.truncatedTo);
  expect(kept.result.sessionBytes).toBe(triangle.size - kept.truncatedTo);
  expect(kept.result.sha256).toBe(fixtureSha256("gs_gcm_basic_triangle.elf"));

  // A sidecar that names a different source forces a restart from zero.
  const changed = await page.evaluate(async ({ name }) => {
    const root = await navigator.storage.getDirectory();
    const imports = await root.getDirectoryHandle(".rpcs3-imports");
    const games = await imports.getDirectoryHandle("games");
    const handle = await games.getFileHandle(`${name}.json`);
    const record = JSON.parse(await (await handle.getFile()).text());
    record.source.etag = '"changed"';
    record.complete = false;
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(record));
    await writable.close();
    return (window as typeof window & { __rpcs3Storage: StorageAPI }).__rpcs3Storage.importFromLibrary(name, "games", { chunkSize: 65536 });
  }, { name: triangle.name });
  expect(changed.restarted).toBe(true);
  expect(changed.resumedFrom).toBe(0);
  expect(changed.sessionBytes).toBe(triangle.size);
  expect(changed.verified).toBe(true);
});
