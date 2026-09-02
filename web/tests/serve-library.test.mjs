import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_FILE, DEFAULT_LIBRARY_DIR, createLibraryServer, parseLibraryArguments } from "../scripts/serve-library.mjs";

describe("library server wrapper", () => {
  it("serves public/fixtures and caches digests under ~/.cache/rpcs3-web-library by default", () => {
    const options = parseLibraryArguments(["--port", "4181"]);
    expect(options.directories).toEqual([DEFAULT_LIBRARY_DIR]);
    expect(options.cacheFile).toBe(DEFAULT_CACHE_FILE);
    expect(options.port).toBe(4181);
    expect(options.prefix).toBe("/library");
    const explicit = parseLibraryArguments(["--dir", "/somewhere", "--cache", "/tmp/h.json"]);
    expect(explicit.directories).toEqual(["/somewhere"]);
    expect(explicit.cacheFile).toBe("/tmp/h.json");
  });

  it("publishes the kit's index under /library/", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rpcs3-library-"));
    await writeFile(path.join(directory, "sample.bin"), new Uint8Array([1, 2, 3]));
    const library = await createLibraryServer({ ...parseLibraryArguments(["--dir", directory]), cacheFile: path.join(directory, "hashes.json"), log: () => {} });
    try {
      const address = await library.listen(0, "127.0.0.1");
      await library.ready;
      const index = await (await fetch(`http://127.0.0.1:${address.port}/library/index.json`)).json();
      expect(index.files).toEqual([expect.objectContaining({ name: "sample.bin", size: 3, sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", url: "files/sample.bin" })]);
    } finally {
      await library.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
