/**
 * Apply the Union end-user split to the vlCVX merkles.
 *
 *   pnpm tsx script/vlCVX/union_reassign/2_mergeIntoLatestMerkle.ts
 *
 * Drops The Union's own claim and credits its balance to the end users computed
 * by 1_computeUnionMerkle.ts.
 *
 * This writes THREE files, because `vlcvx_merkle.json` is derived and not a
 * source. createCombinedMerkle rebuilds it every period as
 * mergeMerkleData(curve, fxn) from the two per-gauge bases, and re-seeds each
 * base from the PREVIOUS period's own copy — never from the combined file. So
 * patching only the combined merkle is undone by the next weekly run: the Union
 * is re-credited at its full balance and every end user drops back to their old
 * cumulative amount, which strands anyone who claimed in between (their next
 * claim() reverts on cumulative < claimed). The bases are patched alongside it.
 *
 * The combined merkle is DERIVED here the same way the pipeline derives it —
 * mergeMerkleData(curve, fxn), in that order — never patched on its own. The
 * root depends on leaf order, not only on the amounts: merging the same two
 * merkles in the opposite order yields a different root over an identical leaf
 * set. Patching the combined file independently therefore produces a root the
 * next weekly run would not reproduce, so the posted root is built the way the
 * pipeline will rebuild it.
 *
 * Amounts are SUMMED, never replaced: the merkles are cumulative and a large
 * share of the end users already hold a claim of their own.
 *
 * Writes under out/, drop-in replacements for the files under bounties-reports/,
 * which this script never touches. Nothing is written unless every invariant
 * below holds on all three files.
 */

import fs from "fs";
import path from "path";
import { getAddress, keccak256 } from "viem";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";
import { mergeMerkleData } from "../../shared/merkle/generateMerkleTree";
import { MerkleData } from "../../interfaces/MerkleData";
import {
  assertUnionNeverClaimed,
  basePath,
  isExcluded,
  latestMerkle,
  liveRounds,
  PROTOCOLS,
  Protocol,
  REPO,
  roundsDigest,
  UNION,
  unionLine,
  unionRounds,
} from "./shared";

const OUT = path.join(__dirname, "out");
const END_USERS = path.join(OUT, "union_end_user_merkle.json");

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

/**
 * Read a merkle and strip the reassigned tokens from the Union's claim.
 *
 * Only the tokens actually being redistributed are removed. The excluded lines
 * (dead or dust — see EXCLUDED_TOKENS) STAY on the Union's claim: dropping them
 * would destroy those totals outright, and the conservation invariant below
 * exists precisely to refuse that.
 */
function loadWithoutUnion(label: string, file: string) {
  const source: MerkleData = JSON.parse(fs.readFileSync(file, "utf8"));
  const before = totals(source);
  const unionKey = Object.keys(source.claims).find((a) => a.toLowerCase() === UNION);
  if (!unionKey) {
    throw new Error(`${label}: the Union holds no claim in ${path.relative(REPO, file)}`);
  }
  const held = source.claims[unionKey].tokens;
  const removed: string[] = [];
  const kept = new Map<string, bigint>();
  for (const token of Object.keys(held)) {
    if (isExcluded(token)) kept.set(getAddress(token), BigInt(held[token].amount));
    else removed.push(token);
  }
  for (const token of removed) delete held[token];
  // An entry with no tokens left would be a dangling address in the tree.
  if (Object.keys(held).length === 0) delete source.claims[unionKey];
  return { source, before, unionTokens: removed.length, retained: kept };
}

/**
 * Every invariant the reassignment has to satisfy, asserted identically on each
 * per-gauge base and on the combined merkle — the old version checked them only
 * on the single file it wrote.
 *
 * `source` is the original merkle with the Union already removed.
 */
