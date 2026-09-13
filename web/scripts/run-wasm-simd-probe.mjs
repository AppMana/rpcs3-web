import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { WebKitConnection } from './webkit-connection.mjs';
const [engine = 'webkit', directory = 'test-results/performance/webkit-unary-probe'] = process.argv.slice(2);
const output = resolve(directory);
const payload = Object.fromEntries(['control', 'candidate'].map(name => [name, readFileSync(join(output, `${name}.wasm`)).toString('base64')]));
async function probe(payload) {
  const variants = {};
  for (const [name, encoded] of Object.entries(payload)) {
    const memory = new WebAssembly.Memory({initial: 2, maximum: 32768, shared: true});
    const {instance} = await WebAssembly.instantiate(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)), {env: {memory, __memory_base: 0, __table_base: 0}});
    variants[name] = {memory, bench: instance.exports.bench};
  }
  function run(name, count) {
    const {memory, bench} = variants[name];
    const bytes = new Uint8Array(memory.buffer, 0, 16);
    for (let i = 0; i < 16; i++) bytes[i] = i;
    const start = performance.now();
    bench(0, count);
    const ms = performance.now() - start;
    for (let i = 0; i < 16; i++) {
      const expected = ((count % 2 ? 15 - i : i) + count) & 255;
      if (bytes[i] !== expected) throw new Error(`${name}: count ${count}, lane ${i}: ${bytes[i]} != ${expected}`);
    }
    return {name, count, ms};
  }
  const cold = ['control', 'candidate'].map(name => run(name, 10000000));
  for (const count of [0,1,2,3,127,128,255,256,1025]) for (const name of Object.keys(variants)) run(name,count);
  for (let i = 0; i < 10; i++) for (const name of Object.keys(variants)) run(name,1000000);
  await new Promise(resolve => setTimeout(resolve, 1000));
  const trials = [];
  for (let i = 0; i < 12; i++) {
    for (const name of i % 2 ? ['candidate','control'] : ['control','candidate']) trials.push(run(name,10000000));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return {userAgent: navigator.userAgent, crossOriginIsolated, cold, trials};
}
let browser, connection;
try {
  let report;
  if (engine === 'ipad') {
    const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
    const page = pages.find(page => page.url.startsWith('https://rpcs3.appmana.com/'));
    if (!page) throw new Error('No RPCS3 ingress page on attached device');
    connection = await new WebKitConnection(page.webSocketDebuggerUrl).open();
    await connection.evaluate(`location.assign('https://rpcs3.appmana.com/runtime.html?simdProbe=${Date.now()}')`);
    connection.close();
    await new Promise(resolve => setTimeout(resolve, 3000));
    const refreshed = await (await fetch('http://127.0.0.1:9222/json')).json();
    connection = await new WebKitConnection(refreshed.find(p => p.url.includes('simdProbe=')).webSocketDebuggerUrl).open();
    report = await connection.evaluate(`(${probe.toString()})(${JSON.stringify(payload)})`, true);
  } else {
    const {webkit, chromium} = await import('../node_modules/playwright/index.mjs');
    browser = await (engine === 'chrome' ? chromium.launch({headless:false, executablePath:'/usr/bin/google-chrome', args:['--no-sandbox']}) : webkit.launch({headless:true}));
    const page = await browser.newPage();
    await page.goto('https://rpcs3.appmana.com/runtime.html');
    report = await page.evaluate(probe, payload);
  }
  writeFileSync(join(output, `${engine}-timing.json`), JSON.stringify(report,null,2)+'\n');
  const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
  console.log(JSON.stringify({engine, userAgent:report.userAgent, cold:report.cold, medianMs:Object.fromEntries(['control','candidate'].map(name=>[name,median(report.trials.filter(t=>t.name===name).map(t=>t.ms))]))},null,2));
} finally {
  connection?.close();
  await browser?.close();
}
