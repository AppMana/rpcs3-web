#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
emsdk_root="${RPCS3_WEB_EMSDK:-${XDG_CACHE_HOME:-${HOME}/.cache}/emsdk-6.0.8}"

if [[ -f "${emsdk_root}/emsdk_env.sh" ]]; then
  source "${emsdk_root}/emsdk_env.sh" >/dev/null
elif ! command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten is not active and no SDK was found at ${emsdk_root}. Set RPCS3_WEB_EMSDK." >&2
  exit 1
fi

emcmake cmake -S "${repo_root}" -B "${repo_root}/build-web" \
  -DRPCS3_WEB_PROBE=ON \
  -DRPCS3_WEB=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "${repo_root}/build-web" --parallel