function assertMerged(
  label: string,
  source: MerkleData,
  before: Map<string, bigint>,
  endUserClaims: MerkleData["claims"],
  merged: MerkleData,
  retained: Map<string, bigint>
): { overlap: number; leaves: number } {
  // Totals per token are conserved: the Union's balance moved, none was created.
  const after = totals(merged);
  for (const token of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(token) ?? 0n) !== (after.get(token) ?? 0n)) {
      throw new Error(
        `${label}/${token}: total moved from ${before.get(token)} to ${after.get(token)} — ` +
          `the merge is not conservative`
      );
    }
  }

  // The Union must survive holding EXACTLY the excluded lines and nothing else:
  // every reassigned token gone, every retained token still at its full amount.
  const unionKey = Object.keys(merged.claims).find((a) => a.toLowerCase() === UNION);
  if (retained.size === 0) {
    if (unionKey) throw new Error(`${label}: the Union survived the merge with nothing excluded`);
  } else {
    if (!unionKey) {
      throw new Error(
        `${label}: the Union was removed entirely, but ${retained.size} excluded line(s) were ` +
          `meant to stay on it — those totals would be destroyed`
      );
    }
    const held = merged.claims[unionKey].tokens;
    for (const token of Object.keys(held)) {
      if (!retained.has(getAddress(token))) {
        throw new Error(`${label}: the Union still holds ${token}, which was meant to be reassigned`);
      }
    }
    for (const [token, amount] of retained) {
      const got = held[token] ? BigInt(held[token].amount) : undefined;
      if (got !== amount) {
        throw new Error(
          `${label}: the Union should retain ${amount} of ${token} but holds ${got ?? "nothing"}`
        );
      }
    }
  }

  // No cumulative entry may regress: the distributor pays the difference
  // against what an address already claimed, so a lower amount strands it.
  for (const [address, claim] of Object.entries(source.claims)) {
    const now = merged.claims[getAddress(address)];
    if (!now) throw new Error(`${label}/${address}: dropped by the merge`);
    for (const [token, { amount }] of Object.entries(claim.tokens)) {
      const entry = now.tokens[getAddress(token)];
      if (!entry) throw new Error(`${label}/${address}/${token}: dropped by the merge`);
      if (BigInt(entry.amount) < BigInt(amount)) {
        throw new Error(`${label}/${address}/${token}: ${amount} regressed to ${entry.amount}`);
      }
    }
  }

  // Each end user must hold their prior amount plus their share, exactly.
  const priorKey = new Map(Object.keys(source.claims).map((a) => [getAddress(a), a]));
  const existing = new Set(priorKey.keys());
  let overlap = 0;
  for (const [address, claim] of Object.entries<any>(endUserClaims)) {
    const checksummed = getAddress(address);
    if (existing.has(checksummed)) overlap++;
    const prior = source.claims[priorKey.get(checksummed) ?? ""];
    for (const [token, { amount }] of Object.entries<any>(claim.tokens)) {
      const priorAmount = BigInt(prior?.tokens[getAddress(token)]?.amount ?? 0);
      const got = BigInt(merged.claims[checksummed].tokens[getAddress(token)].amount);
      if (got !== priorAmount + BigInt(amount)) {
        throw new Error(`${label}/${address}/${token}: ${got} != ${priorAmount} + ${amount}`);
      }
    }
  }

  const tree = new MerkleTree([], keccak256, { sortPairs: true });
  let leaves = 0;
  for (const [address, claim] of Object.entries(merged.claims)) {
    for (const [token, { amount, proof }] of Object.entries(claim.tokens)) {
      if (!tree.verify(proof, leafOf(address, token, amount), merged.merkleRoot)) {
        throw new Error(`${label}: proof does not verify: ${address} / ${token}`);
      }
      leaves++;
    }
  }

  return { overlap, leaves };
}

