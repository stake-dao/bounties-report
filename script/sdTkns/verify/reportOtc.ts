import { parseAbi, parseAbiItem, type PublicClient } from "viem";
import { WEEK } from "../../utils/constants";
import { ALL_MIGHT_V2, BOTMARKET, OTC_REGISTRY, PROTOCOLS_TOKENS } from "../../utils/reportUtils";
import { blockAtOrAfter } from "./reconstructSdMerkle";
import { readClaimLogs } from "./reportSources";

const withdrawn = parseAbiItem("event OTCWithdrawn(uint256 id, address withdrawer, uint256 amount)");
const registryAbi = parseAbi(["function otcs(uint256) view returns (address depositor, string protocolName, address rewardToken, address gauge, uint256 chainId, uint256 amount, uint256 startTimestamp, uint256 totalPeriods, uint256 withdrawPerPeriod)"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// The registry releases of the week and what their swaps delivered: the
// sources the OTC report is generated from, read back from the chain.
export interface OtcLane {
  withdrawals: Array<{ gauge: string; token: string; amount: bigint }>;
  delivered: Map<string, bigint>;
  nativeIn: bigint;
}

export type OtcLanes = Partial<Record<string, OtcLane>>;

const lc = (value: string) => value.toLowerCase();

export async function readOtcLanes(period: number, protocols: readonly string[], client: PublicClient): Promise<Record<string, OtcLane>> {
  const lanes: Record<string, OtcLane> = Object.fromEntries(protocols.map((protocol) => [protocol, { withdrawals: [], delivered: new Map(), nativeIn: 0n }]));
  const [from, end] = await Promise.all([blockAtOrAfter(client, period), blockAtOrAfter(client, period + WEEK)]);
  const logs = await readClaimLogs(from, end, (fromBlock, toBlock) => client.getLogs({ address: OTC_REGISTRY, event: withdrawn, fromBlock, toBlock, strict: true }));
  for (const log of logs) {
    const otc = await client.readContract({ address: OTC_REGISTRY, abi: registryAbi, functionName: "otcs", args: [log.args.id] });
    const protocol = lc(otc[1]);
    const lane = lanes[protocol] as OtcLane | undefined;
    if (!lane) continue;
    lane.withdrawals.push({ gauge: lc(otc[3]), token: lc(otc[2]), amount: log.args.amount });
    const hash = lc(log.transactionHash);
    if (lane.delivered.has(hash)) continue;
    const sd = lc(PROTOCOLS_TOKENS[protocol].sdToken);
    const native = lc(PROTOCOLS_TOKENS[protocol].native);
    let delivered = 0n;
    for (const entry of (await client.getTransactionReceipt({ hash: hash as `0x${string}` })).logs) {
      if (entry.topics[0] !== TRANSFER_TOPIC) continue;
      const token = lc(entry.address);
      const to = lc(`0x${entry.topics[2]?.slice(-40)}`);
      if (token === sd && to === lc(BOTMARKET)) delivered += BigInt(entry.data);
      if (token === native && to === lc(ALL_MIGHT_V2)) lane.nativeIn += BigInt(entry.data);
    }
    lane.delivered.set(hash, delivered);
  }
  return lanes;
}
