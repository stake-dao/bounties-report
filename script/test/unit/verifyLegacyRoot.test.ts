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
const THIRD_ROOT =
  "0x3333333333333333333333333333333333333333333333333333333333333333";

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
  const entry = { symbol: "sdBAL", chainId: 1, address: TOKEN, root: SOURCE_ROOT, merkleContract: STASH };
  const registry = [
    {
      chainId: 1,
      token: TOKEN.toLowerCase(),
      merkleContract: STASH,
      retiredRoot: SOURCE_ROOT,
      replacementRoot: OTHER_ROOT,
      transactionHash: "0x01",
    },
  ];

  it("flags a recorded expiry whose replacement root is live", async () => {
    expect(await isRetiredLegacyEntry(clientReturning(OTHER_ROOT), entry, registry)).toBe(true);
  });

  it("keeps an unrecorded root mismatch for the publish gate to block", async () => {
    expect(await isRetiredLegacyEntry(clientReturning(OTHER_ROOT), entry, [])).toBe(false);
    expect(
      await isRetiredLegacyEntry(clientReturning(OTHER_ROOT), { ...entry, root: THIRD_ROOT }, registry),
    ).toBe(false);
  });

  it("keeps a recorded tree once the chain holds another root", async () => {
    expect(await isRetiredLegacyEntry(clientReturning(ZERO_ROOT), entry, registry)).toBe(false);
    expect(await isRetiredLegacyEntry(clientReturning(THIRD_ROOT), entry, registry)).toBe(false);
  });

  it("fails on a bad read", async () => {
    await expect(isRetiredLegacyEntry(clientReturning("0x"), entry, registry)).rejects.toThrow("invalid on-chain root");
  });

  it("records the Nov 19 sdBAL and sdPENDLE expiry", async () => {
    const live = { readContract: async ({ args }: any) =>
      args[0].toLowerCase() === TOKEN.toLowerCase()
        ? "0x65cde1e33680f0dfbbc615613e5cf727c8bca2f6ccfbbc38d6cadc48a4066650"
        : "0x17e0a56daba5c2085abb89144f8d9e9d7f9e3c67d4fce4b1a200ebdec0cd2d7e" };
    for (const [address, root] of [
      [TOKEN, "0xca4f979846d95ebbd96031b9d96042f016fae583ee91c05129185b466a7caea2"],
      ["0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9", "0xa3cbf3833ff5916d7559e6d502521ebb4c81702689d01b00dd828a3b803b0416"],
    ]) {
      expect(await isRetiredLegacyEntry(live, { chainId: 1, address, root, merkleContract: STASH })).toBe(true);
    }
  });
});
