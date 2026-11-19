import assert from 'node:assert/strict';
import { it as test, afterAll as after } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureWasmRegionTool } from '../scripts/wasm-region-tool.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'rpcs3-wasm-regions-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const tool = ensureWasmRegionTool();
const source = `target triple = "wasm32-unknown-unknown"
declare void @observe(ptr)
declare void @reject()
define i32 @__spu-0x100-test(ptr %ctx, ptr %ls, i64 %unused) {
entry:
 %code = load i32, ptr %ls
 %valid = icmp eq i32 %code, 123
 br i1 %valid, label %body, label %bad
bad:
 call void @reject()
 ret i32 -1
body:
 %old = load i32, ptr %ctx
 %new = add i32 %old, 1
 store i32 %new, ptr %ctx
 %result = call i32 @__spu-cx200-test(ptr %ctx)
 %after = load i32, ptr %ctx
 %sum = add i32 %result, %after
 ret i32 %sum
}
define internal i32 @__spu-cx200-test(ptr %ctx) {
 call void @observe(ptr %ctx)
 %value = load i32, ptr %ctx
 %next = add i32 %value, 1
 store i32 %next, ptr %ctx
 ret i32 %next
}
define i32 @__0x300(i32 %n) {
 %done = icmp eq i32 %n, 0
 br i1 %done, label %exit, label %body
exit:
 ret i32 0
body:
 %next = sub i32 %n, 1
 %result = tail call i32 @__0x300(i32 %next)
 ret i32 %result
}
`;
writeFileSync(join(scratch, 'input.ll'), source);
const stats = JSON.parse(execFileSync(tool, [join(scratch, 'input.ll'), join(scratch, 'region.ll')], { encoding: 'utf8' }));
const transformed = readFileSync(join(scratch, 'region.ll'), 'utf8');
const modules = ['input', 'region'].map(name => {
  execFileSync(process.execPath, [resolve(repoRoot, 'web/scripts/compile-ppu-ir-to-wasm.mjs'), join(scratch, `${name}.ll`), join(scratch, `${name}.wasm`), '--pic', '--export-all'], { stdio: 'pipe' });
  return new WebAssembly.Module(readFileSync(join(scratch, `${name}.wasm`)));
});

function run(module, initial, code) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
  const words = new Uint32Array(memory.buffer);
  words[32] = initial;
  words[64] = code;
  const events = [];
  const instance = new WebAssembly.Instance(module, { env: { memory, __memory_base: 0, __table_base: 0,
    observe(pointer) { events.push(words[pointer / 4]); words[pointer / 4] = 20; },
    reject() { events.push('rejected'); },
  } });
  const result = instance.exports['__spu-0x100-test'](128, 256, 0n);
  return { result, state: words[32], events };
}

test('known guest calls become control flow while imported barriers remain', () => {
  assert.equal(stats.linkedCalls, 1);
  const root = transformed.split('define i32 @__spu-0x100-test')[1].split('\n}')[0];
  assert.doesNotMatch(root, /call.*@__spu-cx/);
  assert.match(root, /notail call void @observe/);
  assert.match(root, /notail call void @reject/);
});

test('verification, committed helper state and helper mutations match the old path', () => {
  for (const initial of [0, 17, 0xffffffff]) for (const code of [123, 0]) {
    const expected = run(modules[0], initial, code);
    assert.deepEqual(run(modules[1], initial, code), expected);
    if (code === 123) assert.deepEqual(expected, { result: 42, state: 21, events: [(initial + 1) >>> 0] });
    else assert.deepEqual(expected, { result: -1, state: initial, events: ['rejected'] });
  }
});

test('recursive edges remain bounded in code size and repeated lowering is stable', () => {
  assert.match(transformed, /tail call i32 @__0x300/);
  const second = JSON.parse(execFileSync(tool, [join(scratch, 'region.ll'), join(scratch, 'again.ll')], { encoding: 'utf8' }));
  assert.equal(second.linkedCalls, 0);
});

test('must-tail continuation edges remain separate functions', () => {
  const input = join(scratch, 'musttail.ll'), output = join(scratch, 'musttail-out.ll');
  writeFileSync(input, `define void @__0x500(ptr %ctx) {
  musttail call void @__0x504(ptr %ctx)
  ret void
}
define void @__0x504(ptr %ctx) {
  ret void
}
`);
  const report = JSON.parse(execFileSync(tool, [input, output], { encoding: 'utf8' }));
  assert.equal(report.linkedCalls, 0);
  assert.match(readFileSync(output, 'utf8'), /musttail call void @__0x504/);
});

