import { defineConfig } from "vitest/config";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  server: { headers: isolationHeaders },
  preview: {
    headers: isolationHeaders,
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
