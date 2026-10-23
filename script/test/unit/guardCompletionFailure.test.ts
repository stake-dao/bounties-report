import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

it("reports the completion failure in both the job log and the result artifact", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "guard-completion-error-"));
  const resultPath = path.join(directory, "result.json");
  try {
    // Run the local tsx loader directly: spawning `pnpm` inherits whatever
    // workspace pnpm discovers above the repo and breaks in nested worktrees.
    const processResult = spawnSync(
      process.execPath,
      ["--import", "tsx", "script/reports/guardCompletion.ts", "invalid"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, JOB_RESULT_PATH: resultPath, PROTOCOL: "curve" },
      }
    );
    expect(processResult.status).toBe(1);
    expect(existsSync(resultPath), processResult.stderr).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result).toEqual({ status: "error", reason: "Expected fetch or publish" });
    expect(processResult.stderr).toContain(result.reason);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
