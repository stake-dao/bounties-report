import {
  parseAbi,
  parseAbiItem,
  getAddress,
  keccak256,
  encodePacked,
  pad,
} from "viem";
import { CVX_GAUGE_DELEGATION_CREATION_BLOCK_ETH } from "./constants";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { getOnChainVotingPower } from "./gaugeVotePlatform";

const DELEGATION_ABI = parseAbi([
  "function getDelegateAtEpoch(address user, uint256 epoch) external view returns (address)",
  "function balanceAtEpochOf(uint256 epoch, address delegate) external view returns (uint256)",
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
 * Cross-checks the enumerated delegators against the delegate's on-chain
 * delegation weight: sum(vlCVX.balanceAtEpochOf(epoch, delegator)) should
 * match GaugeDelegation.balanceAtEpochOf(epoch, delegate) up to the 0.1 vlCVX
 * per-delegator truncation (WEIGHT_DIVISOR = 1e17) plus sync lag (delegation
 * weights are only synced when users vote/relock, so real balances usually run
 * slightly ABOVE the delegate weight — observed +1.3% right after the seed).
 * Only a DEFICIT signals missing delegators, so the hard stop is one-sided:
 * throws when sum VP is >5% BELOW the delegate weight (log scan almost
 * certainly incomplete).
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

  const vps = await getOnChainVotingPower(epoch, delegators, client);
  const sumVp = Object.values(vps).reduce((acc, vp) => acc + vp, 0);

  const deficit = (delegateWeight - sumVp) / delegateWeight;
  const truncationTolerance = 0.1 * delegators.length + 1;

  console.log(
    `Delegators completeness check: ${delegators.length} delegators, ` +
      `sum VP = ${sumVp.toFixed(2)} vlCVX vs delegate weight = ${delegateWeight.toFixed(2)} vlCVX ` +
      `(deficit ${(deficit * 100).toFixed(3)}%)`
  );

  if (deficit > 0.05) {
    throw new Error(
      `Delegators sum VP (${sumVp.toFixed(2)}) is ${(deficit * 100).toFixed(2)}% below ` +
        `the on-chain delegate weight (${delegateWeight.toFixed(2)}) at epoch ${epoch} — ` +
        `the DelegateSet log scan is likely incomplete, aborting`
    );
  }
  if (Math.abs(sumVp - delegateWeight) > truncationTolerance) {
    console.warn(
      `Warning: delegators sum VP differs from delegate weight beyond the ` +
        `truncation tolerance (±${truncationTolerance.toFixed(1)} vlCVX) — sync lag is ` +
        `expected to run high, but investigate if this grows`
    );
  }
};
