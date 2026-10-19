import fs from "fs";
import os from "os";
import path from "path";
import { utils } from "ethers";
import { describe, expect, it } from "vitest";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { bootstrapExpiryLedger, expiryKey, prepareExpiry } from "../../shared/merkle/expiry";
import { replayExpiryJournal } from "../../vlCVX/expiry/journal";

describe("expiry canonical journal replay", () => {
  it("ignores self-hashed cached ages even when root and checkpoint are canonical", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-cache-"));
    try {
      const user = "0x0000000000000000000000000000000000000001";
      const token = "0x0000000000000000000000000000000000000002";
      const treasury = "0x0000000000000000000000000000000000000003";
      const hash = utils.hexZeroPad("0x01", 32);
      const now = Date.UTC(2026, 9, 29, 12) / 1000;
      const merkle = generateMerkleTree({ [user]: { [token]: "100" }, [treasury]: { [token]: "0" } });
      const claims = { [expiryKey(user, token)]: "0", [expiryKey(treasury, token)]: "0" };
      const ledger = bootstrapExpiryLedger(1, [{ root: utils.hexZeroPad("0x00", 32), block: 0, blockHash: hash, timestamp: 0, merkle: null }, { root: merkle.merkleRoot, block: 10, blockHash: hash, timestamp: now - 86400, merkle }], claims, { block: 10, blockHash: hash });
      fs.writeFileSync(path.join(directory, "bootstrap.json"), JSON.stringify(ledger));
      const forged = structuredClone(ledger);
      forged.checkpoint.block = 11;
      forged.pairs[expiryKey(user, token)].credits[0].ageBoundAt = now - 365 * 86400;
      const id = utils.sha256(utils.toUtf8Bytes(JSON.stringify(forged)));
      fs.mkdirSync(path.join(directory, "states"));
      fs.writeFileSync(path.join(directory, "states", `${id}.json`), JSON.stringify(forged));
      fs.writeFileSync(path.join(directory, "current.json"), JSON.stringify({ state: id, root: forged.root, checkpoint: forged.checkpoint }));
      const client: any = {
        getBlock: async ({ blockNumber }: any) => ({ number: blockNumber ?? 11n, hash, timestamp: BigInt(now) }),
        readContract: async () => ledger.root,
        getLogs: async () => [],
      };
      const domain = { address: user, safe: treasury, preparer: treasury, delay: 10800 };
      const actual = await replayExpiryJournal(client, directory, domain);
      expect(actual.pairs).toEqual(ledger.pairs);
      const policy = { treasury, approval: { reference: "fixture", passedAt: 0 }, notices: [{ url: "https://gov.stakedao.org/t/fixture", announcedAt: 0 }, { url: "https://stakedao.org/fixture", announcedAt: 0 }] };
      expect(prepareExpiry(actual, merkle, policy, token, 242, 0, now, domain)).toBeNull();
      await expect(replayExpiryJournal(client, directory, domain, { block: 12, blockHash: hash })).rejects.toThrow("not finalized");
      await expect(replayExpiryJournal(client, directory, domain, { block: 11, blockHash: utils.hexZeroPad("0x02", 32) })).rejects.toThrow("reorged");
      fs.mkdirSync(path.join(directory, "prepared"));
      fs.writeFileSync(path.join(directory, "prepared", "forged.json"), JSON.stringify({ chainId: 1, distributor: ledger.distributor, module: { ...domain, address: token } }));
      await expect(replayExpiryJournal(client, directory, domain)).rejects.toThrow("unreviewed expiry module");
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });
});
