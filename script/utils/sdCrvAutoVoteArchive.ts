import {
  parseAbi, stringToHex, zeroAddress, type Address, type ContractFunctionReturnType, type PublicClient,
} from "viem";
import { AUTO_VOTER_CONTRACT, AUTO_VOTER_DELEGATION_ADDRESS, DELEGATE_REGISTRY, SDCRV_SPACE } from "./constants";

const abi = parseAbi([
  "function get(address user, string space) view returns ((address user, address[] gauges, uint256[] weights, bool killed))",
  "function space_votes_index(string space) view returns (uint256)",
  "function votes(string space, uint256 index) view returns (address user, bool killed)",
]);
const delegationAbi = parseAbi(["function delegation(address delegator, bytes32 id) view returns (address)"]);
export type SdCrvAutoRegistration = ContractFunctionReturnType<typeof abi, "view", "get">;

// Registry slots are permanent. Read their preferences at the block corresponding to the Snapshot ballot.
export async function getSdCrvAutoVoteRegistrations(
  client: Pick<PublicClient, "readContract" | "multicall">, creationBlock: bigint, voteBlock: bigint,
) {
  if (creationBlock > voteBlock) throw new Error("sdCRV proposal creation block is after the vote");
  const count = await client.readContract({
    address: AUTO_VOTER_CONTRACT, abi, functionName: "space_votes_index", args: [SDCRV_SPACE], blockNumber: voteBlock,
  });
  const slots = await client.multicall({
    blockNumber: voteBlock, allowFailure: false,
    contracts: Array.from({ length: Number(count) }, (_, i) => ({
      address: AUTO_VOTER_CONTRACT, abi, functionName: "votes", args: [SDCRV_SPACE, BigInt(i + 1)],
    } as const)),
  });
  if (BigInt(slots.length) !== count) throw new Error("Incomplete sdCRV AutoVoter index");
  const voters = slots.map(([user]) => user.toLowerCase() as Address);
  if (voters.includes(zeroAddress) || new Set(voters).size !== voters.length) throw new Error("Invalid sdCRV AutoVoter index");
  const spaceId = stringToHex(SDCRV_SPACE, { size: 32 });
  const [delegates, preferences] = await Promise.all([
    client.multicall({
      blockNumber: creationBlock, allowFailure: false,
      contracts: voters.map(voter => ({
        address: DELEGATE_REGISTRY, abi: delegationAbi, functionName: "delegation", args: [voter, spaceId],
      } as const)),
    }),
    client.multicall({
      blockNumber: voteBlock, allowFailure: false, batchSize: 8192,
      contracts: voters.map(voter => ({
        address: AUTO_VOTER_CONTRACT, abi, functionName: "get", args: [voter, SDCRV_SPACE],
      } as const)),
    }),
  ]);
  if (delegates.length !== voters.length || preferences.length !== voters.length) {
    throw new Error("Incomplete sdCRV AutoVoter registry response");
  }
  return voters.map((voter, i) => ({
    voter,
    delegatedAtCreation: delegates[i].toLowerCase() === AUTO_VOTER_DELEGATION_ADDRESS.toLowerCase(),
    registration: preferences[i],
  }));
}
