import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import {compilationWindow} from '../scripts/compilation-metrics.mjs';
const frame = (emuFlipId, n) => ({emuFlipId, hostTimeMs:emuFlipId*10,
 compilation:{compileMs:n*4,spuRequested:n,spuCompiled:n,ppuRequested:0,ppuCompiled:0,queued:0},ppuRegistered:n,ppuPending:0});
test('startup work is excluded from a settled gameplay window',()=>{
 const report={frames:[frame(1,0),frame(100,20),frame(4500,200),frame(5000,200),frame(5200,200)]};
 const result=compilationWindow(report,4500,5200);
 assert.equal(result.deltas.spuCompiled,0);
 assert.equal(result.deltas.ppuRegistered,0);
 assert.equal(result.deltas.llvmCompileElapsedMs,0);
});
test('discrete counts use actual endpoints and retain new compilation',()=>{
 const result=compilationWindow({frames:[frame(4501,20),frame(5000,23),frame(5199,24)]},4500,5200);
 assert.equal(result.from,4501); assert.equal(result.to,5199);
 assert.equal(result.deltas.spuCompiled,4);
 assert.equal(result.deltas.llvmCompileElapsedMs,16);
});
test('missing counters and resets remain unmeasured',()=>{
 const frames=[frame(1,10),frame(2,2),frame(3,12)];
 delete frames[1].ppuRegistered;
 const result=compilationWindow({frames},1,3);
 assert.equal(result.deltas.spuCompiled,null);
 assert.equal(result.deltas.ppuRegistered,null);
 assert.equal(result.deltas.ppuCompiled,0);
 assert.throws(()=>compilationWindow({frames},2,2));
});
