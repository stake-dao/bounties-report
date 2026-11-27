import { describe, expect, it } from "vitest";
import { capture, exportIdentity } from "../../helpers/distributionIdentity";

const epoch = 1793836800;
const revision = "b".repeat(40);
const root = `0x${"1a".repeat(32)}`;
const token = "0x0000000000000000000000000000000000000001";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("distribution identity", () => {
  it("binds the verified bytes across commit/rebase instead of trusting latest main", () => {
    const original = bytes({ merkleRoot: root, claims: { a: "one" } });
    const snapshot = capture("vlcvx-delegators", epoch, () => original);
    expect(exportIdentity(snapshot, revision, () => original)).toEqual({ ...snapshot, revision });
    const changed = bytes({ merkleRoot: root, claims: { a: "two" } });
    expect(() => exportIdentity(snapshot, revision, () => changed)).toThrow(/changed after verification/);
    expect(() => exportIdentity(snapshot, "main", () => original)).toThrow(/immutable/);
  });

  it("binds both sdToken liabilities and claims, requiring post-freeze verification for submit", () => {
    let distribution = { period: epoch, tokens: [{ address: token, root }], verified: false, postFreeze: false };
    let claims = bytes([{ old: "claims" }]);
    const read = (path: string) => path.endsWith("merkle.json") ? claims : bytes(distribution);
    expect(capture("sdtokens-check", epoch, read).roots).toEqual({ [token]: root });
    expect(() => capture("sdtokens-submit", epoch, read)).toThrow(/post-freeze/);
    distribution = { ...distribution, verified: true, postFreeze: true };
    const snapshot = capture("sdtokens-submit", epoch, read);
    claims = bytes([{ new: "claims" }]);
    expect(() => exportIdentity(snapshot, revision, read)).toThrow(/changed after verification/);
    expect(() => capture("sdtokens-check", epoch + 604800, read)).toThrow(/epoch mismatch/);
  });
});
