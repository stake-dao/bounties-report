import {
  decodeEventLog,
  getAddress,
  keccak256,
  encodePacked,
  parseAbi,
  pad,
} from "viem";
import { getBlockNumberByTimestamp } from "../chainUtils";
import { createBlockchainExplorerUtils } from "../explorerUtils.js";
import { getClient } from "../constants.js";
import { VotemarketBounty, PlatformConfigs } from "../types.js";

const platformAbi = [
  {
    inputs: [
      {
        internalType: "uint256",
        name: "bountyId",
        type: "uint256",
      },
    ],
    name: "getBounty",
    outputs: [
      {
        components: [
          {
            internalType: "address",
            name: "gauge",
            type: "address",
          },
          {
            internalType: "address",
            name: "manager",
            type: "address",
          },
          {
            internalType: "address",
            name: "rewardToken",
            type: "address",
          },
          {
            internalType: "uint8",
            name: "numberOfPeriods",
            type: "uint8",
          },
          {
            internalType: "uint256",
            name: "endTimestamp",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "maxRewardPerVote",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "totalRewardAmount",
            type: "uint256",
          },
          {
            internalType: "address[]",
            name: "blacklist",
            type: "address[]",
          },
        ],
        internalType: "struct Platform.Bounty",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * Fetches claimed bounties from the Votemarket platform V1 within a specified time range.
 * @param fromTimestamp - Start timestamp
 * @param toTimestamp - End timestamp
 * @param platformConfigs - Platform configurations specifying which platforms and addresses to check
 * @returns Promise<{[protocol: string]: VotemarketBounty[]}>
 */
export const fetchVotemarketV1ClaimedBounties = async (
  fromTimestamp: number,
  toTimestamp: number,
  platformConfigs: PlatformConfigs
): Promise<{ [protocol: string]: VotemarketBounty[] }> => {
  const ethUtils = createBlockchainExplorerUtils();
  const eventSignature =
    "Claimed(address,address,uint256,uint256,uint256,uint256)";
  const claimedEventHash = keccak256(
    encodePacked(["string"], [eventSignature])
  );
  const claimedAbi = parseAbi([
    "event Claimed(address indexed user, address rewardToken, uint256 indexed bountyId, uint256 amount, uint256 protocolFees, uint256 period)",
  ]);

  let filteredLogs: { [protocol: string]: VotemarketBounty[] } = {};

  // Get block numbers
  const fromBlock = await getBlockNumberByTimestamp(fromTimestamp, "before", 1);
  const toBlock = await getBlockNumberByTimestamp(toTimestamp, "after", 1);

  await Promise.all(
    Object.entries(platformConfigs).map(async ([protocol, configs]) => {
      const responses = await Promise.all(
        configs.map(({ platform, toAddress }) => {
          const paddedToAddress = pad(toAddress, { size: 32 }).toLowerCase();
          return ethUtils.getLogsByAddressAndTopics(
            platform,
            fromBlock,
            toBlock,
            {
              "0": claimedEventHash,
              "1": paddedToAddress,
            },
            1
          );
        })
      );

      for (const response of responses) {
        if (!response?.result?.length) continue;

        const bountyPromises = response.result.map(async (log: any) => {
          const decodedLog = decodeEventLog({
            abi: claimedAbi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });

          const client = await getClient(1);
          const bountyInfo = await client.readContract({
            address: getAddress(log.address),
            abi: platformAbi,
            functionName: "getBounty",
            args: [decodedLog.args.bountyId],
          });

          return {
            bountyId: decodedLog.args.bountyId,
            gauge: bountyInfo.gauge,
            amount: decodedLog.args.amount,
            rewardToken: getAddress(decodedLog.args.rewardToken),
          } as VotemarketBounty;
        });

        const bounties = (await Promise.all(bountyPromises)).filter(Boolean);
        if (bounties.length) {
          if (!filteredLogs[protocol]) filteredLogs[protocol] = [];
          filteredLogs[protocol].push(...bounties);
        }
      }
    })
  );

  return filteredLogs;
};