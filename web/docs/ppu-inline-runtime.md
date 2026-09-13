# Runtime PPU inline reads — 2026-09-05

Completed the missing runtime path for the existing inline-read translation policy:

- `RPCS3_PPU_INLINE_READS=1` passes through the benchmark URL, playable session, acceptance API, runtime worker and LLVM pool.
- Runtime PPU side modules bind `GOT.mem.__rpcs3_guest_pages` to the executing runtime's page table. Missing capability and unknown import namespaces fail explicitly.
- Pool statistics report the active policy and compiler URL. Benchmark frames retain them; the runner rejects a mismatch with the requested setting or recorded compiler artifact.
- `RPCS3_LLVM_COMPILER` selects an isolated compiler module. Reports hash both its JS and Wasm artifacts.
- `RPCS3_TEST_ORIGIN` lets Playwright run the correctness lane against the HTTPS ingress.

The default remains off. Stores retain existing helpers and write tracking. No new guest-register caching was implemented in this increment.

## Correctness and builds

Runtime build: `test-results/performance/ppu-inline-runtime-core-build.log`; staged `core/ppu-inline-runtime-jspi` (Wasm unchanged at 21,800,565 bytes; JS loader changed).
Compiler build: `ppu-inline-runtime-compiler-build.log`; staged `core/ppu-inline-compiler`. That directory name existed historically and now contains the new build; use each report's recorded hash, not the directory name alone, to identify compiler versions.

Final validation: seven LLVM/inline-memory headful tests passed (`ppu-inline-runtime-final-tests.log`). Four inline-memory tests passed against `https://rpcs3.appmana.com`, including the dispatch oracle through the full session API, 23 generated-code memory cases through the production runtime side loader, missing page-table rejection, and actual LLVM pool policy forwarding. TypeScript validation passed after adding explicit missing-result checks in the new fixture and an existing LLVM-region fixture.

The first served compiler lacked the inline-read export and was rebuilt. A control run was then stopped after discovering that the acceptance API discarded the new options; `ppu-inline-runtime-control-1` is incomplete and must not enter comparisons. The fixed full-session test and runtime policy assertions prevent that silent configuration failure. Subsequent valid runs are numbered 2.

## First matched Chrome pair

Same isolated core/compiler, prebuilt PPU `lbp2-return-single`, SPU `lbp2-spu-linked-regions-v2`, frozen profile clones, scheduled input and HTTPS ingress. Only runtime PPU inline reads differ. Both runs completed beyond 5,500 flips without reported failures. Frames 4500–5200:

| | Control | Inline runtime reads |
| --- | ---: | ---: |
| OS CPU ms/flip | 473.924 | 468.244 |
| FPS | 12.769 | 12.957 |
| Host CPU pressure | 6.28% | 5.74% |
| PPU compilations | 230 | 255 |
| SPU compilations | 17 | 17 |
| Summed LLVM elapsed ms | 3619 | 4008 |

The nominal CPU reduction is 1.20%, FPS increase 1.47%. Different pressure and compilation activity make this insufficient to establish a causal improvement. Renderer deltas match exactly: 814,361 draws; 4,900 clears; 883,400 texture hits; 730,800 surface hits; 23,800 surface operations. No timing drops, skipped draws, unsupported operations or translation failures were reported in the window.

Reports: `test-results/performance/ppu-inline-runtime-{control,candidate}-2`; combined results: `ppu-inline-runtime-comparison.json`.

End screenshots were inspected. Both retain the existing severe material/lighting faults; poses and a colored panel also differ between these asynchronous end captures. These screenshots are not frame-aligned and do not establish pixel equivalence. Native visual/correctness parity remains outstanding.

## iPad composition check

This separately compares the existing prebuilt inline-read bundle with the original PPU bundle, both using the newer SPU linked regions and the same runtime core. Runtime PPU JIT is disabled on the device; this is **not** a test of the newly enabled runtime compiler option.

Both completed 7,000 frames successfully. Frames4500–5200:

| | Original PPU AOT | Inline-read PPU AOT |
| --- | ---: | ---: |
| FPS | 14.9593 | 14.9325 |
| p99 frame ms | 83.619 | 82.300 |
| Timing drops | 0 | 0 |

Draws, clears and texture/surface hits match; control has one additional surface operation. Thermal conditions were not measured. This pair shows no throughput benefit and does not reproduce earlier optimistic inline-read results on older configurations. Reports: `ipad-ppu-inline-chain-{control,candidate}-1`.

## Decision

Keep the completed path opt-in. No default core, compiler policy or PPU bundle promotion. The next measurement should separate frame-critical execution and waiting from aggregate worker CPU: saving PPU work may not accelerate a frame limited by SPU, graphics submission, GPU work or synchronization. Continue guest-state/dispatch and rendering-correctness work without treating the nominal 1.2% as a verified win.
