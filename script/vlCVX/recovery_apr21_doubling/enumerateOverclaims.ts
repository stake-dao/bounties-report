import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
import { createPublicClient, getAddress, http, parseAbi } from "viem";
import { mainnet } from "../../utils/chains";
import {
  SCRVUSD,
  VLCVX_DELEGATORS_MERKLE,
  WEEK,
} from "../../utils/constants";
import type { MerkleData } from "../../interfaces/MerkleData";

dotenv.config();

/**
 * Enumerate over-claimers for the 2× delegators merkle incident (period 1776297600).
 *
 * Context: on 2026-04-21 a manual `merkle`-step re-run read a stale `latest/`
 * (that already held the current period's cumulative) and produced a merkle with
 * double the intended delta. That bad merkle was submitted on-chain as root
 * `0x24adda71b01b9f7fd6a7049b5eea4175f9ad92621cefce12c5aa2da4df191e0b`.
 * Users who claimed under it received up to 2× their correct week-A share.
 *
 * This script: for each delegator present in the correct week-A merkle, reads
 * the distributor's `claimed(account, sCRVUSD)` value (cumulative lifetime
 * claim from the URD) and compares with the correct week-A cumulative to
 * identify who over-claimed and by how much.
 *
 * Inputs (CLI flags or defaults):
 *   --correct <path>   Correct week-A merkle JSON path
 *                      default: bounties-reports/1776297600/vlCVX/merkle_data_delegators.json
 *                      (assumes it has been regenerated with the fix; the buggy
 *                       2× file MUST be replaced before running this script)
 *   --out <path>       Output JSON
 *                      default: script/vlCVX/recovery_apr21_doubling/overclaimers.json
 *
 * Output: JSON with
 *   { totals, overclaimers[], underclaimers[], fullyClaimed[] }
 */

const URD_ABI = parseAbi([
  "function claimed(address account, address reward) view returns (uint256)",
  "function root() view returns (bytes32)",
]);

const BAD_ROOT =
  "0x24adda71b01b9f7fd6a7049b5eea4175f9ad92621cefce12c5aa2da4df191e0b";

function parseArgs(): { correctPath: string; outPath: string } {
  const args = process.argv.slice(2);
  let correctPath = path.join(
    "bounties-reports",
    "1776297600",
    "vlCVX",
    "merkle_data_delegators.json",
  );
  let outPath = path.join(
    "script",
    "vlCVX",
    "recovery_apr21_doubling",
    "overclaimers.json",
  );
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--correct" && args[i + 1]) correctPath = args[++i];
    else if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
  }
  return { correctPath, outPath };
}

