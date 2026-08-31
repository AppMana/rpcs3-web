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

emcmake cmake -S "${repo_root}" -B "${repo_root}/build-rpcs3-web" \
  -DRPCS3_WEB=ON \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "${repo_root}/build-rpcs3-web" --target rpcs3_web_runtime rpcs3_web_unit_tests --parallel "${build_jobs}"
mkdir -p "${repo_root}/web/public/core"
cmake -E copy_if_different "${repo_root}/build-rpcs3-web/bin/rpcs3-web.mjs" "${repo_root}/web/public/core/rpcs3-web.mjs"
cmake -E copy_if_different "${repo_root}/build-rpcs3-web/bin/rpcs3-web.wasm" "${repo_root}/web/public/core/rpcs3-web.wasm"
cmake -E copy_if_different "${repo_root}/build-rpcs3-web/bin/rpcs3-web-units.mjs" "${repo_root}/web/public/core/rpcs3-web-units.mjs"
cmake -E copy_if_different "${repo_root}/build-rpcs3-web/bin/rpcs3-web-units.wasm" "${repo_root}/web/public/core/rpcs3-web-units.wasm"
