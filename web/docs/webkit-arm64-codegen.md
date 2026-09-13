# WebKit ARM64 code generation experiment — 2026-09-05

Inspected public WebKit revision `54c30c45bed4cb4c6232cdd08d44ac783725430b`, cached outside the repository at `/home/administrator/.cache/rpcs3-webkit-source`. This is not a verified source match for the attached iPad's iOS 27 beta (24A5430a).

## Source findings

[BBQ SIMD shuffle lowering](https://github.com/WebKit/WebKit/blob/54c30c45bed4cb4c6232cdd08d44ac783725430b/Source/JavaScriptCore/wasm/WasmBBQJIT64.cpp#L3699) reserves adjacent ARM64 registers q28/q29 for a binary table lookup, copying inputs when necessary. [MacroAssemblerARM64](https://github.com/WebKit/WebKit/blob/54c30c45bed4cb4c6232cdd08d44ac783725430b/Source/JavaScriptCore/assembler/MacroAssemblerARM64.h#L7295) emits TBL for unary swizzle and TBL2 for binary shuffle.

However, [B3 strength reduction](https://github.com/WebKit/WebKit/blob/54c30c45bed4cb4c6232cdd08d44ac783725430b/Source/JavaScriptCore/b3/B3ReduceStrength.cpp#L3815) already reduces eligible binary shuffles to unary operations. The optimizing tier can remove the apparent baseline overhead. Inspecting baseline source alone would overstate the steady-state opportunity.

## Implementation and validation

`Utilities/WasmSimdPolicy.h` provides an opt-in LLVM module pass, enabled by `--unary-swizzles` in the common IR compiler and SPU AOT builder. It rewrites constant single-source `<16 x i8>` permutations to `llvm.wasm.swizzle`; genuinely mixed inputs remain unchanged. Undefined output lanes are refined to zero. No runtime default or core artifact was promoted; browser LLVM worker integration remains pending evidence of benefit.

The pass changed 57,724 instructions across 3,671 of the 5,127 frozen SPU IR programs. This is static coverage, not an execution-weighted estimate. Coverage output is `test-results/performance/webkit-unary-probe/coverage.json`.

Seven focused tests passed (`wasm-simd-policy.test.mjs` and `wasm-regions.test.mjs`). Byte semantics were checked over 256 distinct input patterns for first-source, second-source, same-source, mixed-source and partially undefined masks. Idempotence was checked. Disassembled probe binaries contain the intended shuffle versus swizzle instructions.

## Measurements

Build with `node web/scripts/build-wasm-simd-probe.mjs test-results/performance/webkit-unary-probe`.
Run `node web/scripts/run-wasm-simd-probe.mjs webkit` or `ipad`; use `DISPLAY=:0` and `chrome` for headful Chrome. All browser pages use `https://rpcs3.appmana.com/runtime.html`.

The dependency-chain fixture reverses 16 bytes then adds one per lane, for 10 million iterations. Each timed result is checked against an independent expected value. After warmup, twelve trials alternate control/candidate order. Timings are milliseconds:

| Engine | First call control / candidate | Warm median control / candidate |
| --- | --- | --- |
| Attached iPad Safari 27 | 26.80 / 14.18 | 10.88 / 10.86 |
| Linux WebKit 26.5, headless WPE | 7.40 / 9.12 | 5.16 / 4.78 |
| Linux Chrome 152, headful | 26.595 / 30.310 | 11.775 / 11.735 |

Raw reports are `test-results/performance/webkit-unary-probe/{ipad,webkit,chrome}-timing.json`. First-call measurements have fixed order, include tiering, and are single observations. They do not establish a repeatable cold-start gain. Warmed iPad and Chrome results are effectively tied. Linux WebKit runs x86-64 despite its Safari-style user agent; it does not supply ARM64 machine-code measurements. No gameplay run was performed for this candidate, and no native-parity claim follows from this probe.

## Next architecture experiment

Prioritize explicit guest-register residency across linked SPU/PPU blocks. Region inlining alone left many context loads and stores; inspect their alias/barrier constraints and represent live guest registers as Wasm locals/SSA until actual helper, safepoint or region exits. Compare emitted spill/load counts and execution-weighted profiles, with precise state commits at observable exits. Keep the swizzle option experimental: broad static coverage does not compensate for a missing steady-state gain.