async function main() {
  const { correctPath, outPath } = parseArgs();

  if (!fs.existsSync(correctPath)) {
    throw new Error(`Correct merkle not found at ${correctPath}`);
  }
  const correct: MerkleData = JSON.parse(fs.readFileSync(correctPath, "utf8"));

  if (correct.merkleRoot.toLowerCase() === BAD_ROOT.toLowerCase()) {
    throw new Error(
      `Supplied merkle still has the BAD root ${BAD_ROOT}. Regenerate with the fixed createDelegatorsMerkle.ts before running this script.`,
    );
  }

  const rpcUrl = process.env.WEB3_ALCHEMY_API_KEY
    ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.WEB3_ALCHEMY_API_KEY}`
    : "https://rpc.flashbots.net";
  const client = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const onchainRoot = await client.readContract({
    address: VLCVX_DELEGATORS_MERKLE as `0x${string}`,
    abi: URD_ABI,
    functionName: "root",
  });
  console.log(`Distributor       : ${VLCVX_DELEGATORS_MERKLE}`);
  console.log(`Current on-chain root: ${onchainRoot}`);
  console.log(`Correct week-A root  : ${correct.merkleRoot}`);
  console.log(`Accounts in correct merkle: ${Object.keys(correct.claims).length}`);

  // Collect all (account, correct_cumulative_scrvUsd) pairs
  type Row = {
    account: `0x${string}`;
    correctCumulative: bigint;
    onchainClaimed: bigint;
    overclaim: bigint;
    underclaim: bigint;
  };
  const rows: Row[] = [];
  const accounts = Object.keys(correct.claims).map((a) => getAddress(a));

  // Chunk the on-chain calls via multicall-style batching through viem's built-in
  // request batching; keep it simple with Promise.all of small groups.
  const BATCH = 50;
  for (let i = 0; i < accounts.length; i += BATCH) {
    const group = accounts.slice(i, i + BATCH);
    const results = await Promise.all(
      group.map((account) =>
        client.readContract({
          address: VLCVX_DELEGATORS_MERKLE as `0x${string}`,
          abi: URD_ABI,
          functionName: "claimed",
          args: [account, getAddress(SCRVUSD)],
        }),
      ),
    );
    for (let j = 0; j < group.length; j++) {
      const account = group[j];
      const onchainClaimed = results[j] as bigint;
      const tok = correct.claims[account]?.tokens?.[getAddress(SCRVUSD)];
      const correctCumulative = BigInt(tok?.amount ?? "0");
      const overclaim =
        onchainClaimed > correctCumulative ? onchainClaimed - correctCumulative : 0n;
      const underclaim =
        onchainClaimed < correctCumulative ? correctCumulative - onchainClaimed : 0n;
      rows.push({ account, correctCumulative, onchainClaimed, overclaim, underclaim });
    }
    if ((i / BATCH) % 4 === 0) {
      console.log(`  ...queried ${Math.min(i + BATCH, accounts.length)}/${accounts.length}`);
    }
  }

  const overclaimers = rows.filter((r) => r.overclaim > 0n);
  const underclaimers = rows.filter((r) => r.overclaim === 0n && r.underclaim > 0n);
  const fullyClaimed = rows.filter((r) => r.overclaim === 0n && r.underclaim === 0n);

  const sum = (arr: Row[], key: "overclaim" | "underclaim") =>
    arr.reduce((acc, r) => acc + r[key], 0n);
  const totalOverclaim = sum(overclaimers, "overclaim");
  const totalUnderclaim = sum(underclaimers, "underclaim");

  overclaimers.sort((a, b) => (a.overclaim < b.overclaim ? 1 : -1));
  underclaimers.sort((a, b) => (a.underclaim < b.underclaim ? 1 : -1));

  const fmt = (x: bigint) => (Number(x) / 1e18).toFixed(6);

  console.log("\n=== Summary ===");
  console.log(`Total accounts examined : ${rows.length}`);
  console.log(`Over-claimers           : ${overclaimers.length}`);
  console.log(`  Total overclaimed     : ${fmt(totalOverclaim)} sCRVUSD`);
  console.log(`Under-claimers (can still claim): ${underclaimers.length}`);
  console.log(`  Total outstanding     : ${fmt(totalUnderclaim)} sCRVUSD`);
  console.log(`Fully claimed (nothing to do)    : ${fullyClaimed.length}`);

  if (overclaimers.length > 0) {
    console.log(`\nAll ${overclaimers.length} over-claimers:`);
    for (const r of overclaimers) {
      console.log(
        `  ${r.account}  claimed=${fmt(r.onchainClaimed).padStart(14)}  entitled=${fmt(r.correctCumulative).padStart(14)}  surplus=${fmt(r.overclaim)}`,
      );
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    distributor: VLCVX_DELEGATORS_MERKLE,
    rewardToken: SCRVUSD,
    badRoot: BAD_ROOT,
    correctRoot: correct.merkleRoot,
    onchainRootAtRun: onchainRoot,
    totals: {
      accountsExamined: rows.length,
      overclaimerCount: overclaimers.length,
      underclaimerCount: underclaimers.length,
      fullyClaimedCount: fullyClaimed.length,
      totalOverclaimWei: totalOverclaim.toString(),
      totalOverclaimScrvUsd: fmt(totalOverclaim),
      totalUnderclaimWei: totalUnderclaim.toString(),
      totalUnderclaimScrvUsd: fmt(totalUnderclaim),
    },
    overclaimers: overclaimers.map((r) => ({
      account: r.account,
      onchainClaimedWei: r.onchainClaimed.toString(),
      correctCumulativeWei: r.correctCumulative.toString(),
      overclaimWei: r.overclaim.toString(),
      overclaimScrvUsd: fmt(r.overclaim),
    })),
    underclaimers: underclaimers.map((r) => ({
      account: r.account,
      onchainClaimedWei: r.onchainClaimed.toString(),
      correctCumulativeWei: r.correctCumulative.toString(),
      underclaimWei: r.underclaim.toString(),
      underclaimScrvUsd: fmt(r.underclaim),
    })),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
