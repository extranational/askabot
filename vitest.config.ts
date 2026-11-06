import { defineConfig } from "vitest/config";

// Default environment stays "node" (Worker tests). Component tests opt in to jsdom
// per file with a `// @vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
  },
});
