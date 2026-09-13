import {readFileSync} from 'node:fs';
import {windowed} from './worker-profiler.mjs';
const [reportPath, base] = process.argv.slice(2);
if (!reportPath || !base) throw new Error('usage: analyse-compiler-profile.mjs report.json run.cpuprofile');
const report=JSON.parse(readFileSync(reportPath));
const targets=JSON.parse(readFileSync(`${base}.targets.json`));
if (!report.profileWindow?.startedAt || !report.profileWindow?.stoppedAt || !Number.isFinite(report.clock?.offsetUs)) throw new Error('missing profile window/clock');
const start=report.profileWindow.startedAt*1000+report.clock.offsetUs;
const end=report.profileWindow.stoppedAt*1000+report.clock.offsetUs;
const rows=[];
for (const target of targets.targets) {
  if (!target.profilePath) {rows.push({target:target.targetInfo,error:target.error??'missing profile'});continue;}
  const profile=JSON.parse(readFileSync(target.profilePath));
  const nodes=new Map(profile.nodes.map(n=>[n.id,n.callFrame.functionName]));
  const counts=new Map();
  for (const id of windowed(profile,0,0,start,end)) {const name=nodes.get(id)??'(unknown node)'; counts.set(name,(counts.get(name)??0)+1);}
  const row={target:target.targetInfo,compiler:/rpcs3-spu-llvm-worker\.mjs/.test(target.targetInfo.url),attributed:0,wait:0,unknown:0,top:[...counts].sort((a,b)=>b[1]-a[1]).slice(0,15)};
  for (const [name,n] of counts) {
    if (['(idle)','emscripten_futex_wait','_do_futex_wait'].includes(name)) row.wait+=n;
    else if (['(program)','(unknown node)','(root)'].includes(name)) row.unknown+=n;
    else row.attributed+=n;
  }
  rows.push(row);
}
const total=rows.reduce((n,r)=>n+(r.attributed??0),0);
const compiler=rows.filter(r=>r.compiler).reduce((n,r)=>n+r.attributed,0);
console.log(JSON.stringify({window:report.profileWindow,accounting:'CDP sample counts, not OS CPU. Unknown and wait samples retained separately. Compiler identity comes from worker URL; browser background compiler threads are outside these worker profiles.',attributedSamples:total,compilerAttributedSamples:compiler,compilerShareOfAttributedSamples:total?compiler/total:null,rows},null,2));
