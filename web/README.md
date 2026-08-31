# RPCS3 browser bring-up

This directory is an executable feasibility harness for local PS3 homebrew in a browser. It is not a general RPCS3 WebGPU renderer yet.

The current vertical slice loads an unmodified PPU ELF, interprets the PPU in Wasm, services the small LV2/PRX surface used by the fixtures, captures the guest `cellGcm` FIFO, and translates the fixture's RSX vertex-program subset to WebGPU. The live Tetris gate keeps the Wasm runtime resident, advances one guest flip at a time, translates the five-instruction color/`DP4` vertex program, converts RSX quads and line loops, and feeds touch, keyboard, or Gamepad state back through `cellPadGetData`.

This does **not** yet implement arbitrary RSX vertex/fragment microcode, textures, render-target aliasing, synchronization, SPUs, firmware, or commercial games. It is a real guest-execution path with a deliberately fixture-scoped graphics translator.

## Memory model

The PS3 does not have 8 GB of physical RAM. It has 256 MB of XDR main memory and 256 MB of RSX local memory. Cell uses 64-bit registers and effective addresses, while ordinary PS3 user processes expose mapped regions and GPU apertures rather than 8 GB of simultaneously resident storage.

The browser core therefore does not allocate a flat guest image. `guest_memory` currently models a 4 GB effective-address space with a page table; mappings allocate metadata, and a 4 KiB backing page becomes resident only when written. The 249 MB RSX aperture is consequently cheap while sparse. The Wasm module currently grows up to 512 MB.

A broader emulator should keep this paged model, add eviction/resource residency for RSX data, and use chunked backing stores or Wasm Memory64 for any guest addresses outside the 32-bit PS3 process map. It should not make GPU apertures synonymous with resident Wasm memory.

## Validation

```sh
# Native PPU/HLE/GCM tests, including a sustained Tetris session
cmake --build ../build-web-native -j2
ctest --test-dir ../build-web-native --output-on-failure

# Wasm, TypeScript, deterministic browser tests
npm run build:core
npm run build
npm test
npm run test:e2e

# Local Chrome 150 + Vulkan hardware lane
npm run test:e2e:gpu
```

The GPU lane uses the system Chrome and the Linux headless flags recommended by Chrome's WebGPU documentation. It requires a real adapter, at least 30 guest flips, expected RSX draw/vertex counts, adapter metadata, and a mapped texture readback containing both the guest clear color and rasterized pixels.
