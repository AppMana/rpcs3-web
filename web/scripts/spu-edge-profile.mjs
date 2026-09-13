import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function counts(snapshot) {
  if (snapshot?.error || snapshot?.report?.schemaVersion !== 1) throw new Error('missing or unsupported edge snapshot');
  const out = new Map();
  for (const [from, to, count] of snapshot.report.edges) {
    if (![from, to, count].every(Number.isSafeInteger) || from <= 0 || to <= 0 || count < 0) throw new Error('invalid edge counter');
    const key = `${from}:${to}`;
    out.set(key, (out.get(key) || 0) + count);
  }
  return out;
}

export function resolveEdgeWindow(window, entries) {
  const before = counts(window?.begin), after = counts(window?.end);
  if (JSON.stringify(window.begin.report.spans) !== JSON.stringify(window.end.report.spans)) throw new Error('code ownership changed during edge window');
  if (!(window.begin.beginFrame <= window.begin.endFrame && window.begin.endFrame < window.end.beginFrame && window.end.beginFrame <= window.end.endFrame)) throw new Error('overlapping or invalid edge snapshot frame bounds');
  const dropped = window.end.report.dropped - window.begin.report.dropped;
  if (!Number.isSafeInteger(dropped) || dropped < 0) throw new Error('edge loss counter reset');
  const edges = [];
  for (const [key, prior] of before) if ((after.get(key) || 0) < prior) throw new Error('edge counter reset');
  for (const [key, count] of after) {
    const samples = count - (before.get(key) || 0);
    if (!samples) continue;
    const [fromIndex, toIndex] = key.split(':').map(Number);
    const from = entries.get(fromIndex), to = entries.get(toIndex);
    if (!from || !to) throw new Error(`unresolved code identity for edge ${key}`);
    edges.push({ from, to, samples });
  }
  const sourceTotals = new Map();
  for (const edge of edges) sourceTotals.set(edge.from.index, (sourceTotals.get(edge.from.index) || 0) + edge.samples);
  const samples = edges.reduce((sum, edge) => sum + edge.samples, 0);
  for (const edge of edges) {
    edge.sampleShare = edge.samples / samples;
    edge.observedSourceShare = edge.samples / sourceTotals.get(edge.from.index);
  }
  edges.sort((a, b) => b.samples - a.samples || a.from.index - b.from.index || a.to.index - b.to.index);
  return { schemaVersion: 1, sampling: window.end.report.sampling,
    beginFrames: [window.begin.beginFrame, window.begin.endFrame], endFrames: [window.end.beginFrame, window.end.endFrame],
    samples, dropped, edges };
}

export function loadEdgeProfile(report, directory) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = readFileSync(join(directory, 'manifest.json'));
  const manifestHash = hash(bytes);
  const manifestUrl = Object.entries(report.artifacts || {}).find(([url, digest]) => url.endsWith('/manifest.json') && digest === manifestHash)?.[0];
  if (!manifestUrl) throw new Error('bundle manifest does not match recorded artifact');
  const manifest = JSON.parse(bytes);
  const spans = report.edgeWindow?.end?.report?.spans;
  if (![2, 3].includes(manifest.chainAbi) || !spans || spans.length !== manifest.parts.length) throw new Error('edge profile requires matching ABI 2/3 bundle ownership');
  const entries = new Map();
  for (const [partIndex, part] of manifest.parts.entries()) {
    const wasm = readFileSync(join(directory, part.url));
    const digest = hash(wasm);
    if (part.sha256 !== digest || report.artifacts[new URL(part.url, manifestUrl).href] !== digest) throw new Error(`part identity mismatch: ${part.url}`);
    const names = WebAssembly.Module.exports(new WebAssembly.Module(wasm))
      .filter(e => e.kind === 'function' && /^__spu-0x[0-9a-f]+-/i.test(e.name)).map(e => e.name);
    const span = spans[partIndex];
    if (span.end - span.begin !== names.length) throw new Error('program ownership span does not match bundle exports');
    for (const [offset, symbol] of names.entries()) {
      const match = /^__spu-0x([0-9a-f]+)-(.+)$/i.exec(symbol);
      const index = span.begin + offset;
      entries.set(index, { index, part: partIndex, offset, symbol, pc: Number.parseInt(match[1], 16), codeHash: match[2] });
    }
  }
  return { ...resolveEdgeWindow(report.edgeWindow, entries), manifestSha256: manifestHash, sourceSha256: manifest.sourceSha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [reportPath, directory, output] = process.argv.slice(2);
  if (!reportPath || !directory || !output) throw new Error('usage: spu-edge-profile.mjs REPORT.json BUNDLE_DIR OUTPUT.json');
  const result = loadEdgeProfile(JSON.parse(readFileSync(reportPath)), directory);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ samples: result.samples, dropped: result.dropped, edges: result.edges.length, top: result.edges.slice(0, 10) }, null, 2));
}
