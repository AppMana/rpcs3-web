import { afterEach, describe, expect, it, vi } from "vitest";
import { Digital1, Digital2, readGamepad, samePadState } from "../public/rpcs3-gamepad.mjs";

// A gamepad in the W3C "standard" mapping, which is what a DualSense reports.
function gamepad({ pressed = [], axes = [0, 0, 0, 0] } = {}) {
  return {
    connected: true,
    id: "DualSense Wireless Controller",
    mapping: "standard",
    buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 })),
    axes,
  };
}

// navigator is a getter-only global under Node, so it has to be stubbed rather than assigned
function withGamepads(pads) {
  vi.stubGlobal("navigator", { getGamepads: () => pads });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("gamepad to RPCS3 web pad", () => {
  it("reports no state when nothing is connected", () => {
    withGamepads([null]);
    expect(readGamepad()).toBeUndefined();
  });

  // The masks are the PS3's own (Digital1Flags/Digital2Flags in rpcs3/Emu/Io/pad_types.h), which is
  // what web_pad_handler masks against, so a wrong bit here is a wrong button in the game.
  it("maps every standard button to its PS3 mask", () => {
    const expected = [
      [0, { digital2: Digital2.cross }], [1, { digital2: Digital2.circle }],
      [2, { digital2: Digital2.square }], [3, { digital2: Digital2.triangle }],
      [4, { digital2: Digital2.l1 }], [5, { digital2: Digital2.r1 }],
      [6, { digital2: Digital2.l2 }], [7, { digital2: Digital2.r2 }],
      [8, { digital1: Digital1.select }], [9, { digital1: Digital1.start }],
      [10, { digital1: Digital1.l3 }], [11, { digital1: Digital1.r3 }],
      [12, { digital1: Digital1.up }], [13, { digital1: Digital1.down }],
      [14, { digital1: Digital1.left }], [15, { digital1: Digital1.right }],
      [16, { digital1: Digital1.ps }],
    ];
    for (const [index, { digital1 = 0, digital2 = 0 }] of expected) {
      withGamepads([gamepad({ pressed: [index] })]);
      const state = readGamepad();
      expect({ index, digital1: state.digital1, digital2: state.digital2 }).toEqual({ index, digital1, digital2 });
    }
  });

  it("combines buttons held together", () => {
    withGamepads([gamepad({ pressed: [0, 9, 12] })]);
    const state = readGamepad();
    expect(state.digital2).toBe(Digital2.cross);
    expect(state.digital1).toBe(Digital1.start | Digital1.up);
  });

  it("centres the sticks at 128 and runs them 0 up and 0 left", () => {
    withGamepads([gamepad()]);
    expect(readGamepad()).toMatchObject({ leftX: 128, leftY: 128, rightX: 128, rightY: 128 });

    withGamepads([gamepad({ axes: [-1, -1, 1, 1] })]);
    expect(readGamepad()).toMatchObject({ leftX: 0, leftY: 0, rightX: 255, rightY: 255 });
  });

  it("holds a resting stick at centre and still reaches full range past the deadzone", () => {
    withGamepads([gamepad({ axes: [0.05, -0.04, 0, 0] })]);
    expect(readGamepad(0.08)).toMatchObject({ leftX: 128, leftY: 128 });

    // Full deflection is unaffected by the deadzone rescale
    withGamepads([gamepad({ axes: [1, 0, 0, 0] })]);
    expect(readGamepad(0.08).leftX).toBe(255);
  });

  it("treats states as equal only when every axis and button matches", () => {
    withGamepads([gamepad({ pressed: [0] })]);
    const first = readGamepad();
    const second = readGamepad();
    expect(samePadState(first, second)).toBe(true);

    withGamepads([gamepad({ pressed: [1] })]);
    expect(samePadState(first, readGamepad())).toBe(false);
  });
});
