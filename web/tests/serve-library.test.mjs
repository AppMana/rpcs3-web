import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLibraryServer } from "../scripts/serve-library.mjs";

let directory;
let library;
let base;
const payload = randomBytes(1_000_003);
const payloadSha256 = createHash("sha256").update(payload).digest("hex");

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "rpcs3-library-"));
  await writeFile(path.join(directory, "sample.iso"), payload);
  await writeFile(path.join(directory, "empty.bin"), new Uint8Array());
  await writeFile(path.join(directory, ".hidden"), "x");
  library = await createLibraryServer({
    directories: [directory],
    cacheFile: path.join(directory, "hashes.json"),
    log: () => {},
  });
  const address = await library.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${address.port}`;
  await library.ready;
});

afterAll(async () => {
  await library?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("library server", () => {
  it("publishes an index with sizes, ETags, and SHA-256 digests under the prefix", async () => {
    const response = await fetch(`${base}/library/index.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const index = await response.json();
    expect(index.hashing).toBe(false);
    expect(index.files.map((file) => file.name)).toEqual(["empty.bin", "sample.iso"]);
    const sample = index.files.find((file) => file.name === "sample.iso");
    expect(sample).toMatchObject({ size: payload.length, sha256: payloadSha256, url: "files/sample.iso" });
    expect(sample.etag).toMatch(/^"\d+-\d+"$/);
    const unprefixed = await fetch(`${base}/index.json`);
    expect((await unprefixed.json()).files.length).toBe(2);
  });

  it("answers HEAD with the full length and range support", async () => {
    const response = await fetch(`${base}/library/files/sample.iso`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe(String(payload.length));
    expect(response.headers.get("x-content-sha256")).toBe(payloadSha256);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("serves exact 206 ranges whose concatenation reproduces the file", async () => {
    const chunkSize = 300_000;
    const pieces = [];
    for (let start = 0; start < payload.length; start += chunkSize) {
      const end = Math.min(payload.length, start + chunkSize) - 1;
      const response = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: `bytes=${start}-${end}` } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes ${start}-${end}/${payload.length}`);
      expect(response.headers.get("content-length")).toBe(String(end - start + 1));
      pieces.push(new Uint8Array(await response.arrayBuffer()));
    }
    const joined = Buffer.concat(pieces);
    expect(joined.length).toBe(payload.length);
    expect(createHash("sha256").update(joined).digest("hex")).toBe(payloadSha256);
  });

  it("handles open-ended, suffix, clamped, and unsatisfiable ranges", async () => {
    const open = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: `bytes=${payload.length - 5}-` } });
    expect(open.status).toBe(206);
    expect(Buffer.from(await open.arrayBuffer())).toEqual(payload.subarray(payload.length - 5));
    const suffix = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: "bytes=-7" } });
    expect(suffix.headers.get("content-range")).toBe(`bytes ${payload.length - 7}-${payload.length - 1}/${payload.length}`);
    const clamped = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: "bytes=10-99999999" } });
    expect(clamped.headers.get("content-range")).toBe(`bytes 10-${payload.length - 1}/${payload.length}`);
    const beyond = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: `bytes=${payload.length}-` } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${payload.length}`);
    const ignored = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: "bytes=0-1,3-4" } });
    expect(ignored.status).toBe(200);
    expect(ignored.headers.get("content-length")).toBe(String(payload.length));
  });

  it("falls back to the full body when If-Range does not match the ETag", async () => {
    const head = await fetch(`${base}/library/files/sample.iso`, { method: "HEAD" });
    const etag = head.headers.get("etag");
    const matching = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: "bytes=0-9", "If-Range": etag } });
    expect(matching.status).toBe(206);
    const stale = await fetch(`${base}/library/files/sample.iso`, { headers: { Range: "bytes=0-9", "If-Range": '"stale"' } });
    expect(stale.status).toBe(200);
  });

  it("refuses traversal, hidden files, unknown names, and other methods", async () => {
    expect((await fetch(`${base}/library/files/..%2Fhashes.json`)).status).toBe(404);
    expect((await fetch(`${base}/library/files/.hidden`)).status).toBe(404);
    expect((await fetch(`${base}/library/files/missing.iso`)).status).toBe(404);
    expect((await fetch(`${base}/library/hashes.json`)).status).toBe(404);
    expect((await fetch(`${base}/library/files/sample.iso`, { method: "POST" })).status).toBe(405);
  });

  it("serves the empty file with a zero length", async () => {
    const response = await fetch(`${base}/library/files/empty.bin`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
  });
});
