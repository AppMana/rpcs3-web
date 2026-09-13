import assert from 'node:assert/strict';
import {it as test} from 'vitest';
import {framePhaseWindow} from '../scripts/frame-phase-metrics.mjs';
const sample=(emuFlipId,submit)=>({emuFlipId,hostTimeMs:emuFlipId*10,phasesUs:{submit,present:2000,limiter:0}});
test('phase accounting excludes work before the opening flip',()=>{
 const result=framePhaseWindow({flipTimings:[sample(10,9000),sample(11,1000),sample(12,3000)]},10,12);
 assert.equal(result.phases.submit.meanMs,2);
 assert.equal(result.phases.submit.fractionOfWall,0.2);
 assert.equal(result.phases.present.fractionOfWall,0.2);
});
test('old reports remain unmeasured and incomplete timing windows are rejected',()=>{
 const samples=[sample(10,1),sample(11,1)];delete samples[1].phasesUs;
 assert.equal(framePhaseWindow({flipTimings:samples},10,11).phases.submit,null);
 assert.throws(()=>framePhaseWindow({flipTimings:samples,timingDrops:1},10,11));
 assert.throws(()=>framePhaseWindow({flipTimings:samples},10,12));
 assert.throws(()=>framePhaseWindow({flipTimings:[samples[0],samples[0]]},10,11));
});
