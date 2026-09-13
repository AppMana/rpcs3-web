import assert from 'node:assert/strict';
import{it as test}from'vitest';
import{mkdtempSync,writeFileSync,rmSync}from'node:fs';
import{execFileSync}from'node:child_process';
import{join,resolve}from'node:path';
import{tmpdir}from'node:os';
import{fileURLToPath}from'node:url';
const repoRoot=fileURLToPath(new URL('../../', import.meta.url));
test('RSX phase totals follow flip boundaries and survive independent draining',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rpcs3-frame-phases-'));
 try{
  writeFileSync(join(dir,'test.cpp'),`#include "Utilities/FrameTiming.h"
#include <cassert>
int main(){using namespace utils::frame_timing;
start();add_phase_us(phase::submit,120);add_phase_us(phase::present,300);note_flip();
auto first=drain();assert(first.frames.size()==1);assert(first.frames[0].phases_us[0]==120);assert(first.frames[0].phases_us[1]==300);
add_phase_us(phase::submit,25);assert(drain().frames.empty());note_flip();auto second=drain();assert(second.frames[0].frame==2);assert(second.frames[0].phases_us[0]==25);assert(second.frames[0].phases_us[1]==0);
enabled=false;{phase_scope scope(phase::submit);}assert(pending_phases[0]==0);
start();note_flip();assert(drain().frames[0].phases_us[0]==0);
fifo_idle=true;fifo_since=10;account_fifo_idle(30);assert(pending_phases[3]==20);account_fifo_idle(50);assert(pending_phases[3]==40);fifo_idle=false;account_fifo_idle(70);assert(pending_phases[3]==40);
start();assert(!fifo_idle);assert(pending_phases[3]==0);
{phase_scope stage(phase::draw_vertex); stage.next(phase::draw_uniform); stage.next(phase::draw_bind);}
note_flip();auto stages=drain();assert(stages.frames[0].phases_us.size()==phase_names.size());
assert(stages.frames[0].phases_us[static_cast<unsigned>(phase::draw_vertex)]>=0);
assert(stages.frames[0].phases_us[static_cast<unsigned>(phase::draw_uniform)]>=0);
enabled=false;{phase_scope stage(phase::draw_vertex);stage.next(phase::draw_uniform);}assert(pending_phases[static_cast<unsigned>(phase::draw_uniform)]==0);
}`);
  execFileSync('c++',['-std=c++17','-pthread','-I',resolve(repoRoot),join(dir,'test.cpp'),'-o',join(dir,'test')]);
  assert.doesNotThrow(()=>execFileSync(join(dir,'test')));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
