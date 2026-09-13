import{readFileSync}from'node:fs';
import{framePhaseWindow}from'./frame-phase-metrics.mjs';
const[path,from='4500',to='5200']=process.argv.slice(2);
if(!path)throw new Error('usage: analyse-frame-phases.mjs report.json [from to]');
console.log(JSON.stringify(framePhaseWindow(JSON.parse(readFileSync(path)),Number(from),Number(to)),null,2));
