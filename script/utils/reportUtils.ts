import axios from "axios";
import {
  decodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  pad,
} from "viem";
import { gql, request } from "graphql-request";
import { getContract, formatUnits, PublicClient, Address } from "viem";
import { erc20Abi } from "viem";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { getClosestBlockTimestamp } from "./chainUtils";
import { Proposal } from "../interfaces/Proposal";

const WEEK = 604800; // One week in seconds

interface SwapEvent {
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  token: string;
  amount: bigint;
}

interface MatchedReward {
  address: string;
  symbol: string;
  amount: number;
  weth: number;
}

export const WETH_ADDRESS = getAddress(
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
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
export const BOSS = getAddress(
  "0xB0552b6860CE5C0202976Db056b5e3Cc4f9CC765"
);

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

export async function getTokenInfo(
  publicClient: PublicClient,
  tokenAddress: string
) {
  const contract = getContract({
    address: tokenAddress as Address,
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
    return { symbol: "Unknown", decimals: 18 }; // Default values
  }
}

/**
 * Retrieves timestamps and block numbers for a specified week.
 * @param {number | undefined} pastWeek - Number of weeks in the past (0 for current week).
 * @returns {Promise<{timestamp1: number, timestamp2: number, timestampEnd: number, blockNumber1: number, blockNumber2: number, blockNumberEnd: number}>}
 */
export async function getTimestampsBlocks(
  publicClient: PublicClient,
  pastWeek?: number
) {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  let timestamp2: number;
  let timestamp1: number;

  if (pastWeek === undefined || pastWeek === 0) {
    console.log("No past week specified, using current week");
    timestamp2 = currentTimestamp;
    timestamp1 = Math.floor(currentTimestamp / WEEK) * WEEK; // Rounded down to the start of the current week
  } else {
    console.log(`Past week specified: ${pastWeek}`);

    timestamp2 = Math.floor(currentTimestamp / WEEK) * WEEK;
    timestamp1 = timestamp2 - pastWeek * WEEK;
  }

  const blockNumber1 = await getClosestBlockTimestamp("ethereum", timestamp1);
  const blockNumber2 =
    pastWeek === undefined || pastWeek === 0
      ? Number(await publicClient.getBlockNumber())
      : await getClosestBlockTimestamp("ethereum", timestamp2);

  return {
    timestamp1,
    timestamp2,
    blockNumber1,
    blockNumber2,
  };
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
};

const SNAPSHOT_ENDPOINT = "https://hub.snapshot.org/graphql";


interface Timestamps {
  [key: number]: Proposal;
}

interface BlockSwaps {
  [blockNumber: number]: bigint[];
}

export function transformSwapEvents(swapEvents: SwapEvent[]): BlockSwaps {
  return swapEvents.reduce((acc: BlockSwaps, event) => {
    if (!acc[event.blockNumber]) {
      acc[event.blockNumber] = [];
    }
    acc[event.blockNumber].push(event.amount);
    return acc;
  }, {});
}

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


  let associated_timestamps: Timestamps = {};

  for (const proposal of proposals) {
    const title = proposal.title;
    const dateStrings = title.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);

    if (dateStrings && dateStrings.length >= 2) {
      const [date_a, date_b] = dateStrings;

      const parts_a = date_a.split("/");
      const parts_b = date_b.split("/");

      // Convert dd/mm/yyyy to mm/dd/yyyy by swapping the first two elements
      const correctFormat_a = `${parts_a[1]}/${parts_a[0]}/${parts_a[2]}`;
      const correctFormat_b = `${parts_b[1]}/${parts_b[0]}/${parts_b[2]}`;

      const timestamp_a = new Date(correctFormat_a).getTime() / 1000;
      const timestamp_b = new Date(correctFormat_b).getTime() / 1000;

      // Associate if the period is between a and b
      if (period + 82800 >= timestamp_a && period <= timestamp_b) {
        associated_timestamps[period] = proposal;
      }
    }
  }
  return associated_timestamps;
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
  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [contractAddress],
  });

  return balance;
}

// Define the ABI for the gauge controller contract
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

    // weight is returned in 1e18 scale
    return Number(formatUnits(weight, 18));
  } catch (error) {
    console.error(`Error fetching gauge weight for ${gaugeAddress}:`, error);
    return 0;
  }
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

  const topics = {
    "0": transferHash,
    "2": paddedContractAddress,
  };

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
      amount: amount,
    };
  });

  return swapEvents.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber
  );
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

  const topics = {
    "0": transferHash,
    "1": paddedContractAddress,
  };

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
      amount: amount,
    };
  });

  return swapEvents.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber - b.blockNumber
  );
}

export function matchWethInWithRewardsOut(blockData: any): MatchedReward[] {
  const wethIn = blockData.wethIn || [];
  const rewardsOut = blockData.rewardsOut || [];

  if (wethIn.length === 0 || rewardsOut.length === 0) {
    return []; // Return empty array if either wethIn or rewardsOut is empty
  }

  if (wethIn.length !== rewardsOut.length) {
    console.warn(
      `Mismatch in WETH inputs (${wethIn.length}) and reward outputs (${rewardsOut.length})`
    );
  }

  const matchLength = Math.min(wethIn.length, rewardsOut.length);

  return wethIn
    .slice(0, matchLength)
    .map((wethAmount: number, index: number) => ({
      address: rewardsOut[index].token,
      symbol: rewardsOut[index].symbol,
      amount: rewardsOut[index].amount,
      weth: wethAmount,
    }));
}

interface GaugeInfo {
  name: string;
  shortName?: string;
  address: string;
  price?: string;
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
      return Object.entries(data)
        .filter(
          ([_, gauge]: [string, any]) =>
            !(gauge.hasNoCrv || !gauge.gauge_controller)
        )
        .map(([_, gauge]: [string, any]) => {
          let gaugeName = gauge.shortName || "";
          const firstIndex = gaugeName.indexOf("(");
          if (firstIndex > -1) {
            gaugeName = gaugeName.slice(0, firstIndex);
          }
          return {
            name: gaugeName,
            address: (gauge.rootGauge || gauge.gauge).toLowerCase(),
            price: gauge.lpTokenPrice,
          };
        });
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
    const response = await axios.get(
      "https://api.aladdin.club/api1/get_fx_gauge_list"
    );
    if (response.status === 200 && response.data.data) {
      return Object.entries(response.data.data).map(
        ([address, gauge]: [string, any]) => ({
          name: gauge.name || "",
          address: address,
        })
      );
    }
    console.error("Failed to fetch FXN gauges: Invalid response format");
    return [];
  } catch (error) {
    console.error("Error fetching FXN gauges:", error);
    return [];
  }
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