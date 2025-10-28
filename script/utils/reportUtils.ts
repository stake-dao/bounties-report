import axios from "axios";
import {
  decodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  pad,
  getContract,
  formatUnits,
  PublicClient,
  Address,
  erc20Abi,
} from "viem";
import { gql, request } from "graphql-request";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { getClosestBlockTimestamp } from "./chainUtils";
import { Proposal } from "../interfaces/Proposal";
import { Interface } from "ethers/lib/utils";
import { debug, sampleArray, isDebugEnabled } from "./logger";
import { getTokenByAddress } from "./tokenService";

const WEEK = 604800; // One week in seconds

// Interfaces
interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface Bounty {
  bountyId: string;
  gauge: string;
  amount: string;
  rewardToken: string;
  sdTokenAmount?: number;
  gaugeName?: string;
  nativeEquivalent?: number;
  share?: number;
  normalizedShare?: number;
  chainId?: number;
}

export interface ClaimedBounties {
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
  votemarket: Record<string, Record<string, Bounty>>;
  votemarket_v2: Record<string, Record<string, Bounty>>;
  warden: Record<string, Record<string, Bounty>>;
  hiddenhand: Record<string, Record<string, Bounty>>;
}

export interface SwapEvent {
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: bigint;
  transactionHash?: string;
}

export interface ProcessedSwapEvent extends SwapEvent {
  formattedAmount: number;
  symbol: string;
}

export interface MatchedReward {
  address: string;
  symbol: string;
  amount: number;
  weth: number;
}

interface GaugeInfo {
  name: string;
  shortName?: string;
  address: string;
  actualGauge?: string; // The actual gauge address if this is a rootGauge entry
  price?: string;
}

// Exported constants
// NOTE: For dynamic token lookups, consider using tokenService
// import { getTokenAddress } from "./tokenService";
export const WETH_ADDRESS = getAddress(
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
);

export const CRV_ADDRESS = getAddress(
  "0xD533a949740bb3306d119CC777fa900bA034cd52"
);

export const WBNB_ADDRESS = getAddress(
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
);
export const OTC_REGISTRY = getAddress(
  "0x9Cc16BDd233A74646e31100b2f13334810d12cB0"
);
export const ALL_MIGHT = getAddress(
  "0x0000000a3Fc396B89e4c11841B39D9dff85a5D05"
);
export const BOSS = getAddress("0xB0552b6860CE5C0202976Db056b5e3Cc4f9CC765");
export const REWARDS_ALLOCATIONS_POOL = getAddress(
  "0xA3ECF0cc8E88136134203aaafB21F7bD2dA6359a"
);
export const HH_BALANCER_MARKET = getAddress(
  "0x45Bc37b18E73A42A4a826357a8348cDC042cCBBc"
);
export const BOTMARKET = getAddress(
  "0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF"
);
export const BSC_BOTMARKET = getAddress(
  "0x1F18E2A3fB75D5f8d2a879fe11D7c30730236B8d"
);
export const BSC_CAKE_VM = getAddress(
  "0x62c5D779f5e56F6BC7578066546527fEE590032c"
);
export const GOVERNANCE = getAddress(
  "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063"
);
export const BSC_CAKE_LOCKER = "0x1E6F87A9ddF744aF31157d8DaA1e3025648d042d";

export const SPECTRA_RECEIVER = getAddress(
  "0xbb0a24dee350d29ee0535353ae0d8fd1222c26b9"
);

