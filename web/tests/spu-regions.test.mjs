import assert from 'node:assert/strict';
import { it as test, afterAll as after } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitSpuRegion, selectSpuRegions } from '../scripts/spu-regions.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rpcs3-linked-spu-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const region = { id: 'abcdef12', symbol: '__spu-rxabcdef12', aliases: 'rpcs3_spu_region_aliases_abcdef12', members: [
  { symbol: '__spu-0x01000-abc', pc: 0x1000, blocks: 2, instructions: 4 },
  { symbol: '__spu-0x02000-def', pc: 0x2000, blocks: 2, instructions: 4 },
] };
writeFileSync(join(scratch, 'region.c'), emitSpuRegion(region));
let fixtureSource = readFileSync(resolve(repoRoot, 'web/tests/fixtures/spu-chain.c'), 'utf8');
for (const [letter, member] of [['a', region.members[0]], ['b', region.members[1]]]) {
  fixtureSource = fixtureSource.replace(`void chain_program_${letter}(uint32_t thread, uint32_t ls, uint64_t unused)`,
    `void chain_program_${letter}(void* thread, void* ls, uint64_t unused) __asm__("${member.symbol}");\nvoid chain_program_${letter}(void* thread, void* ls, uint64_t unused)`);
}
// A real imported helper can mutate code, state, or publication between entries.
fixtureSource = 'extern void observe(void*, void*);\n' + fixtureSource.replace('++t->executions;', '++t->executions;\n\tobserve(t, (void*)(uintptr_t)ls);');
fixtureSource = fixtureSource.replace('++t->executions;', 'if (t->pc != 0x1000) { ++t->failures; return; }\n\t++t->executions;')
  .replace('if (t->mode != 2) t->pc = 0x2000;', 'if (t->mode != 2) t->pc = t->mode >= 5 ? 0x3000 : 0x2000;');
fixtureSource += '\nvoid chain_program_c(void* thread, void* ls, uint64_t unused) { struct thread* t = thread; if (t->mode == 6) { ++t->failures; return; } ++t->executions; if (t->mode != 8) t->pc = 0x1000; if (t->mode == 7) t->state = 1; }\n';
writeFileSync(join(scratch, 'programs.c'), fixtureSource);
writeFileSync(join(scratch, 'chain.c'), readFileSync(resolve(repoRoot, 'web/host/spu/chain.c')));
for (const name of ['region', 'programs', 'chain']) execFileSync('/usr/lib/llvm-22/bin/clang', [
  '--target=wasm32-unknown-unknown', '-O2', '-ffreestanding', '-matomics', '-mbulk-memory', '-fPIC',
  '-I', resolve(repoRoot, 'web/host/spu'), '-S', '-emit-llvm', join(scratch, `${name}.c`), '-o', join(scratch, `${name}.ll`),
]);
execFileSync('/usr/lib/llvm-22/bin/llvm-link', [join(scratch, 'programs.ll'), join(scratch, 'region.ll'), join(scratch, 'chain.ll'), '-S', '-o', join(scratch, 'linked.ll')]);
const lowered = JSON.parse(execFileSync(process.execPath, [resolve(repoRoot, 'web/scripts/compile-ppu-ir-to-wasm.mjs'), join(scratch, 'linked.ll'), join(scratch, 'linked.wasm'), '--pic', '--export-all', '--regions', '--direct-exits'], { encoding: 'utf8' }));
const module = new WebAssembly.Module(readFileSync(join(scratch, 'linked.wasm')));
function fixture({ mode = 0, budget = 5, target = 1, mutate = () => {} } = {}) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
  const words = new Uint32Array(memory.buffer);
  const context = 256, thread = 64, ls = 128, lists = 65536, cache = 400000;
  const table = new WebAssembly.Table({ initial: 4, element: 'anyfunc' });
  const instance = new WebAssembly.Instance(module, { env: { memory, __indirect_function_table: table, __memory_base: 1024, __table_base: 0,
    observe(t, l) { mutate({ words, thread: t, ls: l, lists, cache }); },
  } });
  instance.exports.__wasm_init_memory?.();
  instance.exports.__wasm_apply_data_relocs?.();
  words.set([1, 2], instance.exports[region.aliases]() / 4);
  table.set(1, instance.exports[region.members[0].symbol]);
  table.set(2, instance.exports[region.members[1].symbol]);
  table.set(3, instance.exports.chain_program_c);
  words.set([target === 2 ? 0x2000 : 0x1000, 0, 0, 0, 0, mode, 0], thread / 4);
  words.set([thread, thread + 8, thread + 16, lists, cache, 1, 4, target, budget, 0, 0], context / 4);
  for (const [pc, address, index] of [[0x1000, 500000, 1], [0x2000, 500016, 2], [0x3000, 500032, 3]]) {
    const word = pc >>> 2;
    words[lists / 4 + word] = address;
    words.set([1, index], address / 4);
    words.set([address, 0], cache / 4 + ((word ^ (word >>> 8)) & 4095) * 2);
  }
  return { words, thread, context, run() {
    instance.exports[region.symbol](thread, ls, BigInt(context));
    return { completed: words[context / 4 + 9], reason: words[context / 4 + 10],
      pc: words[thread / 4], executions: words[thread / 4 + 6], failures: words[thread / 4 + 2] };
  } };
}
test('both original entries run a bounded direct region with local fallback', () => {
  assert.ok(lowered.regions[0].linkedCalls >= 2);
  assert.equal(WebAssembly.Module.imports(module).some(x => x.kind === 'function' && x.name !== 'observe'), false);
  for (const target of [1, 2]) assert.equal(fixture({ target, budget: 100000 }).run().completed, 100000);
  assert.equal(fixture({ budget: 0 }).run().executions, 0);
  assert.equal(fixture({ target: 3 }).run().reason, 5);
});
test('rejected downstream code retains prior progress and code is reread', () => {
  for (const mode of [1, 4]) assert.deepEqual(fixture({ mode }).run(), { completed: 1, reason: 1, pc: 0x2000, executions: 1, failures: 1 });
  assert.equal(fixture({ target: 2, mode: 1 }).run().completed, 0);
  const changed = fixture({ mutate({ words, ls, thread }) { if (words[thread / 4 + 6] === 3) words[ls / 4] = 1; } });
  assert.equal(changed.run().completed, 3);
});
test('state, interpreter, publication, and cache guards take explicit exits', () => {
  assert.equal(fixture({ mode: 2 }).run().reason, 2);
  assert.equal(fixture({ mode: 3 }).run().reason, 3);
  const publication = fixture({ mutate({ words, lists }) { Atomics.store(words, lists / 4 + 0x2000 / 4, 500032); } });
  assert.equal(publication.run().reason, 4);
  const stale = fixture();
  stale.words[500016 / 4 + 1] = 1;
  assert.equal(stale.run().completed, 1);
});
test('region selection bounds duplication and rejects uncertain or oversized edges', () => {
  const [a, b] = region.members;
  const profile = { edges: [{ from: a, to: b, samples: 100, observedSourceShare: 1 }] };
  const catalog = new Map(region.members.map(x => [x.symbol, x]));
  assert.equal(selectSpuRegions(profile, catalog).length, 1);
  assert.equal(selectSpuRegions({ edges: [...profile.edges, ...profile.edges] }, catalog).length, 1);
  assert.equal(selectSpuRegions({ edges: [{ ...profile.edges[0], observedSourceShare: 0.5 }] }, catalog).length, 0);
  assert.equal(selectSpuRegions(profile, new Map([[a.symbol, { ...a, instructions: 513 }], [b.symbol, b]])).length, 0);
});

