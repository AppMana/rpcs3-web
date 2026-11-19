import assert from 'node:assert/strict';
import { it as test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPpuAotBundle } from '../public/rpcs3-ppu-aot-table.mjs';
import { loadSpuAotBundle } from '../public/rpcs3-spu-aot-table.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureFile = rel => resolve(repoRoot, 'web/public', rel);

test('prebuilt PPU ownership survives later SPU placement and worker role changes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const rel = new URL(input).pathname.replace(/^\//, '');
    assert.ok(rel.startsWith('fixtures/'));
    return new Response(readFileSync(fixtureFile(rel)), { headers: {
      'Content-Type': rel.endsWith('.wasm') ? 'application/wasm' : 'application/json',
    } });
  };
  try {
    const layouts = {};
    const worker = new class extends EventTarget {
      postMessage(message) {
        const [key, load] = Object.entries(message)[0];
        layouts[key] = load;
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: { [`${key}Ready`]: 0 } })));
      }
    }();
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
    const table = new WebAssembly.Table({ initial: 16, element: 'anyfunc' });
    const exports = new Proxy({ __indirect_function_table: table }, { get: (target, name) => target[name] ?? (() => 1024) });
    let heap = 1 << 20;
    const module = { _malloc(size) { const result = heap; heap = (heap + size + 15) & ~15; return result; }, _free() {},
      ccall() { return 1; }, PThread: { unusedWorkers: [worker], pthreads: {}, loadWasmModuleToWorker() {}, returnWorkerToPool() {} } };
    const prefix = readFileSync(resolve(repoRoot, 'web/host/rpcs3_web_pre.js'), 'utf8').split('// Direct WebGPU backend support')[0];
    new Function('Module', 'wasmExports', 'wasmMemory', 'self', prefix)(module, exports, memory, {});
    const common = { module, mainInstance: { exports }, mainMemory: memory, readyTimeoutMs: 10 };
    const ppu = await loadPpuAotBundle({ ...common, manifestUrl: 'https://rpcs3.test/fixtures/web_dispatch_conformance-return.manifest.json' });
    const spu = await loadSpuAotBundle({ ...common, manifestUrl: 'https://rpcs3.test/fixtures/web_dispatch_conformance-spu-aot.manifest.json' });
    assert.ok(ppu.prebuilt);
    assert.ok(spu.tableBase >= ppu.tableBase + ppu.tableSize, 'SPU aliases overlap prebuilt PPU ownership');
    const references = Array.from({ length: spu.tableSize }, (_, i) => table.get(spu.tableBase + i));
    assert.ok(references.some(x => typeof x === 'function'));
    module.rpcs3PopulatePpuAot(layouts.rpcs3PpuAot);
    assert.deepEqual(Array.from({ length: spu.tableSize }, (_, i) => table.get(spu.tableBase + i)), references);
    const ppuReferences = Array.from({ length: ppu.tableSize }, (_, i) => table.get(ppu.tableBase + i));
    module.rpcs3PopulateSpuAot(layouts.rpcs3SpuAot);
    assert.deepEqual(Array.from({ length: ppu.tableSize }, (_, i) => table.get(ppu.tableBase + i)), ppuReferences);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale PPU AOT codegen policies are rejected before table placement', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    version: 1,
    codegen: {
      semanticsVersion: 21,
      returnDispatch: false,
      inlineReads: true,
      inlineWrites: false,
      wasmRegions: true,
    },
    parts: [],
  }), { headers: { 'Content-Type': 'application/json' } });
  const lines = [];
  try {
    const result = await loadPpuAotBundle({
      module: {},
      mainInstance: { exports: {} },
      mainMemory: new WebAssembly.Memory({ initial: 1 }),
      manifestUrl: 'https://rpcs3.test/stale.manifest.json',
      expectedPolicy: {
        semanticsVersion: 22,
        returnDispatch: true,
        inlineReads: true,
        inlineWrites: false,
        wasmRegions: true,
      },
      log: line => lines.push(line),
    });
    assert.equal(result, null);
    assert.match(lines.join('\n'), /rejected stale codegen policy: semanticsVersion=21 \(need 22\), returnDispatch=false \(need true\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
