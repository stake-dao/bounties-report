import {
  decodeEventLog,
  getAddress,
  keccak256,
  encodePacked,
  parseAbi,
  pad,
  PublicClient,
} from "viem";
import { getBlockNumberByTimestamp } from "../chainUtils";
import { createBlockchainExplorerUtils } from "../explorerUtils.js";
import { getClientWithFallback } from "../getClients.js";
import { ContractRegistry } from "../contractRegistry.js";
import { VotemarketV2Bounty, VotemarketBounty } from "../types.js";
import { BSC_CAKE_LOCKER, BSC_CAKE_VM } from "../reportUtils.js";

// Retry helper for contract reads with exponential backoff
async function retryContractRead<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  context: string = ""
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`[Retry ${attempt + 1}/${maxRetries}] ${context}:`, error);
    }
  }
  throw lastError;
}

export const fetchVotemarketV2ClaimedBounties = async (
  protocol: string,
  fromTimestamp: number,
  toTimestamp: number,
  toAddress: `0x${string}`
): Promise<{ [protocol: string]: VotemarketV2Bounty[] }> => {
  const explorerUtils = createBlockchainExplorerUtils();
  let chainKey: string;
  if (protocol.toLowerCase() === "curve") {
    chainKey = "CURVE_VOTEMARKET_V2";
  } else {
    chainKey = protocol.toUpperCase() + "_VOTEMARKET_V2";
  }
  const chains = ContractRegistry.getChains(chainKey);

  const claimAbi = parseAbi([
    "event Claim(uint256 indexed campaignId, address indexed account, uint256 amount, uint256 fee, uint256 epoch)",
  ]);

  const campaignAbi = parseAbi([
    "function getCampaign(uint256 campaignId) public view returns (uint256 chainId, address gauge, address manager, address rewardToken, uint8 numberOfPeriods, uint256 maxRewardPerVote, uint256 totalRewardAmount, uint256 totalDistributed, uint256 startTimestamp, uint256 endTimestamp, address hook)",
  ]);

  const tokenFactoryAbi = parseAbi([
    "function isWrapped(address token) public view returns (bool)",
    "function nativeTokens(address token) public view returns (address)",
  ]);

  // Get block numbers for all chains in parallel
  const blockPromises = chains.map(async (chain) => ({
    chain,
    fromBlock: await getBlockNumberByTimestamp(fromTimestamp, "before", chain),
    toBlock: await getBlockNumberByTimestamp(toTimestamp, "after", chain),
  }));

  const blockNumbers = await Promise.all(blockPromises);
  const blockMap = Object.fromEntries(
    blockNumbers.map(({ chain, fromBlock, toBlock }) => [
      chain,
      { fromBlock, toBlock },
    ])
  );

  const eventSignature = "Claim(uint256,address,uint256,uint256,uint256)";
  const claimedEventHash = keccak256(
    encodePacked(["string"], [eventSignature])
  );
  const paddedToAddress = pad(toAddress, { size: 32 }).toLowerCase();
  
  console.log(`[fetchVotemarketV2ClaimedBounties] Debug info:`, {
    protocol,
    fromTimestamp,
    toTimestamp,
    toAddress,
    paddedToAddress,
    chains,
    eventSignature,
    claimedEventHash
  });

  // Initialize filteredLogs with a key based on the protocol
  let filteredLogs: { [proto: string]: VotemarketV2Bounty[] } = {};
  filteredLogs[protocol.toLowerCase()] = [];

  // Process each chain's logs
  await Promise.all(
    chains.map(async (chain) => {
      const { fromBlock, toBlock } = blockMap[chain];

      // For curve, support multiple VM addresses; for other protocols, assume a single VM address.
      let vmAddresses: string[] = [];
      if (protocol.toLowerCase() === "curve") {
        vmAddresses = [
          ContractRegistry.getAddress("CURVE_VOTEMARKET_V2", chain),
          ContractRegistry.getAddress("CURVE_VOTEMARKET_V2_NEW", chain),
        ];
      } else {
        vmAddresses = [
          ContractRegistry.getAddress(
            protocol.toUpperCase() + "_VOTEMARKET_V2",
            chain
          ),
        ];
      }

      // Fetch logs for each VM address and merge them
      const logsArrays = await Promise.all(
        vmAddresses.map(async (vmAddress) => {
          console.log(`[Chain ${chain}] Fetching logs from ${vmAddress}`, {
            fromBlock,
            toBlock,
            topics: {
              "0": claimedEventHash,
              "2": paddedToAddress,
            }
          });
          const result = await explorerUtils.getLogsByAddressAndTopics(
            vmAddress,
            fromBlock,
            toBlock,
            {
              "0": claimedEventHash,
              "2": paddedToAddress,
            },
            chain
          );
          console.log(`[Chain ${chain}] Found ${result?.result?.length || 0} logs from ${vmAddress}`);
          return result;
        })
      );
      const mergedLogs = logsArrays.reduce((acc: any[], curr: any) => {
        if (curr && curr.result) {
          acc.push(...curr.result);
        }
        return acc;
      }, []);

      if (!mergedLogs.length) {
        console.log(`[Chain ${chain}] No logs found`);
        return;
      }
      console.log(`[Chain ${chain}] Processing ${mergedLogs.length} total logs`);

      const tokenFactoryAddress = ContractRegistry.getAddress(
        "TOKEN_FACTORY",
        chain
      );

      // Get client once for this chain with fallback
      const client = await getClientWithFallback(chain);

      // First, decode all logs and prepare multicall contracts
      const decodedLogs: Array<{log: any, decodedLog: any}> = [];
      for (const log of mergedLogs) {
        try {
          const decodedLog = decodeEventLog({
            abi: claimAbi,
            data: log.data,
            topics: log.topics,
            strict: true,
          });
          decodedLogs.push({ log, decodedLog });
        } catch (error) {
          console.error(`[Chain ${chain}] Failed to decode log:`, error);
        }
      }

      if (decodedLogs.length === 0) {
        console.log(`[Chain ${chain}] No valid logs to process`);
        return;
      }

      console.log(`[Chain ${chain}] Processing ${decodedLogs.length} claims`);

      // Prepare all getCampaign calls for multicall
      const campaignContracts = decodedLogs.map(({ log, decodedLog }) => ({
        address: getAddress(log.address),
        abi: campaignAbi,
        functionName: "getCampaign",
        args: [decodedLog.args.campaignId],
      }));

      // Execute all getCampaign calls in a single multicall
      let campaignResults: any[] = [];
      try {
        campaignResults = await client.multicall({
          contracts: campaignContracts,
          allowFailure: true,
        });
      } catch (error) {
        console.error(`[Chain ${chain}] Multicall failed for campaigns:`, error);
        // Initialize with failed results
        campaignResults = campaignContracts.map(() => ({ status: "failure", error: error }));
      }

      // Process results and prepare token checks
      const tokenChecks: Array<{index: number, rewardToken: string}> = [];
      const processedBounties: VotemarketV2Bounty[] = [];
      const failedCampaigns: Array<{index: number, log: any, decodedLog: any}> = [];

      for (let i = 0; i < decodedLogs.length; i++) {
        const { log, decodedLog } = decodedLogs[i];
        const campaignResult = campaignResults[i];

        console.log(`[Chain ${chain}] Processing claim:`, {
          campaignId: decodedLog.args.campaignId.toString(),
          account: decodedLog.args.account,
          amount: decodedLog.args.amount.toString(),
          epoch: decodedLog.args.epoch.toString(),
          vmAddress: log.address
        });

        let gauge = "0x0000000000000000000000000000000000000000";
        let rewardToken = "0x0000000000000000000000000000000000000000";

        if (campaignResult?.status === "success") {
          const bountyInfo = campaignResult.result as any;
          gauge = bountyInfo[1];
          rewardToken = bountyInfo[3];

          // Queue token check for later
          if (rewardToken !== "0x0000000000000000000000000000000000000000") {
            tokenChecks.push({ index: i, rewardToken });
          }
        } else {
          console.warn(`[Chain ${chain}] Failed to get campaign info for ID ${decodedLog.args.campaignId}, will retry`);
          failedCampaigns.push({ index: i, log, decodedLog });
        }

        // Store initial bounty data
        processedBounties[i] = {
          chainId: chain,
          bountyId: decodedLog.args.campaignId,
          gauge,
          amount: decodedLog.args.amount,
          rewardToken,
          isWrapped: false,
        };
      }

      // Retry failed campaigns individually with delay
      if (failedCampaigns.length > 0) {
        console.log(`[Chain ${chain}] Retrying ${failedCampaigns.length} failed getCampaign calls...`);
        for (const { index, log, decodedLog } of failedCampaigns) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              // Add delay between retries
              if (attempt > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
              }
              const campaignInfo = await client.readContract({
                address: getAddress(log.address),
                abi: campaignAbi,
                functionName: "getCampaign",
                args: [decodedLog.args.campaignId],
              }) as any;

              const gauge = campaignInfo[1];
              const rewardToken = campaignInfo[3];

              if (gauge !== "0x0000000000000000000000000000000000000000") {
                processedBounties[index].gauge = gauge;
                processedBounties[index].rewardToken = rewardToken;
                if (rewardToken !== "0x0000000000000000000000000000000000000000") {
                  tokenChecks.push({ index, rewardToken });
                }
                console.log(`[Chain ${chain}] Retry successful for campaign ${decodedLog.args.campaignId}`);
                break;
              }
            } catch (error) {
              console.warn(`[Chain ${chain}] Retry attempt ${attempt + 1}/3 failed for campaign ${decodedLog.args.campaignId}:`, error);
            }
          }
        }
      }

      // If we have tokens to check, do it in a single multicall
      if (tokenChecks.length > 0) {
        const isWrappedContracts = tokenChecks.map(({ rewardToken }) => ({
          address: tokenFactoryAddress,
          abi: tokenFactoryAbi,
          functionName: "isWrapped",
          args: [rewardToken],
        }));

        try {
          const isWrappedResults = await client.multicall({
            contracts: isWrappedContracts,
            allowFailure: true,
          });

          // Prepare native token calls for wrapped tokens
          const nativeTokenChecks: Array<{bountyIndex: number, rewardToken: string}> = [];
          
          for (let i = 0; i < tokenChecks.length; i++) {
            const { index: bountyIndex, rewardToken } = tokenChecks[i];
            const isWrappedResult = isWrappedResults[i];

            if (isWrappedResult?.status === "success" && isWrappedResult.result === true) {
              processedBounties[bountyIndex].isWrapped = true;
              nativeTokenChecks.push({ bountyIndex, rewardToken });
            }
          }

          // Get native tokens for wrapped tokens
          if (nativeTokenChecks.length > 0) {
            const nativeTokenContracts = nativeTokenChecks.map(({ rewardToken }) => ({
              address: tokenFactoryAddress,
              abi: tokenFactoryAbi,
              functionName: "nativeTokens",
              args: [rewardToken],
            }));

            try {
              const nativeTokenResults = await client.multicall({
                contracts: nativeTokenContracts,
                allowFailure: true,
              });

              for (let i = 0; i < nativeTokenChecks.length; i++) {
                const { bountyIndex } = nativeTokenChecks[i];
                const nativeTokenResult = nativeTokenResults[i];

                if (nativeTokenResult?.status === "success") {
                  processedBounties[bountyIndex].rewardToken = getAddress(nativeTokenResult.result as string);
                }
              }
            } catch (error) {
              console.warn(`[Chain ${chain}] Failed to get native tokens:`, error);
            }
          }
        } catch (error) {
          console.warn(`[Chain ${chain}] Failed to check wrapped tokens:`, error);
        }
      }

      // Check for any bounties that still have zero addresses after retries
      const zeroAddressBounties = processedBounties.filter(
        b => b.gauge === "0x0000000000000000000000000000000000000000"
      );
      if (zeroAddressBounties.length > 0) {
        console.error(`[Chain ${chain}] WARNING: ${zeroAddressBounties.length} bounties still have zero gauge addresses after retries:`,
          zeroAddressBounties.map(b => `campaignId=${b.bountyId}`).join(', ')
        );
      }

      // Add all processed bounties
      filteredLogs[protocol.toLowerCase()].push(...processedBounties);
    })
  );

  return filteredLogs;
};

