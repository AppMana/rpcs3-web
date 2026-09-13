import assert from 'node:assert/strict';
import {it as test, afterAll as after} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensureWasmRegionTool} from '../scripts/wasm-region-tool.mjs';
const repoRoot=fileURLToPath(new URL('../../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'rpcs3-simd-'));
after(() => rmSync(dir, {recursive:true, force:true}));
const cases = [
 {name:'first', mask:Array.from({length:16},(_,i)=>15-i)},
 {name:'second', mask:Array.from({length:16},(_,i)=>31-i)},
 {name:'same', same:true, mask:Array.from({length:16},(_,i)=>i%2?i:i+16)},
 {name:'mixed', mask:Array.from({length:16},(_,i)=>i%2?i:i+16)},
 {name:'undefined', mask:Array.from({length:16},(_,i)=>i%3?i:-1)},
];
const source = 'target triple = "wasm32-unknown-unknown"\n'+cases.map(c=>`define void @${c.name}(ptr %a, ptr %b, ptr %out) {
 %x = load <16 x i8>, ptr %a, align 1
 %y = load <16 x i8>, ptr %b, align 1
 %v = shufflevector <16 x i8> %x, <16 x i8> ${c.same?'%x':'%y'}, <16 x i32> <${c.mask.map(i=>i<0?'i32 poison':`i32 ${i}`).join(', ')}>
 store <16 x i8> %v, ptr %out, align 1
 ret void
}`).join('\n');
writeFileSync(join(dir,'input.ll'),source);
const stats = JSON.parse(execFileSync(ensureWasmRegionTool(),[join(dir,'input.ll'),join(dir,'output.ll'),'--no-regions','--unary-swizzles'],{encoding:'utf8'}));
test('unary lowering excludes genuinely mixed sources and is idempotent',()=>{
 assert.equal(stats.unarySwizzles,4);
 const second=JSON.parse(execFileSync(ensureWasmRegionTool(),[join(dir,'output.ll'),join(dir,'again.ll'),'--no-regions','--unary-swizzles'],{encoding:'utf8'}));
 assert.equal(second.unarySwizzles,0);
});
test('emitted Wasm preserves every defined byte for distinct and identical inputs',()=>{
 execFileSync(process.execPath,[resolve(repoRoot,'web/scripts/compile-ppu-ir-to-wasm.mjs'),join(dir,'output.ll'),join(dir,'output.wasm'),'--pic','--export-all']);
 const memory=new WebAssembly.Memory({initial:2,maximum:32768,shared:true});
 const bytes=new Uint8Array(memory.buffer);
 const instance=new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir,'output.wasm'))),{env:{memory,__memory_base:0,__table_base:0}});
 for(let seed=0;seed<256;seed++) {
  for(let i=0;i<32;i++) bytes[i]=(seed*17+i*31)&255;
  for(const c of cases) {
   instance.exports[c.name](0,16,32);
   c.mask.forEach((index,lane)=>{if(index>=0) assert.equal(bytes[32+lane],bytes[c.same?index%16:index],`${c.name}, seed ${seed}, lane ${lane}`);});
  }
 }
});
