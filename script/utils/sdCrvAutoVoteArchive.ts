import { isDeepStrictEqual } from "node:util";
import {
  createPublicClient, getAddress, http, isHash, numberToHex, parseAbi, rpcSchema, stringToHex, zeroAddress,
  type Address, type ContractFunctionReturnType, type Hex, type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { AUTO_VOTER_CONTRACT, AUTO_VOTER_DELEGATION_ADDRESS, DELEGATE_REGISTRY, SDCRV_SPACE } from "./constants";
import { getAvailableEndpoints } from "./rpcConfig";

const abi = parseAbi([
  "function get(address user, string space) view returns ((address user, address[] gauges, uint256[] weights, bool killed))",
  "function space_votes_index(string space) view returns (uint256)",
  "function votes(string space, uint256 index) view returns (address user, bool killed)",
]);
const delegationAbi = parseAbi(["function delegation(address delegator, bytes32 id) view returns (address)"]);
export type SdCrvAutoRegistration = ContractFunctionReturnType<typeof abi, "view", "get">;
type Window = { addresses: readonly string[]; fromBlock: bigint; toBlock: bigint };
type Trace = { type: string; action: { to: Address }; blockNumber: number | Hex; transactionHash: Hex; traceAddress: number[] };
type Filter = { fromBlock: Hex; toBlock: Hex; toAddress: Address[]; after: number; count: number };
const schema = rpcSchema<[{ Method: "trace_filter"; Parameters: [Filter]; ReturnType: Trace[] }]>();
const traceBlockRange = 2000n;
const tracePageSize = 128;
const maxBlocksWithoutTraces = 256n;

// Registry slots are permanent, including registrations disabled after the bot read them.
export async function getSdCrvAutoVoteDelegators(
  client: Pick<PublicClient, "readContract" | "multicall">, creationBlock: bigint, voteBlock: bigint,
) {
  if (creationBlock > voteBlock) throw new Error("sdCRV proposal creation block is after the vote");
  const count = await client.readContract({
    address: AUTO_VOTER_CONTRACT, abi, functionName: "space_votes_index", args: [SDCRV_SPACE], blockNumber: voteBlock,
  });
  const registrations = await client.multicall({
    blockNumber: voteBlock, allowFailure: false,
    contracts: Array.from({ length: Number(count) }, (_, i) => ({
      address: AUTO_VOTER_CONTRACT, abi, functionName: "votes", args: [SDCRV_SPACE, BigInt(i + 1)],
    } as const)),
  });
  if (BigInt(registrations.length) !== count) throw new Error("Incomplete sdCRV AutoVoter index");
  const voters = registrations.map(([user]) => user.toLowerCase() as Address);
  if (voters.includes(zeroAddress) || new Set(voters).size !== voters.length) throw new Error("Invalid sdCRV AutoVoter index");
  const spaceId = stringToHex(SDCRV_SPACE, { size: 32 });
  const delegates = await client.multicall({
    blockNumber: creationBlock, allowFailure: false,
    contracts: voters.map(voter => ({
      address: DELEGATE_REGISTRY, abi: delegationAbi, functionName: "delegation", args: [voter, spaceId],
    } as const)),
  });
  if (delegates.length !== voters.length) throw new Error("Incomplete sdCRV delegation registry response");
  return voters.map((voter, i) => ({
    voter, delegatedAtCreation: delegates[i].toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase(),
  }));
}

function archiveClient(url: string) {
  return createPublicClient({ chain: mainnet, rpcSchema: schema, transport: http(url, { timeout: 30_000, retryCount: 0 }) });
}
type Client = ReturnType<typeof archiveClient>;

async function findCallBlocks(client: Client, fromBlock: bigint, toBlock: bigint) {
  const blocks = new Set<bigint>();
  for (let first = fromBlock + 1n; first <= toBlock; first += traceBlockRange) {
    const last = first + traceBlockRange > toBlock ? toBlock : first + traceBlockRange - 1n;
    const range: Pick<Filter, "fromBlock" | "toBlock" | "toAddress"> = {
      fromBlock: numberToHex(first), toBlock: numberToHex(last), toAddress: [AUTO_VOTER_CONTRACT],
    };
    const seen = new Set<string>();
    while (true) {
      const page = await client.request({
        method: "trace_filter", params: [{ ...range, after: seen.size, count: tracePageSize }],
      });
      if (!Array.isArray(page) || page.length > tracePageSize) throw new Error("Invalid registry trace page");
      if (!page.length) break; // Providers may impose a smaller page size than requested.
      for (const { type, action, blockNumber, transactionHash, traceAddress } of page) {
        const block = BigInt(blockNumber);
        if (type !== "call" || action.to.toLowerCase() !== AUTO_VOTER_CONTRACT.toLowerCase() ||
            block < first || block > last || !isHash(transactionHash) || !Array.isArray(traceAddress) ||
            !traceAddress.every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid registry trace");
        const id = transactionHash + "/" + traceAddress.join(".");
        if (seen.has(id)) throw new Error("Registry trace pagination did not advance");
        seen.add(id);
        blocks.add(block); // Include internal calls, unrelated callers and read-only calls.
      }
    }
  }
  return blocks;
}

async function readHistory(client: Client, addresses: Address[], from: bigint, to: bigint, touched: Set<bigint>) {
  // The registry emits no events. Check both sides of each call block, including
  // calls from contract wallets, to observe changes reverted before the bot voted.
  const checkpoints = new Set([from, to]);
  for (const block of touched) {
    checkpoints.add(block - 1n);
    checkpoints.add(block);
  }
  const contracts = addresses.map(address => ({
    address: AUTO_VOTER_CONTRACT, abi, functionName: "get", args: [address, SDCRV_SPACE],
  } as const));
  const history = new Map<string, SdCrvAutoRegistration[]>(addresses.map(address => [address, []]));
  let previous: readonly SdCrvAutoRegistration[] | undefined;
  for (const blockNumber of [...checkpoints].sort((a, b) => Number(a - b))) {
    const current = await client.multicall({ contracts, blockNumber, allowFailure: false });
    if (current.length !== contracts.length) throw new Error("Incomplete registry archive");
    if (previous && !touched.has(blockNumber) && !isDeepStrictEqual(current, previous)) {
      throw new Error("Registry changed without an indexed call");
    }
    for (const [i, registration] of current.entries()) {
      const versions = history.get(addresses[i])!;
      if (!versions.some(version => isDeepStrictEqual(version, registration))) versions.push(registration);
    }
    previous = current;
  }
  return history;
}

export async function readSdCrvAutoVoteArchive({ addresses, fromBlock, toBlock }: Window) {
  if (fromBlock < 0n || fromBlock > toBlock) throw new Error("Invalid sdCRV AutoVoter archive window");
  const accounts = [...new Set(addresses.map(a => getAddress(a.toLowerCase()).toLowerCase() as Address))];
  if (!accounts.length) return new Map<string, SdCrvAutoRegistration[]>();
  const clients = getAvailableEndpoints(1).map(({ url }) => archiveClient(url));
  const modes = toBlock - fromBlock <= maxBlocksWithoutTraces ? ["indexed", "all"] : ["indexed"];
  for (const mode of modes) {
    for (const client of clients) {
      try {
        const touched = mode === "indexed" ? await findCallBlocks(client, fromBlock, toBlock) : new Set<bigint>();
        if (mode === "all") {
          for (let block = fromBlock + 1n; block <= toBlock; block++) touched.add(block);
        }
        return await readHistory(client, accounts, fromBlock, toBlock, touched);
      } catch {
        // Retry the whole window on another archive to keep pagination consistent.
      }
    }
  }
  throw new Error(`No RPC could verify the complete sdCRV AutoVoter archive for blocks ${fromBlock}–${toBlock}`);
}
