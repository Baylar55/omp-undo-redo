import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
