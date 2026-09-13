// Isolate cross-instance guest-style tail calls and exception unwinding from RPCS3.
// Assemble fixtures/wasm-tail-call/probe.wat into public/fixtures/wasm-tail-call-probe.wasm
// with wasm-as --enable-tail-call, then stage it to the served HTTPS origin.
import { writeFile } from "node:fs/promises";
import { WebKitConnection } from "./webkit-connection.mjs";
const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = pages.find((page) => page.url.startsWith("https://rpcs3.appmana.com/"));
if (!page) throw new Error("no RPCS3 page");
const connection = await new WebKitConnection(page.webSocketDebuggerUrl, 20_000).open();
const before = await connection.evaluate("performance.timeOrigin");
try {
  const result = await connection.evaluate(`(async () => {
    window.__tailProbeProgress = "compiling";
    const wasm = await WebAssembly.compileStreaming(fetch("/fixtures/wasm-tail-call-probe.wasm"));
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 2 });
    let calls = 0, throws = false;
    const sentinel = new Error("expected probe unwind");
    const done = (a,b,c,d,e,f,g) => {
      if (a !== 0 || b !== 2 || c !== 3 || d !== 4 || e !== 5n || f !== 6n || g !== 7n) throw new Error("argument corruption");
      calls++;
      if (throws) throw sentinel;
    };
    const first = new WebAssembly.Instance(wasm, {e:{table,done}});
    const second = ${process.env.RPCS3_PROBE_INSTANCES === "1" ? "first" : "new WebAssembly.Instance(wasm, {e:{table,done}})"};
    table.set(0,first.exports.run); table.set(1,second.exports.run);
    const started = performance.now();
    for (let i=0;i<100;i++) {
      window.__tailProbeProgress = i;
      throws = ${process.env.RPCS3_PROBE_THROW === "0" ? "false" : "Boolean(i & 1)"};
      try { first.exports.run(${Number(process.env.RPCS3_PROBE_DEPTH ?? 20000)},2,3,4,5n,6n,7n); }
      catch (error) { if (!throws || error !== sentinel) throw error; }
    }
    return JSON.stringify({ok:calls===100,calls,depth:${Number(process.env.RPCS3_PROBE_DEPTH ?? 20000)},instances:${Number(process.env.RPCS3_PROBE_INSTANCES ?? 2)},elapsedMs:performance.now()-started,userAgent:navigator.userAgent});
  })()`, true);
  await writeFile(process.argv[2] || "tail-call-probe.json", result);
  console.log(result);
} catch (error) {
  const diagnostic = { ok: false, error: error.message, beforeTimeOrigin: before,
    pages: await (await fetch("http://127.0.0.1:9222/json")).json() };
  try { diagnostic.after = await connection.evaluate("JSON.stringify({timeOrigin:performance.timeOrigin,progress:window.__tailProbeProgress})"); } catch {}
  await writeFile(process.argv[2] || "tail-call-probe.json", JSON.stringify(diagnostic, null, 2));
  console.log(JSON.stringify(diagnostic));
  process.exitCode = 1;
} finally { connection.close(); }
