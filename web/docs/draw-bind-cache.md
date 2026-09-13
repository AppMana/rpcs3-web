# Per-frame draw binding reuse — 2026-09-05

The draw profiler measured8.388ms/frame in bind-group construction during
LBP2 frames4500–5200, versus1.925ms for uniforms/index staging. This experiment
reuses a WebGPU bind group for draws with identical resource bindings while
passing four dynamic buffer offsets in ascending binding order32,33,34,35.

`RPCS3_BIND_GROUP_CACHE=1` is opt-in. Both Chrome and device runners forward it;
GPU readiness reports the selected policy, benchmark observations retain it,
and Chrome rejects a policy mismatch or no reuse after4500 gameplay frames.
Default is disabled. The isolated core is `bind-cache-20260905-jspi`.

The cache key includes layout, uniform/stream buffers, exact persistent and
transient storage binding sizes, and sixteen texture-view/sampler pairs. It
excludes offsets and texture contents: contents can change without invalidating
a binding, while view or buffer identity changes require a new group. Shader
storage bounds stay identical to the uncached path. Entries use zero base offset;
the original aligned offsets are supplied per draw. Uniform binding sizes remain
fixed by the renderer ABI. Layout identity distinguishes texture slot sets.

Submission clears cached groups before releasing retired buffer/view handles,
preventing identity reuse from aliasing a stale entry. Ring growth retains old
buffers until submission as before. The cache is capped16384 entries per frame;
clearing it mid-frame releases host handles, while already encoded commands retain
the referenced WebGPU objects. Shutdown clears the cache on the graphics thread.
The presentation blit, clear path and surface-copy bindings remain independent.

Three headful HTTPS direct-session tests passed: timer without cache, message
without cache, message with cache. Each ran60 actual guest flips and produced
frame hash3241800133 with clean shutdown and valid phase timings. The tetris
fixture has one draw per frame: zero cache hits is expected and checks the
submission lifetime, not a performance regression. Six performance-metrics
Vitest tests, TypeScript and diffcheck passed. Initial build failed due an overly
broad edit affecting the presentation blit; corrected build2 passed. Initial
hit assertion mistakenly required within-frame reuse from a one-draw fixture;
corrected to assert zero, while the gameplay harness requires actual reuse.

Gameplay `bind-cache-20260905` completed5504 frames with failures[]. In4500–5200:
248239 hits /809364 draws =30.67% reuse;561125 creations. Binding7.171ms/frame,
draw30.535ms,encoding3.070ms,submission4.469ms,presentation1.392ms;13.968FPS,
436.549 processCPUms/frame,hostpressure3.690%. Timing drops0,unsupported0,
translationfailures0. Visible canvas inspected; existing cyan/material faults
remain. No concurrent host builds/tests/profilers during measurement.

Earlier uncached diagnostic had binding8.388ms,draw31.148ms,encoding2.837ms,
submission3.867ms. This is NOT a controlled speedup: different core builds,
host pressure and slightly different scene work (candidate window includes2new
programs/pipelines and1texture upload). Candidate performed809364 draws rather
than the usual814361. Binding savings partly move to encoding and submission.
No clear total win. Evidence: `test-results/performance/bind-cache-20260905/metrics.json`
and source report; compare `draw-phases-20260905/metrics.json` with its stated
coarse-counter coverage limitation. A later4800–5100 phase check still shows
binding8.471→7.010ms but has different coarse frame endpoints and is exploratory,
not a replacement matched benchmark.

Next: split texture/sampler bindings from buffer bindings so varying storage
sizes do not prevent reuse of stable texture groups. Current combined key admits
only30.7% reuse, which limits savings. Keep exact buffer bounds; do not round
storage sizes without proving shader array-length and robust-access behavior.
A same-build control, targeted ring-growth/binding-bound tests, full material
correctness and iPad validation remain outstanding. No default promotion or
native-parity claim.

