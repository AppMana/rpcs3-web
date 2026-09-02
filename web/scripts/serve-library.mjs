// Same-origin library server for OPFS imports: @appmana-public/disc-images'
// serve-library (exact Range semantics, HEAD, strong ETags, no-store, a JSON
// index with SHA-256 digests) with RPCS3's defaults, public/fixtures when no
// source is given and the hash cache under ~/.cache/rpcs3-web-library/. The
// Ingress mounts it under /library/ on the app's origin; `vite preview`
// proxies the same prefix locally.
//
//   node scripts/serve-library.mjs [--port 4181] [--host 0.0.0.0] [--prefix /library]
//                                  [--dir <directory>]... [--file <file>]... [--cache <hashes.json>]
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_PORT, DEFAULT_PREFIX, createLibraryServer, parseArguments, strongETag } from "@appmana-public/disc-images/serve-library";

export { DEFAULT_PORT, DEFAULT_PREFIX, createLibraryServer, strongETag };
export const DEFAULT_LIBRARY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "fixtures");
export const DEFAULT_CACHE_FILE = path.join(homedir(), ".cache", "rpcs3-web-library", "hashes.json");

export function parseLibraryArguments(argv) {
  const hasSource = argv.includes("--dir") || argv.includes("--file");
  const options = parseArguments(hasSource ? argv : [...argv, "--dir", DEFAULT_LIBRARY_DIR]);
  options.cacheFile ??= DEFAULT_CACHE_FILE;
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseLibraryArguments(process.argv.slice(2));
  const library = await createLibraryServer(options);
  const address = await library.listen(options.port, options.host);
  process.stderr.write(`library: listening on http://${address.address}:${address.port}${library.prefix}/ with ${library.entries.size} files\n`);
  for (const entry of library.entries.values()) process.stderr.write(`library:   ${entry.name} (${entry.size} bytes)${entry.sha256 ? "" : " hashing"}\n`);
  const shutdown = () => { library.close().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
