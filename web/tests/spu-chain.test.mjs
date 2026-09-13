import assert from 'node:assert/strict';
import { it as test, afterAll as after } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rpcs3-spu-chain-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const clang = process.env.RPCS3_CLANG || '/usr/lib/llvm-22/bin/clang';
const inputs = ['web/host/spu/chain.c', 'web/tests/fixtures/spu-chain.c'];
const ir = inputs.map((source, i) => {
  const output = join(scratch, `${i}.ll`);
  execFileSync(clang, ['--target=wasm32-unknown-unknown', '-O2', '-ffreestanding',
    '-DRPCS3_SPU_CHAIN_PROFILE=1',
    '-matomics', '-mbulk-memory', '-fPIC', '-S', '-emit-llvm', resolve(root, source), '-o', output]);
  return output;
});
const output = join(scratch, 'chain.wasm');
execFileSync(process.execPath, [resolve(root, 'web/scripts/compile-ppu-ir-to-wasm.mjs'), ...ir,
  output, '--pic', '--export-all'], { stdio: 'pipe' });
const compiled = new WebAssembly.Module(readFileSync(output));

function fixture({ mode = 0, budget = 5, target = 1, end = 3, profile = false } = {}) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
  const table = new WebAssembly.Table({ initial: 4, element: 'anyfunc' });
  const instance = new WebAssembly.Instance(compiled, { env: { memory,
    __indirect_function_table: table, __memory_base: 0, __table_base: 0 } });
  table.set(1, instance.exports.chain_program_a);
  table.set(2, instance.exports.chain_program_b);
  const words = new Uint32Array(memory.buffer);
  const context = 256, thread = 64, ls = 128, lists = 65536, cache = 400000;
  words.set([0x1000, 0, 0, 0, 0, mode, 0], thread / 4);
  words.set([thread, thread + 8, thread + 16, lists, cache, 1, end, target, budget, 0, 0], context / 4);
  const edges = 620000;
  words[context / 4 + 11] = edges;
  for (const [pc, address, index] of [[0x1000, 500000, 1], [0x2000, 500016, 2]]) {
    const word = pc >>> 2;
    words[lists / 4 + word] = address;
    words.set([1, index], address / 4);
    words.set([address, 0], cache / 4 + ((word ^ (word >>> 8)) & 4095) * 2);
  }
  return { words, context, thread, ls, lists, cache,
    edges: new BigUint64Array(memory.buffer, edges, 4097 * 2),
    run() {
      instance.exports[profile ? 'rpcs3_spu_run_chain_profile' : 'rpcs3_spu_run_chain'](thread, ls, BigInt(context));
      return { completed: words[context / 4 + 9], reason: words[context / 4 + 10],
        pc: words[thread / 4], executions: words[thread / 4 + 6], failures: words[thread / 4 + 2] };
    } };
}

test('bounded same-instance cycles return without an interpreter handoff', () => {
  assert.deepEqual(fixture({ budget: 6 }).run(), { completed: 6, reason: 0, pc: 0x1000, executions: 6, failures: 0 });
  assert.equal(fixture({ budget: 100000 }).run().completed, 100000);
  assert.equal(fixture({ budget: 0 }).run().executions, 0);
});

test('downstream verification failure preserves earlier progress, including self-modification', () => {
  for (const mode of [1, 4]) assert.deepEqual(fixture({ mode }).run(),
    { completed: 1, reason: 1, pc: 0x2000, executions: 1, failures: 1 });
  const first = fixture({ mode: 1, target: 2 });
  first.words[first.thread / 4] = 0x2000;
  assert.equal(first.run().completed, 0);
});

test('same-entry handoff and scheduling state stop the chain', () => {
  assert.deepEqual(fixture({ mode: 2 }).run(), { completed: 1, reason: 2, pc: 0x1000, executions: 1, failures: 0 });
  assert.equal(fixture({ mode: 3 }).run().reason, 3);
  const stopped = fixture();
  stopped.words[stopped.thread / 4 + 4] = 1;
  assert.equal(stopped.run().completed, 0);
});

test('publication and missing preferences return to the owning dispatcher', () => {
  for (const published of [0, 500032]) {
    const f = fixture();
    f.words[f.lists / 4 + (0x2000 >>> 2)] = published;
    assert.deepEqual(f.run(), { completed: 1, reason: 4, pc: 0x2000, executions: 1, failures: 0 });
  }
});

test('module bounds reject even an otherwise callable target', () => {
  assert.deepEqual(fixture({ end: 2 }).run(), { completed: 1, reason: 5, pc: 0x2000, executions: 1, failures: 0 });
  assert.equal(fixture({ target: 3 }).run().executions, 0);
});

test('chain module has no imported host functions', () => {
  assert.deepEqual(WebAssembly.Module.imports(compiled).filter(i => i.kind === 'function'), []);
});

test('edge profiler counts only successful internal transitions', () => {
  const f = fixture({ budget: 100000, profile: true });
  assert.equal(f.run().completed, 100000);
  const counts = new Map();
  for (let i = 0; i < 4096; ++i) if (f.edges[i * 2]) counts.set(f.edges[i * 2], f.edges[i * 2 + 1]);
  assert.deepEqual(counts, new Map([[0x100000002n, 50000n], [0x200000001n, 49999n]]));
  for (const mode of [1, 4]) {
    const failed = fixture({ mode, profile: true });
    assert.equal(failed.run().reason, 1);
    assert.ok(failed.edges.every(value => value === 0n));
  }
});

test('edge profiler bounds collision work and reports dropped samples', () => {
  const f = fixture({ budget: 6, profile: true });
  for (let i = 0; i < 4096; ++i) f.edges[i * 2] = 0xffffffffffffffffn;
  assert.equal(f.run().completed, 6);
  assert.equal(f.edges[4096 * 2 + 1], 5n);
});
