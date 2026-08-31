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

## Current limits

- The full RPCS3 runtime can capture successive coherent frames on demand; a continuous presentation scheduler and pad input still need to be connected to this path.
- The WGSL translators implement the shader and render-state subsets exercised by the triangle and cube, not arbitrary RSX programs.
- The native SPU analyser tests currently instantiate AsmJIT directly. They are not in the browser unit allowlist until the analyser is separated from that native-code factory or the Web interpreter exposes the same analyser implementation.
- Surface aliasing, synchronization, stencil, broader texture formats, culling, and many blend/depth modes remain incomplete.
- Firmware 4.93 is installed and verified in an isolated native oracle profile, but firmware-backed browser boot and commercial titles are not supported yet.
- The Linux host's strict hardware lane is currently blocked by an NVIDIA kernel/userspace version mismatch. Chrome consequently selects SwiftShader and native Vulkan selects llvmpipe until the host is rebooted with the matching driver.
