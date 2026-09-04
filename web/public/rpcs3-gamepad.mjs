// A physical controller, through the Gamepad API, as RPCS3's web pad.
//
// RPCS3 already has the handler: web_pad_handler in rpcs3/Input/pad_thread.cpp is a PadHandlerBase
// bound to the emulated port, and it reads whatever web_pad::set_state was last given. So there is
// nothing to add on the emulator side; this only has to produce the two digital words and the four
// stick bytes that handler expects, and the worker passes them to rpcs3_web_set_pad.
//
// The words are the PS3's own masks (Digital1Flags/Digital2Flags in rpcs3/Emu/Io/pad_types.h), and
// the sticks are 0-255 with 128 at centre, 0 up and 0 left, which is the direction the Gamepad
// API's axes already run in: no inversion.

export const Digital1 = Object.freeze({
  select: 0x0001, l3: 0x0002, r3: 0x0004, start: 0x0008,
  up: 0x0010, right: 0x0020, down: 0x0040, left: 0x0080, ps: 0x0100,
});
export const Digital2 = Object.freeze({
  l2: 0x0001, r2: 0x0002, l1: 0x0004, r1: 0x0008,
  triangle: 0x0010, circle: 0x0020, cross: 0x0040, square: 0x0080,
});

// The W3C "standard" mapping, which is what a DualShock, DualSense or Xbox controller reports.
// Index order is fixed by that mapping, so this is a positional table, not a guess about a device.
const standardButtons = [
  "cross", "circle", "square", "triangle", "l1", "r1", "l2", "r2",
  "select", "start", "l3", "r3", "up", "down", "left", "right", "ps",
];

export const neutral = Object.freeze({ digital1: 0, digital2: 0, leftX: 128, leftY: 128, rightX: 128, rightY: 128 });

// A stick that is physically centred still reports a little off-centre, and web_pad_handler writes
// what it is given straight to the pad, so this is the only place that idle can be squared off.
// Radial, so a diagonal hold is not clipped differently from a cardinal one.
function stickBytes(x, y, deadzone) {
  const magnitude = Math.hypot(x, y);
  if (!(magnitude > deadzone)) return [128, 128];
  // Rescale so the axis still reaches its full range: the first movement past the deadzone reads as
  // the smallest non-centre value rather than jumping.
  const scale = (magnitude - deadzone) / (1 - deadzone) / magnitude;
  const toByte = (value) => Math.max(0, Math.min(255, Math.round((value * scale + 1) * 127.5)));
  return [toByte(x), toByte(y)];
}

// The first connected gamepad, or undefined when none is. Safari only exposes a gamepad after it
// has been used once, and getGamepads() returns a fresh snapshot per call, so this reads live.
export function readGamepad(deadzone = 0.08) {
  const pads = navigator.getGamepads?.() ?? [];
  const gamepad = [...pads].find((pad) => pad && pad.connected);
  if (!gamepad) return undefined;

  let digital1 = 0;
  let digital2 = 0;
  standardButtons.forEach((control, index) => {
    if (!gamepad.buttons[index]?.pressed) return;
    digital1 |= Digital1[control] ?? 0;
    digital2 |= Digital2[control] ?? 0;
  });

  const [leftX, leftY] = stickBytes(gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0, deadzone);
  const [rightX, rightY] = stickBytes(gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0, deadzone);
  return { digital1, digital2, leftX, leftY, rightX, rightY, id: gamepad.id, mapping: gamepad.mapping };
}

export function samePadState(a, b) {
  if (!a || !b) return a === b;
  return a.digital1 === b.digital1 && a.digital2 === b.digital2
    && a.leftX === b.leftX && a.leftY === b.leftY && a.rightX === b.rightX && a.rightY === b.rightY;
}
