const scope = self;

function detail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
}

scope.addEventListener("message", async (event) => {
  if (event.data?.type !== "install-firmware") return;
  const logs = [];
  const startedAt = performance.now();
  try {
    const { default: createRPCS3 } = await import("./core/rpcs3-web.mjs");
    const module = await createRPCS3({
      locateFile: (name) => new URL(`./core/${name}`, scope.location.href).href,
      print: (line) => logs.push(String(line)),
      printErr: (line) => logs.push(String(line)),
    });
    const initialized = module.ccall("rpcs3_web_init", "number", [], []);
    const result = initialized
      ? module.ccall("rpcs3_web_install_firmware", "number", ["string"], [event.data.path])
      : 1;
    scope.postMessage({
      type: "firmware-result",
      ok: initialized === 1 && result === 0,
      initialized,
      result,
      progress: module.ccall("rpcs3_web_firmware_progress", "number", [], []),
      total: module.ccall("rpcs3_web_firmware_total", "number", [], []),
      hasFirmware: Boolean(module.ccall("rpcs3_web_has_firmware", "number", [], [])),
      devFlashPath: module.ccall("rpcs3_web_dev_flash_path", "string", [], []),
      elapsedMs: performance.now() - startedAt,
      logs: logs.slice(-300),
    });
    module.PThread?.terminateAllThreads();
  } catch (error) {
    scope.postMessage({ type: "firmware-result", ok: false, detail: detail(error), logs: logs.slice(-300) });
  }
  scope.close();
});
