import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entrypoint = path.join(root, "script/vlCVX/3_merkles/createDelegatorsMerkle.ts");
const period = 1795046400;

describe("delegators Merkle entrypoint dispatch epoch", () => {
  it.each([
    ["", true],
    [`vlcvx-delegators:${period}:run:step:merkle-delegators-1`, true],
    ["vlcvx-delegators:1794441600:run:step:merkle-delegators-1", false],
    ["vlcvx-delegators:1795651200:run:step:merkle-delegators-1", false],
    [`vlcvx-delegators:${period}0:run:step:merkle-delegators-1`, false],
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
      expect(result.status === 0).toBe(accepted);
      if (accepted) expect(output).toContain("No forwarders found");
      else expect(output).toContain("current reward epoch");
      expect(fs.existsSync(path.join(report, "merkle_data_delegators.json"))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