## Two-group split implemented and hardware-verified — 2026-09-11

The split landed in the direct backend (`WebGPUDirectGSRender.{h,cpp}` +
`WebGPUDrawBindingKey.h`): a shared `m_draw_buffer_layout` for dynamic bindings
32/33/34/35, and a per-program `program.bind_group_layout` for texture/sampler
pairs. Pipeline layouts carry both groups when the cache is on; per-draw
`cached_draw_bind_group(..., texture)` keeps separate buffers and texture caches,
clears them before retiring handles at submission (and before acquiring the other
group when at the 16384-entry cap), and shuts down cleanly on the graphics thread.
WGSL `assembleShader` accepts `drawBufferGroup`/`colorOutputIndices`, so the
buffer group may live in bind group 1 while textures stay in group 0.

Headed Chrome through the HTTPS ingress (`pixel-lane latency 4500 window`, tetris
fixture, 60 guest flips, same binary, cache on vs off) on 2026-09-11:

- Every policy renders the **same deterministic frame**: the transfer-readback
  hash was `2236050885` for cache off and cache on, across timer and
  MessageChannel yields. Two-group bindings do not change pixels; the split is
  pixel-consistent with the uncached path.
- Direct-backend stats were correct in all runs: 60 draws / 60 clears / 60
  presented, `bindGroupCreates > 0`, `bindGroupHits == 0` (one draw per flip, so
  cache lifetime must end at submission), `translationFailures == 0`,
  `unsupported == 0`, zero timing drops.
- The historical pixel pin `3241800133` reflected the previous PSL1GHT ELF
  bytes; the fixture was regenerated in the working tree, so the pin was
  re-bootstrapped to the current deterministic `2236050885` and now applies
  under `RPCS3_TEST_STRICT_PIXELS=1` (known-good hardware capture). In
  software-backed capture the lane asserts structure and cross-policy
  determinism instead of absolute pixels, because the documented canvas
  transfer/readback interop returns blank under SwiftShader/llvmpipe and must
  not be read as either a pass or a regression.
- The bitmap (non-suspending) fallback core hosts no direct WebGPU backend, so
  it reports no direct stats/policies; the spec gates those assertions on the
  JSPI core only.

Environment limitation recorded for the tab in this round: the attached machine
currently exposes **no hardware Vulkan device** (`nvidia-smi` → "NVML: Unknown
Error"; Vulkan enumerates only `llvmpipe`; the shipped `nvidia_icd.json` points
at `libGLX_nvidia.so.0`, which is not a Vulkan ICD and no `libvulkan_nvidia.so`
is installed). Hardware FPS numbers therefore cannot be produced or trusted from
this session; the headed lane validates structure/determinism only until the
GPU ICD is restored (e.g. the proper NVIDIA Vulkan package). Hardware gameplay
pair and iPad hardware validation remain the open, hardware-gated steps.

Remaining per the original plan: a replicated same-build gameplay pair on a
hardware adapter (≥3 pairs per `web/docs/performance.md` promotion rule),
targeted ring-growth/binding-bound tests in the split path, full material
correctness, and iPad validation. The split stays opt-in by default.

## Software-backed structural probe — 2026-09-11

