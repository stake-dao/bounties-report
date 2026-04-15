import axios from "axios";
import request, { gql } from "graphql-request";
import * as fs from "fs";
import * as path from "path";
import { getAddress } from "viem";

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";
const SCORE_ENDPOINT = "https://score.snapshot.org/api/scores";
const DEFILLAMA_ENDPOINT = "https://coins.llama.fi/prices/current";
const CVX_LOCKER_V2 = "0x72a19342e8F1838460eBFCCEf09F6585e32db86E"; // Used by Snapshot cvx.eth space
const CVX_TOKEN = "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B";
const WEEK = 604800;

interface Proposal {
  id: string;
  title: string;
  snapshot: string;
  start: number;
  end: number;
}

async function getRecentProposals(): Promise<Proposal[]> {
  const query = gql`
    query {
      proposals(
        first: 4
        orderBy: "created"
        orderDirection: desc
        where: { space: "cvx.eth", type: "weighted", title_contains: "Gauge Weight for Week" }
      ) {
        id
        title
        snapshot
        start
        end
      }
    }
  `;
  const result: any = await request(SNAPSHOT_ENDPOINT, query);
  return result.proposals.filter((p: Proposal) => !p.title.startsWith("FXN"));
}

interface VotingPowerResult {
  total: number;
  direct: number;
  delegated: number;
}

async function getVotingPower(address: string, snapshotBlock: number | "latest"): Promise<VotingPowerResult> {
  const { data } = await axios.post(SCORE_ENDPOINT, {
    params: {
      network: "1",
      snapshot: snapshotBlock,
      strategies: [
        {
          name: "erc20-balance-of",
          params: { address: CVX_LOCKER_V2, symbol: "vlCVX", decimals: 18 }
        },
        {
          name: "erc20-balance-of-delegation",
          params: { address: CVX_LOCKER_V2, symbol: "vlCVX", decimals: 18 }
        }
      ],
      space: "cvx.eth",
      addresses: [address],
    },
  });
  const direct = data.result.scores[0][address] || 0;
  const delegated = data.result.scores[1][address] || 0;
  return { total: direct + delegated, direct, delegated };
}

async function getCVXPrice(): Promise<number> {
  const { data } = await axios.get(`${DEFILLAMA_ENDPOINT}/ethereum:${CVX_TOKEN.toLowerCase()}`);
  return data.coins[`ethereum:${CVX_TOKEN.toLowerCase()}`]?.price || 0;
}

interface TokenInfo {
  price: number;
  decimals: number;
  symbol: string;
}

