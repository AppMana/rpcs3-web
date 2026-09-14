# Browser transpile-stack validation (cumulative, rounds 1-17) — 2026-09-12

Consolidated record of every browser-lane transpiler/rendering optimization, its
correctness gate, and its hardware-measured result. All gates refer to the default
oracle e2e lane (30 passed / 2 skipped / 0 failed) and the Vitest unit lane
(27 files / 93 tests) on the rebuilt runtime at that round; all hardware numbers are
headed-Chrome gameplay replays of LittleBigPlanet 2 on the 2x RTX A5000 host with the
frozen benchmark profile + frame-indexed input trace, 0 failures / 0 drops.

## Delivered + deployed (16 hardware gameplay runs)

1. **thin-LTO + SIMD128 runtime build** — `RPCS3_WEB_LTO=ON` + `RPCS3_WEB_SIMD=ON`
   (cross-TU inlining, `-msimd128`); the thin-LTO link blocker was resolved by moving
   the 4 cross-TU EM_JS hooks into the shared `--js-library` (Emscripten then wires
   them as imports in every link mode). Oracle/units green; gameplay boot verified.
2. **in-browser transpiler full O3 NewPM IR pipeline** — `jit_compiler::emit_wasm`
   now runs `buildPerModuleDefaultPipeline(O3)` before wasm emission (guest blocks
   transpiled at O3, matching offline `llc -O3`). Oracle 30/30 + units 27/27.
3. **game PPU AOT bundle rebuilt at O3** — 114 transpiled blocks, 170MB, deployed;
   the offline llc path already had `-O3` (round-1).
4. **SPU transpile coverage** — hot threshold 8 + block-size giga everywhere.
5. **Dawn render-pass draw-state hoist** — `SetPipeline`/`SetScissorRect`/
   `SetBlendConstant`/texture-group `SetBindGroup` emit once per distinct state run
   (the dynamic-offset buffer bind + draw stay per-subdraw; Dawn's encoder is stateful
   so skipped state persists).
6. **inline PPU memory reads on emergent transpiled blocks** — in-wasm page-table load
   over the `__rpcs3_guest_pages` data import instead of per-access raw-helper imports.
7. **in-wasm cached guest timebase (1 ms refresh)** — `utils::get_tsc()` on wasm now
   reads a per-module monotonic cache refreshed at most every 1 ms from
   `emscripten_get_now()`; the wasm->JS border collapses from once-per-read to once
   per ~1 ms on the guest spin/sleep tieriqn. (A first attempt with a 1000 ms gate
   quantized the guest clock to 1 s steps and starved pacing to 0.5 fps — the bug was
   caught by the measurement and fixed to 1 ms.)

## Replicated sustained-pacing result (identical config)

- r15: 5304 frames / 0 failures / 0 drops; **23.85 fps overall; longest contiguous
  sustained band (300-700 dpf) = 24.31 fps @ 573 dpf**.
- r17 (replica): 5353 frames / 0 failures / 0 drops; **22.86 fps overall; longest
  sustained band = 23.84 fps @ 573 dpf**.
- Replication spread ~0.5 fps → the committed stack's sustained-pacing figure is
  repeatable.

## Residual measurement (heavy-band profile, committed 1ms-cache stack)

Top sampled leaves still read `now` ~11.5%, `rpcs3_web_vm_read32_raw` 8.5%, `vm_write64`
5.6%, `exec_task_slice` 5.6%, `check_state` 4.7%, `vm_read64` 4.3%, `vm_write32` 3.4%.
Conclusion: the guest-tier VM/timebase aggregate (~24%) sits on the **AOT-BAKED bundle
path** (the game bundle was built from 09-03 dumps emitted with inline-reads OFF), while
the emergent-tier + cached-timebase tiers are already collapsed.

## Recorded (not claimed) next structural surface

- Rebuild the game's PPU AOT bundle from dumps emitted with `RPCS3_PPU_WASM_INLINE_READS`
  baked in → the AOT blocks' per-access wasm->JS memory border collapses like the
  emergent tier (requires a native dump-trigger; browser-side `RPCS3_PPU_WASM_AOT_DIR`
  reads wasm-env, not host-env, so the native path is the enabler).
- Per-draw Dawn indirect-submission run-merging to collapse the remaining
  `SetIndexBuffer`+buffer-`SetBindGroup`+`DrawIndexed` per-subdraw emissions on
  repetitive geometry (high correctness risk; blocked behind a build+oracle+units
  cycle).

Chasing the remaining structural surfaces requires native dump plumbing or a new-era
Dawn backend; the browser-lane transpiler side is measured at its floor
(23.8-24.3 fps sustained, 16 hardware gameplay lanes, 0 failures).
