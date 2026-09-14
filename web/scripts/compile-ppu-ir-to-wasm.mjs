import { execFile, execFileSync } from "node:child_process";
import { accessSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir, availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensureWasmRegionTool } from "./wasm-region-tool.mjs";

// One or more IR parts lower to one wasm module: every part is lowered to an
// object in parallel and a single wasm-ld link resolves the __0x blocks across
// parts as direct calls. A per-part module would import the shared function
// table separately, and V8 keeps a table-sized dispatch table per importing
// instance, which is what made a 114-instance bundle exhaust a worker's heap.
const args = process.argv.slice(2);
const inputArgs = args.filter((argument) => argument.endsWith(".ll"));
const outputArg = args.find((argument) => argument.endsWith(".wasm"));
const options = args.filter((argument) => argument.startsWith("--"));
if (!inputArgs.length || !outputArg) {
  throw new Error("usage: compile-ppu-ir-to-wasm.mjs INPUT.ll [MORE.ll ...] OUTPUT.wasm [--pic] [--export=NAME | --export-all] [--jobs=N]");
}
const execFileAsync = promisify(execFile);

function findTool(environmentName, name) {
  const explicit = process.env[environmentName];
  if (explicit) return explicit;

  for (const root of ["/usr/lib/llvm-22/bin", "/usr/lib/llvm-18/bin", "/usr/bin"]) {
    const candidate = join(root, name);
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next installed LLVM toolchain.
    }
  }
  throw new Error(`${name} was not found; set ${environmentName}`);
}