async function getTokenPrices(tokens: string[]): Promise<Record<string, TokenInfo>> {
  if (tokens.length === 0) return {};

  // Batch query DefiLlama
  const coins = tokens.map(t => `ethereum:${t.toLowerCase()}`).join(",");
  try {
    const { data } = await axios.get(`${DEFILLAMA_ENDPOINT}/${coins}`);
    const result: Record<string, TokenInfo> = {};

    for (const token of tokens) {
      const key = `ethereum:${token.toLowerCase()}`;
      const info = data.coins[key];
      if (info) {
        result[token.toLowerCase()] = {
          price: info.price || 0,
          decimals: info.decimals || 18,
          symbol: info.symbol || token.slice(0, 6),
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function findUserInMerkle(merklePath: string, address: string): any {
  if (!fs.existsSync(merklePath)) return null;
  const data = JSON.parse(fs.readFileSync(merklePath, "utf-8"));
  const claims = data.claims || data;
  for (const [addr, value] of Object.entries(claims)) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      return { address: addr, data: value };
    }
  }
  return null;
}

interface UserShareInfo {
  type: "forwarder" | "non-forwarder" | "direct-voter";
  share: number;
  totalGroupRewardUSD: number;
}


function findUserShare(repartitionPath: string, address: string): UserShareInfo | null {
  if (!fs.existsSync(repartitionPath)) return null;
  const data = JSON.parse(fs.readFileSync(repartitionPath, "utf-8"));
  const dist = data.distribution || data;

  const lowerAddr = address.toLowerCase();

  // Calculate total USD for each group from totalPerGroup
  let forwardersUSD = 0;
  let nonForwardersUSD = 0;

  if (dist.totalPerGroup) {
    for (const [token, amounts] of Object.entries(dist.totalPerGroup) as any) {
      // Rough USD estimate (assume stablecoins = $1, will be refined with prices later)
      const fwdAmount = parseFloat(amounts.forwarders || "0") / 1e18;
      const nfwdAmount = parseFloat(amounts.nonForwarders || "0") / 1e18;
      forwardersUSD += fwdAmount;
      nonForwardersUSD += nfwdAmount;
    }
  }

  if (dist.forwarders) {
    for (const [addr, share] of Object.entries(dist.forwarders)) {
      if (addr.toLowerCase() === lowerAddr) {
        return {
          type: "forwarder",
          share: parseFloat(share as string),
          totalGroupRewardUSD: forwardersUSD
        };
      }
    }
  }

  if (dist.nonForwarders) {
    for (const [addr, share] of Object.entries(dist.nonForwarders)) {
      if (addr.toLowerCase() === lowerAddr) {
        return {
          type: "non-forwarder",
          share: parseFloat(share as string),
          totalGroupRewardUSD: nonForwardersUSD
        };
      }
    }
  }

  return null;
}

function getWeekTimestamps(): { current: number; previous: number } {
  const dirs = fs.readdirSync("bounties-reports")
    .filter(d => /^\d+$/.test(d))
    .map(d => parseInt(d))
    .sort((a, b) => b - a);
  return { current: dirs[0], previous: dirs[1] };
}

interface DirectVoterData {
  cumulative: Record<string, bigint>;
  thisWeek: Record<string, bigint>;
  sources: string[]; // which reward sources (curve, fxn)
}

function loadUserTokens(filePath: string, address: string): Record<string, bigint> {
  if (!fs.existsSync(filePath)) return {};
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const claims = data.claims || data;

  for (const [addr, value] of Object.entries(claims) as any) {
    if (addr.toLowerCase() === address.toLowerCase()) {
      const tokens: Record<string, bigint> = {};
      for (const [token, info] of Object.entries(value.tokens || {}) as any) {
        tokens[token.toLowerCase()] = BigInt(info.amount);
      }
      return tokens;
    }
  }
  return {};
}

function findDirectVoter(currentWeek: number, previousWeek: number, address: string): DirectVoterData | null {
  const sources = ["curve", "fxn"];
  const cumulative: Record<string, bigint> = {};
  const thisWeek: Record<string, bigint> = {};
  const activeSources: string[] = [];

  for (const source of sources) {
    const currentPath = `bounties-reports/${currentWeek}/vlCVX/${source}/merkle_data_non_delegators.json`;
    const previousPath = `bounties-reports/${previousWeek}/vlCVX/${source}/merkle_data_non_delegators.json`;

    const currentTokens = loadUserTokens(currentPath, address);
    const previousTokens = loadUserTokens(previousPath, address);

    if (Object.keys(currentTokens).length > 0) {
      activeSources.push(source);
    }

    // Merge tokens
    for (const [token, amount] of Object.entries(currentTokens)) {
      const prev = previousTokens[token] || 0n;
      cumulative[token] = (cumulative[token] || 0n) + amount;
      const delta = amount - prev;
      if (delta > 0n) {
        thisWeek[token] = (thisWeek[token] || 0n) + delta;
      }
    }
  }

  if (Object.keys(cumulative).length === 0) return null;
  return { cumulative, thisWeek, sources: activeSources };
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(2);
}

async function main() {
  const address = process.argv[2];
  if (!address) {
    console.error("Usage: pnpm tsx script/diagnose/checkVlCvxRewards.ts <address>");
    process.exit(1);
  }

  const checksumAddress = getAddress(address);
  const shortAddr = `${checksumAddress.slice(0, 6)}...${checksumAddress.slice(-4)}`;

  // ===== GATHER ALL DATA SILENTLY =====

  const weeks = getWeekTimestamps();
  const proposals = await getRecentProposals();
  proposals.sort((a, b) => a.end - b.end);

  const pastProposals = proposals.filter(p => p.end <= weeks.current);
  const rewardsProposal = pastProposals[pastProposals.length - 1];
  const nextProposal = proposals.find(p => p.end > weeks.current);

  if (!rewardsProposal) {
    console.error("Could not find proposal for current week rewards");
    process.exit(1);
  }

  const snapshotBlock = parseInt(rewardsProposal.snapshot);
  const nextSnapshotBlock = nextProposal ? parseInt(nextProposal.snapshot) : null;

  // Get VP values (direct + delegated)
  let weekBeforeVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };
  let snapshotVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };
  let nextSnapshotVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };
  let liveVP: VotingPowerResult = { total: 0, direct: 0, delegated: 0 };

  try { weekBeforeVP = await getVotingPower(checksumAddress, snapshotBlock - 50000); } catch {}
  try { snapshotVP = await getVotingPower(checksumAddress, snapshotBlock); } catch {}
  if (nextSnapshotBlock) {
    try { nextSnapshotVP = await getVotingPower(checksumAddress, nextSnapshotBlock); } catch {}
  }
  try { liveVP = await getVotingPower(checksumAddress, "latest"); } catch { liveVP = nextSnapshotVP.total > 0 ? nextSnapshotVP : snapshotVP; }

  // Get user type and rewards
  const repartitionDelegationPath = `bounties-reports/${weeks.current}/vlCVX/curve/repartition_delegation.json`;
  const userShare = findUserShare(repartitionDelegationPath, checksumAddress);
  const directVoterInfo = !userShare ? findDirectVoter(weeks.current, weeks.previous, checksumAddress) : null;

  // Get prices and calculate rewards
  const cvxPrice = await getCVXPrice();
  const aprsPath = `bounties-reports/latest/vlCVX/APRs.json`;
  const aprs = fs.existsSync(aprsPath) ? JSON.parse(fs.readFileSync(aprsPath, "utf-8")) : null;
  const poolAPR = aprs ? (aprs.usdPerCVX / cvxPrice) * 52 * 100 : 0;

  let thisWeekReward = 0;
  let userAPR = poolAPR;
  let nextWeekReward = 0;
  let thisWeekUSD = 0;
  let cumulativeUSD = 0;
  let prices: Record<string, TokenInfo> = {};

  if (userShare && aprs) {
    const groupRewardUSD = userShare.type === "forwarder" ? aprs.rewardValueUSD : userShare.totalGroupRewardUSD;
    thisWeekReward = groupRewardUSD * userShare.share;
    if (nextSnapshotVP.total > snapshotVP.total && snapshotVP.total > 0) {
      const totalGroupVP = snapshotVP.total / userShare.share;
      const nextShare = nextSnapshotVP.total / totalGroupVP;
      nextWeekReward = groupRewardUSD * nextShare;
    }
  } else if (directVoterInfo) {
    const allTokens = Object.keys(directVoterInfo.cumulative);
    prices = await getTokenPrices(allTokens);

    for (const [token, amount] of Object.entries(directVoterInfo.thisWeek)) {
      const info = prices[token.toLowerCase()];
      const decimals = info?.decimals || 18;
      const scaled = Number(amount) / Math.pow(10, decimals);
      thisWeekUSD += scaled * (info?.price || 0);
    }

    for (const [token, amount] of Object.entries(directVoterInfo.cumulative)) {
      const info = prices[token.toLowerCase()];
      const decimals = info?.decimals || 18;
      const scaled = Number(amount) / Math.pow(10, decimals);
      cumulativeUSD += scaled * (info?.price || 0);
    }

    if (snapshotVP.total > 0 && thisWeekUSD > 0) {
      userAPR = (thisWeekUSD * 52 / (snapshotVP.total * cvxPrice)) * 100;
    }
  }

  // ===== PRINT OUTPUT =====

  // Helper to format VP with delegation breakdown
  const formatVP = (vp: VotingPowerResult): string => {
    if (vp.delegated > 0 && vp.direct > 0) {
      return `${formatNumber(vp.total)} (${formatNumber(vp.direct)} own + ${formatNumber(vp.delegated)} delegated)`;
    } else if (vp.delegated > 0) {
      return `${formatNumber(vp.total)} (all delegated)`;
    }
    return `${formatNumber(vp.total)}`;
  };

  console.log(`\n=== vlCVX Diagnostic: ${shortAddr} ===\n`);

  // User type header (prominent)
  if (userShare) {
    const typeLabel = userShare.type.toUpperCase();
    console.log(`>>> ${typeLabel} (delegator) <<<`);
    console.log(`    Share: ${(userShare.share * 100).toFixed(4)}% of pool`);
    console.log(`    Snapshot VP: ${formatVP(snapshotVP)} vlCVX`);
    console.log(`\nThis Week: $${thisWeekReward.toFixed(2)}  →  APR: ${poolAPR.toFixed(2)}% ✓`);
    if (nextWeekReward > thisWeekReward) {
      console.log(`Next Week: ~$${nextWeekReward.toFixed(2)} (VP ↑ to ${formatNumber(nextSnapshotVP.total)})`);
    }
  } else if (directVoterInfo) {
    console.log(`>>> DIRECT VOTER (${directVoterInfo.sources.join(" + ")}) <<<`);
    console.log(`    Snapshot VP: ${formatVP(snapshotVP)} vlCVX`);
    console.log(`    Tokens: ${Object.keys(directVoterInfo.thisWeek).length} this week, ${Object.keys(directVoterInfo.cumulative).length} cumulative`);
    console.log(`\nThis Week: +$${formatNumber(thisWeekUSD)}  →  APR: ${userAPR.toFixed(2)}%`);
    console.log(`Cumulative: $${formatNumber(cumulativeUSD)} claimable`);
    if (userAPR < poolAPR * 0.9) {
      console.log(`⚠️  Below forwarder pool APR (${poolAPR.toFixed(2)}%)`);
    } else if (userAPR > poolAPR * 1.1) {
      console.log(`✓ Above forwarder pool APR (${poolAPR.toFixed(2)}%)`);
    }
  } else {
    console.log(`>>> NOT FOUND <<<`);
    console.log(`    User not in delegation or direct votes`);
    console.log(`    Possible: not delegated, expired, or 0 VP at snapshot`);
  }

  // Diagnosis warning (if applicable)
  if (liveVP.total > snapshotVP.total * 1.1) {
    const lockedAfter = liveVP.total - snapshotVP.total;
    const pctAfter = ((lockedAfter / liveVP.total) * 100).toFixed(0);
    console.log(`\n⚠️  Locked ${formatNumber(lockedAfter)} vlCVX (${pctAfter}%) AFTER snapshot`);
    console.log(`   Rewards based on ${formatNumber(snapshotVP.total)}, not ${formatNumber(liveVP.total)}`);
    if (userShare && thisWeekReward > 0) {
      const incorrectAPR = (thisWeekReward * 52 / (liveVP.total * cvxPrice)) * 100;
      console.log(`   User perceives ${incorrectAPR.toFixed(2)}% APR (wrong calculation)`);
    }
  }

  // ===== DETAILED SECTIONS =====

  console.log(`\n--- Context ---`);
  console.log(`Week: ${weeks.current} (${new Date(weeks.current * 1000).toISOString().split("T")[0]})`);
  console.log(`Snapshot: block ${snapshotBlock} (${rewardsProposal.title.replace("Gauge Weight for Week of ", "")})`);
  console.log(`CVX Price: $${cvxPrice.toFixed(2)}`);

  console.log(`\n--- VP History ---`);
  console.log(`~1 week before : ${formatVP(weekBeforeVP)} vlCVX`);
  console.log(`Snapshot       : ${formatVP(snapshotVP)} vlCVX ← rewards`);
  if (nextSnapshotVP.total > 0) {
    console.log(`Next snapshot  : ${formatVP(nextSnapshotVP)} vlCVX`);
  }
  console.log(`Live (now)     : ${formatVP(liveVP)} vlCVX`);

  // Token details for direct voters
  if (directVoterInfo && Object.keys(directVoterInfo.thisWeek).length > 0) {
    const thisWeekTokens = Object.keys(directVoterInfo.thisWeek);
    const pricedCount = thisWeekTokens.filter(t => prices[t.toLowerCase()]).length;

    console.log(`\n--- This Week's Tokens (${thisWeekTokens.length}, ${pricedCount} priced) ---`);
    for (const [token, amount] of Object.entries(directVoterInfo.thisWeek)) {
      const info = prices[token.toLowerCase()];
      const decimals = info?.decimals || 18;
      const scaled = Number(amount) / Math.pow(10, decimals);
      const symbol = info?.symbol || token.slice(0, 8);
      const price = info?.price || 0;
      const usd = scaled * price;

      if (price > 0) {
        console.log(`  ${symbol.padEnd(10)}: +${scaled.toFixed(4)} × $${price.toFixed(2)} = +$${usd.toFixed(2)}`);
      } else {
        console.log(`  ${symbol.padEnd(10)}: +${scaled.toFixed(4)} (no price)`);
      }
    }
  }

  // Merkle status
  console.log(`\n--- Merkle Status ---`);
  const delegatorsMerkle = findUserInMerkle("bounties-reports/latest/vlCVX/vlcvx_merkle_delegators.json", checksumAddress);
  const mainMerkle = findUserInMerkle("bounties-reports/latest/vlCVX/vlcvx_merkle.json", checksumAddress);

  if (delegatorsMerkle) {
    console.log("Found in: Delegators Merkle (sCRVUSD)");
    const tokens = delegatorsMerkle.data.tokens || {};
    for (const [token, info] of Object.entries(tokens) as any) {
      const amount = parseFloat(info.amount) / 1e18;
      console.log(`  ${token.slice(0, 10)}...: ${amount.toFixed(4)}`);
    }
  } else if (mainMerkle) {
    const tokens = mainMerkle.data.tokens || {};
    console.log(`Found in: Main Merkle (${Object.keys(tokens).length} tokens)`);
  } else {
    console.log("Not found in any merkle");
  }

  console.log("");
}

main().catch(console.error);
