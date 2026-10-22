import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    globalSetup: ["./tests/helpers/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    // Tests share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 120000,
  },
});
