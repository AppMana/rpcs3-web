import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  LIBRARY_IMPORT_SIDECAR_VERSION,
  StreamingSha256,
  createSha256,
  formatRate,
  parseContentRange,
  parseRangeRequest,
  planChunks,
  planResume,
  sha256Hex,
  sidecarPathFor,
} from "../public/library-import-core.mjs";

const reference = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("resumable SHA-256", () => {
  const sizes = [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 65_537, (1 << 20) + 77];

  it("matches node's digest for every padding boundary and split", () => {
    for (const size of sizes) {
      const data = randomBytes(size);
      const hash = new StreamingSha256();
      let offset = 0;
      while (offset < size) {
        const step = Math.min(size - offset, 1 + Math.floor(Math.random() * 70));
        hash.update(data.subarray(offset, offset + step));
        offset += step;
      }
      expect(hash.digestHex()).toBe(reference(data));
      expect(sha256Hex(data)).toBe(reference(data));
    }
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("exports a state that both implementations can resume from", async () => {
    for (const size of [200, 4096 + 13, (1 << 20) + 5]) {
      const data = randomBytes(size);
      const split = Math.floor(size * 0.37);
      const js = new StreamingSha256().update(data.subarray(0, split));
      const state = JSON.parse(JSON.stringify(js.exportState()));
      expect(state.length).toBe(split);
      expect(state.block.length).toBe(split % 64);

      const resumedJs = StreamingSha256.fromState(state).update(data.subarray(split));
      expect(resumedJs.digestHex()).toBe(reference(data));

      const wasm = await createSha256();
      expect(wasm.implementation).toBe("wasm");
      wasm.update(data.subarray(0, split));
      expect(wasm.exportState()).toEqual(state);
      const resumedWasm = await createSha256(state);
      resumedWasm.update(data.subarray(split));
      expect(resumedWasm.digestHex()).toBe(reference(data));
      const crossResumed = await createSha256(wasm.exportState(), { preferWasm: false });
      expect(crossResumed.implementation).toBe("js");
      expect(crossResumed.update(data.subarray(split)).digestHex()).toBe(reference(data));
    }
  });

  it("rejects inconsistent states and reuse after finalization", () => {
    expect(() => StreamingSha256.fromState({ h: [1, 2, 3], block: [], length: 0 })).toThrow(/Invalid/);
    expect(() => StreamingSha256.fromState({ h: new Array(8).fill(0), block: [1], length: 64 })).toThrow(/block/);
    const hash = new StreamingSha256().update(new Uint8Array([1]));
    hash.digestHex();
    expect(() => hash.update(new Uint8Array([2]))).toThrow(/finalized/);
    expect(() => hash.exportState()).toThrow(/finalized/);
  });
});

describe("range bookkeeping", () => {
  it("parses only complete Content-Range headers", () => {
    expect(parseContentRange("bytes 0-15/16")).toEqual({ start: 0, end: 15, total: 16, length: 16 });
    expect(parseContentRange("bytes 16777216-33554431/206197916")).toEqual({ start: 16777216, end: 33554431, total: 206197916, length: 16777216 });
    expect(parseContentRange("bytes */100")).toBeUndefined();
    expect(parseContentRange("bytes 5-4/10")).toBeUndefined();
    expect(parseContentRange("bytes 0-10/10")).toBeUndefined();
    expect(parseContentRange(null)).toBeUndefined();
  });

  it("interprets Range request headers the way the server serves them", () => {
    expect(parseRangeRequest(undefined, 100)).toEqual({ kind: "none" });
    expect(parseRangeRequest("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseRangeRequest("bytes=90-", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeRequest("bytes=90-500", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeRequest("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRangeRequest("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeRequest("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeRequest("bytes=5-4", 100)).toEqual({ kind: "ignore" });
    expect(parseRangeRequest("bytes=0-1,5-6", 100)).toEqual({ kind: "ignore" });
    expect(parseRangeRequest("items=0-1", 100)).toEqual({ kind: "ignore" });
  });

  it("plans consecutive chunks that cover exactly the remaining bytes", () => {
    const chunks = planChunks(10, 100, 30);
    expect(chunks).toEqual([
      { start: 10, end: 39, length: 30 },
      { start: 40, end: 69, length: 30 },
      { start: 70, end: 99, length: 30 },
    ]);
    expect(planChunks(100, 100, 30)).toEqual([]);
    expect(planChunks(0, 206197916, DEFAULT_CHUNK_SIZE).reduce((sum, chunk) => sum + chunk.length, 0)).toBe(206197916);
    expect(() => planChunks(0, 10, 0)).toThrow(RangeError);
  });
});

describe("resume planning", () => {
  const entry = { size: 1000, sha256: "a".repeat(64), etag: '"1000-1"' };
  const state = { h: new Array(8).fill(0), block: [], length: 640 };
  const sidecar = { version: LIBRARY_IMPORT_SIDECAR_VERSION, source: { size: 1000, sha256: "a".repeat(64), etag: '"1000-1"' }, hashed: 640, hashState: state, complete: false };

  it("starts fresh for an empty file", () => {
    expect(planResume({ entry, sidecar: undefined, existingSize: 0 })).toMatchObject({ restart: false, hashed: 0 });
  });

  it("resumes from the sidecar hash state and re-hashes the tail locally", () => {
    expect(planResume({ entry, sidecar, existingSize: 700 })).toMatchObject({ restart: false, hashed: 640, hashState: state });
  });

  it("re-hashes locally when there is no usable sidecar", () => {
    expect(planResume({ entry, sidecar: undefined, existingSize: 700 })).toMatchObject({ restart: false, hashed: 0 });
    expect(planResume({ entry, sidecar: { ...sidecar, hashState: undefined }, existingSize: 700 })).toMatchObject({ restart: false, hashed: 0 });
    expect(planResume({ entry, sidecar: { ...sidecar, version: 99 }, existingSize: 700 })).toMatchObject({ restart: false, hashed: 0 });
  });

  it("restarts when the source changed or the file cannot be trusted", () => {
    expect(planResume({ entry: { ...entry, etag: '"1000-2"' }, sidecar, existingSize: 700 })).toMatchObject({ restart: true });
    expect(planResume({ entry: { ...entry, sha256: "b".repeat(64) }, sidecar, existingSize: 700 })).toMatchObject({ restart: true });
    expect(planResume({ entry, sidecar, existingSize: 1001 })).toMatchObject({ restart: true });
    expect(planResume({ entry, sidecar, existingSize: 600 })).toMatchObject({ restart: true });
    expect(planResume({ entry, sidecar: { ...sidecar, hashState: { ...state, length: 641 } }, existingSize: 700 })).toMatchObject({ restart: true });
  });

  it("recognizes a verified complete import", () => {
    const complete = { ...sidecar, complete: true, sha256: entry.sha256, hashed: 1000, hashState: undefined };
    expect(planResume({ entry, sidecar: complete, existingSize: 1000 })).toMatchObject({ alreadyComplete: true, hashed: 1000, restart: false });
    expect(planResume({ entry, sidecar: complete, existingSize: 999 })).toMatchObject({ alreadyComplete: false, restart: false, hashed: 0 });
  });

  it("rejects entries without a digest", () => {
    expect(() => planResume({ entry: { size: 10, sha256: null }, sidecar: undefined, existingSize: 0 })).toThrow(/SHA-256/);
  });

  it("keeps sidecars beside the destination under a hidden directory", () => {
    expect(sidecarPathFor("games", "LittleBigPlanet.iso")).toBe(".rpcs3-imports/games/LittleBigPlanet.iso.json");
    expect(formatRate(52_428_800)).toBe("50.00 MiB/s");
  });
});
