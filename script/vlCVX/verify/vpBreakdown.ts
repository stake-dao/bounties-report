/**
 * Per-address VP breakdown for a vlCVX round — who weighs what, and through
 * which channel the distribution pays them:
 *  - voter-direct            -> Thursday voters merkle (native tokens), vp from
 *                               the platform tally (getVote, frozen at close)
 *  - delegation (the pool)   -> split among delegators below
 *  - delegator-forwarder     -> Tuesday delegators merkle (sCRVUSD), weight as
 *                               incorporated in the delegate's vote (helper)
 *  - delegator-non-forwarder -> Thursday voters merkle (native tokens), same
 *                               helper weight
 *  - delegator-voted-direct  -> paid as voter-direct; helper weight is 0 or the
 *                               delta that stayed with the delegate
 *
 * Usage: pnpm tsx script/vlCVX/verify/vpBreakdown.ts [--out <file.json>]
 * Env: RPC_URL_1 to target a fork; VLCVX_ALLOW_ACTIVE_PROPOSAL=true to inspect
 * a still-active round (dry-runs). Defaults to
 * bounties-reports/<period>/vlCVX/vp_breakdown.json
 */
import type { PublicClient } from "viem";
import * as fs from "fs";
import * as path from "path";
import {
  CVX_SPACE,
  VOTIUM_FORWARDER,
  WEEK,
  CVX_GAUGE_VOTE_PLATFORM_CURVE,
  CVX_GAUGE_VOTE_PLATFORM_FXN,
  CVX_GAUGE_DELEGATION,
  CVX_GAUGE_VOTE_HELPER,
  VLCVX_ONCHAIN_DELEGATION_ADDRESS,
} from "../../utils/constants";
import {
  getOnChainProposal,
  getOnChainVoters,
} from "../../utils/gaugeVotePlatform";
import {
  getOnChainDelegators,
  getContributingWeightsAtVote,
} from "../../utils/onChainDelegation";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";
import { getClient } from "../../utils/getClients";

type Row = {
  address: string;
  role:
    | "voter-direct"
    | "delegation"
    | "delegator-forwarder"
    | "delegator-non-forwarder"
    | "delegator-voted-direct";
  vp: number;
  paidVia: "thursday-voters-merkle" | "tuesday-delegators-merkle" | "split-below" | "as-voter-direct";
  platform: "curve" | "fxn";
};

const allowActive = process.env.VLCVX_ALLOW_ACTIVE_PROPOSAL === "true";

