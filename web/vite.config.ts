import { defineConfig } from "vitest/config";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// The same-origin file library (scripts/serve-library.mjs) that OPFS imports
// download from. The hosted Ingress routes /library/ to it directly; locally
// the dev and preview servers proxy the prefix so the page stays same-origin.
const libraryProxy = {
  "^/library/": { target: process.env.RPCS3_LIBRARY_PROXY || "http://127.0.0.1:4181", changeOrigin: false },
};

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  server: { headers: isolationHeaders, proxy: libraryProxy },
  preview: {
    headers: isolationHeaders,
    proxy: libraryProxy,
    // The stable HTTPS origin for devices is an nginx Ingress that proxies to
    // this preview server, so its host header must be accepted.
    allowedHosts: ["rpcs3.appmana.com"],
  },
  build: {
    target: "safari26",
    sourcemap: true,
  },
  test: {
    include: ["tests/*.test.ts", "tests/*.test.mjs"],
  },
});
