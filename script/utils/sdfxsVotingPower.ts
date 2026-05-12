import axios from "axios";
import {
  formatUnits,
  getAddress,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { getClient } from "./constants";

const LEGACY_VE_SDT = getAddress("0x0C30476f66034E11782938DF8e4384970B6c9e8a");
const LEGACY_VE_PROXY_BOOST_SDT = getAddress("0xD67bdBefF01Fc492f1864E61756E5FBB3f173506");
const VL_SDT = getAddress("0x94818A7baa7e9F5dC62ce4da1B52ef9a760b80B8");
const VL_PROXY_BOOST_SDT = getAddress("0xaB05ca46d1c78CAbB051efFE35099714Cad2AddA");
const TOKENLESS_PRODUCTION = 40;

const SD_FXS_SCORE_ABI = parseAbi([
  "function adjusted_balance_of(address user) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

type SnapshotStrategy = {
  name: string;
  params: Record<string, any>;
};

type SnapshotProposal = {
  snapshot: string | number;
  strategies: SnapshotStrategy[];
};

type SdGaugeLessVoteBoostOptions = {
  targetChainId: string | number;
  sdTokenGaugeDestinationChain: string;
  blocksPerDay: number;
  twavpDaysInterval: number;
  twavpNumberOfBlocks: number;
  whiteListedAddress?: string[];
  delegation?: Record<string, string>;
  veSDTUserAddresses?: Record<string, string>;
};

type ScoringContracts = {
  votingToken: Address;
  boostProxy: Address;
};

function format18(value: bigint): number {
  return Number(formatUnits(value, 18));
}

function isZeroDataRead(error: any): boolean {
  const text = String(error?.shortMessage || error?.message || "");
  return text.includes("returned no data") || text.includes("Cannot decode zero data");
}

async function readContract18(
  client: PublicClient,
  parameters: Parameters<PublicClient["readContract"]>[0],
  zeroOnNoData: boolean = false
): Promise<number> {
  try {
    const value = await client.readContract(parameters);
    return format18(value as bigint);
  } catch (error) {
    if (zeroOnNoData && isZeroDataRead(error)) {
      return 0;
    }
    throw error;
  }
}

function getPreviousBlocks(
  currentBlockNumber: number,
  numberOfBlocks: number,
  daysInterval: number,
  blocksPerDay: number
): bigint[] {
  const totalBlocksInterval = blocksPerDay * daysInterval;
  const blockInterval =
    totalBlocksInterval / (numberOfBlocks > 1 ? numberOfBlocks - 1 : numberOfBlocks);

  return Array.from({ length: numberOfBlocks }, (_, i) => {
    return BigInt(Math.round(currentBlockNumber - totalBlocksInterval + blockInterval * i));
  });
}

async function getDestinationChainBlock(
  snapshotBlock: bigint,
  targetChainId: string,
  mainnetClient: PublicClient
): Promise<bigint> {
  const block = await mainnetClient.getBlock({ blockNumber: snapshotBlock });
  const { data } = await axios.post(
    "https://blockfinder.snapshot.org",
    {
      query: `
        query Blocks($ts: Int!, $network: String!) {
          blocks(where: { ts: $ts, network_in: [$network] }) {
            number
          }
        }
      `,
      variables: {
        ts: Number(block.timestamp),
        network: targetChainId,
      },
    },
    { timeout: 60000 }
  );

  const blockNumber = data?.data?.blocks?.[0]?.number;
  if (blockNumber === undefined || blockNumber === null) {
    throw new Error(`No blockfinder result for chain ${targetChainId} at ${block.timestamp}`);
  }

  return BigInt(blockNumber);
}

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const address of addresses) {
    const normalized = getAddress(address).toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function findSdFxsStrategy(proposal: SnapshotProposal): SnapshotStrategy | undefined {
  return proposal.strategies.find((strategy) => strategy.name === "sd-gauge-less-vote-boost");
}

async function getScoringContracts(
  client: PublicClient,
  snapshotBlock: bigint
): Promise<ScoringContracts> {
  // Snapshot migrated this strategy from veSDT to vlSDT; historical proposals
  // before vlSDT supply exists must still be scored with the legacy contracts.
  const vlSupply = await readContract18(
    client,
    {
      address: VL_SDT,
      abi: SD_FXS_SCORE_ABI,
      functionName: "totalSupply",
      blockNumber: snapshotBlock,
    },
    true
  );

  if (vlSupply > 0) {
    return {
      votingToken: VL_SDT,
      boostProxy: VL_PROXY_BOOST_SDT,
    };
  }

  return {
    votingToken: LEGACY_VE_SDT,
    boostProxy: LEGACY_VE_PROXY_BOOST_SDT,
  };
}

export function canComputeSdFxsVotingPower(proposal: SnapshotProposal): boolean {
  return Boolean(findSdFxsStrategy(proposal));
}

export async function getSdFxsVotingPower(
  proposal: SnapshotProposal,
  inputAddresses: string[]
): Promise<Record<string, number>> {
  const strategy = findSdFxsStrategy(proposal);
  if (!strategy) {
    throw new Error("No sd-gauge-less-vote-boost strategy found");
  }

  const options = strategy.params as SdGaugeLessVoteBoostOptions;
  if (!options.sdTokenGaugeDestinationChain || !options.targetChainId) {
    throw new Error("Invalid sd-gauge-less-vote-boost strategy parameters");
  }
  const twavpNumberOfBlocks = Number(options.twavpNumberOfBlocks || 2);
  const twavpDaysInterval = Number(options.twavpDaysInterval);
  const blocksPerDay = Number(options.blocksPerDay);

  if (twavpNumberOfBlocks > 2) {
    throw new Error("sd-gauge-less-vote-boost fallback supports at most 2 TWAVP blocks");
  }

  const targetChainId = String(options.targetChainId);
  const addresses = uniqueAddresses(inputAddresses);
  const scoreAddresses = [...addresses];
  const delegations = Object.entries(options.delegation || {}).map(([source, destination]) => ({
    source: getAddress(source).toLowerCase(),
    destination: getAddress(destination).toLowerCase(),
  }));

  for (const delegation of delegations) {
    if (!scoreAddresses.includes(delegation.source)) {
      scoreAddresses.push(delegation.source);
    }
  }

  const veSDTUserAddresses = Object.fromEntries(
    Object.entries(options.veSDTUserAddresses || {}).map(([address, veAddress]) => [
      getAddress(address).toLowerCase(),
      getAddress(veAddress).toLowerCase(),
    ])
  );
  const whiteListedAddresses = new Set(
    (options.whiteListedAddress || []).map((address) => getAddress(address).toLowerCase())
  );

  const mainnetClient = await getClient(1);
  const destinationClient = await getClient(Number(targetChainId));
  const snapshotBlock = BigInt(proposal.snapshot);
  const scoringContracts = await getScoringContracts(mainnetClient, snapshotBlock);
  const destinationBlock = await getDestinationChainBlock(snapshotBlock, targetChainId, mainnetClient);

  const mainnetBlocks = getPreviousBlocks(
    Number(snapshotBlock),
    twavpNumberOfBlocks,
    twavpDaysInterval,
    7200
  );
  const destinationBlocks = getPreviousBlocks(
    Number(destinationBlock),
    twavpNumberOfBlocks,
    twavpDaysInterval,
    blocksPerDay
  );

  const adjustedBalances: Record<string, number>[] = [];
  const gaugeBalances: Record<string, number>[] = [];
  let veSDTTotalSupply = 0;
  let sdTokenGaugeTotalSupplyDestinationChain = 0;

  for (let i = 0; i < twavpNumberOfBlocks; i++) {
    const mainnetBlock = mainnetBlocks[i];
    const destinationChainBlock = destinationBlocks[i];
    const isEnd = i === twavpNumberOfBlocks - 1;

    const adjustedEntries = await Promise.all(
      scoreAddresses.map(async (address) => {
        const mappedAddress = veSDTUserAddresses[address] || address;
        const value = await readContract18(
          mainnetClient,
          {
            address: scoringContracts.boostProxy,
            abi: SD_FXS_SCORE_ABI,
            functionName: "adjusted_balance_of",
            args: [getAddress(mappedAddress) as Address],
            blockNumber: mainnetBlock,
          },
          true
        );
        return [address, value] as const;
      })
    );

    const gaugeEntries = await Promise.all(
      scoreAddresses.map(async (address) => {
        const value = await readContract18(
          destinationClient,
          {
            address: getAddress(options.sdTokenGaugeDestinationChain) as Address,
            abi: SD_FXS_SCORE_ABI,
            functionName: "balanceOf",
            args: [getAddress(address) as Address],
            blockNumber: destinationChainBlock,
          },
          true
        );
        return [address, value] as const;
      })
    );

    adjustedBalances.push(Object.fromEntries(adjustedEntries));
    gaugeBalances.push(Object.fromEntries(gaugeEntries));

    if (isEnd) {
      const [veSupply, gaugeSupply] = await Promise.all([
        readContract18(mainnetClient, {
          address: scoringContracts.votingToken,
          abi: SD_FXS_SCORE_ABI,
          functionName: "totalSupply",
          blockNumber: mainnetBlock,
        }),
        readContract18(destinationClient, {
          address: getAddress(options.sdTokenGaugeDestinationChain) as Address,
          abi: SD_FXS_SCORE_ABI,
          functionName: "totalSupply",
          blockNumber: destinationChainBlock,
        }),
      ]);
      veSDTTotalSupply = veSupply;
      sdTokenGaugeTotalSupplyDestinationChain = gaugeSupply;
    }
  }

  const votingPower: Record<string, number> = {};
  for (const address of scoreAddresses) {
    const userWorkingBalances: number[] = [];

    for (let i = 0; i < twavpNumberOfBlocks; i++) {
      const votingBalance = adjustedBalances[i][address] || 0;
      const gaugeBalance = gaugeBalances[i][address] || 0;
      let limit = (gaugeBalance * TOKENLESS_PRODUCTION) / 100;

      if (veSDTTotalSupply > 0) {
        limit +=
          (((sdTokenGaugeTotalSupplyDestinationChain * votingBalance) / veSDTTotalSupply) *
            (100 - TOKENLESS_PRODUCTION)) /
          100;
      }

      userWorkingBalances.push(Math.min(gaugeBalance, limit));
    }

    votingPower[address] = whiteListedAddresses.has(address)
      ? userWorkingBalances[userWorkingBalances.length - 1]
      : userWorkingBalances.reduce((sum, value) => sum + value, 0) / userWorkingBalances.length;
  }

  for (const delegation of delegations) {
    if (votingPower[delegation.destination] !== undefined) {
      votingPower[delegation.destination] += votingPower[delegation.source] || 0;
    }
  }

  return Object.fromEntries(
    Object.entries(votingPower).map(([address, score]) => [getAddress(address).toLowerCase(), score])
  );
}
