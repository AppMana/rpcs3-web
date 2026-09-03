#!/usr/bin/env bash
# Builds LLVM (WebAssembly target only) and lld with Emscripten for the browser SPU LLVM tier
# (rpcs3_web_spu_llvm in rpcs3/CMakeLists.txt). Same stripping the browser-clang projects use:
# one backend, no threads, no tools; -pthread so the objects link into the shared-memory module.
#
#   web/scripts/build-llvm-wasm.sh [source-dir] [build-dir]
#
# Defaults: ~/llvm-wasm/llvm-project (cloned at release/22.x if missing) and ~/llvm-wasm/build-wasm.
# The RPCS3 web build picks the tree up through RPCS3_WEB_LLVM_DIR (default ~/llvm-wasm/build-wasm).
set -euo pipefail

source_dir="${1:-${HOME}/llvm-wasm/llvm-project}"
build_dir="${2:-${HOME}/llvm-wasm/build-wasm}"
emsdk_root="${RPCS3_WEB_EMSDK:-${XDG_CACHE_HOME:-${HOME}/.cache}/emsdk-6.0.8}"
jobs="${RPCS3_WEB_JOBS:-$(nproc)}"

if [[ -f "${emsdk_root}/emsdk_env.sh" ]]; then
  source "${emsdk_root}/emsdk_env.sh" >/dev/null
elif ! command -v emcmake >/dev/null 2>&1; then
  echo "Emscripten is not active and no SDK was found at ${emsdk_root}. Set RPCS3_WEB_EMSDK." >&2
  exit 1
fi

if [[ ! -d "${source_dir}/llvm" ]]; then
  git clone --depth 1 --branch release/22.x https://github.com/llvm/llvm-project.git "${source_dir}"
fi

# Native llvm-tblgen from the matching system LLVM keeps the cross build from bootstrapping one
tblgen="${LLVM_TABLEGEN:-/usr/lib/llvm-22/bin/llvm-tblgen}"

emcmake cmake -S "${source_dir}/llvm" -B "${build_dir}" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DLLVM_TARGETS_TO_BUILD=WebAssembly \
  -DLLVM_ENABLE_PROJECTS=lld \
  -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF \
  -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBXML2=OFF -DLLVM_ENABLE_LIBEDIT=OFF -DLLVM_ENABLE_LIBPFM=OFF \
  -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TOOLS=ON -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF -DLLVM_INCLUDE_UTILS=ON -DLLVM_BUILD_UTILS=OFF \
  -DLLVM_ENABLE_BINDINGS=OFF -DLLVM_ENABLE_UNWIND_TABLES=OFF -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF \
  -DLLVM_HOST_TRIPLE=wasm32-unknown-emscripten -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-unknown-unknown \
  -DLLVM_TABLEGEN="${tblgen}" \
  -DCMAKE_CXX_FLAGS="-pthread -Wno-unused-command-line-argument" \
  -DCMAKE_C_FLAGS="-pthread -Wno-unused-command-line-argument"

# The libraries rpcs3_web_spu_llvm links (LLVMConfig.cmake resolves their dependencies)
cmake --build "${build_dir}" -j "${jobs}" --target \
  LLVMWebAssemblyCodeGen LLVMWebAssemblyAsmParser LLVMWebAssemblyDesc LLVMWebAssemblyInfo LLVMWebAssemblyUtils \
  LLVMPasses LLVMCodeGen LLVMTarget LLVMMC LLVMMCParser LLVMCore LLVMSupport LLVMAnalysis LLVMTransformUtils \
  LLVMScalarOpts LLVMipo LLVMInstCombine LLVMVectorize LLVMSelectionDAG LLVMAsmPrinter LLVMBitWriter LLVMBitReader \
  LLVMObject LLVMBinaryFormat LLVMIRReader LLVMAsmParser LLVMLinker LLVMTargetParser LLVMDemangle LLVMRemarks \
  LLVMProfileData LLVMDebugInfoCodeView LLVMDebugInfoDWARF LLVMGlobalISel LLVMCFGuard LLVMAggressiveInstCombine \
  LLVMInstrumentation LLVMObjCARCOpts LLVMCoroutines LLVMHipStdPar LLVMIRPrinter LLVMTextAPI lldWasm lldCommon
