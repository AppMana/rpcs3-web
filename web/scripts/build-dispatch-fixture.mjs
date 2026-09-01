import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  copyFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptRoot, "..");
const repoRoot = resolve(webRoot, "..");
const fixtureRoot = join(webRoot, "fixtures/dispatch-conformance");
const outputRoot = join(repoRoot, "bin/test");
const cacheBase = resolve(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"));
const release = "nightly-2026-07-26";
const archiveName = "ps3dev-linux-X64.tar.gz";
const archiveUrl = `https://github.com/ps3dev/ps3dev/releases/download/${release}/${archiveName}`;
const archiveSha256 = "dcbed747e094c6a382dae5b0aacc322a1d4390d9f2849a7d750a96ea398ee8ab";
const ps3dev = resolve(process.env.RPCS3_PS3DEV ?? join(cacheBase, "rpcs3-ps3dev", release));

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function provisionToolchain() {
  try {
    accessSync(join(ps3dev, "ppu_rules"));
    return;
  } catch {}

  const archive = join(dirname(ps3dev), `${release}-${archiveName}`);
  mkdirSync(dirname(ps3dev), { recursive: true });
  let validArchive = false;
  try {
    validArchive = sha256(archive) === archiveSha256;
  } catch {}
  if (!validArchive) {
    const response = await fetch(archiveUrl);
    if (!response.ok || !response.body) throw new Error(`PS3DEV download returned ${response.status}`);
    await pipeline(response.body, createWriteStream(archive));
  }
  const actualHash = sha256(archive);
  if (actualHash !== archiveSha256) {
    throw new Error(`PS3DEV checksum mismatch: expected ${archiveSha256}, received ${actualHash}`);
  }
  rmSync(ps3dev, { recursive: true, force: true });
  mkdirSync(ps3dev, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", ps3dev, "--strip-components=1"], { stdio: "inherit" });
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["build", "data"].includes(entry.name)) return [];
        return sourceFiles(path);
      }
      return [path];
    })
    .filter((path) => path.endsWith("Makefile") || /\.(c|h)$/.test(path))
    .sort();
}

await provisionToolchain();
const buildEnvironment = { ...process.env, PS3DEV: ps3dev, PSL1GHT: ps3dev };
execFileSync("make", ["-C", fixtureRoot, "clean"], { env: buildEnvironment, stdio: "inherit" });
execFileSync("make", ["-C", fixtureRoot, `-j${process.env.RPCS3_FIXTURE_JOBS ?? "2"}`], {
  env: buildEnvironment,
  stdio: "inherit",
});

mkdirSync(outputRoot, { recursive: true });
const elfSource = join(fixtureRoot, "web_dispatch_conformance.elf");
const selfSource = join(fixtureRoot, "web_dispatch_conformance.fake.self");
const elfOutput = join(outputRoot, "web_dispatch_conformance.elf");
const selfOutput = join(outputRoot, "web_dispatch_conformance.self");
copyFileSync(elfSource, elfOutput);
copyFileSync(selfSource, selfOutput);

const files = sourceFiles(fixtureRoot);
const sourceDigest = createHash("sha256");
for (const path of files) {
  sourceDigest.update(relative(fixtureRoot, path));
  sourceDigest.update("\0");
  sourceDigest.update(readFileSync(path));
  sourceDigest.update("\0");
}
const version = (tool) => execFileSync(join(ps3dev, tool), ["--version"], { encoding: "utf8" }).split("\n")[0];
const manifest = {
  protocol: "RPCS3-DISPATCH/1",
  ps3dev: { release, archive: archiveUrl, sha256: archiveSha256 },
  tools: { ppu: version("ppu/bin/ppu-gcc"), spu: version("spu/bin/spu-gcc") },
  source: { sha256: sourceDigest.digest("hex"), files: files.map((path) => relative(fixtureRoot, path)) },
  outputs: {
    elf: { file: relative(repoRoot, elfOutput), bytes: statSync(elfOutput).size, sha256: sha256(elfOutput) },
    self: { file: relative(repoRoot, selfOutput), bytes: statSync(selfOutput).size, sha256: sha256(selfOutput) },
  },
};
writeFileSync(join(fixtureRoot, "fixture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