test('large dispatch fallbacks lower cross-shard import stubs to direct HLE', () => {
  const input = join(scratch, 'hle-stub.ll'), output = join(scratch, 'hle-stub-out.ll');
  const contextFields = Array.from({ length: 167 }, () => 'i64').join(', ');
  writeFileSync(input, `%context_t = type { ${contextFields} }
declare i32 @__hle_call_fnid(ptr, i32, i32)
define void @__0x608214(ptr %0, ptr noalias %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6) {
entry:
  br i1 true, label %no_page, label %have_page
no_page:
  br label %fallback
have_page:
  %index = ptrtoint ptr %3 to i32
  br label %pred
pred:
  br i1 true, label %slot, label %fallback
slot:
  br i1 true, label %call, label %fallback
call:
  %fn = inttoptr i32 %index to ptr
  musttail call void %fn(ptr %0, ptr %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6)
  ret void
fallback:
  %unused_dispatch = phi i32 [ 0, %no_page ], [ %index, %pred ], [ %index, %slot ]
  %cia = getelementptr %context_t, ptr %1, i32 0, i32 166
  store i32 11655788, ptr %cia, align 4
  %r0 = getelementptr %context_t, ptr %1, i32 0, i32 3
  store i64 %4, ptr %r0, align 8
  %r1 = getelementptr %context_t, ptr %1, i32 0, i32 4
  store i64 %5, ptr %r1, align 8
  %r2 = getelementptr %context_t, ptr %1, i32 0, i32 5
  store i64 %6, ptr %r2, align 8
  ret void
}
`);
  const report = JSON.parse(execFileSync(tool, [
    input, output,
    '--stub', 'b1da6c:c6c7a0:1bc200f4',
  ], { encoding: 'utf8' }));
  assert.equal(report.stubCalls, 1);
  assert.match(readFileSync(output, 'utf8'), /call i32 @__hle_call_fnid/);
});

test('self import stubs lower after large dispatch fallback canonicalization', () => {
  const input = join(scratch, 'hle-self-stub.ll'), output = join(scratch, 'hle-self-stub-out.ll');
  const contextFields = Array.from({ length: 167 }, () => 'i64').join(', ');
  writeFileSync(input, `%context_t = type { ${contextFields} }
declare i32 @__hle_call_fnid(ptr, i32, i32)
define void @__0xb1dacc(ptr %0, ptr noalias %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6) {
entry:
  br i1 true, label %no_page, label %have_page
no_page:
  br label %fallback
have_page:
  %index = ptrtoint ptr %3 to i32
  br label %pred
pred:
  br i1 true, label %slot, label %fallback
slot:
  br i1 true, label %call, label %fallback
call:
  %fn = inttoptr i32 %index to ptr
  musttail call void %fn(ptr %0, ptr %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6)
  ret void
fallback:
  %unused_dispatch = phi i32 [ 0, %no_page ], [ %index, %pred ], [ %index, %slot ]
  %cia = getelementptr %context_t, ptr %1, i32 0, i32 166
  store i32 11655884, ptr %cia, align 4
  %r0 = getelementptr %context_t, ptr %1, i32 0, i32 3
  store i64 %4, ptr %r0, align 8
  %r1 = getelementptr %context_t, ptr %1, i32 0, i32 4
  store i64 %5, ptr %r1, align 8
  %r2 = getelementptr %context_t, ptr %1, i32 0, i32 5
  store i64 %6, ptr %r2, align 8
  ret void
}
`);
  const report = JSON.parse(execFileSync(tool, [
    input, output,
    '--stubs-only',
    '--stub', 'b1dacc:c6c7ac:2f85c0ef',
  ], { encoding: 'utf8' }));
  assert.equal(report.stubCalls, 1);
  const lowered = readFileSync(output, 'utf8');
  assert.match(lowered, /call i32 @__hle_call_fnid/);
});

