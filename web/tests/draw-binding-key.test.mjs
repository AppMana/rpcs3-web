import assert from 'node:assert/strict';
import{it as test}from'vitest';
import{mkdtempSync,writeFileSync,rmSync}from'node:fs';
import{execFileSync}from'node:child_process';
import{join,resolve}from'node:path';
import{tmpdir}from'node:os';
import{fileURLToPath}from'node:url';
const repoRoot=fileURLToPath(new URL('../../', import.meta.url));
test('draw binding identities preserve exact bounds and buffer generations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rpcs3-frame-phases-'));
 try{
  writeFileSync(join(dir,'test.cpp'),`#include "rpcs3/Emu/RSX/WG/WebGPUDrawBindingKey.h"
#include <cassert>
#include <unordered_map>
int main(){using namespace rsx::webgpu;
auto key=buffer_binding_key(1,2,3,16,32);
std::unordered_map<draw_binding_key,int,draw_binding_hash> cache;cache.emplace(key,7);
assert(cache.at(buffer_binding_key(1,2,3,16,32))==7);
// Every resource identity and exact size matters, including non-power-of-two bounds.
for(unsigned i=0;i<5;++i){auto other=key;++other[i];assert(cache.find(other)==cache.end());}
assert(cache.find(buffer_binding_key(1,2,4,16,32))==cache.end()); // ring growth
assert(cache.find(buffer_binding_key(1,2,3,32,16))==cache.end()); // swapped streams
// Texture identity is independent from the buffer size and generation.
draw_binding_key texture{};texture[0]=10;texture[5]=20;texture[6]=30;cache.emplace(texture,9);
auto replaced=texture;replaced[5]=21;assert(cache.find(replaced)==cache.end());
replaced=texture;replaced[6]=31;assert(cache.find(replaced)==cache.end());
assert(cache.at(texture)==9);cache.clear();assert(cache.empty());
}`);
  execFileSync('c++',['-std=c++17','-pthread','-I',resolve(repoRoot),join(dir,'test.cpp'),'-o',join(dir,'test')]);
  assert.doesNotThrow(()=>execFileSync(join(dir,'test')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
