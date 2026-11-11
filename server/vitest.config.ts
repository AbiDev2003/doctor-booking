import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
