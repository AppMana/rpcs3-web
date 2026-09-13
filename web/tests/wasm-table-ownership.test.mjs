import { expect, it } from "vitest";
import { tableEntriesAreLocal } from "../scripts/wasm-table-ownership.mjs";
const moduleWithElements = (payload) => Uint8Array.from([0,97,115,109,1,0,0,0,9,payload.length,...payload]);

it("distinguishes imported functions from instance-local element entries", () => {
  expect(tableEntriesAreLocal(moduleWithElements([1,0,0x23,0,0x0b,2,3,4]),3)).toBe(true);
  expect(tableEntriesAreLocal(moduleWithElements([1,0,0x23,0,0x0b,2,2,4]),3)).toBe(false);
});
it("declines unsupported element expressions and truncated sections", () => {
  expect(tableEntriesAreLocal(moduleWithElements([1,4,0x23,0,0x0b,1,0xd2,3,0x0b]),3)).toBe(false);
  expect(tableEntriesAreLocal(moduleWithElements([1,0,0x23,0,0x0b,2,3]),3)).toBe(false);
});
