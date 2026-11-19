import { supportsSuspending } from "./rpcs3-suspending.mjs";

export async function runtimeOptions(target, overrides = {}) {
  const commercial = Boolean(
    target?.startsWith("/opfs/games/") ||
    (target?.startsWith("/opfs/") && (/lbp|littlebigplanet|BCUS98245/i.test(target) || /\.iso$/i.test(target)))
  );
  let bundles = {};
  if (commercial) {
    try {
      const response = await fetch(new URL("./local-aot/index.json", import.meta.url));
      const contentType = response.headers?.get("content-type") || "";
      if (response.ok && (!contentType || contentType.includes("json"))) {
        const titles = (await response.json()).titles ?? [];
        const entry = titles.find((title) => title.disc === target || (title.serial && target.includes(title.serial)))
          ?? (/\.SAVESTAT(?:\.zst)?$/i.test(target) && titles.length === 1 ? titles[0] : undefined);
        if (entry) bundles = { ppuAotBundle: entry.ppu, spuAotBundle: entry.spu };
      }
    } catch {}
  }
  const options = {
    // A commercial title always starts on the fail-closed AOT path. Its live
    // EBOOT/PRX code is compiled to Wasm before execution, and the worker's
    // persistent cache supplies the same modules on later boots. Block-JIT is
    // disabled by default; fail-closed misses still compile synchronously
    // through the same AOT worker rather than executing PPU instructions.
    ...(commercial ? {
      directRenderer: true,
      ppuBackend: "aot",
      ppuFailClosed: true,
      ppuJit: false,
      autoRecomp: true,
      spuDecoder: "llvm",
      clockScale: 100,
    } : {}),
    ...bundles,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
  };
  if (options.suspending === undefined) options.suspending = options.directRenderer && await supportsSuspending();
  if (options.suspending && !await supportsSuspending()) throw new Error("this core requires JSPI");
  options.coreUrl ??= options.suspending ? "./core/jspi/rpcs3-web.mjs" : "./core/rpcs3-web.mjs";
  return options;
}

export function presentationCanvas(canvas, suspending) {
  return {
    gpuCanvas: suspending ? canvas.transferControlToOffscreen() : new OffscreenCanvas(canvas.width, canvas.height),
    view: suspending ? undefined : canvas.getContext("bitmaprenderer"),
  };
}

export function requestRuntime(worker, request, response, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener("message", listener); };
    const listener = ({ data }) => {
      if (data?.type !== response) return;
      cleanup();
      resolve(data);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${request.type} timed out`)); }, timeoutMs);
    worker.addEventListener("message", listener);
    worker.postMessage(request);
  });
}

export function frameCount(frame) {
  return frame.emuFlipId ?? frame.workingSet?.flipCounter ?? frame.frameSequence ?? 0;
}