async function main() {
  if (!fs.existsSync(END_USERS)) {
    throw new Error(`missing ${path.relative(REPO, END_USERS)} — run 1_computeUnionMerkle.ts first`);
  }

  const endUsers = JSON.parse(fs.readFileSync(END_USERS, "utf8"));
  if (!endUsers.claimsByProtocol) {
    throw new Error(
      `${path.relative(REPO, END_USERS)} predates the per-protocol split and cannot be applied ` +
        `to the per-gauge bases — re-run 1_computeUnionMerkle.ts`
    );
  }

  const latest = latestMerkle();
  const combinedSource: MerkleData = JSON.parse(fs.readFileSync(latest.file, "utf8"));

  // Gate on the Union's OWN line, not on the whole source root. The root moves
  // on any unrelated regeneration of the merkle — ENG-2105 moved it without
  // touching a wei of the Union's line — and gating on it made a numerically
  // exact artefact refuse to apply, forcing a full 49-round re-run to change one
  // string. The amounts are what the split actually depends on.
  const line = unionLine(combinedSource, path.relative(REPO, latest.file));
  const pinned = new Map<string, bigint>(
    Object.entries<string>(endUsers.meta.unionClaim ?? {}).map(([token, amount]) => [
      token.toLowerCase(),
      BigInt(amount),
    ])
  );
  if (pinned.size === 0) {
    throw new Error(`${path.relative(REPO, END_USERS)} records no meta.unionClaim — re-run step 1`);
  }
  for (const token of new Set([...line.keys(), ...pinned.keys()])) {
    const now = line.get(token) ?? 0n;
    const then = pinned.get(token) ?? 0n;
    if (now !== then) {
      throw new Error(
        `the split was computed against a Union line holding ${then} of ${token} but ` +
          `${path.relative(REPO, latest.file)} now holds ${now} — recompute first`
      );
    }
  }
  // The line alone does not pin the allocation. Step 1 splits each round over
  // the delegator set at that round's own snapshot block, so a backfill that
  // reattributes an amount between rounds or protocols changes who gets paid
  // while leaving every per-token total — and therefore meta.unionClaim —
  // identical. Re-derive the round inputs and refuse a split that predates them.
  const digest = roundsDigest(liveRounds(unionRounds()).live);
  if (!endUsers.meta.roundsDigest) {
    throw new Error(
      `${path.relative(REPO, END_USERS)} records no meta.roundsDigest, so the split cannot be ` +
        `shown to match the current repartition files — re-run step 1`
    );
  }
  if (endUsers.meta.roundsDigest !== digest) {
    throw new Error(
      `the repartition files have changed since the split was computed ` +
        `(round inputs digest ${endUsers.meta.roundsDigest.slice(0, 16)}… now ${digest.slice(0, 16)}…). ` +
        `The Union's per-token line can be unchanged while rounds are reattributed, which moves ` +
        `the payout between delegator sets — re-run step 1`
    );
  }
  console.log(`rounds   inputs digest ${digest.slice(0, 16)}… matches the split`);

  if (endUsers.meta.sourcePeriod !== latest.period) {
    console.log(
      `note     split computed on period ${endUsers.meta.sourcePeriod}, applying to ` +
        `${latest.period}; the Union's line is unchanged so it still holds`
    );
  }

  // The old root stays claimable until the new one is accepted, so re-read the
  // claimed ledger here and not only at compute time: a Union claim inside that
  // window would leave the distributor short by exactly that amount, and it is
  // the end users who go unpaid.
  const checkedTokens = await assertUnionNeverClaimed(line.keys());
  console.log(`claimed  claimed(union, token) == 0 on all ${checkedTokens} tokens`);

  // ---- the bases must be the true source of the combined merkle -------------

  const sources = new Map<Protocol, MerkleData>();
  for (const protocol of PROTOCOLS) {
    const file = basePath(latest.period, protocol);
    if (!fs.existsSync(file)) {
      throw new Error(`missing ${path.relative(REPO, file)} — cannot patch the per-gauge bases`);
    }
    sources.set(protocol, JSON.parse(fs.readFileSync(file, "utf8")));
  }

  // Everything below relies on the combined merkle being exactly
  // mergeMerkleData(curve, fxn). Prove it against the file that is live today
  // before building the replacement the same way — if the bases do not
  // reproduce the current root, they are out of sync with it and patching them
  // would post a root nobody can reconstruct.
  const rebuiltSource = mergeMerkleData(sources.get("curve")!, sources.get("fxn")!);
  if (rebuiltSource.merkleRoot !== combinedSource.merkleRoot) {
    throw new Error(
      `${path.relative(REPO, latest.file)} is at ${combinedSource.merkleRoot} but its own ` +
        `curve+fxn bases rebuild to ${rebuiltSource.merkleRoot} — they are out of sync, so a ` +
        `patch applied to the bases would not reproduce the posted root`
    );
  }
  console.log(`bases    curve+fxn rebuild the live combined root exactly`);

  // ---- patch each base, then derive the combined merkle from them -----------

  const patched = new Map<Protocol, MerkleData>();
  for (const protocol of PROTOCOLS) {
    const file = basePath(latest.period, protocol);
    const claims = endUsers.claimsByProtocol[protocol] ?? {};
    if (Object.keys(claims).length === 0) {
      throw new Error(`${protocol}: the split credits nobody — re-run step 1`);
    }
    const { source, before, unionTokens, retained } = loadWithoutUnion(protocol, file);
    const merged = mergeMerkleData(source, { merkleRoot: "", claims } as MerkleData);
    const { overlap, leaves } = assertMerged(protocol, source, before, claims, merged, retained);
    patched.set(protocol, merged);
    console.log(
      `${protocol.padEnd(8)} ${path.relative(REPO, file)}\n` +
        `         claims ${Object.keys(merged.claims).length}, ${overlap} summed, removed the ` +
        `Union (${unionTokens} tokens), ${leaves} proofs verified`
    );
  }

  // Same construction, same order as createCombinedMerkle — so next week's run
  // reproduces this root byte for byte instead of a different tree over the
  // same amounts.
  const combined = mergeMerkleData(patched.get("curve")!, patched.get("fxn")!);
  const combinedNoUnion = loadWithoutUnion("combined", latest.file);
  const combinedChecks = assertMerged(
    "combined",
    combinedNoUnion.source,
    combinedNoUnion.before,
    endUsers.claims,
    combined,
    combinedNoUnion.retained
  );

  // What step 1 said should stay with the Union must be what actually stayed —
  // checked against the artefact rather than only against this file's own copy
  // of the exclusion list, so the two steps cannot drift apart silently.
  const declared = new Map<string, bigint>(
    Object.entries<any>(endUsers.meta.retainedByUnion ?? {}).map(([token, v]) => [
      getAddress(token),
      BigInt(v.amount),
    ])
  );
  for (const token of new Set([...declared.keys(), ...combinedNoUnion.retained.keys()])) {
    const want = declared.get(token) ?? 0n;
    const got = combinedNoUnion.retained.get(token) ?? 0n;
    if (want !== got) {
      throw new Error(
        `${token}: step 1 recorded ${want} wei retained by the Union but this merkle leaves ` +
          `${got} — the exclusion lists have drifted apart`
      );
    }
  }
  if (declared.size > 0) {
    console.log(`retained ${declared.size} excluded line(s) left on the Union's claim:`);
    for (const [token, amount] of declared) {
      console.log(`         ${amount.toString().padStart(26)} wei  ${token}`);
    }
  }

  // ---- write --------------------------------------------------------------

  fs.mkdirSync(OUT, { recursive: true });
  const written: string[] = [];
  for (const protocol of PROTOCOLS) {
    const dir = path.join(OUT, protocol);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "merkle_data_non_delegators.json");
    fs.writeFileSync(file, JSON.stringify(patched.get(protocol), null, 2));
    written.push(file);
  }
  const combinedFile = path.join(OUT, "vlcvx_merkle.json");
  fs.writeFileSync(combinedFile, JSON.stringify(combined, null, 2));
  written.push(combinedFile);

  console.log(`\nwrote ${written.length} files under ${path.relative(REPO, OUT)}`);
  for (const file of written) console.log(`  ${path.relative(OUT, file)}`);
  console.log(`  root         ${combinedSource.merkleRoot} -> ${combined.merkleRoot}`);
  console.log(
    `  claims       ${Object.keys(combinedSource.claims).length} -> ` +
      `${Object.keys(combined.claims).length}`
  );
  console.log(`  summed       ${combinedChecks.overlap} end users already held a claim`);
  console.log(`  verified     ${combinedChecks.leaves} proofs on the combined merkle`);
  console.log(
    `\nAll three files must be promoted together: the bases are what next week's run ` +
      `re-seeds from,\nand the combined root above is the one that rebuild reproduces.\n` +
      `Re-check claimed(union, token) immediately before acceptRoot.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
