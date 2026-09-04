# Measuring the port

How the browser port's performance is measured, what the numbers were on 2026-09-04, and what the
desktop emulator does differently. Companion to `port.md`, which covers the architecture.

## The metric

**CPU milliseconds per frame, at a stated draws per frame.**

Frame time alone is not comparable between two runs of a title: the same title reaches the same
scene at a different flip every time, so a fixed flip index compares two different scenes. Frames
per second alone hides whether a run got cheaper or merely lighter. The pair — what a frame costs in
CPU, and how much was on screen — is what survives.

Wall time per frame matters too, because that is what the player feels, but it is a *result*: with
eight busy threads on a thirty-two core machine, CPU per frame is the thing a change moves and frames
per second is what it buys.

`scripts/analyse-cpuprofile.mjs` prints both:

```
76 workers with work samples, 5000 us interval, last 25s
211.4 CPU-ms per frame at 573 draws per frame (535 frames, 113.0 CPU-s)
```

Work samples exclude `(idle)`, `(program)`, the garbage collector and futex waits; without that
exclusion a 75-worker profile reads as 74% `emscripten_futex_wait` and the 26% that is real work
never rises above a rounding error.

## Running the browser benchmark

Profile with the **profile core**, always. `wasm-opt` discards `noinline` when it links the shipping
cores, so `spu_web_interpreter_loop` folds into `spu_thread::cpu_task`, `ppu_thread::exec_task` into
`fast_call`, and `spin_on_cacheline_once` into `nv406e::semaphore_acquire`. The profile core keeps
the name section and attributes them separately. It is not byte-identical to the shipping core, so
shares come from the profile core and the frames-per-second gate is confirmed on the shipping one.

```sh
RPCS3_WEB_PROFILE=1 npm run build:runtime      # stages public/core/profile/
npm run build                                  # staged artifacts reach the browser only through this

DISPLAY=:0 RPCS3_HEADED=1 RPCS3_CORE=profile \
RPCS3_CPU_PROFILE=/tmp/run.cpuprofile RPCS3_CPU_INTERVAL_US=5000 \
RPCS3_PPU_JIT=1 RPCS3_SPU_DECODER=llvm RPCS3_SPU_LLVM_WORKERS=2 \
RPCS3_PPU_AOT_BUNDLE=local-aot/<title>/manifest.json \
RPCS3_SPU_AOT_BUNDLE=local-aot/<title>-spu/manifest.json \
RPCS3_DIRECT_RENDERER=1 RPCS3_CLOCK_SCALE=100 \
RPCS3_FRAMES=4100 RPCS3_RENDER_EVERY=2050 RPCS3_READBACK=0 RPCS3_TIMEOUT_MS=1200000 \
npm run hardware:run -- "/opfs/games/<title>.iso" /tmp/run.json

node scripts/analyse-cpuprofile.mjs /tmp/run.cpuprofile --last=25 --report=/tmp/run.json
node scripts/analyse-cpuprofile.mjs /tmp/run.cpuprofile <function> --last=25   # who calls it
```

Every tier must be on or the measurement is of something else entirely: without `RPCS3_PPU_JIT` and
the bundles, a commercial title is interpreted end to end and runs an order of magnitude slower.

**Reaching gameplay.** A title spends thousands of flips on logos, boot and its intro. LittleBigPlanet
2's first heavy frame is around flip 3500, and before it the run sits at one draw per frame — a
profile of the first 600 frames is a profile of a video player. Give the run a budget past that and
window the analysis onto the end with `--last=`. No input is needed: the title reaches a
573-draws-per-frame scene unattended.

**The caller report** is what turns a share into a lead. Self time says `_emscripten_get_now` costs
26%; `analyse-cpuprofile.mjs <profile> _emscripten_get_now` says 64.7% of it came from `sched_yield`
inside `rsx::thread::on_task`, which is the sentence you can act on. It walks past the `wasm-to-js`
trampoline every import call goes through, and reports three frames of chain.

## Running the native benchmark

