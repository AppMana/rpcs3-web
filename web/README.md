# RPCS3 browser/WebGPU bring-up

This directory contains two executable PS3-homebrew paths:

1. A small fixture-scoped PPU/HLE/GCM harness used for fast capability and input tests.
2. A build of the real RPCS3 `rpcs3_emu` source tree for Wasm32/pthreads. Its `WebGPUGSRender` backend captures authentic RSX state, vertex/fragment programs, buffers, textures, and draw calls. The browser translates that state to WGSL and submits it directly to WebGPU.

The full-runtime path currently boots the unmodified `gs_gcm_basic_triangle.elf` and `gs_gcm_cube.elf` fixtures through `System::BootGame`. The cube exercises indexed geometry, a 256×256 texture, vertex and fragment microcode, a depth target, depth comparison/writes, B8 font texture component mapping, and source-alpha blending. The host can request successive coherent flips from the still-running RPCS3 process, but this is not yet a general or continuously playable RPCS3 browser port.

This is an alternative RPCS3 graphics backend, not a new PS3 emulator and not a Vulkan-call shim. CPU, memory, LV2, PPU, and RSX execution come from the existing RPCS3 sources. Web-only compatibility changes and the WebGPU packet/translation layer replace facilities that Wasm cannot provide.

## Memory model

The PS3 has 256 MB of XDR main memory and 256 MB of RSX local memory, not 8 GB of physical RAM. Desktop RPCS3 reserves several multi-gigabyte host aliases around a 4 GiB guest effective-address space; those aliases are the apparent “8 GB” problem for a Wasm32 browser process.

The full Web build replaces the desktop fixed-address aliases with two 4 KiB page tables covering all 2²⁰ pages of the PS3's 32-bit guest address space. Guest mappings point into compact Wasm backing allocations, and reverse translation uses a second sparse table. The module starts with 512 MB of shared linear memory and may grow to 2 GiB. It therefore never allocates flat 4 GiB or 8 GiB host aliases.

Memory64 could raise the host linear-memory ceiling in supporting browsers, but it is not required for the current 32-bit PS3 process map. Larger games will still need better RSX resource residency and eviction rather than treating every mapped aperture as permanently resident.

## Building

### The browser modules

`npm run build:runtime` builds everything that runs inside the browser (`web/scripts/build-rpcs3-core.sh`): the RPCS3 runtime, the compiled unit-test artifact, and the SPU LLVM compiler module when an Emscripten LLVM tree is present. It uses Ninja on every core, wraps Emscripten's clang with `ccache`, and re-runs CMake only when the build tree is missing or one of its options changed. On 32 cores a cold build takes about four minutes and a one-file change about fifteen seconds.

```sh
RPCS3_WEB_FAST_LINK=1 RPCS3_WEB_TARGETS=rpcs3_web_runtime npm run build:runtime
```

`RPCS3_WEB_FAST_LINK=1` links at `-O1` instead of the Release level, which turns the per-module `wasm-opt` pass from tens of seconds into one or two; use it while iterating on correctness and never for anything you intend to measure. `RPCS3_WEB_TARGETS` limits the build to the named CMake targets. Together they bring a one-file change down to about two seconds. Switching either option back reconfigures the tree, so the first measurement build after fast-link iteration pays one full link.

