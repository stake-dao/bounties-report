import assert from "node:assert/strict";
import fs from "node:fs";
import { getAddress, PublicClient } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { ABI, PublicationIntent, readJournal } from "../../recovery/publicationJournal";
import { TREASURY_RECIPIENT, VOTERS } from "../../recovery/prepare";
import { toPairMap } from "./artifact";
import { fetchClaimed, unionPairKeys } from "./preservation";
import { PairMap } from "./types";

/** Independent arithmetic check: paid offsets and Treasury settlement are not
 * this week's earnings and must not enter cross-tree exclusivity deltas. */
export async function monthlyVotersGains(tree: MerkleData, period: number, client: PublicClient, block: bigint): Promise<PairMap | undefined> {
  const state = readJournal("voters-1");
  if (!state) return;
  const candidate: PublicationIntent = JSON.parse(fs.readFileSync(`bounties-reports/${period}/vlCVX/vlcvx_publication.json`, "utf8"));
  assert(candidate.version === 1 && candidate.pool === "voters-1" && candidate.kind !== "cut", "invalid voters publication");
  assert.deepEqual(candidate.sources, [`voters:${period}`], "voters source period mismatch");
  assert.deepEqual(candidate.merkle, tree, "voters envelope differs from verified tree");
  const root = await client.readContract({ address: VOTERS, abi: ABI, functionName: "root", blockNumber: block });
  if (root === tree.merkleRoot) {
    assert.deepEqual(candidate, state.lastPublication, "active publication not adopted");
  } else {
    assert(root === state.ledger.root && candidate.parent === root && candidate.revision === state.revision, "stale voters publication");
    assert(!(state.creditedSources ?? []).includes(candidate.sources[0]), "voters source already credited");
    const current = toPairMap(tree), previous = toPairMap(state.merkle);
    const claimed = await fetchClaimed(client, { target: "voters", chainId: 1, distributor: VOTERS, pinnedBlock: block }, unionPairKeys(current, previous));
    assert(candidate.kind === (state.adopted ? "settlement" : "ordinary"), "voters publication phase mismatch");
    for (const [account, token] of unionPairKeys(current, previous)) {
      const prior = previous.get(account)?.get(token) ?? 0n;
      const paid = claimed.get(`${account}:${token}`)!;
      const credit: bigint = account === TREASURY_RECIPIENT ? BigInt(state.adopted?.reserve[token] ?? "0") : 0n;
      const gain = BigInt(candidate.gains[account]?.[token] ?? "0");
      assert(gain >= 0n && credit >= 0n, "negative voters allocation");
      assert.equal(current.get(account)?.get(token), (prior > paid ? prior : paid) + gain + credit, "voters normalized allocation mismatch");
    }
  }
  const gains: PairMap = new Map();
  for (const [account, tokens] of Object.entries(candidate.gains)) {
    assert.equal(account, getAddress(account), "noncanonical gains account");
    gains.set(account, new Map());
    for (const [token, value] of Object.entries(tokens)) {
      assert.equal(token, getAddress(token), "noncanonical gains token");
      assert(tree.claims[account]?.tokens[token] && /^\d+$/.test(value), "unpublished or invalid gain");
      if (BigInt(value)) gains.get(account)!.set(token, BigInt(value));
    }
  }
  return gains;
}
