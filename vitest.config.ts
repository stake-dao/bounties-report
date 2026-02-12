import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["script/test/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      provider: "v8",
      include: [
        "script/vlAURA/utils.ts",
        "script/vlCVX/utils.ts",
        "script/vlAURA/2_repartition/nonDelegators.ts",
        "script/vlCVX/2_repartition/nonDelegators.ts",
        // After refactor, these will be the shared modules:
        "script/shared/**/*.ts",
      ],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