Other variables: `RPCS3_WEB_JOBS` (default: every core), `RPCS3_WEB_COMPILER_WRAPPER=` (empty disables `ccache`; `sccache` does not work here, it refuses Emscripten's `-Xclang` arguments and caches nothing), and `RPCS3_WEB_EMSDK` (default `~/.cache/emsdk-6.0.8`).

### The page

`npm run build` typechecks and bundles the site. Playwright serves the bundle, so a change to anything under `web/public/` or `web/src/` needs this before the browser tests see it; a change to the Wasm modules needs `build:runtime` first. `npm run check` is the two of them plus the Node unit tests.

### The symbolized profile core

`RPCS3_WEB_PROFILE=1 npm run build:runtime` builds a second runtime that keeps the Wasm function-name section, staged under `web/public/core/profile/`. It uses a separate build tree, but its compile flags match the Release build, so `ccache` serves the objects and only the link is new. Runners select it with `RPCS3_CORE=profile`, which is what makes a CPU profile show RPCS3 function names instead of `wasm-function[12645]`. Like every other staged artifact it reaches the browser only through `npm run build`, so a profile taken without that step silently measures the previous core.

### LLVM for WebAssembly

The SPU LLVM tier needs LLVM and lld compiled to Wasm by Emscripten. `web/scripts/build-llvm-wasm.sh` clones `release/22.x` and builds only the WebAssembly target with threads off, which takes roughly fifteen minutes once. The result lands in `~/llvm-wasm/build-wasm`; `build:runtime` picks it up from there, or from `RPCS3_WEB_LLVM_DIR`, and silently skips the compiler module when no such tree exists.

### Native RPCS3

Two native trees back the browser work, and neither is configured with a compiler launcher by default; add `-DCMAKE_CXX_COMPILER_LAUNCHER=ccache -DCMAKE_C_COMPILER_LAUNCHER=ccache` when configuring one, since these are the slowest builds in the repository.

`build-rpcs3-native` is configured with `-DRPCS3_PORTABLE_SPU_INTERPRETER=ON`. It compiles the same portable SPU interpreter the browser executes, so it is the differential oracle for SPU semantics and the build that proves web-guarded changes to shared files still compile for a desktop target. `build-rpcs3-native-stock` is stock upstream RPCS3, used for reference frames, SPU program dumps, and native gameplay comparison.

`build-web-native` compiles the WebGPU packet and host sources natively for `ctest`, which catches packet ABI, ownership, and queue regressions without a browser:

```sh
cmake --build build-web-native --target \
  rpcs3_webgpu_command_tests rpcs3_webgpu_host_tests -j2
ctest --test-dir build-web-native --output-on-failure -R webgpu
```

### Ahead-of-time bundles

`npm run ppu:aot:bundle` and `npm run spu:aot:bundle` turn directories of LLVM IR dumped by native RPCS3 into the Wasm side modules the runtime loads before boot. They are inputs to commercial runs rather than part of a normal build, and they are rebuilt only when new programs are dumped.

Dump a title's PPU IR by running it under native RPCS3 with `RPCS3_PPU_WASM_AOT_IR=1` and `RPCS3_PPU_WASM_AOT_DIR` set to an output directory; the analyser finishes within seconds of boot, so the run can be stopped once the parts stop appearing. `--eboot-parts=N` splits a title's program into N modules, which is what keeps each one inside the size a browser will compile.

A bundle holds every block the analyser proved reachable, and every worker running a PPU thread has to hold all of them in its function table. To build one from what a session actually runs instead, capture a profile with `RPCS3_PPU_PROFILE=1` (the runner writes the entered guest addresses beside its report as `.ppu-used.bin`), then `node scripts/filter-ppu-ir-by-profile.mjs IR_DIR OUT_DIR PROFILE.bin` before bundling. A block the profile missed is simply not registered, so it runs interpreted.

## Validation

```sh
# Wasm/TypeScript unit checks and production bundle
npm run check

# Browser tests that do not require WebGPU
npm run test:e2e

# Build the RPCS3 runtime and compiled C++ unit artifact, then run the latter
# in Chromium. GoogleTest performs the assertions inside Wasm.
npm run build:runtime
npm run test:units:browser

# Full-RPCS3 cube correctness. Software WebGPU is allowed in this test so
# shader, texture, depth, blending, and pixel regressions remain testable.
npx playwright test runtime-cube-correctness.spec.ts \
  --config playwright.gpu.config.ts

# Dedicated GPU lane. The strict runtime tests reject SwiftShader/llvmpipe.
npm run test:e2e:gpu

# Capture a raw frame and compare it with a same-size native reference PNG.
RPCS3_CAPTURE_FRAME=1 npx playwright test frame-oracle.spec.ts \
  --config playwright.gpu.config.ts
npm run compare:frame -- native-reference.png \
  test-results/*/browser-frame.json --max-rmse 1 --min-close-pixels 0.99
```

With one trusted iPad visible through `usbmuxd` and `ios-webkit-debug-proxy`, the full local runtime can be transferred through WebKit Inspector without deployment:

```sh
npm run device:runtime -- device-runtime-evidence gs_gcm_cube.elf

# Transfer the identical compiled GoogleTest artifact and run it in Safari.
npm run device:units -- device-unit-evidence
```

The device command requires an HTTPS, cross-origin-isolated page to already be open in Safari. It injects local JS/Wasm/ELF blobs through the USB inspector connection, renders on the device, reads back the raw WebGPU target, applies the cube acceptance checks, and saves `report.json`, `frame.png`, and `page.png`. No emulation or rendering is performed in the cloud.

## Importing firmware and games from the same origin

`storage.html` can fill the origin-private file system without a file picker
by downloading from `/library/` on the page's own origin:

- `scripts/serve-library.mjs` (`npm run library:serve`, port 4181, systemd user
  unit `rpcs3-web-library.service`) serves an allowlist of files with exact HTTP
  Range semantics (`206`/`416`, `Accept-Ranges`, strong ETags, `HEAD`),
  `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`, and a
  JSON index carrying each file's size and SHA-256 (hashed in the background and
  cached under `~/.cache/rpcs3-web-library/`). On https://rpcs3.appmana.com the
  Ingress routes `/library/` to it; `vite preview`/`vite dev` proxy the prefix.
