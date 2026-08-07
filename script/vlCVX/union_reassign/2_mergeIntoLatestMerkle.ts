/**
 * Merge the Union end-user merkle into the latest vlCVX merkle.
 *
 *   pnpm tsx script/vlCVX/union_reassign/2_mergeIntoLatestMerkle.ts
 *
 * Takes the most recent `vlcvx_merkle.json` under bounties-reports/, drops The
 * Union's own claim and credits its balance to the end users computed by
 * 1_computeUnionMerkle.ts.
 *
 * Amounts are SUMMED, never replaced: the merkle is cumulative and a large
 * share of the end users already hold a claim of their own. The tree is built
 * with the pipeline's `mergeMerkleData`, so the leaf encoding matches what
 * createCombinedMerkle would have produced.
 *
 * Writes out/vlcvx_merkle.json — a drop-in replacement for the file under
 * bounties-reports/, which this script never touches. Nothing is written
 * unless every invariant below holds.
 */

import fs from "fs";
import path from "path";
import { getAddress, keccak256 } from "viem";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";
import { mergeMerkleData } from "../../shared/merkle/generateMerkleTree";
import { MerkleData } from "../../interfaces/MerkleData";

const HERE = __dirname;
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "out");
const END_USERS = path.join(OUT, "union_end_user_merkle.json");

/** The most recent round that has a mainnet vlCVX merkle. */
function latestMerkle(): { period: number; file: string } {
  const reports = path.join(REPO, "bounties-reports");
  const periods = fs
    .readdirSync(reports)
    .filter((d) => /^\d+$/.test(d))
    .map(Number)
    .filter((p) => fs.existsSync(path.join(reports, String(p), "vlCVX/vlcvx_merkle.json")))
    .sort((a, b) => a - b);
  if (periods.length === 0) throw new Error("no vlcvx_merkle.json under bounties-reports/");
  const period = periods[periods.length - 1];
  return { period, file: path.join(reports, String(period), "vlCVX/vlcvx_merkle.json") };
}

function leafOf(address: string, token: string, amount: string): string {
  return utils.keccak256(
    utils.solidityPack(
      ["bytes"],
      [
        utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["address", "address", "uint256"],
            [address, token, amount]
          )
        ),
      ]
    )
  );
}

function totals(merkle: MerkleData): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const claim of Object.values(merkle.claims)) {
    for (const [token, { amount }] of Object.entries(claim.tokens)) {
      const t = getAddress(token);
      out.set(t, (out.get(t) ?? 0n) + BigInt(amount));
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(END_USERS)) {
    throw new Error(`missing ${path.relative(REPO, END_USERS)} — run 1_computeUnionMerkle.ts first`);
  }

  const latest = latestMerkle();
  const source: MerkleData = JSON.parse(fs.readFileSync(latest.file, "utf8"));
  const endUsers = JSON.parse(fs.readFileSync(END_USERS, "utf8"));
  const union = getAddress(endUsers.meta.union);

  if (endUsers.meta.sourceMerkleRoot !== source.merkleRoot) {
    throw new Error(
      `the split was computed against root ${endUsers.meta.sourceMerkleRoot} but ` +
        `${path.relative(REPO, latest.file)} is at ${source.merkleRoot} — recompute first`
    );
  }

  const before = totals(source);

  const unionKey = Object.keys(source.claims).find((a) => getAddress(a) === union);
  if (!unionKey) throw new Error("the Union holds no claim in the latest merkle");
  const unionTokens = Object.keys(source.claims[unionKey].tokens).length;
  delete source.claims[unionKey];

  // How many end users already hold a claim — the ones whose amounts are summed.
  const existing = new Set(Object.keys(source.claims).map((a) => getAddress(a)));
  const overlap = Object.keys(endUsers.claims).filter((a) => existing.has(getAddress(a)));

  const merged = mergeMerkleData(source, endUsers as MerkleData);

  // ---- invariants ---------------------------------------------------------

  const after = totals(merged);
  for (const token of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(token) ?? 0n) !== (after.get(token) ?? 0n)) {
      throw new Error(
        `${token}: total moved from ${before.get(token)} to ${after.get(token)} — ` +
          `the merge is not conservative`
      );
    }
  }

  if (Object.keys(merged.claims).some((a) => getAddress(a) === union)) {
    throw new Error("the Union survived the merge");
  }

  // No cumulative entry may regress: the distributor pays the difference
  // against what an address already claimed, so a lower amount strands it.
  for (const [address, claim] of Object.entries(source.claims)) {
    const now = merged.claims[getAddress(address)];
    for (const [token, { amount }] of Object.entries(claim.tokens)) {
      const got = BigInt(now.tokens[getAddress(token)].amount);
      if (got < BigInt(amount)) {
        throw new Error(`${address} / ${token}: ${amount} regressed to ${got}`);
      }
    }
  }

  // Each end user must hold their prior amount plus their share, exactly.
  for (const [address, claim] of Object.entries<any>(endUsers.claims)) {
    const prior = source.claims[
      Object.keys(source.claims).find((a) => getAddress(a) === getAddress(address)) ?? ""
    ];
    for (const [token, { amount }] of Object.entries<any>(claim.tokens)) {
      const priorAmount = BigInt(prior?.tokens[getAddress(token)]?.amount ?? 0);
      const got = BigInt(merged.claims[getAddress(address)].tokens[getAddress(token)].amount);
      if (got !== priorAmount + BigInt(amount)) {
        throw new Error(`${address} / ${token}: ${got} != ${priorAmount} + ${amount}`);
      }
    }
  }

  const tree = new MerkleTree([], keccak256, { sortPairs: true });
  let leaves = 0;
  for (const [address, claim] of Object.entries(merged.claims)) {
    for (const [token, { amount, proof }] of Object.entries(claim.tokens)) {
      if (!tree.verify(proof, leafOf(address, token, amount), merged.merkleRoot)) {
        throw new Error(`proof does not verify: ${address} / ${token}`);
      }
      leaves++;
    }
  }

  // ---- write --------------------------------------------------------------

  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "vlcvx_merkle.json");
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));

  console.log(`wrote ${path.relative(REPO, file)}`);
  console.log(`  merged into  ${path.relative(REPO, latest.file)}`);
  console.log(`  root         ${endUsers.meta.sourceMerkleRoot} -> ${merged.merkleRoot}`);
  console.log(
    `  claims       ${Object.keys(source.claims).length + 1} -> ${Object.keys(merged.claims).length}`
  );
  console.log(`  summed       ${overlap.length} end users already held a claim`);
  console.log(`  removed      ${union} (${unionTokens} tokens)`);
  console.log(`  verified     ${leaves} proofs, totals conserved on ${after.size} tokens`);
}

main();