// Helper to fetch token info using ERC20 contract
export async function getTokenInfo(
  publicClient: PublicClient,
  tokenAddress: string
): Promise<TokenInfo> {
  let checksumAddress: string | undefined;
  try {
    checksumAddress = getAddress(tokenAddress);
  } catch {
    checksumAddress = undefined;
  }

  const lookupAddress = checksumAddress ?? tokenAddress;
  const primaryChainId =
    typeof publicClient?.chain?.id === "number"
      ? publicClient.chain.id.toString()
      : undefined;
  const fallbackChains = [
    "1",
    "10",
    "56",
    "1124",
    "137",
    "42161",
    "8453",
    "252",
    "43114",
  ];
  const chainCandidates = new Set<string>();
  if (primaryChainId) {
    chainCandidates.add(primaryChainId);
  }
  fallbackChains.forEach((id) => chainCandidates.add(id));

  for (const chainId of chainCandidates) {
    try {
      const tokenInfo = await getTokenByAddress(lookupAddress, chainId);
      if (tokenInfo) {
        const symbol = tokenInfo.symbol || "UNKNOWN";
        const decimals =
          typeof tokenInfo.decimals === "number" ? tokenInfo.decimals : 18;
        return { symbol, decimals };
      }
    } catch (error) {
      if (isDebugEnabled()) {
        debug("[tokenService] lookup failed", {
          token: lookupAddress,
          chainId,
          error: String(error),
        });
      }
    }
  }

  if (!checksumAddress) {
    console.warn(
      `Invalid token address format ${tokenAddress}, defaulting to UNKNOWN`
    );
    return { symbol: "UNKNOWN", decimals: 18 };
  }

  const contract = getContract({
    address: checksumAddress as Address,
    abi: erc20Abi,
    client: { public: publicClient },
  });

  try {
    const [symbol, decimals] = await Promise.all([
      contract.read.symbol(),
      contract.read.decimals(),
    ]);
    return { symbol, decimals };
  } catch (error) {
    console.error(`Error fetching info for token ${tokenAddress}:`, error);
    return { symbol: "UNKNOWN", decimals: 18 };
  }
}

/**
 * Retrieves timestamps and block numbers for a specified week.
 */
export async function getTimestampsBlocks(
  publicClient: PublicClient,
  pastWeek?: number,
  chain: string = "ethereum"
) {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  let timestamp1: number, timestamp2: number;

  if (!pastWeek || pastWeek === 0) {
    console.log("No past week specified, using current week");
    timestamp2 = currentTimestamp;
    timestamp1 = Math.floor(currentTimestamp / WEEK) * WEEK;
  } else {
    console.log(`Past week specified: ${pastWeek}`);
    timestamp2 = Math.floor(currentTimestamp / WEEK) * WEEK;
    timestamp1 = timestamp2 - pastWeek * WEEK;
  }

  const blockNumber1 = await getClosestBlockTimestamp(chain, timestamp1);
  const blockNumber2 =
    !pastWeek || pastWeek === 0
      ? Number(await publicClient.getBlockNumber())
      : await getClosestBlockTimestamp(chain, timestamp2);
  return { timestamp1, timestamp2, blockNumber1, blockNumber2 };
}

export function isValidAddress(address: string): address is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export const MAINNET_VM_PLATFORMS: {
  [key: string]: { platforms: string[]; locker: string };
} = {
  curve: {
    platforms: [
      getAddress("0x0000000895cB182E6f983eb4D8b4E0Aa0B31Ae4c"),
      getAddress("0x000000073D065Fc33a3050C2d0E19C393a5699ba"),
    ],
    locker: getAddress("0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6"),
  },
  balancer: {
    platforms: [getAddress("0x0000000446b28e4c90DbF08Ead10F3904EB27606")],
    locker: getAddress("0xea79d1A83Da6DB43a85942767C389fE0ACf336A5"),
  },
  frax: {
    platforms: [getAddress("0x000000060e56DEfD94110C1a9497579AD7F5b254")],
    locker: getAddress("0xCd3a267DE09196C48bbB1d9e842D7D7645cE448f"),
  },
  fxn: {
    platforms: [getAddress("0x00000007D987c2Ea2e02B48be44EC8F92B8B06e8")],
    locker: getAddress("0x75736518075a01034fa72D675D36a47e9B06B2Fb"),
  },
};

export const WARDEN_PATHS: { [key: string]: string } = {
  curve: "crv",
  balancer: "bal",
  frax: "frax",
  fxn: "fxn",
};

export const PROTOCOLS_TOKENS: {
  [key: string]: { native: string; sdToken: string };
} = {
  curve: {
    native: getAddress("0xD533a949740bb3306d119CC777fa900bA034cd52"),
    sdToken: getAddress("0xD1b5651E55D4CeeD36251c61c50C889B36F6abB5"),
  },
  balancer: {
    native: getAddress("0xba100000625a3754423978a60c9317c58a424e3D"),
    sdToken: getAddress("0xF24d8651578a55b0C119B9910759a351A3458895"),
  },
  frax: {
    native: getAddress("0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0"),
    sdToken: getAddress("0x402F878BDd1f5C66FdAF0fabaBcF74741B68ac36"),
  },
  fxn: {
    native: getAddress("0x365accfca291e7d3914637abf1f7635db165bb09"),
    sdToken: getAddress("0xe19d1c837b8a1c83a56cd9165b2c0256d39653ad"),
  },
  pendle: {
    native: getAddress("0x808507121B80c02388fAd14726482e061B8da827"),
    sdToken: getAddress("0x5Ea630e00D6eE438d3deA1556A110359ACdc10A9"),
  },
  spectra: {
    native: getAddress("0x64FCC3A02eeEba05Ef701b7eed066c6ebD5d4E51"),
    sdToken: getAddress("0x8e7801bAC71E92993f6924e7D767D7dbC5fCE0AE"),
  },
};

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";

