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
  // Thin-LTO (RPCS3_WEB_LTO) runs the whole emulator archive through bitcode,
  // where Emscripten strips the __em_js__ metadata + address-taken import chain
  // that its linker normally uses to emit EM_JS glue. Keeping these cross-TU
  // browser hooks in the --js-library instead makes every reference resolve to a
  // library-provided JS function at link time, which survives LTO. The JS
  // bodies are verbatim the EM_JS bodies they replace; the C++ callers declare
  // them extern "C" and see no difference.
  rpcs3_web_ppu_hot_sync: function() { return rpcs3PpuHotSyncImpl() >>> 0; },
  rpcs3_web_spu_hot_sync: function() { return rpcs3SpuHotSyncImpl() >>> 0; },
  rpcs3_web_ppu_aot_worker_ready: function() { if (!self.__rpcs3PpuAotReady && Module["rpcs3EnsureAot"]) Module["rpcs3EnsureAot"]("rpcs3PpuAot"); return self.__rpcs3PpuAotReady ? 1 : 0; },
  rpcs3_web_spu_aot_worker_ready: function() { if (!self.__rpcs3SpuAotReady && Module["rpcs3EnsureAot"]) Module["rpcs3EnsureAot"]("rpcs3SpuAot"); return self.__rpcs3SpuAotReady ? 1 : 0; },
});
