// Runs one of the kit's installed commands with RPCS3's defaults. The kit's
// bin scripts execute on import, so they are spawned rather than imported.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";

export function kitBinPath(packageName, binName) {
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve(`${packageName}/package.json`));
  return path.join(packageRoot, "bin", `${binName}.js`);
}

export function runKitBin(packageName, binName, args) {
  const result = spawnSync(process.execPath, [kitBinPath(packageName, binName), ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

/**
 * The persistent Chrome profile whose origin-private storage holds RPCS3's
 * firmware and games, from RPCS3_WEB_URL (keep it stable: storage is per
 * origin), RPCS3_CHROME_PROFILE, RPCS3_CHROME_PATH, and RPCS3_HEADED=1.
 */
export function rpcs3ProfileArguments(env = process.env) {
  return [
    "--url", env.RPCS3_WEB_URL || "http://127.0.0.1:4175",
    "--page", "/storage.html",
    "--profile", env.RPCS3_CHROME_PROFILE || path.join(homedir(), ".cache", "rpcs3-web-chrome-profile"),
    "--chrome", env.RPCS3_CHROME_PATH || "/usr/bin/google-chrome",
    ...(env.RPCS3_HEADED === "1" ? ["--headed"] : []),
  ];
}
