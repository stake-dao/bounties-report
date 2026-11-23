import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const period = 1795046400;

describe.each([
  ["delegators", "vlcvx-delegators", "createDelegatorsMerkle.ts"],
  ["voters", "votemarket-v2", "createCombinedMerkle.ts"],
])("%s Merkle entrypoint dispatch epoch", (kind, pipeline, filename) => {
  const entrypoint = path.join(root, "script/vlCVX/3_merkles", filename);
  it.each([
    ["", true],
    [`${pipeline}:${period}:run:step:merkle-1`, true],
    [`${pipeline}:1794441600:run:step:merkle-1`, false],
    [`${pipeline}:1795651200:run:step:merkle-1`, false],
    [`${pipeline}:${period}0:run:step:merkle-1`, false],
    [`vlcvx-voters:${period}:run:step:merkle-delegators-1`, false],
    ["malformed", false],
  ])("dispatch %s accepted=%s", (dispatchId, accepted) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "delegators-epoch-"));
    try {
      // No forwarders: a valid invocation exits without RPC or generated files.
      const report = path.join(cwd, "bounties-reports", String(period), "vlCVX");
      fs.mkdirSync(path.join(report, "curve"), { recursive: true });
      fs.writeFileSync(path.join(report, "curve/repartition_delegation.json"),
        JSON.stringify({ distribution: { totalForwardersShare: 0 } }));
      // Voters stop at the existing-artifact guard, before any RPC or generation.
      if (kind === "voters") fs.writeFileSync(path.join(report, "vlcvx_merkle.json"), "{}");
      const clock = path.join(cwd, "clock.cjs");
      fs.writeFileSync(clock, "Date.now = () => 1795449600000;\n");
      const result = spawnSync(process.execPath, [
        "--require", clock, "--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), entrypoint,
      ], { cwd, encoding: "utf8", timeout: 20_000, env: {
        PATH: process.env.PATH, MAESTRO_DISPATCH_ID: dispatchId,
        // Force regeneration must not bypass epoch validation.
        FORCE_MERKLE: "true",
      } });
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      expect(result.signal).toBeNull();
      if (accepted) {
        expect(output).toContain(kind === "voters" ? "Merkle files already exist" : "No forwarders found");
        if (kind === "delegators") expect(result.status).toBe(0);
        expect(output).not.toContain("current reward epoch");
      } else {
        expect(result.status).not.toBe(0);
        expect(output).toContain("current reward epoch");
      }
      if (kind === "voters") expect(fs.readFileSync(path.join(report, "vlcvx_merkle.json"), "utf8")).toBe("{}");
      expect(fs.existsSync(path.join(report, "merkle_data_delegators.json"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
