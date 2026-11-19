# Agent Guidelines (`rpcs3-web`)

## 1. Context Hygiene & Prohibited File Operations
- **NEVER search (`grep`) or read (`read_file`) minified or compiled build artifacts**:
  - Do **NOT** read or grep inside:
    - `web/dist/**`
    - `web/public/core/*.mjs` or `web/public/core/**/*.mjs` (Emscripten-generated minified glue)
    - `web/public/firmware-wasm/**` or `web/public/local-aot/**`
    - `build-*/**`
    - Raw `.cpuprofile`, Chrome `.trace.json`, or multi-megabyte `report.json` files
- **Inspect and edit only human-authored source files**:
  - C++ core & HLE: `rpcs3/**`, `Utilities/**`
  - Static recompiler & SPU/PPU lifters: `ps3recomp/**`
  - Web runtime & workers: `web/src/**`, `web/scripts/**`, `web/public/rpcs3-*.mjs`, `web/public/runtime-smoke-worker.mjs`
- **Keep command & telemetry outputs compact (`< 2 KB`)**:
  - Redirect build and test stdout/stderr to `/tmp/*.log` and inspect only summary lines (`tail -n 20`).
  - Use `gameplay-summary.json`, `*.summary.txt`, and `node web/scripts/query-profile.mjs` to query CPU profiles, Chrome traces, and reports without loading multi-megabyte JSON into context.
- **Targeted `read_file` & Zero Ad-Hoc One-Liners**:
  - Always use `grep -n` to locate exact symbol or line numbers before calling `read_file` with a tight 30–60 line range instead of paging through large files in 200-line chunks.
  - Do **NOT** write ad-hoc inline `node -e` or `python3 -c` scripts; add permanent, reusable CLI flags to `web/scripts/*.mjs` or `ps3recomp`.
  - Do **NOT** use manual `rm -f` or manual `cp` to work around build or cache tooling; rely on content-hash (`sourceHash`) cache invalidation in `ps3recomp` and CMake `POST_BUILD` auto-staging.

## 2. Core Architecture Directives
1. **JSPI Focus**:
   - Target the JSPI build (`build-rpcs3-web-jspi`, `--jspi`, `RPCS3_CORE=jspi`). Do not spend build/test cycles on non-JSPI Asyncify builds unless explicitly requested.
2. **Desktop Wasm == Browser Wasm Parity**:
   - The static recompilation pipeline, HLE backends, and WebGPU renderer must behave identically on native Linux desktop (`node web/scripts/run-desktop-wasm.mjs --jspi` using Dawn Vulkan WebGPU) and in Chrome (`node web/scripts/run-gameplay-sequence.mjs`).
3. **HLE-First Everywhere (PPU & SPU)**:
   - **PPU / Firmware `.sprx`**: Default all firmware modules with C++ HLE implementations to HLE-first (`g_prx_list` / `libraries_control` / `StaticHLE`) so guest code calls host C++ / WebGPU / WebAudio HLE directly via `env.rpcs3_hle_call` instead of executing LLE PowerPC `.sprx` instructions.
   - **SPU HLE + WebGPU Compute (`WGSL`)**:
     - High-level emulate SPU workloads wherever possible (intercepting SDK SPU tasks/codecs/SPURS workloads at the HLE boundary).
     - Compile SPU programs AOT into equivalent **WebGPU Compute Shaders (`WGSL`)** backed by a reusable WGSL SPU shader library (`web/public/rpcs3-spu-wgsl.mjs`) implementing 128-bit SIMD vector intrinsics, Local Store access, DMA staging, and common SPU kernels.
   - **Zero Interpretation**: Keep PPU interpretation at `0` (`ppuInstructions: 0`) and eliminate SPU interpretation through HLE + AOT compilation.
