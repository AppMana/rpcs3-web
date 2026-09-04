# The RPCS3 web port

RPCS3 compiled to wasm32 with pthreads, rendering through WebGPU, running commercial titles in
Chromium and Mobile Safari. CPU, memory, LV2, PPU, SPU and RSX execution are RPCS3's own sources; the
port replaces only what wasm cannot provide, at named seams.

This document covers the shape of the port, where its seams are, how to test it, how to get it onto
an iPad, and what that device can and cannot do. It is the companion to `web/README.md`, which
covers building.

## The two threads that matter

Everything about the port follows from one fact: **an Emscripten pthread is a Web Worker, and the C++
thread function runs on that worker's only JS stack.** While RPCS3's code runs, that worker's event
loop cannot turn. A thread cannot await, cannot receive a message, and cannot let the browser
composite, without unwinding back to JS.

Two threads feel this most:

- **The RSX thread** renders. It never returns to its event loop, so it cannot use the browser's
  ordinary "present when the task ends" path.
- **The module thread** (`runtime-smoke-worker.mjs`) owns the Emscripten module. Emscripten proxies
  `pthread_create` to it, so it must never block; if it does, no guest thread can be created.

The JSPI work exists to relax the first constraint. See "Suspending" below.

## Layout

| Path | What lives there |
| --- | --- |
| `web/host/rpcs3_web_main.cpp` | Host glue and the `rpcs3_web_*` C API the page drives: boot, status, frames, pad, profiles, diagnostics. Mounts WASMFS's OPFS backend at `/opfs`. |
| `web/host/rpcs3_web_pre.js` | `--pre-js`. Per-worker AOT table population, GPU worker reservation, pthread error forwarding. Runs inside every pthread worker. |
| `web/public/runtime-smoke-worker.mjs` | The module thread. Boots the runtime, drives frames, applies pad state, loads AOT bundles, owns the SPU LLVM pool. |
| `web/public/runtime-acceptance.mjs` | Page-side harness API used by every runner and browser test. |
| `web/public/play-runtime.mjs`, `play.html` | The interactive page: display, input, HUD. |
| `web/public/rpcs3-gamepad.mjs` | Gamepad API to PS3 pad words. |
| `web/public/rpcs3-*-aot-table.mjs`, `rpcs3-aot-workers.mjs` | Loading compiled PPU/SPU side modules and placing them in each worker's function table. |
| `web/public/rpcs3-spu-llvm*.mjs` | The SPU LLVM tier's compiler workers. |
| `web/public/rpcs3-webgpu-renderer.mjs` | RSX program to WGSL translation, imported by the RSX worker. |
| `rpcs3/Emu/RSX/WG/` | The WebGPU backend: `WebGPUDirectGSRender` (renders on the RSX thread), `WebGPURenderTargets.h` (RPCS3's surface store driving it). |
| `rpcs3/Input/pad_thread.cpp` | `web_pad_handler`, a real `PadHandlerBase` fed by `web_pad::set_state`. |
| `rpcs3/Emu/Cell/PPUThread.cpp`, `SPUThread.cpp` | Compiled-block dispatch and the profile counters. |
| `rpcs3/Emu/Memory/vm.cpp`, `rpcs3/util/vm_web.cpp` | The page-table memory model. |
| `rpcs3/util/tsc.hpp`, `sysinfo.cpp` | The monotonic clock standing in for a cycle counter. |
| `web/scripts/` | Build, bundle, and runner scripts. |
| `web/tests/`, `web/tests/e2e/` | Node unit tests and browser tests. |

## Seams

The port replaces whole subsystems at clean boundaries rather than patching call sites.

**Memory.** Desktop RPCS3 reserves multi-gigabyte host aliases around a 4 GiB guest address space.
The port replaces those with two 4 KiB page tables covering all 2²⁰ pages of the guest's 32-bit
space, backed by compact wasm allocations, with a sparse reverse table. Shared memory starts at
512 MiB and may grow to 2 GiB.

**Graphics.** `WebGPUDirectGSRender` is an RSX backend beside the Vulkan and OpenGL ones. Render
targets are RPCS3's own surface store; the ops it emits are executed against `WGPUTexture`s.
Programs are translated to WGSL by `rpcs3-webgpu-renderer.mjs`, which the RSX worker imports.

**Presentation.** The RSX worker holds the WebGPU device and an `OffscreenCanvas`. Because that
thread never yields, the frame is forced out with `transferToImageBitmap` and posted to the page,
which displays it through a `bitmaprenderer` context. This is the seam JSPI changes.

**Input.** `web_pad_handler` is bound to the emulated port and reads a seqlock snapshot set by
`rpcs3_web_set_pad`. RPCS3's own `pad_thread` polls it every `g_cfg.io.pad_sleep` microseconds, so
JavaScript never drives input timing — it only keeps the snapshot fresh.

**Execution.** PPU and SPU blocks are compiled to wasm side modules and placed in each worker's
function table; dispatch is a table call, and an address with no compiled block falls back to the
interpreter. The SPU LLVM tier runs RPCS3's LLVM SPU recompiler with LLVM's wasm backend and
`wasm-ld` inside compiler workers.

**Clock.** `utils::get_tsc()` reads `emscripten_get_now()` directly rather than going through
`steady_clock` and the WASI clock shim.

**Storage.** WASMFS with the OPFS backend mounted at `/opfs`. Titles and firmware live there.

## Suspending: JSPI, with an Asyncify fallback

### Why

A thread that cannot yield cannot: present through a display-backed canvas, await async storage,
await a module compile, or await a fetch. Today each of those is worked around:

| Wanted | Current workaround | Cost |
| --- | --- | --- |
| Present a frame | `transferToImageBitmap` + postMessage | On WebKit this reads back every pixel of the canvas each frame; on Chromium it is a GPU-side handoff. |
| Read a disc image | Import the whole image into OPFS first | A title cannot stream; the import must finish before boot. |
| Load compiled blocks | Instantiate every part synchronously in every worker | Each worker pays for every block up front, which is what forces profile-guided bundles. |
| Compile SPU blocks | Separate compiler workers | Extra workers, extra memory, cross-worker plumbing. |

JSPI (`WebAssembly.Suspending` / `WebAssembly.promising`) lets a wasm call stack suspend at an async
boundary and resume, so C++ can await. Asyncify is the older, universal mechanism: a whole-program
transform that costs code size and speed everywhere. The port targets JSPI where present and falls
back to Asyncify where it is not.

### Capability, not assumption

Support is detected at runtime, never inferred from a version string:

```js
typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function"
```

and confirmed with an actual suspend-and-resume round trip through a tiny module, because a present
constructor is not proof of a working implementation. `web/scripts/` carries the probes; run them
against a device before assuming a path is available there.

### Build

`RPCS3_WEB_JSPI=1 npm run build:runtime` builds the suspending runtime into its own tree and stages
it under `web/public/core/jspi/`. The page probes and loads it in place of the core beside it.

Four rules govern that build, and none of them are enforced at build time:

- An export that can reach a suspending import must itself be able to suspend, listed in
  `JSPI_EXPORTS`. All file access suspends, so this covers the entry points that touch the file
  system and `_emscripten_check_mailbox`, since proxied work runs off the thread mailbox and
  WASMFS's OPFS backend suspends inside it.
- Such an export returns a promise, so its JavaScript callers await it.
- A stack carrying JavaScript frames cannot suspend. Emscripten's default exceptions and longjmp
  reach their handlers through JS trampolines that sit inside ordinary emulator call chains, so this
  build uses `-fwasm-exceptions` and `-sSUPPORT_LONGJMP=wasm`.
- A call that suspends must not also block the thread whose event loop the suspension needs.
  Booting both reads the disc image and waits on the threads it starts, so it runs on its own
  thread, not the module thread.

Build with `--profiling-funcs` when diagnosing a suspend failure; without it the stack is only
function indices.

### Seams that suspend

Ordered by value, not by ease:

1. **Presentation.** The RSX thread suspends once per flip; the worker's event loop turns; a canvas
   whose control was transferred with `transferControlToOffscreen` presents natively. Removes the
   readback and the per-frame ImageBitmap entirely.
2. **Storage.** Async OPFS and HTTP range reads from the file layer, so a title streams instead of
   being imported whole.
3. **Module loading.** Await `compileStreaming` per worker, so compiled blocks load lazily rather
   than every worker holding every block.
4. **SPU compilation.** Await a compile in place, which makes the separate compiler workers optional.

Each is independently switchable, because each has a working non-suspending path today and a
regression in any one of them must be attributable.

## Testing

The rule the port is held to: **timing is recorded, never asserted; correctness is asserted on
output.** A frame time is a measurement, not a gate. What gates is what was drawn, what was
executed, and what came back.

Layers, fastest first:

**Node unit tests** (`npm test`, Vitest, `web/tests/*.test.mjs`). Pure functions and wire formats:
packet decoding, bundle manifests, the gamepad mapping, the library importer's hashing. These take
under a second and are where anything expressible as data-in/data-out belongs. A mapping table gets
a test that pins every entry, because a wrong bit is a wrong button and nothing downstream would
catch it.

**Native C++ tests** (`ctest --test-dir build-web-native -R webgpu`). The packet ABI, ownership and
queue semantics compiled natively, so an ABI regression is caught without a browser.

**Browser tests** (`npm run test:e2e`, and `npm run test:e2e:gpu` for the lane that rejects software
adapters). Real Chromium, real WebGPU. Correctness fixtures compare rendered output against known
hashes or a native reference frame; the GPU lane exists because a software adapter will happily pass
a test that real hardware fails.

**Differential tests.** Where a JS reimplementation shadows an RPCS3 routine, the two are compared
rather than trusted — the SPU interpreter against the native portable build, texture decode against
`upload_texture_subresource`. A new reimplementation should arrive with its differential.

**Device runs.** The only place Mobile Safari behaviour is real. Everything above can pass while the
device fails, so a change that touches memory, threads, or presentation is not done until it has run
there.

Writing a new test, in order of preference: make it a Node unit test; if it needs a GPU, make it a
browser test with an output assertion; if it needs Safari, make it a device run that writes a report
and a frame. Prefer asserting on counters the runtime already reports over adding new diagnostics to
the hot path, and gate any diagnostic that costs time behind a flag the default run leaves off.

### A caution learned the hard way

A device harness must be able to distinguish this run's result from the last one's. A runner that
polls for a saved report will find the previous run's file the moment the page loads and report it as
its own; every run appearing to take exactly one poll interval is the tell. Stamp each run and ignore
anything else.

## Running locally

```sh
npm run build:runtime     # everything that runs inside the browser
npm run build             # the page; staged artifacts reach the browser only through this
npm test                  # Node unit tests
npm run test:e2e          # browser tests that do not need WebGPU
npm run test:e2e:gpu      # the strict GPU lane
```

A title on desktop hardware, which is the fastest way to see a real workload:

```sh
RPCS3_DIRECT_RENDERER=1 RPCS3_PPU_AOT_BUNDLE=local-aot/<title>/manifest.json \
RPCS3_FRAMES=600 npm run hardware:run -- "/opfs/games/<title>.iso" out.json
```

The runner writes `out.json` plus sidecars beside it. Useful variables: `RPCS3_SPU_DECODER`,
`RPCS3_CLOCK_SCALE`, `RPCS3_RENDER_EVERY`, `RPCS3_READBACK`, `RPCS3_INPUT_TRACE`, `RPCS3_PPU_PROFILE`,
`RPCS3_CORE=profile` for the symbolized build.

## Deploying to an iPad

The device needs a **cross-origin-isolated HTTPS origin** it can reach — `SharedArrayBuffer` requires
COOP/COEP, and the whole port is built on shared memory. Any origin you control that serves
`web/dist/` with those headers works; `vite preview` serves them locally.

Host side, once:

```sh
usbmuxd                        # the device must be trusted and unlocked
ios_webkit_debug_proxy -c null:9221,:9222-9230
curl -s http://127.0.0.1:9221/json     # should list the device
```

Safari must have Web Inspector enabled, and a page on the origin must already be open — the runners
drive the existing tab over the WebKit Inspector Protocol rather than opening one.

```sh
npm run device:runtime -- <outDir> gs_gcm_cube.elf   # homebrew fixture
npm run device:units -- <outDir>                     # the compiled GoogleTest artifact
npm run device:library -- <origin> <outDir> <name> [games|firmware]
```

Runners write `report.json` and `frame.png` into the output directory. Nothing renders in the cloud;
the device does the work and the host only reads the result back.

Two device behaviours will bite:

- **Navigate cross-origin before a fresh run.** Shared memory reserves its maximum when it is
  created, and a same-origin navigation leaves the previous run's reservation in place because
  WebKit keeps the process. A cross-origin round trip swaps the process and gives the memory back.
  Without it, a second run fails in the `WebAssembly.Memory` constructor before RPCS3 starts.
- **An uncaught error in a pthread worker reaches the page as an opaque `ErrorEvent`.** The stack is
  forwarded deliberately (`rpcs3_web_pre.js`); keep it flowing into whatever the runner reports, or
  a device failure is unattributable.

## What the iPad can and cannot do

Verified by probe on the device, not inferred:

**Can:** WebGPU in a worker, including from a thread that never yields, with
`texture-compression-bc`, `float32-filterable`, `depth-clip-control` and `shader-f16`. Shared memory
and `SharedArrayBuffer` on a cross-origin-isolated origin. OPFS through sync access handles.
`transferControlToOffscreen`. Roughly 5 GiB of committed memory across the process, which several
2 GiB reservations will exhaust — a shared memory reserves its maximum up front, so every module's
`MAXIMUM_MEMORY` is a real cost for as long as that module exists.

**Can, from iPadOS 27:** JSPI. `WebAssembly.Suspending` and `WebAssembly.promising` are present and
a suspend-and-resume round trip through a wasm module returns its value. iPadOS 26 has neither, which
is what the Asyncify core is for. `scripts/probe-device-jspi.mjs` checks this and the blit below.

**Cannot, or not usefully:**

- **Present from a non-yielding worker through a display-backed canvas.** Measured on the device: a
  worker that yields between frames rotates the canvas texture every frame (60 of 60) and reaches the
  screen; the same worker blocking instead of yielding is handed the same texture every time (1 of
  60) and presents nothing until its task finally ends. Presentation commits when the worker's event
  loop turns, which is exactly what the RSX thread cannot do today and what JSPI provides. A
  screenshot alone does not distinguish the two cases — the blocking canvas does display its last
  frame once the worker returns — so the texture-rotation count is the measurement that matters.
- **`transferToImageBitmap` cheaply.** On WebKit it reads back the whole canvas; on Chromium it is a
  GPU handoff. Any presentation design must account for the difference.
- **Compile an arbitrarily large wasm module.** A single large module will not compile on the device
  at all, which is why title bundles are split into parts and, where needed, filtered to the blocks
  a profiled run actually enters.
- **JSPI, before iPadOS 27.** Probe it; do not assume from the OS version alone.

`navigator.storage.estimate()` overstates small files, because WebKit accounts OPFS quota by
sync-access-handle capacity, which grows in powers of two and does not shrink within a session.

## Benchmarking

Chromium is the reference for any performance claim, because it is the only place both presentation
paths are cheap and a regression can be attributed to the change rather than to a browser quirk. A
JSPI change is benchmarked against the same build without it, on the same hardware, over the same
input trace.

Compare like with like. A title's frame time depends on what is on screen, and the same run reaches
the same scene at a different flip each time, so compare **microseconds per draw over frames
carrying a comparable draw count**, never wall time or a fixed frame index. Record the adapter, the
clock scale, and whether compiled blocks were active; a run with a bundle and a run without are not
comparable numbers.
