import {percentile} from './performance-metrics.mjs';
export function framePhaseWindow(report, from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new Error('invalid phase window');
  if (report.timingDrops) throw new Error('timing drops prevent complete phase accounting');
  const samples=(report.flipTimings??[]).filter(s=>s.emuFlipId>=from&&s.emuFlipId<=to);
  if (samples.length!==to-from+1 || samples.some((s,i)=>s.emuFlipId!==from+i)) throw new Error('missing or duplicate phase frame boundaries');
  const durationMs=samples.at(-1).hostTimeMs-samples[0].hostTimeMs;
  if (!(durationMs>0)) throw new Error('invalid phase clock');
  // A phase belongs to the interval ENDING at this flip. The first boundary's
  // phases precede the requested window and must not enter its denominator.
  const intervals=samples.slice(1);
  const phases={};
  for (const name of ['submit','present','limiter','fifoIdle','draw','drawSetup','drawTextures','drawProgram','drawClause','drawVertex','drawUniform','drawBind','drawEncode','drawEnd']) {
    const values=intervals.map(s=>s.phasesUs?.[name]);
    phases[name]=values.every(v=>Number.isFinite(v)&&v>=0)?{
      meanMs:values.reduce((a,b)=>a+b,0)/values.length/1000,
      p99Ms:percentile(values,0.99)/1000,
      fractionOfWall:values.reduce((a,b)=>a+b,0)/1000/durationMs,
    }:null;
  }
  return{from,to,frames:to-from,durationMs,phases,
    accounting:'RSX-thread wall scopes: host submit, presentation/capture/yield, explicit frame-limiter wait, and FIFO idle intervals split at flip boundaries (including configured wake delay). Draw includes setup and its vertex/uniform/bind/encode child stages; uniform includes index staging, encode includes pipeline lookup. Detailed clocks perturb per-draw costs. Scopes may overlap when a deferred flip is serviced during FIFO idle; do not sum them. Not GPU timestamps or CPU time. Uninstrumented time includes command generation, guest waits and other execution.'};
}
