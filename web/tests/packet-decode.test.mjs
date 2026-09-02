import { describe, expect, it } from "vitest";
import {
  DRAW_PACKET_ABI,
  DRAW_PACKET_HEADER_SIZE,
  DRAW_PACKET_MAGIC,
  DRAW_PACKET_SECTION_COUNT,
  RESOLVED_STATE_SIZE,
  SectionKind,
  decodeDrawPacket,
} from "../public/rpcs3-webgpu-packet.mjs";

// Builds a packet the way rsx::webgpu::draw_packet_builder does: header,
// then sections appended with power-of-two alignment.
function buildPacket({ abi = DRAW_PACKET_ABI, kind = 1, sections = [] } = {}) {
  const table = new Array(DRAW_PACKET_SECTION_COUNT).fill(null).map(() => ({ offset: 0, size: 0 }));
  let size = DRAW_PACKET_HEADER_SIZE;
  const placed = [];
  for (const { index, bytes, alignment = 16 } of sections) {
    const offset = Math.ceil(size / alignment) * alignment;
    table[index] = { offset, size: bytes.byteLength };
    placed.push({ offset, bytes });
    size = offset + bytes.byteLength;
  }
  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  view.setUint32(0, DRAW_PACKET_MAGIC, true);
  view.setUint32(4, abi, true);
  view.setUint32(8, size, true);
  view.setUint32(12, kind, true);
  view.setBigUint64(16, 7n, true);
  view.setUint32(24, 5, true); // primitive
  view.setUint32(44, 3, true); // vertex count
  view.setUint32(56, 1280, true);
  view.setUint32(60, 720, true);
  table.forEach(({ offset, size: sectionSize }, index) => {
    view.setUint32(104 + index * 8, offset, true);
    view.setUint32(108 + index * 8, sectionSize, true);
  });
  for (const { offset, bytes } of placed) packet.set(bytes, offset);
  return packet;
}

function resolvedState(fields) {
  const bytes = new Uint8Array(RESOLVED_STATE_SIZE);
  const view = new DataView(bytes.buffer);
  for (const [wordIndex, value, kind] of fields) {
    if (kind === "f32") view.setFloat32(wordIndex * 4, value, true);
    else view.setUint32(wordIndex * 4, value, true);
  }
  return bytes;
}

describe("WebGPU packet ABI v5", () => {
  it("decodes RPCS3-resolved state instead of a register snapshot", () => {
    const state = resolvedState([
      [0, 0xf1],            // clear mask: color rgba + depth
      [1, 0.25, "f32"], [2, 0.5, "f32"], [3, 0.75, "f32"], [4, 1, "f32"],
      [5, 1, "f32"],        // clear depth
      [10, 1], [11, 1], [12, 0x201], // depth test, write, less
      [36, 1],              // blend enabled mask
      [37, 0x302], [38, 0x302], [39, 0x303], [40, 0x303], [41, 0x8006], [42, 0x8006],
      [47, 0xf],            // color write mask 0
      [55, 0x0405], [56, 0x0901], // cull back, front cw
    ]);
    const packet = decodeDrawPacket(buildPacket({ sections: [
      { index: SectionKind.resolvedState, bytes: state },
      { index: SectionKind.persistentVertices, bytes: Uint8Array.of(1, 2, 3, 4), alignment: 256 },
    ] }));
    expect(packet.abi).toBe(7);
    expect(packet.sections).toHaveLength(DRAW_PACKET_SECTION_COUNT);
    expect(packet.sections[SectionKind.persistentVertices].offset % 256).toBe(0);
    expect(packet.sections[SectionKind.rawRegisters].size).toBe(0);
    expect(packet.resolvedState.clearMask).toBe(0xf1);
    expect(packet.resolvedState.clearColor).toEqual([0.25, 0.5, 0.75, 1]);
    expect(packet.resolvedState.clearDepth).toBe(1);
    expect(packet.resolvedState.depthTestEnabled).toBe(true);
    expect(packet.resolvedState.depthWriteEnabled).toBe(true);
    expect(packet.resolvedState.depthFunc).toBe(0x201);
    expect(packet.resolvedState.blendEnabledMask).toBe(1);
    expect(packet.resolvedState.blendSfactorRgb).toBe(0x302);
    expect(packet.resolvedState.blendDfactorA).toBe(0x303);
    expect(packet.resolvedState.blendEquationA).toBe(0x8006);
    expect(packet.resolvedState.colorWriteMask).toEqual([0xf, 0, 0, 0]);
    expect(packet.resolvedState.cullFaceMode).toBe(0x0405);
    expect(packet.resolvedState.frontFaceMode).toBe(0x0901);
    expect(packet.resolvedState.logicOpEnabled).toBe(false);
  });

  it("rejects the previous ABI and a malformed resolved-state section", () => {
    expect(() => decodeDrawPacket(buildPacket({ abi: 4, sections: [
      { index: SectionKind.resolvedState, bytes: new Uint8Array(RESOLVED_STATE_SIZE) },
    ] }))).toThrow(/ABI=4/);
    expect(() => decodeDrawPacket(buildPacket({ sections: [
      { index: SectionKind.resolvedState, bytes: new Uint8Array(RESOLVED_STATE_SIZE - 4) },
    ] }))).toThrow(/resolved-state/);
  });
});