async function breakdownForPlatform(
  platform: "curve" | "fxn",
  client: PublicClient
): Promise<{ rows: Row[]; meta: any } | null> {
  const platformAddress =
    platform === "curve"
      ? CVX_GAUGE_VOTE_PLATFORM_CURVE
      : CVX_GAUGE_VOTE_PLATFORM_FXN;

  let proposal;
  try {
    proposal = await getOnChainProposal(platformAddress, CVX_SPACE, client, {
      requireFinal: !allowActive,
    });
  } catch (e: any) {
    // Only the expected empty states are skippable; a real RPC/decode
    // failure must not read as "platform has no proposal".
    if (!/proposal/i.test(String(e?.message))) throw e;
    console.warn(`[${platform}] no usable proposal: ${e.message}`);
    return null;
  }

  const proposalId = Number(proposal.id);
  const votes = await getOnChainVoters(platformAddress, proposalId, proposal, client);
  const delegationVoter = VLCVX_ONCHAIN_DELEGATION_ADDRESS.toLowerCase();
  const voterSet = new Map<string, number>(
    votes.map((v: any) => [v.voter.toLowerCase(), v.vp])
  );
  const delegationVoted = voterSet.has(delegationVoter);

  const rows: Row[] = [];

  let delegators: string[] = [];
  let contributing: Record<string, number> = {};
  let forwardedMap: Record<string, boolean> = {};
  if (delegationVoted) {
    delegators = await getOnChainDelegators(
      CVX_GAUGE_DELEGATION,
      VLCVX_ONCHAIN_DELEGATION_ADDRESS,
      Number(proposal.snapshot),
      client
    );
    contributing = await getContributingWeightsAtVote(
      CVX_GAUGE_VOTE_HELPER,
      platformAddress,
      proposalId,
      VLCVX_ONCHAIN_DELEGATION_ADDRESS,
      delegators,
      client
    );
    const blockSnapshotEnd = allowActive
      ? Number(await client.getBlockNumber())
      : await getBlockNumberByTimestamp(proposal.end, "after", 1);
    const forwarded = await getForwardedDelegators(delegators, blockSnapshotEnd);
    delegators.forEach((d, i) => {
      forwardedMap[d.toLowerCase()] =
        forwarded[i].toLowerCase() === VOTIUM_FORWARDER.toLowerCase();
    });
  }

  const delegatorSet = new Set(delegators.map((d) => d.toLowerCase()));
  for (const vote of votes) {
    const addr = vote.voter.toLowerCase();
    if (addr === delegationVoter) {
      rows.push({ address: addr, role: "delegation", vp: vote.vp, paidVia: "split-below", platform });
    } else if (delegatorSet.has(addr)) {
      rows.push({ address: addr, role: "delegator-voted-direct", vp: vote.vp, paidVia: "as-voter-direct", platform });
    } else {
      rows.push({ address: addr, role: "voter-direct", vp: vote.vp, paidVia: "thursday-voters-merkle", platform });
    }
  }
  for (const d of delegators) {
    const addr = d.toLowerCase();
    const w = contributing[addr] || 0;
    if (voterSet.has(addr)) continue; // already listed as delegator-voted-direct
    if (w === 0) continue; // off-epoch / zero contribution
    rows.push({
      address: addr,
      role: forwardedMap[addr] ? "delegator-forwarder" : "delegator-non-forwarder",
      vp: w,
      paidVia: forwardedMap[addr] ? "tuesday-delegators-merkle" : "thursday-voters-merkle",
      platform,
    });
  }

  const sumContributing = Object.values(contributing).reduce((a, b) => a + b, 0);
  const meta = {
    platform,
    proposalId,
    epoch: Number(proposal.snapshot),
    votersCount: votes.length,
    delegationVoted,
    delegationVp: voterSet.get(delegationVoter) ?? 0,
    delegatorsEnumerated: delegators.length,
    sumContributingWeights: sumContributing,
  };
  console.log(
    `[${platform}] proposal #${proposalId} (epoch ${meta.epoch}): ${meta.votersCount} voters, ` +
      `delegation vp ${meta.delegationVp.toFixed(2)}, sum contributing ${sumContributing.toFixed(2)} ` +
      `(${delegators.length} delegators)`
  );
  return { rows, meta };
}

(async () => {
  const outArg = process.argv.indexOf("--out");
  const client = await getClient(1);
  const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  if (outArg !== -1 && !process.argv[outArg + 1]) {
    throw new Error("--out requires a path argument");
  }
  const outPath =
    outArg !== -1
      ? process.argv[outArg + 1]
      : path.join("bounties-reports", `${currentPeriod}`, "vlCVX", "vp_breakdown.json");

  const results = [];
  for (const platform of ["curve", "fxn"] as const) {
    const r = await breakdownForPlatform(platform, client);
    if (r) results.push(r);
  }

  const out = {
    generatedAt: Math.floor(Date.now() / 1000),
    period: currentPeriod,
    allowActive,
    platforms: results.map((r) => r.meta),
    rows: results.flatMap((r) => r.rows),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  const totals: Record<string, { count: number; vp: number }> = {};
  for (const row of out.rows) {
    const key = `${row.platform}:${row.role}`;
    totals[key] = totals[key] || { count: 0, vp: 0 };
    totals[key].count++;
    totals[key].vp += row.vp;
  }
  console.table(
    Object.entries(totals).map(([k, v]) => ({
      "platform:role": k,
      addresses: v.count,
      "vp (vlCVX)": v.vp.toFixed(2),
    }))
  );
  console.log(`vp breakdown written to ${outPath} (${out.rows.length} rows)`);
})();
