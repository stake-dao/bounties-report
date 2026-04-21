import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { mainnet } from "viem/chains";
import { createPublicClient, http } from "viem";
import {
  escapeCSV,
  getGaugesInfos,
  getTokenInfo,
} from "../utils/reportUtils";
import { WEEK } from "../utils/constants";

// Balancer treasury-routed weekly report.
// This week USDC was sent to Stake DAO Governance (treasury) and sdBAL was
// returned manually instead of swapped via ALL_MIGHT. The normal
// generateReport.ts pipeline sees wethNotSwapped/tokensNotSwapped and emits
// zero sdBAL. This script rebuilds balancer.csv by distributing a known total
// sdBAL across bounties pro-rata to their USDC amounts.

dotenv.config();

const SDBAL = "0xF24d8651578a55b0C119B9910759a351A3458895";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("period", {
      type: "number",
      description: "Period timestamp (defaults to current week)",
    })
    .option("sdbal", {
      type: "string",
      demandOption: true,
      description: "Total sdBAL received from treasury (decimal, e.g. 979)",
    })
    .parseAsync();

  const currentPeriod =
    argv.period ?? Math.floor(Date.now() / 1000 / WEEK) * WEEK;
  const totalSdBal = Number(argv.sdbal);
  if (!Number.isFinite(totalSdBal) || totalSdBal <= 0) {
    throw new Error(`invalid --sdbal: ${argv.sdbal}`);
  }

  const bountiesPath = path.join(
    "weekly-bounties",
    String(currentPeriod),
    "votemarket-v2",
    "claimed_bounties.json"
  );
  if (!fs.existsSync(bountiesPath)) {
    throw new Error(`missing ${bountiesPath}`);
  }
  const claimed = JSON.parse(fs.readFileSync(bountiesPath, "utf-8"));
  const balancerBounties: Record<string, any> = claimed.balancer || {};
  const bounties = Object.values(balancerBounties);
  if (bounties.length === 0) {
    throw new Error("no balancer bounties for period");
  }

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(process.env.RPC_URL || undefined),
  });

  const gaugesInfo = await getGaugesInfos("balancer");
  const gaugeMap = new Map(
    gaugesInfo.map((g: any) => [
      g.address.toLowerCase(),
      { name: g.name, actualGauge: g.actualGauge },
    ])
  );

  // Aggregate by (gauge, rewardToken) and compute USDC (or any reward-token) amounts
  type Row = {
    gaugeKey: string;
    gaugeName: string;
    gaugeAddress: string;
    rewardToken: string;
    rewardAddress: string;
    rewardAmountRaw: bigint;
    rewardAmount: number;
  };
  const rowMap = new Map<string, Row>();
  const tokenInfoCache: Record<string, { symbol: string; decimals: number }> = {};

  for (const b of bounties as any[]) {
    const gaugeLower = b.gauge.toLowerCase();
    const tokenLower = b.rewardToken.toLowerCase();
    const key = `${gaugeLower}-${tokenLower}`;

    if (!tokenInfoCache[tokenLower]) {
      tokenInfoCache[tokenLower] = await getTokenInfo(
        publicClient as any,
        b.rewardToken
      );
    }
    const ti = tokenInfoCache[tokenLower];
    const raw = BigInt(b.amount);
    const amount = Number(raw) / Math.pow(10, ti.decimals);

    const gInfo = gaugeMap.get(gaugeLower);
    const gaugeName = gInfo?.name || "UNKNOWN";
    const gaugeAddress = gInfo?.actualGauge || b.gauge;

    const existing = rowMap.get(key);
    if (existing) {
      existing.rewardAmountRaw += raw;
      existing.rewardAmount += amount;
    } else {
      rowMap.set(key, {
        gaugeKey: key,
        gaugeName,
        gaugeAddress,
        rewardToken: ti.symbol,
        rewardAddress: b.rewardToken,
        rewardAmountRaw: raw,
        rewardAmount: amount,
      });
    }
  }

  const rows = Array.from(rowMap.values());
  const totalRewardAmount = rows.reduce((s, r) => s + r.rewardAmount, 0);
  if (totalRewardAmount <= 0) {
    throw new Error("totalRewardAmount == 0");
  }

  // Pro-rata distribution of sdBAL
  const enriched = rows.map((r) => {
    const share = r.rewardAmount / totalRewardAmount;
    const sdValue = totalSdBal * share;
    return {
      ...r,
      rewardSdValue: sdValue,
      sharePercentage: share * 100,
    };
  });

  // Sum check (drift from float)
  const sdSum = enriched.reduce((s, r) => s + r.rewardSdValue, 0);
  console.log(
    `bounties=${enriched.length} totalUSDCish=${totalRewardAmount.toFixed(
      6
    )} totalSdBal=${totalSdBal} distributed=${sdSum.toFixed(6)} drift=${(
      sdSum - totalSdBal
    ).toExponential(3)}`
  );

  const outDir = path.join("bounties-reports", String(currentPeriod));
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "balancer.csv");

  const csv = [
    "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
    ...enriched.map(
      (r) =>
        `${escapeCSV(r.gaugeName)};${escapeCSV(r.gaugeAddress)};` +
        `${escapeCSV(r.rewardToken)};${escapeCSV(r.rewardAddress)};` +
        `${r.rewardAmount.toFixed(6)};${r.rewardSdValue.toFixed(6)};` +
        `${r.sharePercentage.toFixed(2)}`
    ),
  ].join("\n");

  fs.writeFileSync(outPath, csv);
  console.log(`wrote ${outPath}`);

  // Attribution file companion (mirrors balancer-attribution.json shape loosely)
  const attribution = {
    protocol: "balancer",
    period: currentPeriod,
    mode: "treasury-routed",
    treasury: "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063",
    sdToken: SDBAL,
    totalRewardAmount,
    totalSdBal,
    rows: enriched.map((r) => ({
      gauge: r.gaugeAddress,
      gaugeName: r.gaugeName,
      rewardAddress: r.rewardAddress,
      rewardToken: r.rewardToken,
      rewardAmount: r.rewardAmount,
      rewardSdValue: r.rewardSdValue,
      sharePercentage: r.sharePercentage,
    })),
  };
  const attrPath = path.join(outDir, "balancer-attribution.json");
  fs.writeFileSync(attrPath, JSON.stringify(attribution, null, 2));
  console.log(`wrote ${attrPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
