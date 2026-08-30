import { defineConfig } from "vitest/config";

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  base: process.env.BASE_PATH || "/",
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    target: "safari26",
    sourcemap: true,
  },
  test: {
    include: ["tests/*.test.ts"],
  },
});
