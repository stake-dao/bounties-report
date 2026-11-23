import { describe, expect, it } from "vitest";
import {
  classifyLegacyRootStatus,
  isRetiredLegacyEntry,
} from "../../helpers/verifyLegacyRoot";

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const SOURCE_ROOT =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_ROOT =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

describe("classifyLegacyRootStatus", () => {
  it("returns OK for a matching root", () => {
    expect(
      classifyLegacyRootStatus({
        source: SOURCE_ROOT.toUpperCase(),
        onchain: SOURCE_ROOT,
      }),
    ).toBe("OK");
  });

  it("returns WAITING when the token is frozen", () => {
    expect(
      classifyLegacyRootStatus({ source: SOURCE_ROOT, onchain: ZERO_ROOT }),
    ).toBe("WAITING");
  });

  it("returns BLOCK for a non-zero mismatch", () => {
    expect(
      classifyLegacyRootStatus({ source: SOURCE_ROOT, onchain: OTHER_ROOT }),
    ).toBe("BLOCK");
  });
});

describe("isRetiredLegacyEntry", () => {
  const TOKEN = "0xF24d8651578a55b0C119B9910759a351A3458895";
  const STASH = "0x03E34b085C52985F6a5D27243F20C84bDdc01Db4";
  const clientReturning = (onchain: string) => ({
    readContract: async () => onchain,
  });
  const entry = { symbol: "sdBAL", address: TOKEN, root: SOURCE_ROOT, merkleContract: STASH };

  it("flags a root that governance replaced", async () => {
    expect(await isRetiredLegacyEntry(clientReturning(OTHER_ROOT), entry)).toBe(true);
  });

  it("keeps a live or frozen root", async () => {
    expect(await isRetiredLegacyEntry(clientReturning(SOURCE_ROOT.toUpperCase().replace("0X", "0x")), entry)).toBe(false);
    expect(await isRetiredLegacyEntry(clientReturning(ZERO_ROOT), entry)).toBe(false);
  });

  it("keeps entries it cannot check and fails on a bad read", async () => {
    expect(await isRetiredLegacyEntry(clientReturning(OTHER_ROOT), { ...entry, merkleContract: undefined })).toBe(false);
    await expect(isRetiredLegacyEntry(clientReturning("0x"), entry)).rejects.toThrow("invalid on-chain root");
  });
});
