import {
  parseAbi,
  parseAbiItem,
  getAddress,
  keccak256,
  encodePacked,
  pad,
  formatUnits,
} from "viem";
import { CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH } from "./constants";
import { createBlockchainExplorerUtils } from "./explorerUtils";

const DELEGATION_ABI = parseAbi([
  "function getDelegateAtEpoch(address user, uint256 epoch) external view returns (address)",
  "function balanceAtEpochOf(uint256 epoch, address delegate) external view returns (uint256)",
  "function userWeightAtEpochOf(uint256 epoch, address user) external view returns (uint256)",
]);

const delegateSetSignature = "DelegateSet(address,address)";
const delegateSetHash = keccak256(
  encodePacked(["string"], [delegateSetSignature])
);
const DELEGATE_SET_EVENT = parseAbiItem(
  "event DelegateSet(address indexed user, address indexed delegate)"
);

// Explorer API chunk size (same convention as cacheUtils delegator fetching)
const LOGS_CHUNK_SIZE = 50_000;

// Enumerates every user that ever emitted DelegateSet(*, delegateTo), via the
// explorer API (avoids RPC getLogs range limits on public/free-tier endpoints).
const fetchDelegateSetUsersViaExplorer = async (
  delegationContract: string,
  delegateTo: string,
  latestBlock: number
): Promise<Set<string>> => {
  const explorerUtils = createBlockchainExplorerUtils();
  const paddedDelegate = pad(getAddress(delegateTo), { size: 32 }).toLowerCase();
  const users = new Set<string>();

  for (
    let fromBlock = CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH;
    fromBlock <= latestBlock;
    fromBlock += LOGS_CHUNK_SIZE
  ) {
    const toBlock = Math.min(fromBlock + LOGS_CHUNK_SIZE - 1, latestBlock);
    const response = await explorerUtils.getLogsByAddressAndTopics(
      getAddress(delegationContract),
      fromBlock,
      toBlock,
      {
        "0": delegateSetHash,
        "2": paddedDelegate, // DelegateSet(user indexed, delegate indexed)
      },
      1
    );

    for (const log of response?.result || []) {
      // topics[1] = user (indexed address, left-padded to 32 bytes)
      users.add(("0x" + log.topics[1].slice(26)).toLowerCase());
    }
  }

  return users;
};

// Same enumeration through raw RPC eth_getLogs — needed when reading a fork
// (e.g. Tenderly virtual testnet): the explorer API only sees real mainnet,
// while the RPC sees the fork state including delegations made on the fork.
const fetchDelegateSetUsersViaRpc = async (
  delegationContract: string,
  delegateTo: string,
  latestBlock: number,
  client: any
): Promise<Set<string>> => {
  const users = new Set<string>();

  for (
    let fromBlock = CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH;
    fromBlock <= latestBlock;
    fromBlock += LOGS_CHUNK_SIZE
  ) {
    const toBlock = Math.min(fromBlock + LOGS_CHUNK_SIZE - 1, latestBlock);
    const logs = await client.getLogs({
      address: delegationContract,
      event: DELEGATE_SET_EVENT,
      args: { delegate: getAddress(delegateTo) },
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });

    for (const log of logs) {
      users.add((log.args.user as string).toLowerCase());
    }
  }

  return users;
};

/**
 * Returns the addresses actively delegating to `delegateTo` at the given vlCVX
 * epoch, from the Convex GaugeDelegation contract. Replaces
 * processAllDelegators (Snapshot delegate registry) for on-chain vlCVX rounds.
 *
 * ⚠️ For StakeDAO, delegateTo must be VLCVX_ONCHAIN_DELEGATION_ADDRESS
 * (0xbB06fEFB…) — the seed remapped all delegators there; the legacy Snapshot
 * DELEGATION_ADDRESS (0x52ea58f4…) has ZERO on-chain delegators.
 *
 * There is no reverse lookup on the contract, so:
 * 1. Fetch DelegateSet(*, delegateTo) logs via the explorer API (chunked, like
 *    cacheUtils) — seedDelegates() also emits DelegateSet, so the seeded
 *    delegators are included.
 * 2. Dedupe users (a user can emit DelegateSet several times).
 * 3. getDelegateAtEpoch(user, epoch) in one multicall, keep those still
 *    pointing to delegateTo — filters later re-delegations and revocations
 *    (setDelegate(address(0))).
 * 4. Sanity check: sum of delegators' vlCVX balances vs the delegate's
 *    on-chain delegation weight at the epoch. A large deficit means the log
 *    scan missed delegators (e.g. a failed explorer chunk masked as empty) —
 *    abort rather than distribute on an incomplete set.
 *
 * Returned addresses are lowercase.
 */
