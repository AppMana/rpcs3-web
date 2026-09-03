#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
emsdk_root="${RPCS3_WEB_EMSDK:-${XDG_CACHE_HOME:-${HOME}/.cache}/emsdk-6.0.8}"
build_jobs="${RPCS3_WEB_JOBS:-4}"

if [[ -f "${emsdk_root}/emsdk_env.sh" ]]; then
  source "${emsdk_root}/emsdk_env.sh" >/dev/null
elif ! command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten is not active and no SDK was found at ${emsdk_root}. Set RPCS3_WEB_EMSDK." >&2
  exit 1
fi

# RPCS3_WEB_PROFILE=1 builds the symbolized profiling variant into a separate
# build tree and stages it under web/public/core/profile/. The default build is
# the stripped runtime that the iPad and the acceptance lanes use.
if [[ "${RPCS3_WEB_PROFILE:-0}" == "1" ]]; then
  build_dir="${repo_root}/build-rpcs3-web-profile"
  stage_dir="${repo_root}/web/public/core/profile"
  profile_flag=ON
  targets=(rpcs3_web_runtime)
else
  build_dir="${repo_root}/build-rpcs3-web"
  stage_dir="${repo_root}/web/public/core"
  profile_flag=OFF
  targets=(rpcs3_web_runtime rpcs3_web_unit_tests)
fi

# The browser SPU LLVM tier builds when an Emscripten LLVM+lld tree is available
# (RPCS3_WEB_LLVM_DIR, default ~/llvm-wasm/build-wasm; see PLAN.md for the build recipe).
llvm_dir="${RPCS3_WEB_LLVM_DIR:-${HOME}/llvm-wasm/build-wasm}"
if [[ -f "${llvm_dir}/lib/cmake/llvm/LLVMConfig.cmake" && "${profile_flag}" == "OFF" ]]; then
  targets+=(rpcs3_web_spu_llvm)
else
  llvm_dir=""
fi

emcmake cmake -S "${repo_root}" -B "${build_dir}" \
  -DRPCS3_WEB=ON \
  -DRPCS3_WEB_PROFILE="${profile_flag}" \
  -DRPCS3_WEB_LLVM_DIR="${llvm_dir}" \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "${build_dir}" --target "${targets[@]}" --parallel "${build_jobs}"
mkdir -p "${stage_dir}"
cmake -E copy_if_different "${build_dir}/bin/rpcs3-web.mjs" "${stage_dir}/rpcs3-web.mjs"
cmake -E copy_if_different "${build_dir}/bin/rpcs3-web.wasm" "${stage_dir}/rpcs3-web.wasm"
if [[ "${profile_flag}" == "OFF" ]]; then
  cmake -E copy_if_different "${build_dir}/bin/rpcs3-web-units.mjs" "${stage_dir}/rpcs3-web-units.mjs"
  cmake -E copy_if_different "${build_dir}/bin/rpcs3-web-units.wasm" "${stage_dir}/rpcs3-web-units.wasm"
fi
if [[ -n "${llvm_dir}" ]]; then
  cmake -E copy_if_different "${build_dir}/bin/rpcs3-spu-llvm.mjs" "${stage_dir}/rpcs3-spu-llvm.mjs"
  cmake -E copy_if_different "${build_dir}/bin/rpcs3-spu-llvm.wasm" "${stage_dir}/rpcs3-spu-llvm.wasm"
fi
ls -l "${stage_dir}/rpcs3-web.wasm"
