import { expect, it } from "vitest";
import { translateRsxProgram } from "../public/rpcs3-webgpu-renderer.mjs";

function translate(control, outputs) {
  // A terminating NOP is sufficient to test export routing independently of ALU decoding.
  const fragmentProgram = new Uint8Array(16);
  new DataView(fragmentProgram.buffer).setUint32(0, 0x100, true);
  return translateRsxProgram({ vertexProgram: new Uint8Array(0), vertexProgramEntry: 0,
    fragmentProgram, fragmentProgramControl: control,
    colorTargetCount: outputs.length, colorOutputIndices: outputs }).code;
}

it("preserves a lone nonzero MRT export when earlier attachments are disabled", () => {
  expect(translate(0x40, [1])).toContain("return r32[2];");
  expect(translate(0, [1])).toContain("return r16[4];");
});

it("routes sparse MRT exports in attachment order for full and half precision", () => {
  expect(translate(0x40, [0, 2, 3])).toContain("return FragmentOut(r32[0], r32[3], r32[4]);");
  expect(translate(0, [0, 2, 3])).toContain("return FragmentOut(r16[0], r16[6], r16[8]);");
});

it("rejects invalid output indices instead of generating an incorrect shader", () => {
  expect(() => translate(0x40, [4])).toThrow("invalid RSX color output mapping");
  expect(() => translate(0x40, [-1])).toThrow("invalid RSX color output mapping");
});
