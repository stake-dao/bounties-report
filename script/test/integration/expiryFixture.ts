import fs from "fs";
import path from "path";
import { utils } from "ethers";
import { getAddress } from "viem";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { MerkleData } from "../../interfaces/MerkleData";
import { expiryFrontier } from "../../shared/merkle/expiry";

const topic = path.resolve("..");
const output = path.join(topic, "contracts-monorepo/packages/shared/test/distributors/expiry/fixtures");
fs.mkdirSync(output, { recursive: true });
const treasury = getAddress("0x000000000000000000000000000000002109ffff");
const recent = getAddress("0x000000000000000000000000000000002109fffe");
for (const chainId of [1, 8453, 42161]) {
  const chain = JSON.parse(fs.readFileSync(path.join(topic, `chain-${chainId}.json`), "utf8"));
  const name = chainId === 1 ? "vlcvx_merkle.json" : `vlcvx_merkle_${chainId}.json`;
  let source = "";
  let parent: MerkleData | undefined;
  for (const period of fs.readdirSync("bounties-reports").filter(p => /^\d+$/.test(p)).sort().reverse()) {
    for (const file of [name, name.replace(".json", ".superseded.json")]) {
      const candidate = path.join("bounties-reports", period, "vlCVX", file);
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (data.merkleRoot.toLowerCase() !== chain["root()"].toLowerCase()) continue;
      source = candidate;
      parent = data;
      break;
    }
    if (parent) break;
  }
  if (!parent) throw new Error(`unresolved ${chainId} active root`);
  const original: Record<string, Record<string, string>> = {};
  for (const [account, claim] of Object.entries(parent.claims)) {
    original[account] = Object.fromEntries(Object.entries(claim.tokens).map(([token, value]) => [token, value.amount]));
  }
  if (generateMerkleTree(original).merkleRoot !== chain["root()"]) throw new Error(`reconstruction ${chainId}`);
  const untouchedAccount = Object.keys(original)[0];
  const token = Object.keys(original[untouchedAccount])[0];
  for (const count of [1, 16, 64]) {
    const rows = Array.from({ length: count }, (_, i) => ({
      account: getAddress(`0x${(0x21090000n + BigInt(i)).toString(16).padStart(40, "0")}`),
      amount: "1000000",
      expiredThrough: "600000",
    }));
    const distribution: Record<string, Record<string, string>> = {};
    const accounts = Object.entries(original);
    let inserted = 0;
    accounts.forEach(([account, tokens], i) => {
      while (inserted < count && Math.floor(inserted * accounts.length / count) === i) {
        const row = rows[inserted++];
        distribution[row.account] = { [token]: row.amount };
      }
      distribution[account] = tokens;
    });
    distribution[recent] = { [token]: "1000000" };
    distribution[treasury] = { [token]: "0" };
    const normal = generateMerkleTree(distribution);
    const proof = expiryFrontier(distribution, token, treasury, rows);
    const expiredDistribution = structuredClone(distribution);
    rows.slice(1).forEach(row => { expiredDistribution[row.account][token] = "400000"; });
    expiredDistribution[treasury][token] = String((count - 1) * 600000);
    const expired = generateMerkleTree(expiredDistribution);
    const getClaim = (merkle: MerkleData, account: string) => ({ account, token, ...merkle.claims[account].tokens[token] });
    const nextDistribution = structuredClone(expiredDistribution);
    const nextRows = rows.map(row => {
      const amount = String(BigInt(expiredDistribution[row.account][token]) + 100000n);
      nextDistribution[row.account][token] = amount;
      return { ...row, amount, expiredThrough: "0" };
    });
    const next = generateMerkleTree(nextDistribution);
    const split = Math.max(1, Math.floor(count / 2));
    const partialDistribution = structuredClone(distribution);
    rows.slice(1, split).forEach(row => { partialDistribution[row.account][token] = "400000"; });
    partialDistribution[treasury][token] = String((split - 1) * 600000);
    const partial = generateMerkleTree(partialDistribution);
    const fixture = {
      chainId, block: chain.block, liveRoot: chain["root()"], source,
      sourceSha256: utils.sha256(fs.readFileSync(source)),
      leafCount: Object.values(distribution).reduce((n, tokens) => n + Object.keys(tokens).length, 0),
      round: 238,
      token, treasury, normalRoot: normal.merkleRoot, expiredRoot: expired.merkleRoot,
      rows, ...proof,
      competing: getClaim(normal, rows[0].account),
      recent: getClaim(expired, recent),
      untouched: getClaim(expired, untouchedAccount),
      protected: getClaim(expired, rows[count === 1 ? 0 : 1].account),
      treasuryClaim: getClaim(expired, treasury),
      normalUntouched: getClaim(normal, untouchedAccount),
      next: { rows: nextRows, root: next.merkleRoot, ...expiryFrontier(nextDistribution, token, treasury, nextRows), newReward: getClaim(next, rows[0].account) },
      partial: {
        split, root: partial.merkleRoot,
        first: expiryFrontier(distribution, token, treasury, rows.slice(0, split)),
        second: count > 1 ? expiryFrontier(partialDistribution, token, treasury, rows.slice(split)) : null,
      },
    };
    fs.writeFileSync(path.join(output, `${chainId}-${count}.json`), JSON.stringify(fixture, null, 2) + "\n");
    console.log(JSON.stringify({ chainId, count, source, leaves: fixture.leafCount, program: utils.arrayify(proof.program).length, nodes: proof.nodes.length, normalRoot: normal.merkleRoot, expiredRoot: expired.merkleRoot }));
  }
}