export const fetchVotemarketBSCBounties = async (
  publicClient: PublicClient,
  fromBlock: number,
  toBlock: number
): Promise<{ cake: VotemarketBounty[] }> => {
  const bscUtils = createBlockchainExplorerUtils();

  const eventSignature =
    "Claimed(address,address,uint256,uint256,uint256,uint256)";
  const claimedEventHash = keccak256(
    encodePacked(["string"], [eventSignature])
  );

  const paddedBSCLocker = pad(BSC_CAKE_LOCKER as `0x${string}`, {
    size: 32,
  }).toLowerCase();

  const claimedResponse = await bscUtils.getLogsByAddressAndTopics(
    BSC_CAKE_VM,
    fromBlock,
    toBlock,
    { "0": claimedEventHash, "1": paddedBSCLocker },
    56
  );

  if (
    !claimedResponse ||
    !claimedResponse.result ||
    claimedResponse.result.length === 0
  ) {
    console.log("No logs found for BSC");
    return { cake: [] };
  }

  const claimedAbi = parseAbi([
    "event Claimed(address indexed user, address rewardToken, uint256 indexed bountyId, uint256 amount, uint256 protocolFees, uint256 period)",
  ]);

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

  let filteredBounties: VotemarketBounty[] = [];

  for (const log of claimedResponse.result) {
    const decodedLog = decodeEventLog({
      abi: claimedAbi,
      data: log.data,
      topics: log.topics,
      strict: true,
    });

    try {
      const bountyInfo = await retryContractRead(
        () => publicClient.readContract({
          address: getAddress(log.address),
          abi: platformAbi,
          functionName: "getBounty",
          args: [decodedLog.args.bountyId],
        }),
        3,
        `BSC getBounty for bountyId ${decodedLog.args.bountyId}`
      );

      const bounty: VotemarketBounty = {
        bountyId: decodedLog.args.bountyId,
        gauge: bountyInfo.gauge,
        amount: decodedLog.args.amount,
        rewardToken: getAddress(decodedLog.args.rewardToken),
      };

      filteredBounties.push(bounty);
    } catch (error) {
      console.error(`[BSC] Failed to get bounty info for ID ${decodedLog.args.bountyId} after retries:`, error);
      // Still add the bounty with zero gauge so we don't lose the claim amount
      filteredBounties.push({
        bountyId: decodedLog.args.bountyId,
        gauge: "0x0000000000000000000000000000000000000000",
        amount: decodedLog.args.amount,
        rewardToken: getAddress(decodedLog.args.rewardToken),
      });
    }
  }

  // Warn if any bounties have zero gauge addresses
  const zeroGaugeBounties = filteredBounties.filter(
    b => b.gauge === "0x0000000000000000000000000000000000000000"
  );
  if (zeroGaugeBounties.length > 0) {
    console.error(`[BSC] WARNING: ${zeroGaugeBounties.length} bounties have zero gauge addresses:`,
      zeroGaugeBounties.map(b => `bountyId=${b.bountyId}`).join(', ')
    );
  }

  return { cake: filteredBounties };
};