import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { renderers } from "./build/renderers.ts";

export default defineConfig({
  plugins: [react(), renderers()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: true,
    testTimeout: 20_000,
  },
});