// Additional interfaces
interface Timestamps {
  [key: number]: Proposal;
}

interface BlockSwaps {
  [blockNumber: number]: bigint[];
}

/** Group swap amounts by block number. */
export function transformSwapEvents(swapEvents: SwapEvent[]): BlockSwaps {
  return swapEvents.reduce((acc: BlockSwaps, event) => {
    if (!acc[event.blockNumber]) acc[event.blockNumber] = [];
    acc[event.blockNumber].push(event.amount);
    return acc;
  }, {});
}

/** Fetch proposals for a period and map to timestamps. */
export async function fetchProposalsIdsBasedOnPeriods(
  space: string,
  period: number
): Promise<Timestamps> {
  const query = gql`
    query Proposals {
      proposals(
        first: 1000
        skip: 0
        orderBy: "created",
        orderDirection: desc,
        where: {
          space_in: ["${space}"]
          type: "weighted"
        }
      ) {
        id
        title
        body
        choices
        start
        end
        snapshot
        state
        scores
        scores_by_strategy
        scores_total
        scores_updated
        author
        space {
          id
          name
        }
      }
    }`;
  const result = await request(SNAPSHOT_ENDPOINT, query);
  const proposals = result.proposals.filter(
    (proposal: Proposal) => proposal.title.indexOf("Gauge vote") > -1
  );

  let associatedTimestamps: Timestamps = {};
  for (const proposal of proposals) {
    const title = proposal.title;
    const dateStrings = title.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
    if (dateStrings && dateStrings.length >= 2) {
      const [date_a, date_b] = dateStrings;
      const parts_a = date_a.split("/");
      const parts_b = date_b.split("/");
      const correctFormat_a = `${parts_a[1]}/${parts_a[0]}/${parts_a[2]}`;
      const correctFormat_b = `${parts_b[1]}/${parts_b[0]}/${parts_b[2]}`;
      const timestamp_a = new Date(correctFormat_a).getTime() / 1000;
      const timestamp_b = new Date(correctFormat_b).getTime() / 1000;
      if (period + 82800 >= timestamp_a && period <= timestamp_b) {
        associatedTimestamps[period] = proposal;
      }
    }
  }
  return associatedTimestamps;
}

export async function getTokenBalance(
  publicClient: PublicClient,
  tokenAddress: Address,
  contractAddress: Address,
  decimals: number = 18
): Promise<number> {
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [contractAddress],
  });
  return Number(formatUnits(balance, decimals));
}

export async function getRawTokenBalance(
  publicClient: PublicClient,
  tokenAddress: Address,
  contractAddress: Address
): Promise<bigint> {
  return await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [contractAddress],
  });
}