The desktop emulator is the reference for what a cost *should* be. `build-rpcs3-native-stock/bin/rpcs3`
is the tree to use — `build-rpcs3-native` sets `RPCS3_PORTABLE_SPU_INTERPRETER=ON`, which forces the
SPU decoder to the static interpreter and would measure the browser's SPU path, not RPCS3's.

`perf` needs the paranoia level lowered once per boot:

```sh
sudo sysctl -w kernel.perf_event_paranoid=1
```

Record flat. `--call-graph dwarf` on a multithreaded emulator produced 1.4 GB in four minutes and
answered a question the comparison does not ask; self time per symbol is what is wanted.

RPCS3 installs no signal handler, so `timeout` kills it before its own reports flush. Close its
window instead and it shuts down cleanly, which is what writes the `perf_meter` histograms and the
guest-PC profiler summary into `~/.cache/rpcs3/RPCS3.log`.

```sh
cat > /tmp/native-profile.yml <<'YAML'
Core:
  PPU Decoder: Recompiler (LLVM)
  SPU Decoder: Recompiler (LLVM)
  PPU Profiler: true
  SPU Profiler: true
  Enable Performance Report: true
  Performance Report Threshold: 500
Video:
  Renderer: Vulkan
  Resolution: 1280x720
  Frame limit: Auto
Audio:
  Renderer: Null
YAML

( sleep 280; for w in $(xdotool search --name "<title>"); do xdotool windowclose $w; done ) &
perf record -F 999 -o /tmp/native.perf -- \
  build-rpcs3-native-stock/bin/rpcs3 --no-gui --allow-any-location \
  --config /tmp/native-profile.yml "/path/to/<title>.iso"
```

`--no-gui`, not `--headless`: headless mode rejects any renderer but null, and a null renderer is not
a graphics measurement. `Audio: Renderer: Null` keeps the audio thread's jitter out of the profile.
`Enable Performance Report` costs about 4% of the run in `perf_stat_base::push` — leave it off for a
clean total and on when the question is about DMA, reservations or memory locks specifically.

Reading it back:

```sh
perf script -i /tmp/native.perf -F time | awk '{b=int($1/25)*25; c[b]++} END {for (k in c) print k, c[k]}' | sort -n
perf report -i /tmp/native.perf --no-children --sort dso    --time <start>,<end> --stdio -g none
perf report -i /tmp/native.perf --no-children --sort symbol --time <start>,<end> --stdio -g none
```

The histogram picks a steady-state window — the first and last buckets are boot and shutdown and are
not the run. Samples in a window, divided by the sampling frequency, are CPU-seconds; divide by
frames (frames per second read off the window title, which carries `FPS: nn.nn`) for CPU-ms per frame.

JIT'd guest code shows as unresolved addresses under `[JIT] tid …`, because the `perf-<pid>.map`
emitter in `Utilities/JITASM.cpp` is compiled out. Sorting by DSO is therefore the useful split:
guest code against emulator C++.

## 2026-09-04: LittleBigPlanet 2, the same machine

32-core desktop, RTX A5000. Browser figures from the gameplay stretch at 573 draws per frame; native
from a steady-state window with the title reporting a locked `FPS: 30.00`.

