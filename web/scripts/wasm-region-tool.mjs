import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function ensureWasmRegionTool() {
  if (process.env.RPCS3_WASM_REGION_TOOL) return process.env.RPCS3_WASM_REGION_TOOL;
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const llvmConfig = process.env.RPCS3_LLVM_CONFIG || '/usr/lib/llvm-22/bin/llvm-config';
  const compiler = process.env.RPCS3_CLANGXX || '/usr/lib/llvm-22/bin/clang++';
  const flags = execFileSync(llvmConfig, ['--cxxflags', '--ldflags', '--system-libs', '--libs', 'core', 'irreader', 'passes', 'transformutils', 'webassemblycodegen', 'webassemblyasmparser', 'webassemblydesc', 'webassemblyinfo', 'codegen', 'target', 'mc', 'support'], { encoding: 'utf8' }).trim().split(/\s+/);
  const hash = createHash('sha256').update(compiler).update(flags.join('\0'))
    .update(execFileSync(llvmConfig, ['--version']));
  for (const name of ['web/host/wasm-region-tool.cpp', 'Utilities/WasmRegion.h', 'Utilities/WasmCallPolicy.h', 'Utilities/WasmStubMap.h', 'Utilities/WasmSimdPolicy.h']) hash.update(readFileSync(join(root, name)));
  const directory = join(homedir(), '.cache/rpcs3-web-tools');
  mkdirSync(directory, { recursive: true });
  const output = join(directory, `wasm-region-${hash.digest('hex')}`);
  if (!existsSync(output)) {
    const temporary = `${output}.${process.pid}`;
    execFileSync(compiler, [join(root, 'web/host/wasm-region-tool.cpp'), ...flags, '-std=c++20', '-O2', '-o', temporary], { stdio: 'inherit' });
    renameSync(temporary, output);
  }
  return output;
}
