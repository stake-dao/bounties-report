import fs from "fs";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { assertExpiryLedger, bootstrapExpiryLedger, expiryKey, Ledger, prepareExpiry, Publication, sixCalendarMonths } from "../../shared/merkle/expiry";
import ageBound from "../../vlCVX/expiry/union-age-bound.json";

const USER = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const UNION = "0x0000000000000000000000000000000000000003";
const OTHER_TOKEN = "0x0000000000000000000000000000000000000004";
const UNKNOWN = "0x0000000000000000000000000000000000000005";
const TREASURY = "0x0000000000000000000000000000000000000006";
const BOUND = Date.UTC(2026, 3, 23, 12, 2, 11) / 1000;
const ASSIGNED = Date.UTC(2026, 7, 20, 17, 39, 47) / 1000;
const HASH = `0x${"1".repeat(64)}`;

function fixture() {
  const source = { [UNION]: { [TOKEN]: "100", [OTHER_TOKEN]: "80" }, [USER]: { [TOKEN]: "50" }, [UNKNOWN]: { [TOKEN]: "30" }, [TREASURY]: { [TOKEN]: "0" } };
  const publication = (block: number, timestamp: number, distribution: Record<string, Record<string, string>>): Publication => {
    const merkle = generateMerkleTree(distribution);
    return { root: merkle.merkleRoot, block, blockHash: HASH, timestamp, merkle };
  };
  const witness = publication(2, BOUND, source);
  const middle = publication(3, BOUND + 604800, source);
  const assigned = publication(4, ASSIGNED, { ...source, [UNION]: { [TOKEN]: "0", [OTHER_TOKEN]: "0" }, [USER]: { [TOKEN]: "200", [OTHER_TOKEN]: "80" } });
  const publications: Publication[] = [
    { root: `0x${"0".repeat(64)}`, block: 0, blockHash: HASH, timestamp: 0, merkle: null },
    { root: `0x${"2".repeat(64)}`, block: 1, blockHash: HASH, timestamp: BOUND - 86400, merkle: null },
    witness, middle, assigned,
  ];
  const claims = Object.fromEntries(Object.entries(assigned.merkle!.claims).flatMap(([account, claim]) => Object.keys(claim.tokens).map(token => [expiryKey(account, token), account === USER && token === TOKEN ? "50" : "0"])));
  const union = { root: assigned.root, amounts: { [expiryKey(USER, TOKEN)]: "100", [expiryKey(USER, OTHER_TOKEN)]: "80" }, ageBound: { account: UNION, witness: { root: witness.root, block: witness.block, blockHash: witness.blockHash, timestamp: witness.timestamp }, roots: [witness.root, middle.root, assigned.root], amounts: { [TOKEN]: "100" } } };
  return { publications, claims, union, checkpoint: { block: 4, blockHash: HASH } };
}

