// Rewrite a RPCS3_PPU_WASM_AOT_IR dump to the blocks a profiled run actually entered.
//
//   node scripts/filter-ppu-ir-by-profile.mjs IR_DIR OUT_DIR PROFILE.bin
//
// PROFILE.bin is the little-endian u32 list of guest addresses a run entered, written by a
// RPCS3_PPU_PROFILE=1 run (rpcs3_web_ppu_used_blocks). The analyser finds every block it can prove
// reachable, which for a title is far more than a session runs: LittleBigPlanet 2 compiles 502,334
// blocks and enters about 44,000 of them. Every block costs a function in its part's module and an
// element-segment entry in every worker's table, and that per-worker cost is what Mobile Safari
// cannot pay.
//
// A block is kept when the profile entered it, or when a kept block tail-calls it directly: a
// direct call names the callee, so dropping it would leave a dangling reference. Calls that go
// through the function table are unaffected, because an address with no compiled block returns to
// the interpreter, so a block this run did not reach still executes, just interpreted.
//
// The profile records absolute guest addresses below 32 MB, which covers a title's own segments but
// not the PRX modules mapped high, so parts whose blocks sit outside that span are copied whole.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [inputArg, outputArg, profileArg] = process.argv.slice(2);
if (!inputArg || !outputArg || !profileArg) {
  throw new Error("usage: filter-ppu-ir-by-profile.mjs IR_DIR OUT_DIR PROFILE.bin");
}
const inputDirectory = resolve(inputArg);
const outputDirectory = resolve(outputArg);
const profiledSpan = 32 << 20;
mkdirSync(outputDirectory, { recursive: true });

const profileBytes = readFileSync(resolve(profileArg));
if (profileBytes.length % 4) throw new Error(`${profileArg} is not a whole number of u32s`);
const entered = new Set();
for (let offset = 0; offset < profileBytes.length; offset += 4) entered.add(profileBytes.readUInt32LE(offset));
if (!entered.size) throw new Error(`${profileArg} holds no addresses`);

const sources = readdirSync(inputDirectory).filter((name) => name.endsWith(".wasm.ll")).sort();
if (!sources.length) throw new Error(`no .wasm.ll parts under ${inputDirectory}`);

// The parts are one module each; a part's blocks array gives the guest address of every block it
// defines, in the order __ppu_block_index_ reports them.
function parse(text) {
  const lines = text.split("\n");
  const segments = [];
  let literal = [];
  const bodies = new Map();
  let name;
  let addresses;
  let suffix = "";

  const flush = () => {
    if (literal.length) segments.push({ kind: "literal", lines: literal });
    literal = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    const blocks = /^@__ppu_blocks_(\w+) = constant .*\[([^\]]*)\]\s*\}(.*)$/.exec(line);
    if (blocks) {
      name = blocks[1];
      addresses = [...blocks[2].matchAll(/i32 (\d+)/g)].map((match) => Number(match[1]));
      suffix = blocks[3];
      flush();
      segments.push({ kind: "blocks" });
      continue;
    }

    if (line.startsWith(`define i32 @__ppu_block_index_`)) {
      while (lines[index] !== "}") index++;
      flush();
      segments.push({ kind: "index" });
      continue;
    }

    const definition = /^define hidden void @__0x([0-9a-f]+)\(/.exec(line);
    if (definition) {
      const start = index;
      while (lines[index] !== "}") index++;
      const body = lines.slice(start, index + 1);
      const address = Number.parseInt(definition[1], 16);
      bodies.set(address, body);
      // A direct tail call names its callee, so the callee has to survive with the caller
      const calls = new Set();
      for (const call of body.join("\n").matchAll(/musttail call void @__0x([0-9a-f]+)\(/g)) {
        calls.add(Number.parseInt(call[1], 16));
      }
      flush();
      segments.push({ kind: "block", address, calls });
      continue;
    }

    literal.push(line);
  }
  flush();
  return { segments, bodies, name, addresses, suffix };
}

function emit(part, keep) {
  const kept = part.addresses.filter((address) => keep.has(address));
  const count = kept.length;
  const array = kept.map((address) => `i32 ${address}`).join(", ");
  const blocksLine = `@__ppu_blocks_${part.name} = constant { i32, [${count} x i32] } `
    + `{ i32 ${count}, [${count} x i32] [${array}] }${part.suffix}`;

  const cases = kept.map((address, index) => `    i32 ${index}, label %${index + 1}`).join("\n");
  const returns = kept
    .map((address, index) => `${index + 1}:\n  ret i32 ptrtoint (ptr @__0x${address.toString(16)} to i32)\n`)
    .join("\n");
  const indexFunction = `define i32 @__ppu_block_index_${part.name}(i32 %0) {\nentry:\n`
    + `  switch i32 %0, label %none [\n${cases}\n  ]\n\nnone:\n  ret i32 0\n\n${returns}}`;

  const out = [];
  for (const segment of part.segments) {
    if (segment.kind === "literal") out.push(segment.lines.join("\n"));
    else if (segment.kind === "blocks") out.push(blocksLine);
    else if (segment.kind === "index") out.push(indexFunction);
    else if (keep.has(segment.address)) out.push(part.bodies.get(segment.address).join("\n"));
  }
  return out.join("\n");
}

let keptTotal = 0;
let sourceTotal = 0;
let copiedParts = 0;
const summary = [];

for (const source of sources) {
  const text = readFileSync(join(inputDirectory, source), "utf8");
  const part = parse(text);
  if (!part.name || !part.addresses) throw new Error(`${source} has no block table`);
  sourceTotal += part.addresses.length;

  // A part mapped above the profiled span was never recorded, so it is kept whole
  if (part.addresses.some((address) => address >= profiledSpan)) {
    writeFileSync(join(outputDirectory, source), text);
    keptTotal += part.addresses.length;
    copiedParts++;
    continue;
  }

  const keep = new Set();
  const queue = [];
  for (const segment of part.segments) {
    if (segment.kind === "block" && entered.has(segment.address)) {
      keep.add(segment.address);
      queue.push(segment.address);
    }
  }
  const callsOf = new Map();
  for (const segment of part.segments) if (segment.kind === "block") callsOf.set(segment.address, segment.calls);
  while (queue.length) {
    for (const callee of callsOf.get(queue.pop()) ?? []) {
      if (!callsOf.has(callee) || keep.has(callee)) continue;
      keep.add(callee);
      queue.push(callee);
    }
  }

  keptTotal += keep.size;
  summary.push({ source, blocks: part.addresses.length, kept: keep.size });
  if (!keep.size) continue; // A part this run never entered contributes no module
  writeFileSync(join(outputDirectory, source), emit(part, keep));
}

const written = readdirSync(outputDirectory).filter((name) => name.endsWith(".wasm.ll")).length;
console.log(`profile: ${entered.size} entered addresses`);
console.log(`parts: ${written} written of ${sources.length} (${copiedParts} copied whole, above the profiled span)`);
console.log(`blocks: ${keptTotal} of ${sourceTotal} (${(keptTotal / sourceTotal * 100).toFixed(1)}%)`);
