// Emscripten's emscripten_get_now() is `performance.timeOrigin + performance.now()`, evaluated in
// full on every call: two lookups of the `performance` global, the timeOrigin getter, and the now
// lookup. RPCS3 asks for the time on every spin-loop iteration and every guest timebase read, so
// those lookups are a measurable share of the emulator's CPU on their own.
//
// timeOrigin is fixed for a global and is what makes timestamps from different workers comparable,
// so it is read once and closed over; the same value comes back. This is the pthreads form of
// Emscripten's own definition with the constant parts hoisted out of the call.
addToLibrary({
  emscripten_get_now: "((perf, origin) => () => origin + perf.now())(performance, performance.timeOrigin)",
});