describe("Union conservative age bound", () => {
  it("preserves every persisted baseline field apart from scoped Union ageing metadata", () => {
    const ledger: Ledger = JSON.parse(fs.readFileSync("bounties-reports/expiry/bootstrap/1/ledger.json", "utf8"));
    const tokens = new Set(Object.keys(ageBound.amounts));
    let bounded = 0;
    for (const pair of Object.values(ledger.pairs)) {
      for (const credit of pair.credits) {
        if (credit.ageBoundAt === undefined) continue;
        expect(tokens.has(pair.token)).toBe(true);
        expect(credit.root).toBe("0x5d9f92267cf5949bfd969e46ba89951e06536b80e0b367892ea865e5118799cd");
        expect(credit.ageBoundAt).toBe(ageBound.witness.timestamp);
        expect(credit.protection).toBeNull();
        credit.protection = "unresolved Union ageing";
        delete credit.ageBoundAt;
        bounded++;
      }
    }
    expect(bounded).toBe(3360);
    expect(createHash("sha256").update(JSON.stringify(ledger)).digest("hex")).toBe("547538f070e26571639f0c581b6d5c2689354ce18a99e2b3b055e5bdbd36fe49");
  });

  it("keeps publication FIFO and prior payments while ageing only approved Union credits", () => {
    const { publications, claims, union, checkpoint } = fixture();
    const ledger = bootstrapExpiryLedger(1, publications, claims, checkpoint, union);
    const original = bootstrapExpiryLedger(1, publications, claims, checkpoint, { root: union.root, amounts: union.amounts });
    for (const [key, pair] of Object.entries(original.pairs)) {
      const credits = pair.credits.map(credit => pair.token === TOKEN && credit.protection === "unresolved Union ageing" ? { ...credit, protection: null, ageBoundAt: BOUND } : credit);
      expect(ledger.pairs[key]).toEqual({ ...pair, credits });
    }
    const credits = ledger.pairs[expiryKey(USER, TOKEN)].credits;
    expect(credits[0].paid).toBe("50");
    expect(credits[0].protection).toBe("unresolved history");
    expect(credits[1].granted).toBe("50");
    expect(credits[1].activatedAt).toBe(ASSIGNED);
    expect(credits[2]).toMatchObject({ granted: "100", paid: "0", protection: null, activatedAt: ASSIGNED, ageBoundAt: BOUND });
    expect(ledger.pairs[expiryKey(USER, OTHER_TOKEN)].credits[0].protection).toBe("unresolved Union ageing");
    expect(ledger.pairs[expiryKey(UNKNOWN, TOKEN)].credits[0].protection).toBe("unresolved history");
    expect(() => assertExpiryLedger(ledger)).not.toThrow();
    const policy = { treasury: TREASURY, approval: { reference: "fixture", passedAt: 0 }, notices: [{ url: "https://gov.stakedao.org/t/fixture", announcedAt: 0 }, { url: "https://stakedao.org/fixture", announcedAt: 0 }] };
    const domain = { address: "0x0000000000000000000000000000000000000007", safe: "0x0000000000000000000000000000000000000008", delay: 10800 };
    const expires = sixCalendarMonths(BOUND);
    expect(prepareExpiry(ledger, publications[4].merkle!, policy, TOKEN, 242, 0, expires - 1, domain)).toBeNull();
    expect(prepareExpiry(ledger, publications[4].merkle!, policy, TOKEN, 242, 0, expires, domain)!.batch.rows).toEqual([{ account: USER, amount: "200", expiredThrough: "150" }]);
  });

  it("consumes Union credit when a post-assignment claim pays the full active entitlement", () => {
    const { publications, claims, union, checkpoint } = fixture();
    claims[expiryKey(USER, TOKEN)] = "200";
    const ledger = bootstrapExpiryLedger(1, publications, claims, checkpoint, union);
    expect(ledger.pairs[expiryKey(USER, TOKEN)].credits[2]).toMatchObject({ granted: "100", paid: "100", recovered: "0" });
  });

  it("rejects a missing root or changed original pot after the witness", () => {
    const { publications, claims, union, checkpoint } = fixture();
    const missing = structuredClone(publications);
    missing[3].merkle = null;
    expect(() => bootstrapExpiryLedger(1, missing, claims, checkpoint, union)).toThrow("Union age");
    expect(() => bootstrapExpiryLedger(1, publications.filter((_, i) => i !== 3), claims, checkpoint, union)).toThrow("Union age history sequence");
    const changed = structuredClone(publications);
    changed[3].merkle!.claims[UNION].tokens[TOKEN].amount = "101";
    changed[3].merkle = generateMerkleTree(Object.fromEntries(Object.entries(changed[3].merkle!.claims).map(([account, claim]) => [account, Object.fromEntries(Object.entries(claim.tokens).map(([token, value]) => [token, value.amount]))])));
    changed[3].root = changed[3].merkle.merkleRoot;
    expect(() => bootstrapExpiryLedger(1, changed, claims, checkpoint, union)).toThrow("Union age");
  });

  it("rejects claimed source funds, altered dates and allocation mismatches", () => {
    const { publications, claims, union, checkpoint } = fixture();
    expect(() => bootstrapExpiryLedger(1, publications, { ...claims, [expiryKey(UNION, TOKEN)]: "1" }, checkpoint, union)).toThrow("Union age");
    const changed = structuredClone(union);
    changed.ageBound.witness.timestamp--;
    expect(() => bootstrapExpiryLedger(1, publications, claims, checkpoint, changed)).toThrow("Union age");
    const mismatched = structuredClone(union);
    mismatched.amounts[expiryKey(USER, TOKEN)] = "99";
    expect(() => bootstrapExpiryLedger(1, publications, claims, checkpoint, mismatched)).toThrow("Union age");
  });
});
