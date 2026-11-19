// Rebase relocatable PRX .wasm.ll files to their deterministic runtime seg0 load
// addresses so they can be filtered by profile and linked directly into EBOOT.wasm.
//
//   node scripts/rebase-prx-ir.mjs IR_DIR OUT_DIR [PRX_BASE_JSON]
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PRX_BASES = {
  "liblv2.sprx": 0x00fd0000,
  "libgcm_sys.sprx": 0x01000000,
  "libsre.sprx": 0x01020000,
  "libfs.sprx": 0x01060000,
  "libnet.sprx": 0x01080000,
  "liblv2dbg_for_cex.sprx": 0x010c0000,
  "libhttp.sprx": 0x010e0000,
  "libssl.sprx": 0x01130000,
  "libfiber.sprx": 0x011b0000,
  "libjpgdec.sprx": 0x011d0000,
  "libkey2char.sprx": 0x01230000,
};

const [inputArg, outputArg, mapArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("usage: rebase-prx-ir.mjs IR_DIR OUT_DIR [PRX_BASE_JSON]");
}
const inputDirectory = resolve(inputArg);
const outputDirectory = resolve(outputArg);
const prxBases = mapArg ? JSON.parse(readFileSync(resolve(mapArg), "utf8")) : DEFAULT_PRX_BASES;
mkdirSync(outputDirectory, { recursive: true });

let rebasedCount = 0;
for (const name of readdirSync(inputDirectory).filter((entry) => entry.endsWith(".wasm.ll")).sort()) {
  const moduleName = name.slice(0, name.indexOf("-"));
  if (moduleName.startsWith("EBOOT")) continue;
  const base = Number(prxBases[moduleName]);
  if (!base) continue;

  let text = readFileSync(join(inputDirectory, name), "utf8");
  text = text.replace(
    /^(@__ppu_blocks_\w+ = constant \{ i32, \[\d+ x i32\] \} \{ i32 \d+, \[\d+ x i32\] \[)([^\]]+)(\] \}.*)$/m,
    (_, prefix, list, suffix) => {
      const rebasedList = list.replace(/i32 (\d+)/g, (__, offset) => `i32 ${base + Number(offset)}`);
      return `${prefix}${rebasedList}${suffix}`;
    },
  );
  text = text.replace(/@__0x([0-9a-fA-F]+)/g, (_, hex) => `@__0x${(base + Number.parseInt(hex, 16)).toString(16)}`);
  text = text.replace(/= add i64 (-?\d+), %2(?![0-9])/g, (_, offset) => `= add i64 ${offset}, ${base}`);
  text = text.replace(/tail call void @__check\(ptr %1, i64 %2\)/g, `tail call void @__check(ptr %1, i64 ${base})`);

  writeFileSync(join(outputDirectory, `EBOOT.BIN-prx-${name}`), text);
  rebasedCount += 1;
}
console.log(`rebased ${rebasedCount} PRX IR parts into ${outputDirectory}`);
