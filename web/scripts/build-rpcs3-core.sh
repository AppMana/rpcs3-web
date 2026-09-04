#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
emsdk_root="${RPCS3_WEB_EMSDK:-${XDG_CACHE_HOME:-${HOME}/.cache}/emsdk-6.0.8}"
build_jobs="${RPCS3_WEB_JOBS:-$(nproc)}"

if [[ -f "${emsdk_root}/emsdk_env.sh" ]]; then
  source "${emsdk_root}/emsdk_env.sh" >/dev/null
elif ! command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten is not active and no SDK was found at ${emsdk_root}. Set RPCS3_WEB_EMSDK." >&2
  exit 1
fi

# Compilation cache: emcc is a Python driver, so the cache wraps the clang it invokes
# (Emscripten's EM_COMPILER_WRAPPER) rather than emcc itself. ccache keys on the preprocessed
# source, so a rebuild after a header touch pays only for the objects whose preprocessed text
# changed. sccache is not an option here: it refuses Emscripten's -Xclang arguments and caches
# nothing. RPCS3_WEB_COMPILER_WRAPPER= disables the wrapper.
if [[ -z "${RPCS3_WEB_COMPILER_WRAPPER+x}" ]]; then
  if command -v ccache >/dev/null 2>&1; then
    RPCS3_WEB_COMPILER_WRAPPER=ccache
  else
    RPCS3_WEB_COMPILER_WRAPPER=
  fi
fi
if [[ -n "${RPCS3_WEB_COMPILER_WRAPPER}" ]]; then
  export EM_COMPILER_WRAPPER="${RPCS3_WEB_COMPILER_WRAPPER}"
fi

# RPCS3_WEB_PROFILE=1 builds the symbolized profiling variant into a separate
# build tree and stages it under web/public/core/profile/. The default build is
# the stripped runtime that the iPad and the acceptance lanes use.
# RPCS3_WEB_JSPI=1 builds the variant whose guest threads can suspend, staged under
# web/public/core/jspi/. The page probes for JavaScript Promise Integration and loads it when the
# browser has it, falling back to the core beside it.
jspi_flag=OFF
if [[ "${RPCS3_WEB_PROFILE:-0}" == "1" ]]; then
  build_dir="${repo_root}/build-rpcs3-web-profile"
  stage_dir="${repo_root}/web/public/core/profile"
  profile_flag=ON
  targets=(rpcs3_web_runtime)
elif [[ "${RPCS3_WEB_JSPI:-0}" == "1" ]]; then
  build_dir="${repo_root}/build-rpcs3-web-jspi"
  stage_dir="${repo_root}/web/public/core/jspi"
  profile_flag=OFF
  jspi_flag=ON
  targets=(rpcs3_web_runtime)
else
  build_dir="${repo_root}/build-rpcs3-web"
  stage_dir="${repo_root}/web/public/core"
  profile_flag=OFF
  targets=(rpcs3_web_runtime rpcs3_web_unit_tests)
fi

# The browser LLVM tiers' compiler module builds when an Emscripten LLVM+lld tree is available
# (RPCS3_WEB_LLVM_DIR, default ~/llvm-wasm/build-wasm; see PLAN.md for the build recipe). It is not
# part of the suspending build: it runs in its own worker and never suspends, and the LLVM archives
# are built with Emscripten's own longjmp, which that build's -sSUPPORT_LONGJMP=wasm cannot resolve.
# The page loads the one module beside the core in either case.
llvm_dir="${RPCS3_WEB_LLVM_DIR:-${HOME}/llvm-wasm/build-wasm}"
if [[ -f "${llvm_dir}/lib/cmake/llvm/LLVMConfig.cmake" && "${profile_flag}" == "OFF" && "${jspi_flag}" == "OFF" ]]; then
  targets+=(rpcs3_web_spu_llvm)
else
  llvm_dir=""
fi

# RPCS3_WEB_FAST_LINK=1 links at -O1 for correctness iterations (never for measurements);
# RPCS3_WEB_TARGETS="rpcs3_web_runtime" limits the build to the module being iterated on.
fast_link="${RPCS3_WEB_FAST_LINK:-0}"
if [[ "${fast_link}" == "1" ]]; then fast_link=ON; else fast_link=OFF; fi
if [[ -n "${RPCS3_WEB_TARGETS:-}" ]]; then
  read -r -a targets <<< "${RPCS3_WEB_TARGETS}"
fi

# Ninja schedules the ~900 objects far better than the Makefiles generator and rebuilds only what
# changed; a tree configured with another generator is reconfigured from scratch (the objects come
# back from the compilation cache). Configure runs only when the tree is missing or an option
# changed: every configure regenerates third-party headers (wolfssl's config.h among them), which
# recompiles their dependents and relinks every module.
cache_value() { grep -E "^$1:[A-Z]+=" "${build_dir}/CMakeCache.txt" 2>/dev/null | head -1 | cut -d= -f2-; }
if [[ -f "${build_dir}/CMakeCache.txt" ]] && ! grep -q "^CMAKE_GENERATOR:INTERNAL=Ninja$" "${build_dir}/CMakeCache.txt"; then
  echo "Reconfiguring ${build_dir} with Ninja" >&2
  rm -rf "${build_dir}"
fi
if [[ ! -f "${build_dir}/build.ninja" \
   || "$(cache_value RPCS3_WEB_LLVM_DIR)" != "${llvm_dir}" \
   || "$(cache_value RPCS3_WEB_FAST_LINK)" != "${fast_link}" \
   || "$(cache_value RPCS3_WEB_PROFILE)" != "${profile_flag}" \
   || "$(cache_value RPCS3_WEB_JSPI)" != "${jspi_flag}" ]]; then
  # No C++ modules here: the Ninja generator's module dependency scan (emscan-deps) fails on the
  # emdawnwebgpu port headers and would only add a pass over every source
  emcmake cmake -S "${repo_root}" -B "${build_dir}" -G Ninja \
    -DRPCS3_WEB=ON \
    -DRPCS3_WEB_PROFILE="${profile_flag}" \
    -DRPCS3_WEB_JSPI="${jspi_flag}" \
    -DRPCS3_WEB_LLVM_DIR="${llvm_dir}" \
    -DRPCS3_WEB_FAST_LINK="${fast_link}" \
    -DCMAKE_CXX_SCAN_FOR_MODULES=OFF \
    -DCMAKE_BUILD_TYPE=Release
fi
cmake --build "${build_dir}" --target "${targets[@]}" --parallel "${build_jobs}"
if [[ "${RPCS3_WEB_COMPILER_WRAPPER}" == "ccache" ]]; then
  ccache -s | grep -E "Hits|Misses" | head -2 || true
fi
mkdir -p "${stage_dir}"
stage() {
  if [[ -f "${build_dir}/bin/$1" ]]; then
    cmake -E copy_if_different "${build_dir}/bin/$1" "${stage_dir}/$1"
  fi
}
stage rpcs3-web.mjs
stage rpcs3-web.wasm
if [[ "${profile_flag}" == "OFF" && "${jspi_flag}" == "OFF" ]]; then
  stage rpcs3-web-units.mjs
  stage rpcs3-web-units.wasm
fi
if [[ -n "${llvm_dir}" ]]; then
  stage rpcs3-spu-llvm.mjs
  stage rpcs3-spu-llvm.wasm
fi
ls -l "${stage_dir}/rpcs3-web.wasm"