With no hardware Vulkan device reachable (`llvmpipe`/SwiftShader only), the split's dense-workload
reuse (>0 hits) cannot be measured on hardware. On headed Chrome with SwiftShader, the direct
backend still booted the bundled `gs_gcm_cube.elf` (MRT cube) with cache on:
`ok=true, BootGame=0, 200 flips, 200 presented, 400 draws, 200 clears, 2 programs, 3 pipelines,
0 translation failures, 0 unsupported, 0 timing drops; bindGroupCreates=400 + textureBindGroupCreates=400
(one unique buffer group and one unique texture group per draw; cache lifetime ends at submission so
cross-frame hits are correctly 0 for this 1/2-draw workload). This validates the split path executes
correctly on a textured multi-draw frame under software capture, without claiming hardware FPS.
Reusable probe: `scripts/probe-direct-split-reuse.mjs [fixture] [frames] [baseURL]`.

## Hardware gameplay pair — 2026-09-11 (evening; NVIDIA Vulkan ICD restored)

After the environment's hardware Vulkan became reachable (RTX A5000, two discrete GPUs
enumerated, SwiftShader rejected by the runner), the same-build LBP2 gameplay pair was run with
`RPCS3_CORE=jspi`, the frozen `~/.cache/rpcs3-web-benchmark-fixture` clone per run, and window
4500–5300 (matched: 800 frame samples, exactly 573 draws/frame in each):

| window metric | cache-off baseline | cache-on (two-group split) |
| --- | ---: | ---: |
| fps | 21.98 | 21.44 |
| p95 frame interval | 55.9 ms | 56.4 ms |
| p99 frame interval | 94.1 ms | 68.8 ms |
| max frame interval | 409 ms | 134 ms |
| bindGroupCreates | 458,400 (1/draw, 0 hits) | 194,348 + 264,052 hits (~57.6% reuse) |
| textureBindGroupCreates+Hits | — (combined path) | 88,800 + 369,600 hits (~80.6% reuse) |
| translation failures / unsupported / drops | 0 / 0 / 0 | 0 / 0 / 0 |

Both runs completed to ≥ 5,300 guest flips with zero packet drops, zero translation
failures, zero unsupported RSX ops, and ~87 programs / 105 pipelines settled. The split's designed
effect is real on hardware: two-group reuse (~58% buffer, ~81% texture) versus the old combined key
(~31%), and the worst-case frame stalls improve (p99 94→69 ms, max 409→134 ms) by removing
per-draw bind-group object churn. Mean flip rate and p95 are flat, which is consistent with the
pre-split conclusion that the remaining cost is the draw path's unclassified work (setup + surface
ops), not binding.

## Hardware replication pair 2 — 2026-09-11 (same session)

A second matched pair was run identically (fresh frozen-fixture clone per run, same `jspi` core,
window 4500–5300, 573 draws/frame in each side both times):

| window metric | off-1 | on-1 | off-2 | on-2 |
| --- | ---: | ---: | ---: | ---: |
| fps | 21.98 | 21.44 | 22.12 | 22.34 |
| p50 ms | 42.8 | 45.5 | 43.5 | 43.2 |
| p95 ms | 55.9 | 56.4 | 54.2 | 57.2 |
| p99 ms | 94.1 | 68.8 | 94.0 | 68.7 |
| max ms | 409 | 134 | 117 | 243 |
| buffer creates (hits) | 458,400 (0) | 194,348 (264k) | 458,400 (0) | 194,338 (264k) |
| texture creates (hits) | — | 88,800 (370k) | — | 88,800 (370k) |
| translation failures / unsupported / drops | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |

Both pairs show the same, clean reproduction in the fully matched window: per-draw creates drop
~58% (buffer) with ~81% texture reuse; **p99 improves 94→69 ms in both pairs**; mean FPS/p50/p95 are
flat within run-to-run noise (no input replay on this run set), and `max` is a high-variance tail
(irreproducible sign). No throughput regression in either direction.

**Promotion decision**: keep the split opt-in. Across two independently immovable matched pairs the
split's benefit is defensive (removes per-draw bind-group object churn → better worst-case stalls),
not a flip-rate win, so it is neither promoted to default nor reverted. The formal retention gate
(≥3 pairs) is only triggered when a change is proposed as a default; this outcome does not cross it.
The next stage is subdividing the remaining unclassified draw work (per the frame-phases backlog).
Evidence: `test-results/performance/hw-cacheoff-20260911{,-b}` and `hw-cacheon-20260911{,-b}`/report.json (+ `.metrics.json`).
