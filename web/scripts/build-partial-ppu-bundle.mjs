// A bundle that registers only part of what its module carries, so the runtime PPU tier still has
// blocks to compile while bundle blocks are running. A full bundle hides the interaction between
// the two: a bundle block reaches another through the guest-address table, so it can branch into an
// address only the tier knows about.
//
//   node scripts/build-partial-ppu-bundle.mjs INPUT.wasm OUTPUT.manifest.json [stride]
//
// Every strideth block is kept, which splits a hot path between the bundle and the tier rather than
// leaving one of them cold.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [input, output, strideArgument] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write("usage: build-partial-ppu-bundle.mjs INPUT.wasm OUTPUT.manifest.json [stride]\n");
  process.exit(2);
}
const stride = Math.max(1, Number(strideArgument) || 2);
const compiled = await WebAssembly.compile(readFileSync(input));
// The same stand-in environment the bundle builder reads block tables through (build-ppu-aot-bundle.mjs)
const memory = new WebAssembly.Memory({ initial: 512, maximum: 32768, shared: true });
const table = new WebAssembly.Table({ initial: 1 << 16, element: "anyfunc" });
const memoryBase = 1 << 16;
const env = {
  memory,
  __indirect_function_table: table,
  __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, memoryBase),
  __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
  __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, 1 << 24),
};
for (const imported of WebAssembly.Module.imports(compiled)) {
  if (imported.module !== "env" || imported.name in env) continue;
  if (imported.kind === "function") env[imported.name] = () => 0;
  else if (imported.kind === "global") env[imported.name] = new WebAssembly.Global({ value: "i32", mutable: false }, 0);
}
const instance = new WebAssembly.Instance(compiled, { env });
if (typeof instance.exports.__wasm_apply_data_relocs === "function") instance.exports.__wasm_apply_data_relocs();
const heap = new Uint32Array(memory.buffer);
const blocks = [];
for (const [name, value] of Object.entries(instance.exports)) {
  if (!name.startsWith("__ppu_blocks_") || !(value instanceof WebAssembly.Global)) continue;
  const indexOf = instance.exports[`__ppu_block_index_${name.slice("__ppu_blocks_".length)}`];
  if (typeof indexOf !== "function") throw new Error(`${name} has no index function`);
  const address = (memoryBase + (value.value >>> 0)) >>> 0;
  const count = heap[address >>> 2];
  for (let entry = 0; entry < count; entry += 1) blocks.push(heap[(address >>> 2) + 1 + entry] >>> 0, indexOf(entry) >>> 0);
}
const kept = [];
for (let block = 0; block < blocks.length / 2; block += stride) kept.push(blocks[block * 2], blocks[block * 2 + 1]);
writeFileSync(output, `${JSON.stringify({
  version: 1,
  parts: [{
    url: basename(input),
    module: "partial",
    relocatable: false,
    blocks: Buffer.from(new Uint32Array(kept).buffer).toString("base64"),
  }],
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ input, output, stride, total: blocks.length / 2, kept: kept.length / 2 })}\n`);
