# RPCS3 in the browser

RPCS3 built for wasm32 with pthreads, rendering through WebGPU. CPU, memory, LV2, PPU, SPU and RSX
execution are RPCS3's own sources; this directory adds a WebGPU render backend, a host glue layer,
and the browser-side plumbing that replaces what wasm cannot provide.

Commercial titles boot and render, on desktop Chromium and on an iPad. Compiled PPU and SPU blocks
run on the guest threads through the wasm function table, with the interpreter as the fallback for
any block that is not compiled. Both PPU and SPU blocks can also be compiled while the guest runs,
by RPCS3's own recompilers hosted in compiler workers, so a block no bundle carries does not stay
interpreted for the rest of the run.

`docs/port.md` describes the architecture, the seams, how to test, how to deploy to a device, and
what that device can and cannot do. This file covers building and running.

## Memory model

The PS3 has 256 MB of XDR main memory and 256 MB of RSX local memory. Desktop RPCS3 reserves several
multi-gigabyte host aliases around a 4 GiB guest effective-address space; those aliases are what a
wasm32 process cannot provide.

The web build replaces them with two 4 KiB page tables covering all 2²⁰ pages of the guest's 32-bit
address space. Guest mappings point into compact wasm backing allocations, and reverse translation
uses a second sparse table. The module starts with 512 MB of shared linear memory and may grow to
2 GiB, so it never allocates a flat 4 GiB or 8 GiB alias.

A shared memory reserves its **maximum** when it is created, not as it grows. Every module's
`MAXIMUM_MEMORY` is therefore a live cost for as long as that module exists, which matters on a
device with a few gigabytes of headroom and several modules in play.

## Building

### The browser modules

`npm run build:runtime` builds everything that runs inside the browser
(`scripts/build-rpcs3-core.sh`): the RPCS3 runtime, the compiled unit-test artifact, and the SPU LLVM
compiler module when an Emscripten LLVM tree is present. It uses Ninja on every core, wraps
Emscripten's clang with `ccache`, and re-runs CMake only when the build tree is missing or one of its
options changed. On 32 cores a cold build takes about four minutes and a one-file change about
fifteen seconds.

```sh
RPCS3_WEB_FAST_LINK=1 RPCS3_WEB_TARGETS=rpcs3_web_runtime npm run build:runtime
```

`RPCS3_WEB_FAST_LINK=1` links at `-O1` instead of the Release level, which turns the per-module
`wasm-opt` pass from tens of seconds into one or two. Use it while iterating on correctness and never
for anything you intend to measure. `RPCS3_WEB_TARGETS` limits the build to the named CMake targets.
Together they bring a one-file change down to about two seconds. Switching either option back
reconfigures the tree, so the first measurement build after fast-link iteration pays one full link.

Other variables: `RPCS3_WEB_JOBS` (default: every core), `RPCS3_WEB_COMPILER_WRAPPER=` (empty
disables `ccache`; `sccache` does not work here, it refuses Emscripten's `-Xclang` arguments and
caches nothing), and `RPCS3_WEB_EMSDK` (default `~/.cache/emsdk-6.0.8`).

### The page

`npm run build` typechecks and bundles the site. **Staged artifacts reach the browser only through
this step**, so a change under `public/` or `src/` needs it before any browser test or device run
sees it, and a change to the wasm modules needs `build:runtime` first. A measurement taken without it
silently measures the previous build. `npm run check` is the bundle plus the Node unit tests.

### The symbolized profile core

`RPCS3_WEB_PROFILE=1 npm run build:runtime` builds a second runtime that keeps the wasm
function-name section, staged under `public/core/profile/`. It uses a separate build tree, but its
compile flags match the Release build, so `ccache` serves the objects and only the link is new.
Runners select it with `RPCS3_CORE=profile`, which is what makes a CPU profile show RPCS3 function
names instead of `wasm-function[12645]`.

### LLVM for WebAssembly

The SPU LLVM tier needs LLVM and lld compiled to wasm by Emscripten. `scripts/build-llvm-wasm.sh`
clones `release/22.x` and builds only the WebAssembly target with threads off, which takes roughly
fifteen minutes once. The result lands in `~/llvm-wasm/build-wasm`; `build:runtime` picks it up from
there, or from `RPCS3_WEB_LLVM_DIR`, and silently skips the compiler module when no such tree exists.

### Native RPCS3

Two native trees back the browser work, and neither is configured with a compiler launcher by
default; add `-DCMAKE_CXX_COMPILER_LAUNCHER=ccache -DCMAKE_C_COMPILER_LAUNCHER=ccache` when
configuring one, since these are the slowest builds in the repository.

`build-rpcs3-native` is configured with `-DRPCS3_PORTABLE_SPU_INTERPRETER=ON`. It compiles the same
portable SPU interpreter the browser executes, so it is the differential oracle for SPU semantics and
the build that proves web-guarded changes to shared files still compile for a desktop target.
`build-rpcs3-native-stock` is stock upstream RPCS3, used for reference frames, SPU program dumps,
native gameplay comparison, and dumping the PPU IR that title bundles are built from.

`build-web-native` compiles the host sources natively for `ctest`, which catches host-glue and
ownership regressions without a browser:

```sh
ctest --test-dir build-web-native --output-on-failure -R webgpu
```

### Ahead-of-time bundles

`npm run ppu:aot:bundle` and `npm run spu:aot:bundle` turn directories of LLVM IR dumped by native
RPCS3 into the wasm side modules the runtime loads before boot. They are inputs to commercial runs
rather than part of a normal build, and are rebuilt only when new programs are dumped.