- `public/library-import-worker.mjs` fetches 16 MiB ranges with
  `cache: "no-store"`, writes every body read straight into a
  `FileSystemSyncAccessHandle` (Safari has no `createWritable`), and hashes it
  as it goes (`library-import-core.mjs`: resumable SHA-256 in wasm with a
  JavaScript fallback, both checked against Node's digest). A sidecar
  `.rpcs3-imports/<destination>/<name>.json` records the source size/SHA-256/ETag
  and the running hash state, so an interrupted import resumes from the bytes
  already on disk (`Range: bytes=<size>-`), re-hashing any unrecorded tail
  locally, and a changed source restarts from zero.
- Page API: `window.__rpcs3Storage.importFromLibrary(name, destination)` returns
  a report (bytes, elapsed, rate, requests, resume point, SHA-256 verdict,
  `navigator.storage.estimate()` before and after); `importProgress()` and
  `abortImport()` support pollers. `storage.html?import=<name>&destination=games|firmware`
  starts one on load.
- `npm run device:library -- https://rpcs3.appmana.com/ <outDir> <name> [destination] [--interrupt-after S]`
  drives the same API on the attached iPad over the WebKit Inspector Protocol
  and writes `report.json`; `--interrupt-after` reloads the page mid-transfer
  and proves the resume.

WebKit accounts OPFS quota by sync-access-handle capacity, which grows in
powers of two below 256 MiB and in 128 MiB steps above, and does not shrink
when a file is deleted within the session, so `estimate().usage` overstates
small files; `truncate()` to a target size requests the next power of two, so
the worker never pre-sizes files.

## Current limits

- The full RPCS3 runtime can capture successive coherent frames on demand; a continuous presentation scheduler and pad input still need to be connected to this path.
- The WGSL translators implement the shader and render-state subsets exercised by the triangle and cube, not arbitrary RSX programs.
- The native SPU analyser tests currently instantiate AsmJIT directly. They are not in the browser unit allowlist until the analyser is separated from that native-code factory or the Web interpreter exposes the same analyser implementation.
- Surface aliasing, synchronization, stencil, broader texture formats, culling, and many blend/depth modes remain incomplete.
- Firmware 4.93 is installed and verified in an isolated native oracle profile, but firmware-backed browser boot and commercial titles are not supported yet.
- The Linux host's strict hardware lane is currently blocked by an NVIDIA kernel/userspace version mismatch. Chrome consequently selects SwiftShader and native Vulkan selects llvmpipe until the host is rebooted with the matching driver.
