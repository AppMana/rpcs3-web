// Append recorded SPU AOT misses (SPU cache format, from RPCS3_SPU_FALLBACK_HIST=1 runs) to a
// title's native SPU cache so the native IR dump compiles them into the bundle.
//   node scripts/merge-spu-misses.mjs <spu-safe-v1-tane.dat> <misses.dat>...
import { readFileSync, writeFileSync } from "node:fs";

function entries(buffer) {
  const out = new Map();
  for (let offset = 0; offset + 8 <= buffer.length;) {
    const sizeCrc = buffer.readUInt32BE(offset);
    const size = sizeCrc & 0xffff;
    const bytes = 8 + size * 4;
    if (!size || offset + bytes > buffer.length) break;
    const entry = buffer.subarray(offset, offset + bytes);
    out.set(entry.toString("base64"), entry);
    offset += bytes;
  }
  return out;
}

const [cachePath, ...missPaths] = process.argv.slice(2);
if (!cachePath || !missPaths.length) {
  console.error("usage: merge-spu-misses.mjs <cache.dat> <misses.dat>...");
  process.exit(2);
}
const cache = readFileSync(cachePath);
const known = entries(cache);
const added = [];
for (const missPath of missPaths) {
  for (const [key, entry] of entries(readFileSync(missPath))) {
    if (known.has(key)) continue;
    known.set(key, entry);
    added.push(entry);
  }
}
if (added.length) writeFileSync(cachePath, Buffer.concat([cache, ...added]));
console.log(`cache ${cachePath}: ${known.size - added.length} programs, appended ${added.length}`);
