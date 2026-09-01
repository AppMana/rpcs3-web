#!/usr/bin/env bash
# Builds the freestanding SHA-256 module used by the library import worker and
# prints the base64 that web/public/library-import-core.mjs embeds.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clang="${RPCS3_CLANG:-$(command -v clang-22 || command -v /usr/lib/llvm-22/bin/clang || command -v clang)}"
out="${1:-${TMPDIR:-/tmp}/sha256_wasm.wasm}"
"$clang" --target=wasm32 -O3 -nostdlib -ffreestanding -fno-builtin -Wall -Wextra \
  -Wl,--no-entry -Wl,--export-memory -Wl,--strip-all -Wl,--initial-memory=1441792 -Wl,-z,stack-size=32768 \
  -o "$out" "$here/../host/sha256/sha256_wasm.c"
ls -l "$out" >&2
base64 -w0 "$out"
echo