const gaugeControllerAbi = [
  {
    name: "get_gauge_weight",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "gauge", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export async function getGaugeWeight(
  publicClient: PublicClient,
  gaugeControllerAddress: Address,
  gaugeAddress: Address
): Promise<number> {
  try {
    const weight = await publicClient.readContract({
      address: gaugeControllerAddress,
      abi: gaugeControllerAbi,
      functionName: "get_gauge_weight",
      args: [gaugeAddress],
    });
    return Number(formatUnits(weight, 18)); // Weight is in 1e18 scale
  } catch (error) {
    console.error(`Error fetching gauge weight for ${gaugeAddress}:`, error);
    return 0;
  }
}

/**
 * Processes non-OTC swap events, filtering out duplicates and unwanted addresses.
 * @param swaps - Array of swap events to process
 * @param tokenInfos - Token information for formatting  
 * @param options - Optional configuration for filtering behavior
 *                  requiredTxAddresses: Array of addresses that must be present in the block for swaps to be included
 *                                      If not specified, auto-detects BOTMARKET presence on mainnet
 *                  excludedFromAddresses: Array of addresses to exclude from 'from' field
 *                  excludedToAddresses: Array of addresses to exclude from 'to' field
 */
export function processSwaps(
  swaps: SwapEvent[],
  tokenInfos: Record<string, TokenInfo>,
  options?: {
    requiredTxAddresses?: string[];
    excludedFromAddresses?: string[];
    excludedToAddresses?: string[];
  }
): ProcessedSwapEvent[] {
  const total = swaps.length;
  const seen = new Set<string>();

  const defaultExcludedFrom = [OTC_REGISTRY, BOTMARKET, SPECTRA_RECEIVER];
  const defaultExcludedTo = [GOVERNANCE, BOSS];

  const excludedFrom = (options?.excludedFromAddresses || defaultExcludedFrom).map((addr) => addr.toLowerCase());
  const excludedTo = (options?.excludedToAddresses || defaultExcludedTo).map((addr) => addr.toLowerCase());

  const blocksWithRequiredAddresses = new Set<number>();
  let hasRequiredAddresses = false;

  if (options?.requiredTxAddresses && options.requiredTxAddresses.length > 0) {
    const requiredAddresses = options.requiredTxAddresses.map((addr) => addr.toLowerCase());
    swaps.forEach((swap) => {
      const fromLower = swap.from.toLowerCase();
      const toLower = swap.to.toLowerCase();
      if (requiredAddresses.includes(fromLower) || requiredAddresses.includes(toLower)) {
        hasRequiredAddresses = true;
        blocksWithRequiredAddresses.add(swap.blockNumber);
      }
    });
  } else {
    swaps.forEach((swap) => {
      if (swap.from.toLowerCase() === BOTMARKET.toLowerCase() || swap.to.toLowerCase() === BOTMARKET.toLowerCase()) {
        hasRequiredAddresses = true;
        blocksWithRequiredAddresses.add(swap.blockNumber);
      }
    });
  }

  const afterAddressFilter = swaps.filter((swap) => {
    const fromLower = swap.from.toLowerCase();
    const toLower = swap.to.toLowerCase();
    return !excludedFrom.includes(fromLower) && !excludedTo.includes(toLower);
  });

  const afterDedup = afterAddressFilter.filter((swap) => {
    const key = `${swap.blockNumber}-${swap.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const afterRequired = afterDedup.filter((swap) => {
    if (!hasRequiredAddresses) return true;
    return blocksWithRequiredAddresses.has(swap.blockNumber);
  });

  if (isDebugEnabled()) {
    debug("[processSwaps] counts", {
      total,
      afterAddressFilter: afterAddressFilter.length,
      afterDedup: afterDedup.length,
      afterRequired: afterRequired.length,
    });
    debug(
      "[processSwaps] sample",
      sampleArray(
        afterRequired.map((s) => ({ block: s.blockNumber, logIndex: s.logIndex, token: s.token, tx: s.transactionHash })),
        5
      )
    );
  }

  return afterRequired.map((swap) => formatSwap(swap, tokenInfos));
}

/**
 * Processes OTC swap events.
 */
export function processSwapsOTC(
  swaps: SwapEvent[],
  tokenInfos: Record<string, TokenInfo>
): ProcessedSwapEvent[] {
  const seen = new Set<string>();
  const filtered = swaps
    .filter((swap) => swap.from.toLowerCase() === OTC_REGISTRY.toLowerCase())
    .filter((swap) => {
      const key = `${swap.blockNumber}-${swap.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (isDebugEnabled()) {
    debug("[processSwapsOTC] otc swaps", filtered.length);
  }
  return filtered.map((swap) => formatSwap(swap, tokenInfos));
}

/**
 * Merges bounty objects across protocols.
 */
export function aggregateBounties(
  claimedBounties: ClaimedBounties
): Record<string, Bounty[]> {
  const protocols = ["curve", "balancer", "fxn", "frax", "pendle"];
  const aggregated: Record<string, Bounty[]> = {};
  for (const protocol of protocols) {
    aggregated[protocol] = [
      ...Object.values(claimedBounties.votemarket[protocol] || {}),
      ...Object.values(claimedBounties.votemarket_v2[protocol] || {}),
      ...Object.values(claimedBounties.warden[protocol] || {}),
      ...Object.values(claimedBounties.hiddenhand[protocol] || {}),
    ];
  }
  return aggregated;
}

/**
 * Formats a swap event with token info.
 */
export function formatSwap(
  swap: SwapEvent,
  tokenInfos: Record<string, TokenInfo>
): ProcessedSwapEvent {
  const tokenInfo = tokenInfos[swap.token.toLowerCase()];
  const decimals = tokenInfo ? tokenInfo.decimals : 18;
  return {
    ...swap,
    formattedAmount: Number(formatUnits(swap.amount, decimals)),
    symbol: tokenInfo?.symbol || "UNKNOWN",
  };
}

/**
 * Collects all token addresses from bounty data.
 */
export function collectAllTokens(
  bounties: Record<string, Bounty[]>,
  protocols: typeof PROTOCOLS_TOKENS,
  chainId: number = 1
): Set<string> {
  const allTokens = new Set<string>();
  Object.values(bounties).forEach((protocolBounties) =>
    protocolBounties.forEach((bounty) => {
      const bountyChainId =
        bounty.hasOwnProperty("isWrapped") && bounty.isWrapped === true
          ? 1
          : bounty.chainId || chainId;
      if (bountyChainId === chainId) {
        allTokens.add(bounty.rewardToken);
      }
    })
  );
  if (chainId === 1) {
    allTokens.add(WETH_ADDRESS);
    Object.values(protocols).forEach((protocolInfo) => {
      allTokens.add(protocolInfo.native);
      allTokens.add(protocolInfo.sdToken);
    });
  }
  return allTokens;
}

/**
 * Attaches gauge names to each bounty.
 */
export function addGaugeNamesToBounties(
  bounties: Bounty[],
  gaugesInfo: GaugeInfo[]
): Bounty[] {
  const gaugeMap = new Map<string, { name: string; actualGauge?: string }>(
    gaugesInfo.map((g) => [g.address.toLowerCase(), { name: g.name, actualGauge: g.actualGauge }])
  );
  return bounties.map((bounty) => {
    const gaugeInfo = gaugeMap.get(bounty.gauge.toLowerCase());
    if (gaugeInfo) {
      return {
        ...bounty,
        gaugeName: gaugeInfo.name,
        // If this bounty was claimed through a rootGauge, update the gauge address to the actual gauge
        gauge: gaugeInfo.actualGauge || bounty.gauge,
      };
    }
    return {
      ...bounty,
      gaugeName: "UNKNOWN",
    };
  });
}

/**
 * Escapes CSV fields.
 */
export function escapeCSV(field: string): string {
  if (field.includes(";") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Fetch token information for a list of tokens.
 */
export async function fetchAllTokenInfos(
  allTokens: string[],
  publicClient: PublicClient
): Promise<Record<string, TokenInfo>> {
  const tokenInfos: Record<string, TokenInfo> = {};
  for (const token of allTokens) {
    tokenInfos[token.toLowerCase()] = await getTokenInfo(publicClient, token);
  }
  return tokenInfos;
}

export async function fetchSwapInEvents(
  chainId: number,
  blockMin: number,
  blockMax: number,
  rewardTokens: string[],
  contractAddress: string
): Promise<SwapEvent[]> {
  const explorerUtils = createBlockchainExplorerUtils();
  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));
  const paddedContractAddress = pad(contractAddress as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const topics = { "0": transferHash, "2": paddedContractAddress };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    rewardTokens,
    blockMin,
    blockMax,
    topics,
    chainId
  );

  const swapEvents: SwapEvent[] = response.result.map((log) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], log.data);
    return {
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      from: `0x${log.topics[1].slice(26)}`,
      to: `0x${log.topics[2].slice(26)}`,
      token: log.address,
      amount,
      transactionHash: log.transactionHash,
    };
  });

  // Filter out the specific transaction hash
  const filteredSwapEvents = swapEvents.filter(
    event => event.transactionHash?.toLowerCase() !== '0xf17999a7ba3dfd203d571f95f211f4786005c3cb6d5370e10a6b7dbad2f3e049'
  );
  const sorted = filteredSwapEvents.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber
  );
  if (isDebugEnabled()) {
    debug("[fetchSwapInEvents] params", { chainId, blockMin, blockMax, tokens: rewardTokens.length, contractAddress });
    debug("[fetchSwapInEvents] count", sorted.length);
    debug("[fetchSwapInEvents] sample", sampleArray(sorted.map((s) => ({ block: s.blockNumber, logIndex: s.logIndex, token: s.token, tx: s.transactionHash })), 5));
  }
  return sorted;
}

export async function fetchSwapOutEvents(
  chainId: number,
  blockMin: number,
  blockMax: number,
  rewardTokens: string[],
  contractAddress: string
): Promise<SwapEvent[]> {
  const explorerUtils = createBlockchainExplorerUtils();
  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));
  const paddedContractAddress = pad(contractAddress as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const topics = { "0": transferHash, "1": paddedContractAddress };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    rewardTokens,
    blockMin,
    blockMax,
    topics,
    chainId
  );

  const swapEvents: SwapEvent[] = response.result.map((log) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], log.data);
    return {
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      from: `0x${log.topics[1].slice(26)}`,
      to: `0x${log.topics[2].slice(26)}`,
      token: log.address,
      amount,
      transactionHash: log.transactionHash,
    };
  });

  // Filter out the specific transaction hash
  const filteredSwapEvents = swapEvents.filter(
    event => event.transactionHash?.toLowerCase() !== '0xf17999a7ba3dfd203d571f95f211f4786005c3cb6d5370e10a6b7dbad2f3e049'
  );
  const sorted = filteredSwapEvents.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber
  );
  if (isDebugEnabled()) {
    debug("[fetchSwapOutEvents] params", { chainId, blockMin, blockMax, tokens: rewardTokens.length, contractAddress });
    debug("[fetchSwapOutEvents] count", sorted.length);
    debug("[fetchSwapOutEvents] sample", sampleArray(sorted.map((s) => ({ block: s.blockNumber, logIndex: s.logIndex, token: s.token, tx: s.transactionHash })), 5));
  }
  return sorted;
}