test('worker population shares immutable aliases and installs local region functions', async () => {
  const { dylinkInfo } = await import('../public/wasm-dylink.mjs');
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
  const prefix = readFileSync(resolve(repoRoot, 'web/host/rpcs3_web_pre.js'), 'utf8').split('// Direct WebGPU backend support')[0];
  const populate = new Function('Module', 'wasmExports', 'wasmMemory', 'self', `${prefix}\nreturn Module.rpcs3PopulateSpuAot;`);
  const info = dylinkInfo(module);
  const part = { module, memoryBase: 1024, memorySize: info.memorySize, elemBase: 0, importsTable: true,
    exportBase: 1, exportCount: 2, regionEntries: [{ ...region, index: 3, targets: [1, 2] }] };
  const load = { tableBase: 1, tableSize: 3, parts: [part], bindings: { observe: 'observe' }, initializeRegionAliases: true };
  const mainTable = new WebAssembly.Table({ initial: 1, element: 'anyfunc' });
  assert.equal(populate({}, { __indirect_function_table: mainTable, observe() {} }, memory, {})(load), 2);
  const inspector = new WebAssembly.Instance(module, { env: { memory, __indirect_function_table: mainTable, __memory_base: 1024, __table_base: 0, observe() {} } });
  const pointer = inspector.exports[region.aliases]();
  const aliases = new Uint32Array(memory.buffer, pointer, 2);
  assert.deepEqual([...aliases], [1, 2]);
  load.initializeRegionAliases = false;
  // Mutated descriptor distinguishes a worker rewrite from the existing values.
  part.regionEntries[0].targets = [2, 1];
  const workerTable = new WebAssembly.Table({ initial: 1, element: 'anyfunc' });
  assert.equal(populate({}, { __indirect_function_table: workerTable, observe() {} }, memory, {})(load), 2);
  assert.deepEqual([...aliases], [1, 2]);
  assert.equal(typeof workerTable.get(3), 'function');
  assert.notEqual(workerTable.get(3), mainTable.get(3));
});


test('leaving a region continues locally for the remaining budget', () => {
  const f = fixture({ mode: 5, budget: 100000 });
  const result = f.run();
  assert.equal(result.completed, 100000);
  assert.equal(result.executions, 100000);
  assert.equal(result.reason, 0);
  assert.equal(f.words[f.context / 4 + 8], 100000);
  assert.equal(f.words[f.context / 4 + 7], 1);
});

test('generic continuation preserves rejection, scheduling, interpretation and ownership exits', () => {
  assert.deepEqual(fixture({ mode: 6 }).run(), { completed: 1, reason: 1, pc: 0x3000, executions: 1, failures: 1 });
  assert.equal(fixture({ mode: 7 }).run().reason, 3);
  assert.equal(fixture({ mode: 8 }).run().reason, 2);
  const foreign = fixture({ mode: 5 });
  foreign.words[foreign.context / 4 + 6] = 3;
  assert.deepEqual(foreign.run(), { completed: 1, reason: 5, pc: 0x3000, executions: 1, failures: 0 });
});
