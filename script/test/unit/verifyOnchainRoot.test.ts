import { describe, expect, it } from "vitest";
import { classifyRootStatus } from "../../helpers/verifyOnchainRoot";

const ZERO_ROOT = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SOURCE_ROOT = "0x1111111111111111111111111111111111111111111111111111111111111111";
const OLD_ROOT = "0x2222222222222222222222222222222222222222222222222222222222222222";

describe("classifyRootStatus", () => {
  it("allows publish when matching pending root timelock has expired", () => {
    const result = classifyRootStatus({
      source: SOURCE_ROOT,
      onchain: OLD_ROOT,
      pendingRoot: SOURCE_ROOT,
      pendingValidAt: 1_000n,
      now: 1_001,
    });

    expect(result.status).toBe("READY");
    expect(result.reason).toContain("acceptRoot() callable");
  });

  it("skips publish while matching pending root is still timelocked", () => {
    const result = classifyRootStatus({
      source: SOURCE_ROOT,
      onchain: OLD_ROOT,
      pendingRoot: SOURCE_ROOT,
      pendingValidAt: 1_001n,
      now: 1_000,
    });

    expect(result.status).toBe("PENDING");
  });

  it("allows publish when on-chain root already matches source", () => {
    const result = classifyRootStatus({
      source: SOURCE_ROOT,
      onchain: SOURCE_ROOT,
      pendingRoot: ZERO_ROOT,
      pendingValidAt: 0n,
      now: 1_000,
    });

    expect(result.status).toBe("OK");
  });

  it("waits (noop) when no pending root has been submitted yet", () => {
    const result = classifyRootStatus({
      source: SOURCE_ROOT,
      onchain: OLD_ROOT,
      pendingRoot: ZERO_ROOT,
      pendingValidAt: 0n,
      now: 1_000,
    });

    expect(result.status).toBe("WAITING");
    expect(result.reason).toContain("set-root has not been called");
  });

  it("blocks publish when pending root is present but does not match source", () => {
    const result = classifyRootStatus({
      source: SOURCE_ROOT,
      onchain: OLD_ROOT,
      pendingRoot: OLD_ROOT,
      pendingValidAt: 0n,
      now: 1_000,
    });

    expect(result.status).toBe("BLOCK");
  });
});
