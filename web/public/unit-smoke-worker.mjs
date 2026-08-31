self.addEventListener("message", async (event) => {
  if (event.data?.type !== "run-units") return;

  const output = [];
  try {
    const { default: createRPCS3Units } = await import(event.data.coreUrl || "./core/rpcs3-web-units.mjs");
    await createRPCS3Units({
      locateFile: (name) => name.endsWith(".wasm")
        ? (event.data.wasmUrl || new URL(`./core/${name}`, self.location.href).href)
        : name,
      print: (line) => output.push(String(line)),
      printErr: (line) => output.push(String(line)),
    });

    const marker = "RPCS3_WEB_UNIT_REPORT=";
    const reportLine = output.find((line) => line.startsWith(marker));
    if (!reportLine) throw new Error(`unit report marker missing; output: ${output.join("\n")}`);
    const report = JSON.parse(reportLine.slice(marker.length));
    self.postMessage({ type: "unit-result", ok: report.failed === 0, report, output });
  } catch (error) {
    self.postMessage({
      type: "unit-result",
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : String(error),
      output,
    });
  }
});
