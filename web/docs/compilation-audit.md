# Compilation versus execution audit — 2026-09-05

The previous benchmark retained final compilation totals but discarded their frame history. Final totals cannot establish steady-state compilation cost. `play-runtime.mjs` now retains the existing worker-supplied PPU/SPU request/completion counters, aggregate LLVM job elapsed time, queue depth, and PPU registration/pending counters with each benchmark frame. No additional worker sampling or compiler calls are introduced.

`compilationWindow` uses actual observed endpoints, rejects missing/reset counter series as unmeasured, and never interpolates fractional compilations. Run:

```
node web/scripts/analyse-compilation.mjs PATH/report.json 4500 5200
```

## Unprofiled headful capture

`test-results/performance/compilation-audit-20260905/report.json`, same diagnostic region core and v2 SPU AOT, frozen profile clone, HTTPS ingress, scheduled LBP2 replay. Completed 5,501 flips with no reported failures or timing drops. Summarized in `audit.json` beside the report.

| Observed frame window | PPU compilations | SPU compilations | LLVM job elapsed time | Wall duration |
| --- | ---: | ---: | ---: | ---: |
| 1–3500 | 3297 | 108 | 35.924 s | 121.314 s |
| 3500–4500 | 3995 | 1493 | 64.506 s | 77.463 s |
| 4500–5200 | 244 | 17 | 3.773 s | 52.868 s |
| 5200–5500 | 63 | 1 | 0.783 s | 20.117 s |

These are deltas after the first endpoint, not complete boot totals. The game still discovers code in the measured gameplay window; the major translation burst accompanies the transition into gameplay. Compiler elapsed time sums completed jobs across workers, is not OS CPU time, and excludes browser Wasm compilation, tiering and module installation. It must not be divided by total process CPU and described as a measured compiler CPU share.

Window 4500–5200: 454.63 observed process CPU ms/flip, 13.24 FPS, CPU pressure 4.39%, 814,361 draws, 4,900 clears, 883,400 texture hits, 730,800 surface hits and 23,800 surface operations. This is an audit run, not evidence of a performance regression or improvement against earlier runs with different host pressure and runtime compilation coverage.

## Why one title still has many translations

The bundle has EBOOT plus multiple library modules. SPU programs also occupy writable local store; a cached translation checks whether its source instructions still match. Program-entry verification is execution work, not recompilation. PPU dispatch marks addresses already covered by AOT as ineligible for runtime compilation (`ppu_web_jit_mark_entry`); runtime PPU work is intended to fill uncovered addresses. Address request/response traces would be needed to prove the absence of redundant requests, not just completion counts.

There are two compilers: RPCS3's guest-to-Wasm translator and the browser's Wasm-to-machine-code compiler. A finite, unchanged hot set should stop requiring new guest translations. Even then, per-block dispatch, validation, helper calls, register spills/reloads, synchronization and graphics work remain.

Runtime installation currently constructs `WebAssembly.Module` from stored bytes on each worker's first placement. Each worker tracks its placed watermark, so this is not construction on every guest dispatch. Engine caching may share compiled code; construction alone does not prove repeated machine-code compilation. Explicit installation timing and module sharing are worthwhile follow-ups.

## Architecture leads from WebKit source

[WebKit's BBQ entry-tiering discussion](https://github.com/WebKit/WebKit/blob/54c30c45bed4cb4c6232cdd08d44ac783725430b/Source/JavaScriptCore/wasm/WasmBBQJIT.cpp#L3271) explains that tiny functions retain prologue/epilogue costs in both baseline and optimizing tiers, and that compiling many tiny functions can flood compiler threads during warm-up. This supports bounded hot regions with direct internal edges and guest registers live in locals across those edges. It does not justify one enormous Wasm function: compilation cost and register pressure remain constraints.

Separate the next experiments: improve AOT/persistent translation coverage to remove startup and discovery work; improve execution regions and state commits to reduce steady-state work. Neither has a new shipping performance result in this audit.

## Fresh worker CPU profile

`test-results/performance/compilation-profile-20260905` completed 5,219 flips with no reported failures. Same core/AOT configuration and another frozen profile clone; CDP profiling and per-thread OS counters enabled. Worker attachment completed at frame 4507 and capture stopped at 4908. All 76 page/worker targets supplied profiles. Analysis files: `worker-attribution.json`, `profile-analysis.txt`, and `compilation-window.json`.

Reproduce worker attribution with:

```
node web/scripts/analyse-compiler-profile.mjs PATH/report.json PATH/run.cpuprofile
```

Compiler workers contributed 451 of 23,335 attributed samples (1.93%). Worker `rpcs3-llvm-0` had 451 attributed and 5,753 idle samples; `rpcs3-llvm-1` had zero attributed and 6,220 idle samples. Neither compiler had unknown samples. The common frame window 4520–4900 completed 162 PPU and 17 SPU translations, with 2.360 seconds of summed LLVM elapsed time over 27.566 seconds of wall time.

The existing detailed analyzer trims to observed frame endpoints inside the capture; its slightly narrower denominator is 23,305 work samples. Leading named leaves:

| Leaf | Share of attributed work samples |
| --- | ---: |
| SPU same-instance chain runner | 5.7% |
| SPU DMA transfer | 3.5% |
| PPU execution slice | 3.4% |
| PPU raw 32-bit read helper | 2.9% |
| thread state checks | 2.5% |
| SPU DMA list transfer | 2.5% |
| SPU dispatch lambda | 2.4% |
| SPU MFC command processing | 2.0% |
| VM writer lock | 1.8% |
| PPU raw 64-bit write helper | 1.7% |

On the busiest PPU worker, raw read32/write64/read64/write32 helpers together account for approximately 26% of attributed samples. The busiest graphics worker includes RSX execution, `WebGPUDirectGSRender::end`, texture copies, buffer writes, FIFO fetch and bind-group creation.

These are sampled attributed-work shares, **not total CPU shares**. The detailed report retains 338,505 unknown `(program)` samples and 28,459 wait/idle samples across many workers. CDP alone cannot distinguish all waiting/native engine work, and it does not sample browser background compiler threads. Do not call 1.93% a complete measurement of all compilation costs. Nevertheless, both identifiable LLVM workers are mostly idle while named emulation and graphics work dominates attributed activity.

Next concrete priority: PPU memory helpers and state residency. Experimental AOT inline reads already exist but enlarge the EBOOT module from 29.9 to 38.2 MB. Runtime compiler pools do not enable that option, and the runtime PPU side-module loader does not bind its `GOT.mem.__rpcs3_guest_pages` import yet. Enabling only the compiler flag would therefore be incomplete. Finish that explicit ABI seam and test mapped, unmapped and page-crossing accesses before candidate gameplay measurements; stores must retain write-version/reservation semantics.

Validation: three new compilation-window tests and six existing performance-metrics tests passed. The existing metrics suite uses Vitest (an initial attempt with Node's test runner failed to initialize Vitest; rerun under Vitest passed). Syntax checks and `git diff --check` passed. Only benchmark counter retention was staged; no new emulator optimization or core default was promoted.
