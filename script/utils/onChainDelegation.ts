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
export const getDelegatedWeightsAtEpochRaw = async (
  delegationContract: string,
  epoch: number,
  addresses: string[],
  client: any
): Promise<Record<string, bigint>> => {
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
    addresses.map((addr, i) => [addr.toLowerCase(), weights[i]])
  );
};

/** Same as getDelegatedWeightsAtEpochRaw, values converted to Number. */
export const getDelegatedWeightsAtEpoch = async (
  delegationContract: string,
  epoch: number,
  addresses: string[],
  client: any
): Promise<Record<string, number>> => {
  const raw = await getDelegatedWeightsAtEpochRaw(
    delegationContract,
    epoch,
    addresses,
    client
  );
  return Object.fromEntries(
    Object.entries(raw).map(([addr, wei]) => [
      addr,
      Number(formatUnits(wei, 18)),
    ])
  );
};

const GAUGE_VOTE_HELPER_ABI = parseAbi([
  "function getContributingWeights(uint256 _proposalId, address _delegate, address[] _users, address _gaugePlatform) external view returns (uint256[])",
]);

// The helper replays sync-nonce accounting per user, so this eth_call is
// compute-heavy server-side. Public gateways shed it under load with
// "evm timeout" (-32009, observed on mainnet.gateway.tenderly.co) — a
// NONSTANDARD error code that viem's transport does NOT retry, so one
// throttled response would kill the whole run. Chunk small, and let
// readHelperChunk retry with backoff then split before giving up.
const HELPER_CHUNK_SIZE = 25;
const HELPER_RETRIES = 3;
const HELPER_BACKOFF_MS = 2000;

/**
 * Per-delegator weight AS INCORPORATED IN THE DELEGATE'S VOTE on a given
 * platform proposal, via GaugeVoteHelper.getContributingWeights.
 *
 * Unlike userWeightAtEpochOf (the CURRENT synced table, mutable until the
 * epoch rolls), the helper replays the platform's sync-nonce accounting:
 * - delegator synced AFTER the delegate's last vote -> pre-sync weight (the
 *   increase went to pendingWeightAdjustment and did NOT weigh this round);
 * - delegator voted directly -> 0, or only the delta that stayed with the
 *   delegate (synced between their own vote and the delegate's);
 * - not delegating to `delegateTo` at the proposal epoch -> 0.
 * Weights must be fetched separately per platform (Curve / FXN): the
 * delegate's lastVoteSyncNonce differs per proposal.
 */
export const getContributingWeightsAtVote = async (
  helperContract: string,
  gaugeVotePlatformAddress: string,
  proposalId: number,
  delegateTo: string,
  delegators: string[],
  client: any
): Promise<Record<string, number>> => {
  if (delegators.length === 0) return {};

  // Retry the chunk with backoff (transient gateway throttling), then split
  // it in halves (persistent per-call compute cap). A single user still
  // failing after its own retries throws — a silent 0 weight would quietly
  // redistribute that delegator's share to the others.
  const readHelperChunk = async (chunk: string[]): Promise<bigint[]> => {
    let lastError: any;
    for (let attempt = 0; attempt < HELPER_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, HELPER_BACKOFF_MS * attempt));
      }
      try {
        return (await client.readContract({
          address: helperContract,
          abi: GAUGE_VOTE_HELPER_ABI,
          functionName: "getContributingWeights",
          args: [
            BigInt(proposalId),
            getAddress(delegateTo),
            chunk.map((a) => getAddress(a)),
            getAddress(gaugeVotePlatformAddress),
          ],
        })) as bigint[];
      } catch (error) {
        lastError = error;
      }
    }
    if (chunk.length === 1) throw lastError;
    console.warn(
      `getContributingWeights failed for a ${chunk.length}-user chunk after ` +
        `${HELPER_RETRIES} attempts — splitting in halves`
    );
    const mid = Math.ceil(chunk.length / 2);
    return [
      ...(await readHelperChunk(chunk.slice(0, mid))),
      ...(await readHelperChunk(chunk.slice(mid))),
    ];
  };

  const out: Record<string, number> = {};
  for (let i = 0; i < delegators.length; i += HELPER_CHUNK_SIZE) {
    const chunk = delegators.slice(i, i + HELPER_CHUNK_SIZE);
    const weights = await readHelperChunk(chunk);
    chunk.forEach((addr, j) => {
      out[addr.toLowerCase()] = Number(formatUnits(weights[j], 18));
    });
  }
  return out;
};

/**
 * Cross-checks the enumerated delegators against the delegate's on-chain
 * delegation weight: sum(userWeightAtEpochOf(epoch, delegator)) must EXACTLY
 * equal GaugeDelegation.balanceAtEpochOf(epoch, delegate). The contract
 * maintains delegateEpochWeights by applying the same packed deltas it writes
 * to userEpochWeights (sync/_syncUser), so both sides are the identical
 * accounting and any non-zero wei difference means the delegator set is
 * wrong: a deficit = the DelegateSet log scan missed delegators (the found
 * ones would be renormalized and overpaid), an excess = extra/duplicate
 * delegators. Compared in bigint (no float rounding), throws on any mismatch.
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
  if (delegateWeightWei === 0n) return; // nothing delegated at this epoch

  const weightsWei = await getDelegatedWeightsAtEpochRaw(
    delegationContract,
    epoch,
    delegators,
    client
  );
  const sumWei = Object.values(weightsWei).reduce((acc, w) => acc + w, 0n);
  const diffWei = sumWei - delegateWeightWei;

  // Percentage only for log readability — the check itself is exact.
  const deficitPct =
    Number(formatUnits(delegateWeightWei - sumWei, 18)) /
    Number(formatUnits(delegateWeightWei, 18));
  console.log(
    `Delegators completeness check: ${delegators.length} delegators, ` +
      `sum delegated weight = ${formatUnits(sumWei, 18)} vlCVX vs delegate weight = ` +
      `${formatUnits(delegateWeightWei, 18)} vlCVX (deficit ${(deficitPct * 100).toFixed(3)}%)`
  );

  if (diffWei !== 0n) {
    throw new Error(
      `Delegators sum weight (${formatUnits(sumWei, 18)} vlCVX) does not exactly ` +
        `match the on-chain delegate weight (${formatUnits(delegateWeightWei, 18)} vlCVX) ` +
        `at epoch ${epoch} (diff ${formatUnits(diffWei, 18)} vlCVX): ` +
        (diffWei < 0n
          ? `the DelegateSet log scan is likely incomplete — the found delegators ` +
            `would be renormalized and overpaid`
          : `extra or duplicate delegators were enumerated`) +
        ` — aborting`
    );
  }
};
