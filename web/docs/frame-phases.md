# RSX frame phases and presentation scheduling — 2026-09-05

The new frame timing records measure four RSX-thread wall scopes: host submission,
presentation/capture/yield, explicit flip-limiter sleep, and FIFO idle. These are
not GPU timestamps or CPU time. FIFO idle can overlap a deferred flip, so the
numbers must not be summed into a partition. Open idle intervals are split at
flip boundaries. Draining observations does not reset pending phase work.

`analyse-frame-phases.mjs REPORT 4500 5200` requires contiguous guest flip
boundaries and excludes the phase totals on the opening boundary. Old reports
without phase data return null, not a fabricated zero.

Initial fixed-window measurements (700 guest frames):

| Wall time per frame | Headful Chrome | Attached iPad |
| --- | ---: | ---: |
| Host submit | 5.024 ms | 5.411 ms |
| Presentation/capture/yield | 5.035 ms | 21.817 ms |
| Explicit limiter | 0 ms | 0 ms |
| FIFO idle | 8.881 ms | 2.502 ms |
| Total frame interval | 82.543 ms | 84.635 ms |

Evidence: `test-results/performance/rsx-frame-phases-20260905/report.json`
and recovered `ipad-rsx-frame-phases-20260905/progress.json`. Both use core
`rsx-frame-phases-20260905-jspi`, original PPU return-single AOT and SPU linked
regions v2. Chrome uses the isolated inline compiler with inline reads disabled;
iPad uses static SPU and PPU JIT disabled. These are within-platform diagnostic
measurements, not equivalent cross-platform execution configurations. The iPad
lost inspector connectivity after the measurement window; do not claim a
successful full 7000-frame run from recovered progress alone.

The iPad presentation scope is 25.8% of the window. It includes suspension and
resumption scheduling, not merely JavaScript executing the timer. The regular
capture is only the final requested frame, outside this window. No conclusion
about a timer-specific cause is justified until a controlled alternative runs.

An opt-in `RPCS3_PRESENTATION_YIELD=message` experiment replaces `setTimeout(0)`
with a reusable MessageChannel task on the RSX worker. A task boundary preserves
the opportunity for a transferred canvas to publish; a microtask would not.
The GPU readiness record reports the selected policy and Chrome's performance
runner rejects mismatches. The option passes through page, acceptance wrapper,
runtime worker and PThread GPU initialization. Default remains `timer`.

The isolated candidate core is `presentation-yield-20260905-jspi`. Both modes
passed headful Chrome HTTPS direct-session tests: 60 guest flips, capture pixels,
contiguous timing records, selected-policy assertion and clean shutdown. The
three phase accounting tests and TypeScript passed. Capturing pixels alone does
not prove compositor publication; inspect the gameplay runner's visible canvas
screenshot too. Both gameplay runs completed, with visible canvas screenshots inspected. No default promotion.

Same-build Chrome pair, window4500–5200:

| Metric | Timer | MessageChannel |
| --- | ---: | ---: |
| Presentation wall ms/frame | 4.960 | 1.538 |
| Host submit wall ms/frame | 4.971 | 4.105 |
| FIFO idle wall ms/frame | 6.978 | 10.180 |
| FPS | 12.822 | 13.877 |
| Observed process CPU ms/frame | 469.034 | 436.977 |
| Frame interval p99 ms | 129.760 | 95.655 |
| Host CPU pressure some stall | 5.277% | 3.095% |

Evidence: `test-results/performance/presentation-yield-comparison.json`, derived
from `presentation-{timer,message}-20260905/report.json`. Exact matching deltas:
814361 draws,4900 clears,883400 texture hits,730800 surface hits,23799 surface
operations; no new uploads, shaders, pipelines, skips, unsupported operations,
translation failures or timing drops in either window. Both ran the same isolated
core/compiler/AOT configuration, fresh fixture profiles and input trace. Actual
worker policies were asserted. Candidate completed5507 frames, timer5506, both
failures[]. No concurrent host builds/tests/profilers during either measurement.

Presentation scope improved69.0%; nominal FPS+8.22%, CPU-6.83%. Overall gains are
not isolated from the lower host pressure, and this is one pair. No native parity
claim. Screenshots show the canvas continues to publish, but existing severe
material/color faults remain and asynchronous final screenshots differ in pose
and panel color; this is not pixel-equivalence proof. The iPad remains unavailable
(discovery returned[]); its baseline runner terminated with timeout, not success.
Next: replicated scheduling comparison and iPad candidate when attached, then
profile per-draw CPU work and address visual correctness before default promotion.


## Per-draw diagnostic

Isolated core `draw-phases-20260905-jspi` extends the profiler with `draw`,
`drawVertex`, `drawUniform`, `drawBind`, and `drawEncode`. A stage transition
uses one clock read and retains local uploads needed by later stages. The drain
serializer uses the shared phase-name array, avoiding positional-field drift.
Full draw time includes shader/texture/surface preparation and all child stages;
uniform includes index staging, encoding includes pipeline lookup and binding
release. Every draw is measured: this adds clock overhead, so use this build for
attribution, not an unqualified speed comparison against uninstrumented builds.

Headful HTTPS gameplay `draw-phases-20260905` completed5543 frames with failures[].
In4500–5200, total frame interval70.801ms; draw31.148ms (44.0% wall), comprising
vertex2.847ms,uniform/index1.925ms,bind-group construction8.388ms,encoding2.837ms.
The remaining15.151ms of draw time includes setup, shader/texture/surface work,
clause handling and base-thread completion. Submit3.867ms,presentation1.524ms,
FIFOidle8.225ms,limiter0. Bind construction alone is11.85% of wall; uniform
copying is2.72%, so binding reuse is the stronger immediate target. The unclassified
draw work warrants further subdivision too. No inference that all wall time is
on-CPU or that these scopes form a partition of the whole frame.

Evidence: `test-results/performance/draw-phases-20260905/metrics.json` and source
report. Phase records cover all700 intervals exactly; the separate coarse
performance/counter section ends at5186 (686frames), explicitly reported by its
from/to fields. Do not treat its CPU/counter values as4500–5200 measurements. Three phase tests,TypeScript,diffcheck and two headful direct-session
tests passed, including actual nonzero values in every draw stage. No concurrent
host builds/tests/profilers during gameplay. iPad discovery still[]; no device
candidate claim. Default core remains unchanged.

Next implementation: opt-in per-frame bind-group reuse with dynamic buffer
offsets. Cache identity must include layout, buffer handles, exact storage
binding sizes, texture views and samplers. Clear/release cached groups before
retiring resources at submission, preserving old-buffer references on ring
growth. Dynamic offsets must follow binding-number order32,33,34,35; preserve
alignment and binding-size bounds. Add actual hit/create counters and reject
requested/active policy mismatches in the harness. Test ring growth, changing
texture identities and distinct binding sizes before claiming gameplay safety.
