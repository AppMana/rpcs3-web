// Whether this browser can suspend a WebAssembly stack, which decides which runtime core the page
// loads and how a frame reaches the screen.
//
// A guest thread runs on its worker's only JS stack. With JavaScript Promise Integration that stack
// can suspend, the worker's event loop turns between flips, and a canvas whose control the page
// transferred presents on its own. Without it the thread never yields, the canvas never presents,
// and the frame has to be copied out with transferToImageBitmap instead.
//
// The constructors existing is not proof of a working implementation, so this suspends and resumes
// through a real module and checks the value comes back.

// (module (import "e" "f" (func $f (result i32))) (func (export "g") (result i32) (call $f)))
const roundTripModule = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 2, 7, 1, 1, 101, 1, 102,
  0, 0, 3, 2, 1, 0, 7, 5, 1, 1, 103, 0, 1, 10, 6, 1, 4, 0, 16, 0, 11,
]);

let cached;

export async function supportsSuspending() {
  if (cached !== undefined) return cached;
  cached = await (async () => {
    if (typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") return false;
    try {
      const suspending = new WebAssembly.Suspending(async () => 42);
      const { instance } = await WebAssembly.instantiate(roundTripModule, { e: { f: suspending } });
      return await WebAssembly.promising(instance.exports.g)() === 42;
    } catch {
      return false;
    }
  })();
  return cached;
}
