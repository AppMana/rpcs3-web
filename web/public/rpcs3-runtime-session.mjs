import { supportsSuspending } from "./rpcs3-suspending.mjs";

export async function runtimeOptions(target, overrides = {}) {
  const commercial = target?.startsWith("/opfs/");
  let bundles = {};
  if (commercial) {
    const response = await fetch(new URL("./local-aot/index.json", import.meta.url));
    if (!response.ok) throw new Error(`bundle index: HTTP ${response.status}`);
    const entry = (await response.json()).titles?.find((title) => title.disc === target);
    if (entry) bundles = { ppuAotBundle: entry.ppu, spuAotBundle: entry.spu };
  }
  const options = {
    ...(commercial ? { directRenderer: true, ppuJit: true, spuDecoder: "llvm", spuLlvmWorkers: 2, clockScale: 100 } : {}),
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
