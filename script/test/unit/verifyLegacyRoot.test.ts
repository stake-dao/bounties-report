import { describe, expect, it } from "vitest";
import { classifyLegacyRootStatus } from "../../helpers/verifyLegacyRoot";

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
