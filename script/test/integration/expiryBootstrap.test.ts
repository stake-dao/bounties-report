import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.EXPIRY_BOOTSTRAP_CHECK)("expiry bootstrap recovery", () => {
  it("resumes a partially persisted bootstrap without changing its checkpoint", () => {
    const repository = process.cwd();
    const directory = fs.mkdtempSync(path.resolve("script/test/integration/expiry-bootstrap-"));
    try {
      const folder = path.join(directory, "bounties-reports/expiry/bootstrap/1");
      fs.mkdirSync(folder, { recursive: true });
      fs.symlinkSync(path.join(repository, "script"), path.join(directory, "script"));
      fs.copyFileSync("bounties-reports/expiry/bootstrap/1/inputs.json", path.join(folder, "inputs.json"));
      fs.copyFileSync("bounties-reports/expiry/bootstrap/1/report.json", path.join(folder, "report.json"));
      const report = fs.readFileSync(path.join(folder, "report.json"), "utf8");
      const run = spawnSync(process.execPath, ["--import", path.join(repository, "node_modules/tsx/dist/loader.mjs"), path.join(repository, "script/vlCVX/expiry/reconcile.ts"), "1"], { cwd: directory, env: process.env, encoding: "utf8", timeout: 240000 });
      expect(run.status, `${run.error ?? ""}${run.stdout}${run.stderr}`).toBe(0);
      expect(fs.readFileSync(path.join(folder, "report.json"), "utf8")).toBe(report);
      expect(JSON.parse(fs.readFileSync(path.join(folder, "ledger.json"), "utf8"))).toEqual(JSON.parse(fs.readFileSync("bounties-reports/expiry/bootstrap/1/ledger.json", "utf8")));
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  }, 300000);
});