export const getOnChainDelegators = async (
  delegationContract: string,
  delegateTo: string,
  epoch: number,
  client: any,
  opts: { logsSource?: "explorer" | "rpc" } = {}
): Promise<string[]> => {
  const latestBlock = Number(await client.getBlockNumber());

  const users =
    opts.logsSource === "rpc"
      ? await fetchDelegateSetUsersViaRpc(
          delegationContract,
          delegateTo,
          latestBlock,
          client
        )
      : await fetchDelegateSetUsersViaExplorer(
          delegationContract,
          delegateTo,
          latestBlock
        );

  const candidates = [...users];
  if (candidates.length === 0) {
    throw new Error(
      `No DelegateSet events found for delegate ${delegateTo} on ${delegationContract} — ` +
        `expected at least the seeded delegators. Explorer API failure?`
    );
  }

  const delegatesAtEpoch = (await client.multicall({
    allowFailure: false,
    contracts: candidates.map((user) => ({
      address: delegationContract,
      abi: DELEGATION_ABI,
      functionName: "getDelegateAtEpoch",
      args: [user, BigInt(epoch)],
    })),
  })) as string[];

  const target = delegateTo.toLowerCase();
  const delegators = candidates.filter(
    (_, i) => delegatesAtEpoch[i].toLowerCase() === target
  );

  await assertDelegatorsCompleteness(
    delegationContract,
    delegateTo,
    epoch,
    delegators,
    client
  );

  return delegators;
};

/**
 * Synced delegation weight of each user at a vlCVX epoch, via
 * Delegation.userWeightAtEpochOf (0.1 vlCVX granularity, returned in wei).
 *
 * This is the weight that actually counted in the delegate's platform vote —
 * use it (NOT the raw vlCVX balance) to split the delegation pool: a user who
 * increased their lock without a sync() still votes with their OLD weight, so
 * paying them on their real balance would over-credit them and dilute the
 * other delegators.
 *
 * Keys of the returned record are lowercase.
 */
export const getDelegatedWeightsAtEpoch = async (
  delegationContract: string,
  epoch: number,
  addresses: string[],
  client: any
): Promise<Record<string, number>> => {
  if (addresses.length === 0) return {};

  const weights = (await client.multicall({
    allowFailure: false,
    contracts: addresses.map((addr) => ({
      address: delegationContract,
      abi: DELEGATION_ABI,
      functionName: "userWeightAtEpochOf",
      args: [BigInt(epoch), addr],
    })),
  })) as bigint[];

  return Object.fromEntries(
    addresses.map((addr, i) => [
      addr.toLowerCase(),
      Number(formatUnits(weights[i], 18)),
    ])
  );
};

/**
 * Cross-checks the enumerated delegators against the delegate's on-chain
 * delegation weight: sum(userWeightAtEpochOf(epoch, delegator)) must match
 * GaugeDelegation.balanceAtEpochOf(epoch, delegate) up to the 0.1 vlCVX
 * per-delegator truncation (WEIGHT_DIVISOR = 1e17) — both sides are synced
 * weights, so any real deficit means the DelegateSet log scan missed
 * delegators (e.g. a failed explorer chunk masked as empty). Throws on a >5%
 * deficit; warns beyond the truncation tolerance.
 */
const assertDelegatorsCompleteness = async (
  delegationContract: string,
  delegateTo: string,
  epoch: number,
  delegators: string[],
  client: any
): Promise<void> => {
  const delegateWeightWei: bigint = await client.readContract({
    address: delegationContract,
    abi: DELEGATION_ABI,
    functionName: "balanceAtEpochOf",
    args: [BigInt(epoch), getAddress(delegateTo)],
  });
  const delegateWeight = Number(delegateWeightWei) / 1e18;
  if (delegateWeight === 0) return; // nothing delegated at this epoch

  const weights = await getDelegatedWeightsAtEpoch(
    delegationContract,
    epoch,
    delegators,
    client
  );
  const sumWeights = Object.values(weights).reduce((acc, w) => acc + w, 0);

  const deficit = (delegateWeight - sumWeights) / delegateWeight;
  const truncationTolerance = 0.1 * delegators.length + 1;

  console.log(
    `Delegators completeness check: ${delegators.length} delegators, ` +
      `sum delegated weight = ${sumWeights.toFixed(2)} vlCVX vs delegate weight = ${delegateWeight.toFixed(2)} vlCVX ` +
      `(deficit ${(deficit * 100).toFixed(3)}%)`
  );

  if (deficit > 0.05) {
    throw new Error(
      `Delegators sum weight (${sumWeights.toFixed(2)}) is ${(deficit * 100).toFixed(2)}% below ` +
        `the on-chain delegate weight (${delegateWeight.toFixed(2)}) at epoch ${epoch} — ` +
        `the DelegateSet log scan is likely incomplete, aborting`
    );
  }
  if (Math.abs(sumWeights - delegateWeight) > truncationTolerance) {
    console.warn(
      `Warning: delegators sum weight differs from delegate weight beyond the ` +
        `truncation tolerance (±${truncationTolerance.toFixed(1)} vlCVX) — investigate`
    );
  }
};
