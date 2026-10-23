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
        "script/vlCVX/utils.ts",
        "script/vlCVX/2_repartition/nonDelegators.ts",
        "script/shared/**/*.ts",
      ],
      // No-regression floor, not a quality target. The previous 80% gate never
      // ran (the v8 provider was not installed) and is not reachable today:
      // `vlCVX/utils.ts` is a single explorer-backed function with no unit
      // test, and `shared/effectiveVotes.ts` is covered only through its
      // consumer. Raise these as the untested modules gain coverage.
      thresholds: {
        branches: 60,
        functions: 87,
        lines: 73,
        statements: 67,
      },
    },
  },
});
