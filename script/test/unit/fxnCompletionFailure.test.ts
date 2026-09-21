import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("reports the completion failure in both the job log and the result artifact", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fxn-completion-error-"));
  const resultPath = path.join(directory, "result.json");
  try {
    const processResult = spawnSync("pnpm", ["exec", "tsx", "script/reports/fxnCompletion.ts", "invalid"], {
      encoding: "utf8",
      env: { ...process.env, JOB_RESULT_PATH: resultPath },
    });
    expect(processResult.status).toBe(1);
    expect(existsSync(resultPath), processResult.stderr).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result).toEqual({ status: "error", reason: "Expected fetch or publish" });
    expect(processResult.stderr).toContain(result.reason);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
