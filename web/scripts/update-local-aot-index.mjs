// Point a title's local AOT selection at a freshly built PPU manifest while
// preserving the title's existing SPU bundle and any unrelated entries.
//
//   node scripts/update-local-aot-index.mjs INDEX MANIFEST --disc=PATH [--serial=ID] [--spu=MANIFEST]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [indexArg, manifestArg, ...options] = process.argv.slice(2);
if (!indexArg || !manifestArg) {
  throw new Error("usage: update-local-aot-index.mjs INDEX MANIFEST --disc=PATH [--serial=ID] [--spu=MANIFEST]");
}
const valueOf = (name) => options.find((option) => option.startsWith(`--${name}=`))?.slice(name.length + 3);
const disc = valueOf("disc");
const serial = valueOf("serial");
const spu = valueOf("spu");
if (!disc) throw new Error("--disc=PATH is required");

const indexPath = path.resolve(indexArg);
const manifestPath = path.resolve(manifestArg);
const indexDirectory = path.dirname(indexPath);
const publicDirectory = path.dirname(indexDirectory);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.parts) || !manifest.codegen) {
  throw new Error(`${manifestPath} is not a policy-tagged PPU AOT manifest`);
}

let index = { titles: [] };
try {
  index = JSON.parse(await readFile(indexPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (!Array.isArray(index.titles)) throw new Error(`${indexPath} has no titles array`);

const position = index.titles.findIndex((entry) => entry.disc === disc || (serial && entry.serial === serial));
const previous = position >= 0 ? index.titles[position] : {};
const entry = {
  ...previous,
  disc,
  ...(serial ? { serial } : {}),
  ppu: path.relative(publicDirectory, manifestPath).split(path.sep).join("/"),
  ...(spu ? { spu: path.relative(publicDirectory, path.resolve(spu)).split(path.sep).join("/") } : {}),
};
if (position >= 0) index.titles[position] = entry;
else index.titles.push(entry);

await mkdir(indexDirectory, { recursive: true });
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ index: indexPath, entry }, null, 2)}\n`);
