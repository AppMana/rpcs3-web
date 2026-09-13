// Host-side size sweep of the per-preamble ucode content-walk primitives,
// modeled exactly on ProgramStateCache.cpp (rotr64 via 32-bit halves; FP
// constant-load skip; sparse VP instruction mask). Answers: how much per-frame
// hashing does the preamble actually pay at realistic ucode sizes?
import { performance } from "node:perf_hooks";
const iters = Number(process.argv[2] || 40000) || 40000;
function rotr(r){return [r>>>1,(r<<1)>>>0];}
function fpWalk(fp,len){let a0=0,a1=0,idx=0;
  while(idx<len){const lo=fp[idx*2]|0,hi=fp[idx*2+1]|0;
    a0=Math.imul((a0+lo)>>>0,0x9e3779b1)>>>0; a1=Math.imul((a1+hi)>>>0,0x85ebca6b)>>>0;
    if((hi&1)===0) idx++; else idx+=2;} return (a0+a1)>>>0;}
function vpWalk(vp,len){let a0=0,a1=0;
  for(let idx=0;idx<len;idx++){if(vp.mask[idx]){const lo=vp.d[idx*2]|0,hi=vp.d[idx*2+1]|0;
    a0=Math.imul((a0+((rotr(hi*1)|0)))>>>0,0x9e3779b1)>>>0; a1=Math.imul((a1+((rotr(lo*1)|0)))>>>0,0x85ebca6b)>>>0;}}
  return (a0+a1)>>>0;}
const fp = new Uint32Array(32768*4+4);
for(let i=0;i<fp.length;i++) fp[i]=(i*2654435761)>>>0;
const vp={d:new Uint32Array(512*4),mask:new Uint8Array(512)};
for(let i=0;i<512;i++){vp.d[i*4]=i*1103515245>>>0;vp.d[i*4+1]=(i*12345^0x9e3779b9)>>>0;vp.mask[i]=i%7===0?1:0;}
function bench(name,fn,n){fn();const t0=performance.now();for(let i=0;i<n;i++)fn();const ns=(performance.now()-t0)*1e6/n;console.log(`${name.padEnd(40)} ${ns.toFixed(1).padStart(7)} ns/preamble  => ${(ns*573/1e3).toFixed(1).padStart(5)} us/frame @573`);}
let s=0;
console.log(`microbench-ucode-walk iter=${iters}`);
for(const len of [64,256,512,1024,2048,4096,8192]){
  const fp2=new Uint32Array(50); // 128B fp at small only
  // fp: size in INSTRUCTIONS (16B fp / 4B vp half-words)
  bench(`fp_walk@${(len*16/1024).toFixed(2)}KB`,()=>s+=fpWalk(fp,len),iters);
}
for(const words of [512,1024,2048]){
  bench(`vp_walk@${(words/512).toFixed(2)}x2KB-block`,()=>s+=vpWalk(vp,words),iters);
}
console.log(`fp_walk@128B`,()=>{}); // noop marker
console.log(`sink=${s}`);