test('self import stubs lower with the page-test dispatch CFG', () => {
  const input = join(scratch, 'hle-self-page-cfg.ll'), output = join(scratch, 'hle-self-page-cfg-out.ll');
  const contextFields = Array.from({ length: 167 }, () => 'i64').join(', ');
  writeFileSync(input, `%context_t = type { ${contextFields} }
declare i32 @__hle_call_fnid(ptr, i32, i32)
define void @__0xb1df0c(ptr %0, ptr noalias %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6) {
entry:
  br i1 true, label %no_page, label %have_page
no_page:
  br label %fallback
have_page:
  %index = ptrtoint ptr %3 to i32
  br i1 true, label %call, label %fallback
call:
  %fn = inttoptr i32 %index to ptr
  musttail call void %fn(ptr %0, ptr %1, i64 %2, ptr %3, i64 %4, i64 %5, i64 %6)
  ret void
fallback:
  %unused_dispatch = phi i32 [ 0, %no_page ], [ %index, %have_page ]
  %cia = getelementptr %context_t, ptr %1, i32 0, i32 166
  store i32 11656972, ptr %cia, align 4
  %r0 = getelementptr %context_t, ptr %1, i32 0, i32 3
  store i64 %4, ptr %r0, align 8
  %r1 = getelementptr %context_t, ptr %1, i32 0, i32 4
  store i64 %5, ptr %r1, align 8
  %r2 = getelementptr %context_t, ptr %1, i32 0, i32 5
  store i64 %6, ptr %r2, align 8
  ret void
}
`);
  const report = JSON.parse(execFileSync(tool, [
    input, output,
    '--stubs-only',
    '--stub', 'b1df0c:c6c828:718bf5f8',
  ], { encoding: 'utf8' }));
  assert.equal(report.stubCalls, 1);
  const lowered = readFileSync(output, 'utf8');
  assert.match(lowered, /call i32 @__hle_call_fnid/);
  assert.match(lowered, /musttail call void %fn/);
});

test('large callees stay outside the region budget', () => {
  const large = `define void @__0x400(ptr %p) { call void @__0x404(ptr %p) ret void }\ndefine internal void @__0x404(ptr %p) {\n${Array.from({ length: 600 }, (_, i) => `%v${i} = load volatile i32, ptr %p`).join('\n')}\nret void\n}`;
  writeFileSync(join(scratch, 'large.ll'), large);
  const report = JSON.parse(execFileSync(tool, [join(scratch, 'large.ll'), join(scratch, 'large-out.ll')], { encoding: 'utf8' }));
  assert.equal(report.linkedCalls, 0);
  assert.ok(report.budgetExits > 0);
});

test('dispatch-marker ABI removes only empty bindings and preserves committed state', () => {
  const input = join(scratch, 'markers.ll'), output = join(scratch, 'markers.wasm');
  writeFileSync(input, `target triple = "wasm32-unknown-unknown"
declare void @spu_dispatch(ptr)
declare ptr @spu_dispatcher()
declare void @__spu-0x100-abc-pp-0(ptr)
declare void @escape(ptr)
define i32 @markers(ptr %ctx, i32 %reject) {
 store i32 8192, ptr %ctx
 %failure = getelementptr i32, ptr %ctx, i32 1
 store i32 %reject, ptr %failure
 call void @spu_dispatch(ptr %ctx)
 call void @__spu-0x100-abc-pp-0(ptr %ctx)
 %address = call ptr @spu_dispatcher()
 call void @escape(ptr %ctx)
 %result = ptrtoint ptr %address to i32
 ret i32 %result
}`);
  const report = JSON.parse(execFileSync(process.execPath, [resolve(repoRoot, 'web/scripts/compile-ppu-ir-to-wasm.mjs'), input, output, '--pic', '--export-all', '--direct-exits'], { encoding: 'utf8' }));
  assert.equal(report.regions[0].directExits, 3);
  const module = new WebAssembly.Module(readFileSync(output));
  assert.deepEqual(WebAssembly.Module.imports(module).filter(x => x.kind === 'function').map(x => x.name), ['escape']);
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 32768, shared: true });
  const words = new Uint32Array(memory.buffer), observed = [];
  const instance = new WebAssembly.Instance(module, { env: { memory, __memory_base: 0, __table_base: 0,
    escape(pointer) { observed.push([...words.slice(pointer / 4, pointer / 4 + 2)]); words[pointer / 4] = 12288; },
  } });
  assert.equal(instance.exports.markers(256, 1), 0);
  assert.deepEqual(observed, [[8192, 1]]);
  assert.equal(words[64], 12288);
});
