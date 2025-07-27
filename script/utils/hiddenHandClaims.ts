import {
  decodeEventLog,
  getAddress,
  keccak256,
  encodePacked,
  parseAbi,
  PublicClient,
} from "viem";
import axios from "axios";
import {
  fetchProposalsIdsBasedOnPeriods,
  getTokenBalance,
  getGaugeWeight,
  isValidAddress,
  BOTMARKET,
  HH_BALANCER_MARKET,
} from "./reportUtils";
import { createBlockchainExplorerUtils } from "./explorerUtils";
import { Bounty, GaugeShare } from "./types";

/**
 * Fetches claimed bounties from the Hidden Hand platform.
 * @returns {Promise<{[protocol: string]: HiddenHandBounty[]}>} A mapping of protocol names to their respective claimed bounties.
 */
export const fetchHiddenHandClaimedBounties = async (
  publicClient: PublicClient,
  period: number,
  block_min: number,
  block_max: number
) => {
  const ethUtils = createBlockchainExplorerUtils();

  const rewardClaimedSig = "RewardClaimed(bytes32,address,address,uint256)";
  const rewardClaimedHash = keccak256(
    encodePacked(["string"], [rewardClaimedSig])
  );

  let allClaimedBounties: Bounty[] = [];

  const claimedAbi = parseAbi([
    "event RewardClaimed(bytes32 indexed identifier,address indexed token,address indexed account,uint256 amount)",
  ]);

  const claimedResponse = await ethUtils.getLogsByAddressAndTopics(
    getAddress("0xa9b08B4CeEC1EF29EdEC7F9C94583270337D6416"),
    block_min,
    block_max,
    { "0": rewardClaimedHash },
    1
  );

  if (
    !claimedResponse ||
    !claimedResponse.result ||
    claimedResponse.result.length === 0
  ) {
    console.log("No logs found for Hidden Hand");
    return {};
  }

  for (const log of claimedResponse.result) {
    const decodedLog = decodeEventLog({
      abi: claimedAbi,
      data: log.data,
      topics: log.topics,
      strict: true,
    });

    if (getAddress(decodedLog.args.account) == BOTMARKET) {
      const hiddenHandBounty = {
        gauge: decodedLog.args.identifier,
        amount: decodedLog.args.amount,
        rewardToken: getAddress(decodedLog.args.token),
      };
      allClaimedBounties.push(hiddenHandBounty);
    }
  }

  // Get all bribes that has been deposited on Hidden Hand since inception
  const depositBribeSig =
    "DepositBribe(address,bytes32,uint256,address,address,uint256,uint256,uint256,uint256)";
  const depositBribeHash = keccak256(
    encodePacked(["string"], [depositBribeSig])
  );

  let allDepositedBribes: any[] = [];

  const depositBribeAbi = parseAbi([
    "event DepositBribe(address indexed market,bytes32 indexed proposal,uint256 indexed deadline,address token,address briber,uint256 amount,uint256 totalAmount,uint256 maxTokensPerVote,uint256 periodIndex)",
  ]);

  // Long range, batch blocks 500 000 per 500 000 from 17621913 to block_min
  const chunk = 500000;
  const startBlock = 17621913;
  const endBlock = block_min;
  const numChunks = Math.ceil((endBlock - startBlock) / chunk);

  for (let i = 0; i < numChunks; i++) {
    const block_min = startBlock + i * chunk;
    const block_max = Math.min(block_min + chunk, endBlock);
    const depositedBribeResponse = await ethUtils.getLogsByAddressAndTopics(
      getAddress("0xE00fe722e5bE7ad45b1A16066E431E47Df476CeC"),
      block_min,
      block_max,
      { "0": depositBribeHash },
      1
    );

    if (
      !depositedBribeResponse ||
      !depositedBribeResponse.result ||
      depositedBribeResponse.result.length === 0
    ) {
      continue;
    }

    for (const log of depositedBribeResponse.result) {
      const decodedLog = decodeEventLog({
        abi: depositBribeAbi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });

      // Filter out old ones
      if (
        Number(decodedLog.args.deadline) < period ||
        getAddress(decodedLog.args.market) != HH_BALANCER_MARKET
      ) {
        continue;
      }

      // End of  Selection
      allDepositedBribes.push(decodedLog.args);
    }
  }

  // Match all deposited bribes with Hidden API to get the correct gauge (proposal)
  const hiddenHandApiUrl = "https://api.hiddenhand.finance/proposal/balancer";
  let hiddenHandProposals: any[] = [];
  try {
    const response = await axios.get(hiddenHandApiUrl);
    hiddenHandProposals = response.data.data;
  } catch (error) {
    console.error("Failed to fetch proposals from Hidden Hand:", error);
  }

  allDepositedBribes.map((bribe) => {
    for (const proposal of hiddenHandProposals) {
      if (
        proposal.proposalHash.toLowerCase() === bribe.proposal.toLowerCase()
      ) {
        bribe.title = proposal.title;
        bribe.gauge = proposal.proposal;
      }
    }
  });

  // Fetch proposals for Balancer bribes on snapshot (take the one with my week in the period)
  const proposals = await fetchProposalsIdsBasedOnPeriods("sdbal.eth", period);

  // Current period -> Proposal
  const proposal = proposals[period];

  if (!proposal) return {};

  const scoresTotal = proposal.scores_total;
  const choices = proposal.choices;
  const scores = proposal.scores;

  // Compute the voting shares per gauge on that snapshot
  const gaugeShares = scores.reduce<{ [key: string]: GaugeShare }>(
    (acc, score, index) => {
      if (typeof score === "number" && score !== 0) {
        acc[choices[index]] = {
          voted: score,
          share: score / scoresTotal,
        };
      }
      return acc;
    },
    {}
  );

  // Get Stake DAO delegation veBal balance
  const totalVebal = await getTokenBalance(
    publicClient,
    "0xC128a9954e6c874eA3d62ce62B468bA073093F25",
    "0xea79d1A83Da6DB43a85942767C389fE0ACf336A5",
    18
  );

  // Drop those who are not bribed from allDepositedBribes
  for (let i = allDepositedBribes.length - 1; i >= 0; i--) {
    const bribe = allDepositedBribes[i];
    let found = false;

    for (const gauge in gaugeShares) {
      if (bribe.gauge) {
        const match = gauge.match(/0x[a-fA-F0-9]+/); // Match hexadecimal characters that start with '0x'

        if (!match) continue;

        const bribeAddress = bribe.gauge.toLowerCase(); // Prepare bribe gauge address for comparison

        if (bribeAddress.startsWith(match[0].toLowerCase())) {
          gaugeShares[gauge].gaugeAddress = bribeAddress;

          // Compute stakeVotes
          gaugeShares[gauge].stakeVote = gaugeShares[gauge].share * totalVebal;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      allDepositedBribes.splice(i, 1); // Remove from array if no match found
    }
  }

  const totalEstimatedToken: { [token: string]: number } = {};

  // First, preprocess gaugeShares for faster lookup
  const gaugeSharesMap = new Map();
  for (const [key, data] of Object.entries(gaugeShares)) {
    if (data.gaugeAddress && isValidAddress(data.gaugeAddress)) {
      gaugeSharesMap.set(data.gaugeAddress.toLowerCase(), { key, ...data });
    }
  }

  // Now process allDepositedBribes
  for (const bribe of allDepositedBribes) {
    const gaugeData = gaugeSharesMap.get(bribe.gauge.toLowerCase());

    if (gaugeData) {
      if (!gaugeData.gaugeWeight) {
        gaugeData.gaugeWeight = await getGaugeWeight(
          publicClient,
          "0xC128468b7Ce63eA702C1f104D55A2566b13D3ABD" as `0x${string}`,
          gaugeData.gaugeAddress as `0x${string}`
        );
      }

      bribe.gaugeWeight = gaugeData.gaugeWeight;

      if (
        gaugeData.voted !== undefined &&
        gaugeData.gaugeWeight !== undefined
      ) {
        bribe.stakeVote = gaugeData.voted;
        bribe.stakeShares = bribe.stakeVote / bribe.gaugeWeight;
        bribe.estimatedAmount =
          Number(bribe.stakeShares) * Number(bribe.totalAmount);

        totalEstimatedToken[bribe.token] =
          (totalEstimatedToken[bribe.token] || 0) + bribe.estimatedAmount;
      }
    }
  }

  // Compute real
  for (const bribe of allDepositedBribes) {
    // Get total claimed for that token
    const totalClaimed = allClaimedBounties
      .filter(
        (bounty) =>
          bounty.rewardToken.toLowerCase() === bribe.token.toLowerCase()
      )
      .reduce((acc, bounty) => acc + Number(bounty.amount), 0);

    const shareOfTotal =
      bribe.estimatedAmount / totalEstimatedToken[bribe.token];

    // Compute the real amount
    bribe.realAmount = totalClaimed * shareOfTotal;
  }

  let protocolBounties: { [protocol: string]: Bounty[] } = {};

  protocolBounties["balancer"] = [];

  for (const bribe of allDepositedBribes) {
    const hiddenHandBounty: Bounty = {
      gauge: bribe.gauge,
      amount: bribe.realAmount,
      rewardToken: bribe.token,
    };

    protocolBounties["balancer"].push(hiddenHandBounty);
  }

  // Merge when same reward token and same gauge
  const mergedBounties: { [protocol: string]: any[] } = {};

  for (const protocol in protocolBounties) {
    const bounties = protocolBounties[protocol];
    const merged: { [key: string]: any } = {};

    for (const bounty of bounties) {
      const key = `${bounty.rewardToken.toLowerCase()}-${bounty.gauge.toLowerCase()}`;

      if (key in merged) {
        merged[key].amount = merged[key].amount + Number(bounty.amount);
      } else {
        merged[key] = {
          ...bounty,
          rewardToken: bounty.rewardToken.toLowerCase(),
          gauge: bounty.gauge.toLowerCase(),
          amount: Number(bounty.amount),
        };
      }
    }

    mergedBounties[protocol] = Object.values(merged);
  }

  return mergedBounties;
};