| | browser | native |
| --- | --- | --- |
| frames per second | 21.4 | **30.00** (the title's own cap) |
| CPU per frame | **211 ms** | 135 ms (≈129 without the perf report) |
| cores busy | 4.5 of 32 | 4.04 of 32 |
| guest code | ~7% (compiled SPU blocks) | **42.7%** (`[JIT]`) |
| emulator C++ | the rest | 23.9% |
| PPU threads | — | 99.4% idle |
| SPU threads | — | 80.9% idle, 19.4% reservations |

Both use about four cores. Native turns them into 30 fps; the browser turns them into 21.4. The gap
in CPU per frame is 1.56×, and it is wider than that in truth, because native is frame-limited and
part of its four cores is spent spinning to fill a frame it finished early.

The split is the finding, not the total:

| browser, pooled self time | | native, self time |
| --- | --- | --- |
| `spu_web_interpreter_loop` (SPU dispatch) | **20.4%** | `spu_thread::do_list_transfer` 2.4% |
| `nv406e::semaphore_acquire` (the RSX spin) | 8.6% | `process_mfc_cmd` 1.7% |
| SPU DMA (dma / list / mfc) | 7.0% | the MFC `__mwaitx` 1.6% |
| compiled SPU blocks | ~7% | `do_dma_transfer` 1.4% |
| `rpcs3_web_vm_*_raw` | 3.2% | `mov_rdata` 1.3% |
| `vm::writer_lock` | 2.1% | `vm::writer_lock` 0.7% |
| `ppu_thread::fast_call` (PPU dispatch) | 2.0% | `do_putllc` 0.6% |
| `WebGPUDirectGSRender::end()` | 1.1% | — |

Natively nothing dominates and the emulator's own C++ is a flat ~20%, with 43% of the machine going
into translated guest code. In the browser the largest single cost is the SPU dispatcher, and it
costs about three times the compiled code it dispatches.

Eight of seventy-five workers carry 88% of the work: the RSX thread, the main PPU thread, and six SPU
threads.

## Why the SPU dispatcher is the outlier

Native and the port's own PPU tier already agree on how dispatch should work; the SPU path is the one
that does something else.

**Native SPU** (`spu_runtime::g_dispatcher`, built in `SPUCommonRecompiler.cpp`). A one-million-entry
table indexed by the *first instruction word* of the block, `word >> 12`. The trampoline is six
instructions:

```
mov  eax, [rcx]              ; the instruction word at the local-store pc
shr  eax, 12                 ; index
lea  rdx, [g_dispatcher]
mov  [r13+block_hash], 0
jmp  [rdx + rax*8]           ; tail jump into the block
```

A block that finishes tail-jumps to the next one. The C++ loop in `spu_thread::cpu_task` is re-entered
only on an escape. Collisions in the table are resolved by the block's own local-store verification.

**The port's PPU tier** does the same thing in wasm (`PPUTranslator.cpp`, the branch epilogue). A
compiled block loads a two-level dispatch page, takes the bundle slot or the runtime tier's slot, and
ends in a `musttail` indirect call — a wasm `return_call_indirect` — or returns to the interpreter
when there is nothing there. Blocks chain; the loop is not involved. That is why `fast_call` carries
only 2% of the profile.

**The port's SPU path** returns to `spu_web_interpreter_loop` after **every** block, and per block
re-derives: a thread-state check, an atomic load from a 256 KiB candidate-list table, a scan of the
candidate list against the hot-table base with a possible `rpcs3_web_spu_hot_sync()` call out to
JavaScript, a `call_indirect`, a `block_failure` round trip through memory to decide whether the block
actually ran, and two counter updates — one of them an out-of-line call that loads from a 128 KiB
array. Branch targets with no compiled program additionally take a shared-memory atomic
read-modify-write on a 256 KiB array that every SPU worker shares, on every visit, forever.

So the concept is not broken; one implementation of it is. The SPU path needs the epilogue the PPU
path already has.

## Rules that stop a measurement lying

- **Compare at matched draws per frame.** Two runs of the same title at the same flip index are two
  different scenes.
- **One browser run at a time.** Chrome's profile directory is exclusive, and a second run competes
  for the GPU as well.
- **Never profile the first 600 frames of a commercial title** and call it a workload; that is its
  intro video.
- **Check what is actually enabled.** A run reports `ppuAotBlocks`, `ppuJit.registered`,
  `spuAotPrograms` and `spuLlvm.compiled`. If those are absent the title is being interpreted and the
  profile is meaningless.
- **A background rebuild will corrupt a run in progress.** Both compete for the same cores.
- **Timing is recorded, never asserted.** Frame time is a measurement; what gates a change is what was
  drawn and what was executed, through the dispatch oracles and the frame comparison in `port.md`.