Dump a title's PPU IR by running it under native RPCS3 with `RPCS3_PPU_WASM_AOT_IR=1` and
`RPCS3_PPU_WASM_AOT_DIR` set to an output directory; the analyser finishes within seconds of boot, so
the run can be stopped once the parts stop appearing. `--eboot-parts=N` splits a title's program into
N modules, which is what keeps each one inside the size a browser will compile — a single large
module will not compile on a device at all.

`RPCS3_PPU_JIT=1` turns on the runtime PPU tier, which needs no bundle at all and can also stand
beside one: the bundle is the warm start and the tier compiles what the bundle lacks.
`RPCS3_PPU_JIT_THRESHOLD` is how many times the interpreter must enter a block first (default 64).

A bundle holds every block the analyser proved reachable, and **every worker running a PPU thread
holds all of them in its function table**, so the bundle is a per-worker cost. To build one from what
a session actually runs, capture a profile with `RPCS3_PPU_PROFILE=1` (the runner writes the entered
guest addresses beside its report as `.ppu-used.bin`), then:

```sh
node scripts/filter-ppu-ir-by-profile.mjs IR_DIR OUT_DIR PROFILE.bin
```

The filter keeps the blocks the profile entered plus the transitive closure of their direct tail
calls, since a direct call names its callee. Blocks reached only through the function table are not
recorded by a profile, so they fall back to the interpreter; capturing a second profile from a run of
the filtered bundle names exactly those blocks, and merging converges. A block left out costs speed,
never correctness.

## Running

```sh
npm test              # Node unit tests
npm run test:e2e      # browser tests that do not need WebGPU
npm run test:e2e:gpu  # the strict GPU lane, which rejects software adapters
```

A title on desktop hardware:

```sh
RPCS3_PPU_AOT_BUNDLE=local-aot/<title>/manifest.json \
RPCS3_FRAMES=600 npm run hardware:run -- "/opfs/games/<title>.iso" out.json
```

The runner writes `out.json` plus sidecars beside it. Useful variables: `RPCS3_SPU_DECODER`
(`static`, `asmjit`, `llvm`), `RPCS3_SPU_LLVM_WORKERS`, `RPCS3_CLOCK_SCALE`, `RPCS3_RENDER_EVERY`,
`RPCS3_INPUT_TRACE`, `RPCS3_PPU_PROFILE`, `RPCS3_CORE=profile`.

`play.html` is the interactive page. It takes the title and its bundles as query parameters:

```
play.html?boot=/opfs/games/<title>.iso&ppuAot=local-aot/<title>/manifest.json&spuDecoder=llvm
```

Keyboard, on-screen touch controls and a physical controller all feed the same pad. The on-screen
pad hides itself while a controller is connected.

## Devices

See `docs/port.md` for the full procedure, the device's measured capabilities, and the two behaviours
that will otherwise cost you a day (the cross-origin navigation that releases the previous run's
memory reservation, and stamping a run so its report cannot be confused with the previous one's).

Briefly: the device needs a cross-origin-isolated HTTPS origin it can reach, `usbmuxd` and
`ios-webkit-debug-proxy` on the host, Web Inspector enabled, and a page on that origin already open.

```sh
npm run device:runtime -- <outDir> gs_gcm_cube.elf
npm run device:units -- <outDir>
npm run device:library -- <origin> <outDir> <name> [games|firmware]
```

Runners write `report.json` and `frame.png`. Nothing renders in the cloud; the device does the work
and the host reads the result back.

## Importing firmware and titles

`storage.html` fills the origin-private file system without a file picker, by downloading from
`/library/` on the page's own origin.

- `scripts/serve-library.mjs` (`npm run library:serve`, port 4181) serves an allowlist of files with
  exact HTTP Range semantics (`206`/`416`, `Accept-Ranges`, strong ETags, `HEAD`),
  `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, and a JSON index carrying
  each file's size and SHA-256. Serve that prefix from the same origin as the page.
- `public/library-import-worker.mjs` fetches 16 MiB ranges, writes every body read straight into a
  `FileSystemSyncAccessHandle` (Safari has no `createWritable`), and hashes as it goes
  (`library-import-core.mjs`: resumable SHA-256 in wasm with a JavaScript fallback, both checked
  against Node's digest). A sidecar `.rpcs3-imports/<destination>/<name>.json` records the source
  size, SHA-256 and ETag plus the running hash state, so an interrupted import resumes from the bytes
  already on disk and a changed source restarts from zero.
- Page API: `window.__rpcs3Storage.importFromLibrary(name, destination)` returns a report (bytes,
  elapsed, rate, requests, resume point, SHA-256 verdict, `navigator.storage.estimate()` before and
  after); `importProgress()` and `abortImport()` support pollers.
  `storage.html?import=<name>&destination=games|firmware` starts one on load.

WebKit accounts OPFS quota by sync-access-handle capacity, which grows in powers of two below
256 MiB and in 128 MiB steps above, and does not shrink when a file is deleted within the session, so
`estimate().usage` overstates small files. `truncate()` to a target size requests the next power of
two, so the worker never pre-sizes files.

## Current limits

- The WGSL translator implements the shader and render-state subsets the tested titles and fixtures
  exercise, not arbitrary RSX programs.
- Surface aliasing, stencil, broader texture formats and several blend and depth modes are
  incomplete.
- The native SPU analyser tests instantiate AsmJIT directly, so they are not in the browser unit
  allowlist until the analyser is separated from that native-code factory.
- Audio is not connected.
