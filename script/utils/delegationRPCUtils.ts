import pLimit from "p-limit";
import { getAddress, parseAbi, parseAbiItem, stringToHex } from "viem";
import {
  DELEGATE_REGISTRY,
  DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  DELEGATE_REGISTRY_CREATION_BLOCK_BSC,
  DELEGATE_REGISTRY_CREATION_BLOCK_BASE,
  SPACE_TO_CHAIN_ID,
} from "./constants";
import { getClient } from "./getClients";
import { processAllDelegators } from "./cacheUtils";

const REGISTRY_ABI = parseAbi([
  "function delegation(address delegator, bytes32 id) view returns (address)",
]);
const SET_DELEGATE = parseAbiItem(
  "event SetDelegate(address indexed delegator, bytes32 indexed id, address indexed delegate)"
);
const CREATION_BLOCKS: Record<string, number> = {
  "1": DELEGATE_REGISTRY_CREATION_BLOCK_ETH,
  "56": DELEGATE_REGISTRY_CREATION_BLOCK_BSC,
  "8453": DELEGATE_REGISTRY_CREATION_BLOCK_BASE,
};
const LOG_CHUNK_SIZE = 50_000n;

/**
 * Compare the complete parquet delegator sets with the Snapshot registry at
 * one block (finalized by default). Enumerating Set events independently of
 * parquet also finds missing wallets; reading the registry removes wallets
 * that have since cleared or redirected their delegation. RPC/cache errors
 * propagate: neither an unavailable space nor a failed log page is skipped.
 */
export async function verifyAllSpacesAgainstRPC(
  chainId: string,
  delegationAddress: string,
  blockNumber?: bigint
): Promise<void> {
  const creationBlock = CREATION_BLOCKS[chainId];
  if (creationBlock === undefined) throw new Error(`Unsupported delegation chain ${chainId}`);

  const client = await getClient(Number(chainId));
  const block = await client.getBlock(
    blockNumber === undefined ? { blockTag: "finalized" } : { blockNumber }
  );
  const target = getAddress(delegationAddress);
  const spaces = Object.entries(SPACE_TO_CHAIN_ID)
    .filter(([, id]) => id === chainId)
    .map(([space]) => space);
  const candidatesBySpace = new Map(
    spaces.map((space) => [stringToHex(space, { size: 32 }), new Set<string>()])
  );
  console.log(
    `Verifying Snapshot delegations via RPC on chain ${chainId} at block ` +
    `${block.number} (${block.hash}), timestamp ${block.timestamp}`
  );

  // Scan once for all spaces, not once per space. Bounded concurrency keeps
  // the independent full-history check practical without flooding providers.
  const limit = pLimit(4);
  const scans: Promise<void>[] = [];
  for (let from = BigInt(creationBlock); from <= block.number; from += LOG_CHUNK_SIZE) {
    const fromBlock = from;
    const toBlock = from + LOG_CHUNK_SIZE - 1n < block.number
      ? from + LOG_CHUNK_SIZE - 1n
      : block.number;
    scans.push(limit(async () => {
      const logs = await client.getLogs({
        address: getAddress(DELEGATE_REGISTRY),
        event: SET_DELEGATE,
        args: { delegate: target },
        fromBlock,
        toBlock,
        strict: true,
      });
      for (const log of logs) {
        candidatesBySpace.get(log.args.id)?.add(log.args.delegator.toLowerCase());
      }
    }));
  }
  try {
    await Promise.all(scans);
  } catch (error) {
    limit.clearQueue();
    throw error;
  }

  for (const space of spaces) {
    const id = stringToHex(space, { size: 32 });
    const parquet = new Set((await processAllDelegators(
      space, Number(block.timestamp), delegationAddress
    )).map((user) => user.toLowerCase()));
    const candidates = [...new Set([...candidatesBySpace.get(id)!, ...parquet])];
    const delegates = candidates.length === 0 ? [] : await client.multicall({
      allowFailure: false,
      batchSize: 8192,
      blockNumber: block.number,
      contracts: candidates.map((user) => ({
        address: getAddress(DELEGATE_REGISTRY),
        abi: REGISTRY_ABI,
        functionName: "delegation",
        args: [getAddress(user), id],
      } as const)),
    });
    const rpc = new Set(candidates.filter(
      (_, i) => delegates[i].toLowerCase() === target.toLowerCase()
    ));
    const parquetOnly = [...parquet].filter((user) => !rpc.has(user));
    const rpcOnly = [...rpc].filter((user) => !parquet.has(user));
    if (parquetOnly.length || rpcOnly.length) {
      throw new Error(
        `Delegation verification failed for ${space} at block ${block.number}: ` +
        `${parquetOnly.length} in parquet only [${parquetOnly.join(", ")}], ` +
        `${rpcOnly.length} in RPC only [${rpcOnly.join(", ")}]`
      );
    }
    console.log(`  ✓ ${space}: ${rpc.size} delegators match RPC at block ${block.number}`);
  }
}
