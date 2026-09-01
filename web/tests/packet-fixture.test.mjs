import { describe, expect, it } from "vitest";
import { decodePacketFixtureBytes, encodePacketFixture } from "../public/rpcs3-webgpu-fixture.mjs";

describe("WebGPU packet fixtures", () => {
  it("round-trips a frame without changing packet bytes", () => {
    const packets = [Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5), Uint8Array.of(6, 7, 8, 9)];
    const decoded = decodePacketFixtureBytes(encodePacketFixture(packets));
    expect(decoded).toEqual(packets);
  });

  it("rejects truncated and trailing fixture data", () => {
    const fixture = encodePacketFixture([Uint8Array.of(1, 2, 3)]);
    expect(() => decodePacketFixtureBytes(fixture.subarray(0, fixture.byteLength - 1))).toThrow(/packet 0/);
    const trailing = new Uint8Array(fixture.byteLength + 1);
    trailing.set(fixture);
    expect(() => decodePacketFixtureBytes(trailing)).toThrow(/trailing bytes/);
  });
});
