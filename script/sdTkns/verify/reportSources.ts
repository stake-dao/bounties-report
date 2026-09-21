import { readFileSync } from "node:fs";
import { parseAbi, parseAbiItem, type Address, type PublicClient } from "viem";
import { FXN_STAKE_DAO_LOCKER, STAKE_DAO_LOCKER, VOTEMARKET_PLATFORM_CONFIGS, WEEK } from "../../utils/constants";
import { ContractRegistry } from "../../utils/contractRegistry";
import { getClient } from "../../utils/getClients";
import { blockAtOrAfter } from "./reconstructSdMerkle";

const claimV1 = parseAbiItem("event Claimed(address indexed user, address rewardToken, uint256 indexed bountyId, uint256 amount, uint256 protocolFees, uint256 period)");
const claimV2 = parseAbiItem("event Claim(uint256 indexed campaignId, address indexed account, uint256 amount, uint256 fee, uint256 epoch)");
const campaignAbi = parseAbi(["function getCampaign(uint256) view returns (uint256, address, address, address, uint8, uint256, uint256, uint256, uint256, uint256, address)"]);
const bountyAbi = parseAbi(["function getBounty(uint256) view returns ((address gauge, address manager, address rewardToken, uint8 numberOfPeriods, uint256 endTimestamp, uint256 maxRewardPerVote, uint256 totalRewardAmount, address[] blacklist))"]);
const factoryAbi = parseAbi(["function isWrapped(address) view returns (bool)", "function nativeTokens(address) view returns (address)"]);

interface SourceClaim {
  chainId?: number;
  bountyId: string | bigint;
  gauge: string;
  rewardToken: string;
  amount: string | bigint;
  isWrapped?: boolean;
}

function claimKey(claim: SourceClaim): string {
  return [claim.chainId ?? 1, BigInt(claim.bountyId), claim.gauge.toLowerCase(),
    claim.rewardToken.toLowerCase(), BigInt(claim.amount), claim.isWrapped === true].join("/");
}

export function compareSourceClaims(stored: SourceClaim[], events: SourceClaim[]): void {
  const counts = new Map<string, number>();
  for (const claim of stored) counts.set(claimKey(claim), (counts.get(claimKey(claim)) ?? 0) + 1);
  for (const claim of events) counts.set(claimKey(claim), (counts.get(claimKey(claim)) ?? 0) - 1);
  const differences = [...counts].filter(([, count]) => count !== 0);
  if (differences.length) throw new Error(`Claim event mismatch: ${differences.slice(0, 5).map(([key, count]) => `${key} (${count > 0 ? "extra in file" : "missing from file"}: ${Math.abs(count)})`).join("; ")}`);
}

export async function readClaimLogs<T>(from: bigint, end: bigint, read: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  const logs: T[] = [];
  let size = 50_000n;
  let rateRetries = 0;
  for (let start = from; start < end;) {
    const to = start + size < end ? start + size - 1n : end - 1n;
    try {
      logs.push(...await read(start, to));
      start = to + 1n;
      rateRetries = 0;
    } catch (error) {
      if (/rate limit|too many requests|\b429\b/i.test(String(error)) && rateRetries < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** rateRetries++));
        continue;
      }
      if (to === start || !/block range|range.*(?:large|limit|blocks)|limit.*range|too many results|more than.*results/i.test(String(error))) throw error;
      size = (to - start + 1n) / 2n;
    }
  }
  return logs;
}

export async function verifySourceClaims(
  period: number,
  protocols: readonly ("curve" | "fxn")[],
  clientForChain: (chain: number) => Promise<PublicClient> = getClient,
): Promise<number> {
  const windows = new Map<number, Promise<{ client: PublicClient; from: bigint; end: bigint }>>();
  const windowFor = (chain: number) => {
    if (!windows.has(chain)) windows.set(chain, (async () => {
      const client = await clientForChain(chain);
      const [from, end] = await Promise.all([blockAtOrAfter(client, period), blockAtOrAfter(client, period + WEEK)]);
      return { client, from, end };
    })());
    return windows.get(chain)!;
  };
  let checked = 0;
  for (const protocol of protocols) {
    for (const version of [1, 2] as const) {
      const file = `weekly-bounties/${period}/${version === 1 ? "votemarket" : "votemarket-v2"}/claimed_bounties.json`;
      const stored = Object.values(JSON.parse(readFileSync(file, "utf8"))[protocol] ?? {}) as SourceClaim[];
      const registryKey = `${protocol.toUpperCase()}_VOTEMARKET_V2`;
      const chains = version === 1 ? [1] : ContractRegistry.getChains(registryKey);
      const onchain = (await Promise.all(chains.map(async (chain) => {
        const { client, from, end } = await windowFor(chain);
        const configs = version === 1 ? VOTEMARKET_PLATFORM_CONFIGS[protocol] : [registryKey, ...(protocol === "curve" ? ["CURVE_VOTEMARKET_V2_NEW"] : [])].map((key) => ({
          platform: ContractRegistry.getAddress(key, chain),
          toAddress: protocol === "curve" ? STAKE_DAO_LOCKER : FXN_STAKE_DAO_LOCKER,
        }));
        const claims: SourceClaim[] = [];
        const seen = new Set<string>();
        for (const config of configs) {
          const common = { address: config.platform as Address, strict: true as const };
          if (version === 1) {
            const logs = await readClaimLogs(from, end, (fromBlock, toBlock) => client.getLogs({ ...common, fromBlock, toBlock, event: claimV1, args: { user: config.toAddress as Address } }));
            for (const log of logs) {
              const key = `${log.transactionHash}/${log.logIndex}`;
              if (seen.has(key)) throw new Error(`Duplicate claim event ${key}`);
              seen.add(key);
              const bounty = await client.readContract({ address: common.address, abi: bountyAbi, functionName: "getBounty", args: [log.args.bountyId] });
              claims.push({ bountyId: log.args.bountyId, gauge: bounty.gauge, rewardToken: log.args.rewardToken, amount: log.args.amount });
            }
          } else {
            const logs = await readClaimLogs(from, end, (fromBlock, toBlock) => client.getLogs({ ...common, fromBlock, toBlock, event: claimV2, args: { account: config.toAddress as Address } }));
            for (const log of logs) {
              const key = `${log.transactionHash}/${log.logIndex}`;
              if (seen.has(key)) throw new Error(`Duplicate claim event ${key}`);
              seen.add(key);
              const campaign = await client.readContract({ address: common.address, abi: campaignAbi, functionName: "getCampaign", args: [log.args.campaignId] });
              const factory = ContractRegistry.getAddress("TOKEN_FACTORY", chain);
              const isWrapped = await client.readContract({ address: factory, abi: factoryAbi, functionName: "isWrapped", args: [campaign[3]] });
              const rewardToken = isWrapped ? await client.readContract({ address: factory, abi: factoryAbi, functionName: "nativeTokens", args: [campaign[3]] }) : campaign[3];
              claims.push({ chainId: chain, bountyId: log.args.campaignId, gauge: campaign[1], rewardToken, amount: log.args.amount, isWrapped });
            }
          }
        }
        return claims;
      }))).flat();
      try { compareSourceClaims(stored, onchain); }
      catch (error) { throw new Error(`${protocol}/v${version}: ${error instanceof Error ? error.message : String(error)}`); }
      checked += onchain.length;
    }
  }
  return checked;
}