/**
 * Matches WETH inputs with corresponding reward outputs.
 */
export function matchWethInWithRewardsOut(blockData: any): MatchedReward[] {
  const wethIn = blockData.wethIn || [];
  const rewardsOut = blockData.rewardsOut || [];
  if (wethIn.length === 0 || rewardsOut.length === 0) return [];
  if (wethIn.length !== rewardsOut.length) {
    console.warn(
      `Mismatch in WETH inputs (${wethIn.length}) and reward outputs (${rewardsOut.length})`
    );
  }
  const matchLength = Math.min(wethIn.length, rewardsOut.length);
  const matches = wethIn
    .slice(0, matchLength)
    .map((wethAmount: number, index: number) => ({
      address: rewardsOut[index].token,
      symbol: rewardsOut[index].symbol,
      amount: rewardsOut[index].amount,
      weth: wethAmount,
    }));
  if (isDebugEnabled()) {
    debug("[matchWethInWithRewardsOut] pairs", sampleArray(matches, 5));
  }
  return matches;
}

// Decode Transfer logs from receipts
const transferInterface = new Interface([
  {
    anonymous: false,
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
]);

export async function mapTokenSwapsToOutToken(
  publicClient: PublicClient,
  txHash: string,
  tokenList: Set<string>, // tokens swapped to outToken
  outToken: string,
  targetTo: string // consider only transfers from/to this address
): Promise<Record<string, bigint>> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const TRANSFER_TOPIC =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  // Inputs: tokens in tokenList transferred FROM targetTo
  const transfersIn: { token: string; amount: bigint; logIndex: number }[] = [];
  // Outputs: outToken transfers TO targetTo
  const transfersOut: { amount: bigint; logIndex: number }[] = [];

  // Lowercase tokenList for matching
  const tokenListLower = new Set(
    Array.from(tokenList).map((token) => token.toLowerCase())
  );

  // Walk logs and collect matched transfers
  for (const log of receipt.logs) {
    if (!log.topics || !log.topics[0] || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    try {
      const decoded = transferInterface.parseLog(log);
      const tokenAddress = log.address.toLowerCase();
      const value = BigInt(decoded.args.value.toString());

      // Input criteria: token in tokenList, from = targetTo
      if (
        tokenListLower.has(tokenAddress) &&
        (decoded.args.from as string).toLowerCase() === targetTo.toLowerCase()
      ) {
        transfersIn.push({
          token: tokenAddress,
          amount: value,
          logIndex: log.logIndex,
        });
      }

      // Output criteria: token is outToken, to = targetTo
      if (
        tokenAddress === outToken.toLowerCase() &&
        (decoded.args.to as string).toLowerCase() === targetTo.toLowerCase()
      ) {
        transfersOut.push({ amount: value, logIndex: log.logIndex });
      }
    } catch (e) {
      console.error("Error decoding event:", e);
      // Skip decoding errors
      continue;
    }
  }

  // Sort by log index to preserve order
  transfersIn.sort((a, b) => a.logIndex - b.logIndex);
  transfersOut.sort((a, b) => a.logIndex - b.logIndex);

  // Greedy pair: each input consumes the first later output not yet paired
  const pairedOut = new Array(transfersOut.length).fill(false);
  const tokenToOut: Record<string, bigint> = {};

  for (const input of transfersIn) {
    for (let i = 0; i < transfersOut.length; i++) {
      if (!pairedOut[i] && transfersOut[i].logIndex > input.logIndex) {
        tokenToOut[input.token] =
          (tokenToOut[input.token] || 0n) + transfersOut[i].amount;
        pairedOut[i] = true;
        break;
      }
    }
  }

  return tokenToOut;
}

export function mergeTokenMaps(
  map1: Record<string, bigint>,
  map2: Record<string, bigint>
): Record<string, bigint> {
  const merged: Record<string, bigint> = { ...map1 };
  for (const [token, amount] of Object.entries(map2)) {
    merged[token] = (merged[token] || 0n) + amount;
  }
  return merged;
}

export async function getGaugesInfos(protocol: string): Promise<GaugeInfo[]> {
  switch (protocol) {
    case "curve":
      return getCurveGaugesInfos();
    case "balancer":
      return getBalancerGaugesInfos();
    case "frax":
      return getFraxGaugesInfos();
    case "fxn":
      return getFxnGaugesInfos();
    case "cake":
      return getCakeGaugesInfos();
    case "pendle":
      return getPendleGaugesInfos();
    default:
      return [];
  }
}

async function getCurveGaugesInfos(): Promise<GaugeInfo[]> {
  try {
    const response = await axios.get(
      "https://raw.githubusercontent.com/stake-dao/votemarket-data/main/gauges/curve.json"
    );
    if (response.status === 200 && response.data.success) {
      const data = response.data.data;
      const gaugeInfos: GaugeInfo[] = [];
      
      Object.entries(data)
        .filter(
          ([_, gauge]: [string, any]) =>
            !(gauge.hasNoCrv || !gauge.gauge_controller)
        )
        .forEach(([_, gauge]: [string, any]) => {
          let gaugeName = gauge.shortName || "";
          const firstIndex = gaugeName.indexOf("(");
          if (firstIndex > -1) gaugeName = gaugeName.slice(0, firstIndex);
          
          // Add the regular gauge
          gaugeInfos.push({
            name: gaugeName,
            address: gauge.gauge.toLowerCase(),
            price: gauge.lpTokenPrice,
          });
          
          // If there's a rootGauge, also add an entry for it that maps to the actual gauge
          if (gauge.rootGauge) {
            gaugeInfos.push({
              name: gaugeName,
              address: gauge.rootGauge.toLowerCase(),
              actualGauge: gauge.gauge.toLowerCase(), // Store the actual gauge address
              price: gauge.lpTokenPrice,
            });
          }
        });
        
      return gaugeInfos;
    }
    console.error(
      "Failed to fetch Curve gauges: API responded with success: false"
    );
    return [];
  } catch (error) {
    console.error("Error fetching Curve gauges:", error);
    return [];
  }
}

async function getBalancerGaugesInfos(): Promise<GaugeInfo[]> {
  try {
    const response = await axios.post("https://api-v3.balancer.fi/", {
      query: `
        query {
          veBalGetVotingList {
            gauge {
              address
            }
            symbol
          }
        }
      `,
    });
    if (response.status === 200 && response.data.data?.veBalGetVotingList) {
      return response.data.data.veBalGetVotingList.map((pool: any) => ({
        name: pool.symbol,
        address: pool.gauge.address,
      }));
    }
    console.error("Failed to fetch Balancer pools: Invalid response");
    return [];
  } catch (error) {
    console.error("Error fetching Balancer pools:", error);
    return [];
  }
}

async function getFraxGaugesInfos(): Promise<GaugeInfo[]> {
  try {
    const response = await axios.get("https://api.frax.finance/v1/gauge/info");
    if (response.status === 200 && Array.isArray(response.data)) {
      return response.data.map((gauge: any) => ({
        name: gauge.name,
        address: gauge.address,
      }));
    }
    console.error("Failed to fetch Frax gauges: Invalid response format");
    return [];
  } catch (error) {
    console.error("Error fetching Frax gauges:", error);
    return [];
  }
}

async function getFxnGaugesInfos(): Promise<GaugeInfo[]> {
  try {
    // First attempt to get data from the primary API
    const response = await axios.get(
      "https://api.aladdin.club/api1/get_fx_gauge_list"
    );
    if (response.status === 200 && response.data.data) {
      return Object.entries(response.data.data).map(
        ([address, gauge]: [string, any]) => ({
          name: gauge.name || "",
          address,
        })
      );
    }

    // If primary API fails, try the fallback GitHub repository
    console.log("Primary FXN API failed, trying GitHub fallback source");
    return await getFxnGaugesFromGithub();
  } catch (error) {
    console.error("Error fetching FXN gauges from primary API:", error);

    // Try fallback on any error
    try {
      console.log("Attempting to fetch FXN gauges from GitHub fallback");
      return await getFxnGaugesFromGithub();
    } catch (fallbackError) {
      console.error("Error fetching FXN gauges from fallback:", fallbackError);
      return [];
    }
  }
}

/**
 * Fetches FXN gauge information from the GitHub repository as a fallback.
 */
async function getFxnGaugesFromGithub(): Promise<GaugeInfo[]> {
  const response = await axios.get(
    "https://raw.githubusercontent.com/stake-dao/votemarket-data/main/gauges/fxn.json"
  );

  if (response.status === 200 && response.data.data) {
    return Object.entries(response.data.data).map(
      ([address, gauge]: [string, any]) => ({
        name: gauge.name || "",
        address: address.toLowerCase(),
      })
    );
  }

  console.error(
    "Failed to fetch FXN gauges from GitHub: Invalid response format"
  );
  return [];
}

export async function getCakeGaugesInfos(): Promise<GaugeInfo[]> {
  try {
    const response = await axios.get(
      "https://raw.githubusercontent.com/stake-dao/votemarket-data/main/gauges/cake.json"
    );
    if (response.data.success) {
      return response.data.data;
    }
    console.error("Failed to fetch CAKE gauges: Invalid response format");
    return [];
  } catch (error) {
    console.error("Error fetching CAKE gauges:", error);
    return [];
  }
}

export const getPendleGaugesInfos = async (): Promise<GaugeInfo[]> => {
  try {
    const chains = [1, 42161, 5000, 56, 8453, 146];
    const responses = await Promise.all(
      chains.map((chainId) =>
        axios.get(
          `https://api-v2.pendle.finance/core/v1/${chainId}/markets/active`
        )
      )
    );

    const allMarkets = responses.flatMap((r) => r.data.markets);

    if (Array.isArray(allMarkets)) {
      return allMarkets.map((market: any) => ({
        name: `${market.name} - ${new Date(market.expiry)
          .toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
          .toUpperCase()
          .replace(/ /g, "")}`,
        address: market.address,
      }));
    } else {
      console.error("Failed to fetch Pendle gauges: Invalid response format");
      return [];
    }
  } catch (error) {
    console.error("Error fetching Pendle gauges:", error);
    return [];
  }
};

/**
 * Fetch transfer events to a specific delegation recipient address
 */
export async function fetchDelegationEvents(
  chainId: number,
  blockMin: number,
  blockMax: number,
  rewardTokens: string[],
  delegationAddress: string
): Promise<SwapEvent[]> {
  const explorerUtils = createBlockchainExplorerUtils();
  const transferSig = "Transfer(address,address,uint256)";
  const transferHash = keccak256(encodePacked(["string"], [transferSig]));
  const paddedDelegationAddress = pad(delegationAddress as `0x${string}`, {
    size: 32,
  }).toLowerCase();
  const topics = { "0": transferHash, "2": paddedDelegationAddress };

  const response = await explorerUtils.getLogsByAddressesAndTopics(
    rewardTokens,
    blockMin,
    blockMax,
    topics,
    chainId
  );

  const delegationEvents: SwapEvent[] = response.result.map((log) => {
    const [amount] = decodeAbiParameters([{ type: "uint256" }], log.data);
    return {
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      from: `0x${log.topics[1].slice(26)}`,
      to: `0x${log.topics[2].slice(26)}`,
      token: log.address,
      amount,
      transactionHash: log.transactionHash,
    };
  });

  const sorted = delegationEvents.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber
  );
  
  if (isDebugEnabled()) {
    debug("[fetchDelegationEvents] params", { 
      chainId, 
      blockMin, 
      blockMax, 
      tokens: rewardTokens.length, 
      delegationAddress 
    });
    debug("[fetchDelegationEvents] count", sorted.length);
    debug("[fetchDelegationEvents] sample", 
      sampleArray(sorted.map((s) => ({ 
        block: s.blockNumber, 
        logIndex: s.logIndex, 
        token: s.token, 
        tx: s.transactionHash 
      })), 5)
    );
  }
  
  return sorted;
}
