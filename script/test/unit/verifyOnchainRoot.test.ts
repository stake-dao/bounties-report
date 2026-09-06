import { describe, expect, it } from "vitest";
import { classifyRootStatus, collectFiles } from "../../helpers/verifyOnchainRoot";

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

describe("collectFiles", () => {
  it("targets the sdCRV URD on mainnet with the period merkle file", () => {
    const files = collectFiles("sdcrv", 1785369600);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(
      "bounties-reports/1785369600/sdTkns/sdtkns_merkle_1_sdcrv.json"
    );
    expect(files[0].chainId).toBe(1);
    expect(files[0].distributor).toBe("0x32dA29D7F3aD8cF157C6427CecFD3f0665042A37");
  });

  it("targets the sdFXN URD on mainnet with the period merkle file", () => {
    const files = collectFiles("sdfxn", 1785369600);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(
      "bounties-reports/1785369600/sdTkns/sdtkns_merkle_1_sdfxn.json"
    );
    expect(files[0].chainId).toBe(1);
    expect(files[0].distributor).toBe("0xdD03449c5b8F1e2aF92FaA45Db6CCA268479b990");
  });

  it("keeps the vlCVX delegators target unchanged", () => {
    const files = collectFiles("delegators", 1785369600);

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(
      "bounties-reports/1785369600/vlCVX/merkle_data_delegators.json"
    );
    expect(files[0].chainId).toBe(1);
    expect(files[0].distributor).toBe("0x17F513CDE031C8B1E878Bde1Cb020cE29f77f380");
  });
});