function existing(paths) {
  return paths.filter((candidate) => {
    try {
      accessSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function findRuntimeArchives() {
  const explicit = options
    .filter((option) => option.startsWith("--runtime="))
    .map((option) => resolve(option.slice("--runtime=".length)));
  if (explicit.length) return explicit;

  const sysroots = existing([
    process.env.EMSDK ? join(process.env.EMSDK, "upstream/emscripten/cache/sysroot") : "",
    join(homedir(), ".cache/emsdk-6.0.8/upstream/emscripten/cache/sysroot"),
  ].filter(Boolean));
  for (const sysroot of sysroots) {
    const libraryDirectory = join(sysroot, "lib/wasm32-emscripten");
    const archives = existing([
      join(libraryDirectory, "libclang_rt.builtins-wasmsjlj.a"),
      join(libraryDirectory, "libc.a"),
    ]);
    if (archives.length === 2) return archives;
  }
  return [];
}

const inputs = inputArgs.map((argument) => resolve(argument));
const output = resolve(outputArg);
const jobsOption = options.find((option) => option.startsWith("--jobs="));
const jobs = Math.max(1, Number(jobsOption?.slice("--jobs=".length)) || Math.min(8, availableParallelism()));
const exports = options.filter((option) => option.startsWith("--export="));
// Shared (PIC) modules export their visible symbols by default: the per-part block tables. Named
// block exports are only for the JS dispatcher fixtures (--export-all).
const exportAll = options.includes("--export-all") || (!options.includes("--pic") && exports.length === 0);
const pic = options.includes("--pic");
const llvmAs = findTool("RPCS3_LLVM_AS", "llvm-as");
const llc = findTool("RPCS3_LLC", "llc");
const wasmLd = findTool("RPCS3_WASM_LD", "wasm-ld");
const runtimeArchives = findRuntimeArchives();
const scratch = mkdtempSync(join(tmpdir(), "rpcs3-ppu-aot-"));
const regionTool = (options.includes("--regions") || options.includes("--direct-exits") || options.includes("--unary-swizzles")) ? ensureWasmRegionTool() : null;
const inlineReads = options.includes("--inline-reads");
const regionReports = new Array(inputs.length);

// Inline the AOT bundle's host-VM-helper reads into wasm (mirrors PPUTranslator.cpp:1036):
// page-table load over @__rpcs3_guest_pages + bounds check + volatile aligned load + a
// fallback to the raw helper for unmapped pages. Register index = unique suffix.
function inlineVmReads(text) {
  if (!text.includes("rpcs3_web_vm_read")) return text;
  const re = /^  %(\d+) = call (i\d+) @rpcs3_web_vm_read(\d+)_raw\(i32 %(\d+)\)$/gm;
  const t = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    const reg = m[1], ty = m[2], w = Number(m[3]), addr = m[4];
    const lim = (4096 - (w / 8)) | 0;
    t.push(text.slice(last, m.index));
    t.push(`  %vmrpi_${reg} = lshr i32 %${addr}, 12\n`);
    t.push(`  %vmrp_${reg} = getelementptr [1048576 x i32], ptr @__rpcs3_guest_pages, i32 0, i32 %vmrpi_${reg}\n`);
    t.push(`  %vmrpv_${reg} = load i32, ptr %vmrp_${reg}, align 4\n`);
    t.push(`  %vmro_${reg} = and i32 %${addr}, 4095\n`);
    t.push(`  %vmrin_${reg} = icmp ule i32 %vmro_${reg}, ${lim}\n`);
    t.push(`  %vmrm_${reg} = icmp ne i32 %vmrpv_${reg}, 0\n`);
    t.push(`  %vmrgo_${reg} = and i1 %vmrin_${reg}, %vmrm_${reg}\n`);
    t.push(`  br i1 %vmrgo_${reg}, label %vmr_d_${reg}, label %vmr_f_${reg}\n`);
    t.push(`vmr_d_${reg}:\n`);
    t.push(`  %vmra_${reg} = add i32 %vmrpv_${reg}, %vmro_${reg}\n`);
    t.push(`  %vmrpt_${reg} = inttoptr i32 %vmra_${reg} to ptr\n`);
    t.push(`  %vmrv_${reg} = load volatile ${ty}, ptr %vmrpt_${reg}, align 1\n`);
    t.push(`  br label %vmr_m_${reg}\n`);
    t.push(`vmr_f_${reg}:\n`);
    t.push(`  %vmrs_${reg} = call ${ty} @rpcs3_web_vm_read${w}_raw(i32 %${addr})\n`);
    t.push(`  br label %vmr_m_${reg}\n`);
    t.push(`vmr_m_${reg}:\n`);
    t.push(`  %${reg} = phi ${ty} [ %vmrv_${reg}, %vmr_d_${reg} ], [ %vmrs_${reg}, %vmr_f_${reg} ]\n`);
    last = re.lastIndex;
  }
  t.push(text.slice(last));
  let out = t.join("");
  // Inject the @__rpcs3_guest_pages declaration only if the ORIGINAL input lacked
  // it (the transformed body references it as a global, not a declaration).
  if (!text.includes("@__rpcs3_guest_pages = external")) {
    const decl = `@__rpcs3_guest_pages = external global [1048576 x i32]\n`;
    const idx = out.indexOf("define ");
    out = idx > 0 ? out.slice(0, idx) + decl + out.slice(idx) : decl + out;
  }
  return out;
}

async function lower(input, index) {
  const bitcode = join(scratch, `${index}-${basename(input)}.bc`);
  const object = join(scratch, `${index}-${basename(input)}.o`);
  let source = input;
  if (regionTool) {
    source = join(scratch, `${index}.region.ll`);
    const result = await execFileAsync(regionTool, [input, source, ...(options.includes("--regions") ? [] : ["--no-regions"]), ...(options.includes("--direct-exits") ? ["--direct-exits"] : []), ...(options.includes("--unary-swizzles") ? ["--unary-swizzles"] : [])], { maxBuffer: 1 << 24 });
    regionReports[index] = JSON.parse(result.stdout);
  }
  if (inlineReads) {
    const inline = join(scratch, `${index}.inline.ll`);
    await writeFile(inline, inlineVmReads(await readFile(source, "utf8")));
    source = inline;
  }
  await execFileAsync(llvmAs, [source, "-o", bitcode], { maxBuffer: 1 << 24 });
  await execFileAsync(llc, [
    "-mtriple=wasm32-unknown-unknown",
    "-mattr=+atomics,+bulk-memory,+mutable-globals,+sign-ext,+simd128,+tail-call",
    pic ? "-relocation-model=pic" : undefined,
    "-O3",
    "-filetype=obj",
    bitcode,
    "-o",
    object,
  ].filter(Boolean), { maxBuffer: 1 << 24 });
  rmSync(bitcode, { force: true });
  return object;
}

try {
  const objects = new Array(inputs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, inputs.length) }, async () => {
    while (next < inputs.length) {
      const index = next++;
      objects[index] = await lower(inputs[index], index);
    }
  }));

  const linkOptions = [
    pic ? "--shared" : "--no-entry",
    "--import-memory",
    "--shared-memory",
    pic ? undefined : "--initial-memory=16777216",
    "--max-memory=2147483648",
    pic ? undefined : "--global-base=12582912",
    "--allow-undefined",
    exportAll ? "--export-all" : undefined,
    ...exports,
    ...objects,
    ...runtimeArchives,
    "-o",
    output,
  ].filter(Boolean);
  execFileSync(wasmLd, linkOptions, { stdio: "inherit" });

  const bytes = readFileSync(output);
  const module = new WebAssembly.Module(bytes);
  process.stdout.write(`${JSON.stringify({
    inputs,
    output,
    pic,
    bytes: bytes.byteLength,
    runtimeArchives,
    ...(regionTool ? { regions: regionReports } : {}),
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
