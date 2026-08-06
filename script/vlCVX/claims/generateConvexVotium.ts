import { fetchVotiumClaimedBounties } from "../../utils/claims/votiumClaims";
import fs from "fs";
import path from "path";
import {
  CVX_SPACE,
  VOTIUM_FORWARDER,
  getClient,
  VOTIUM_FORWARDER_REGISTRY,
  VLCVX_ONCHAIN_DELEGATION_ADDRESS,
  DELEGATION_ADDRESS,
  CVX_GAUGE_DELEGATION,
  CVX_GAUGE_VOTE_HELPER,
  CVX_GAUGE_VOTE_PLATFORM_CURVE,
  CVX_GAUGE_VOTE_PLATFORM_FXN,
  WEEK,
} from "../../utils/constants";
import {
  getContributingWeightsAtVote,
  getDelegatesAtEpoch,
} from "../../utils/onChainDelegation";
import {
  getOnChainProposal,
  getOnChainVoters,
  getOnChainVotingPower,
  associateGaugesPerIdOnChain,
} from "../../utils/gaugeVotePlatform";
import { getGaugesInfos } from "../../utils/reportUtils";
import {
  getBlockNumberByTimestamp,
  getClosestBlockTimestamp,
} from "../../utils/chainUtils";
import { getAllCurveGauges } from "../../utils/curveApi";
import {
  fetchDelegatorData,
  getForwardedDelegators,
} from "../../utils/delegationHelper";
import { processAllForwarders } from "../../utils/forwarderCacheUtils";
import { ClaimsTelegramLogger } from "../../sdTkns/claims/claimsTelegramLogger";
import {
  getTokenAddress as getTokenAddressFromService,
  getTokenDecimals as getTokenDecimalsFromService,
} from "../../utils/tokenService";
import { getTokenPrices, TokenIdentifier } from "../../utils/priceUtils";
import { getAddress, isAddress } from "viem";
import {
  normalizeVotiumTokenAddress,
  reconcileVotiumClaimAllocations,
} from "./votiumClaimAllocations";

const THE_UNION_ADDRESS = "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49";

interface Forwarder {
  address: string;
  type: "delegator" | "direct-voter";
  votingPower: number;
  delegatedTo?: string; // e.g. The Union — resolved on-chain at the epoch
  isUnionDelegator?: boolean;
  // Weight actually incorporated in The Union's vote on THIS proposal
  // (GaugeVoteHelper): 0 when the wallet voted directly or synced late.
  unionContributingWeight?: number;
}

interface TokenAllocation {
  [token: string]: {
    amount: string; // Token amount as string to avoid precision issues
    usd: number; // USD value
  };
}

// ========== HELPER FUNCTIONS ==========

/**
 * Get token decimals with fallback to 18
 */
async function getTokenDecimals(tokenAddress: string): Promise<number> {
  return getTokenDecimalsFromService(tokenAddress);
}

/**
 * Wrapper for token address lookup
 */
async function getTokenAddress(token: string): Promise<string> {
  const resolved = isAddress(token)
    ? token
    : await getTokenAddressFromService(token);
  if (!resolved) {
    throw new Error(
      `Unable to resolve Votium reward token "${token}" on Ethereum`
    );
  }
  return getAddress(resolved).toLowerCase();
}

/**
 * Ensure directory exists
 */
function ensureDirExists(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Custom JSON replacer for BigInt
 */
function customReplacer(_key: string, value: any): any {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "object" && value !== null) {
    if (value.type === "BigInt") return value.value;
    const newObj: any = {};
    for (const k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        newObj[k] = customReplacer(k, value[k]);
      }
    }
    return newObj;
  }
  return value;
}

/**
 * Identify every wallet whose Votium rewards are forwarded to Stake DAO and
 * classify it against the same pinned round:
 * 1. Candidates: this round's voters plus every wallet the Votium indexer has
 *    seen register behind our forwarder.
 * 2. Forwarders: candidates the Votium registry forwards to us at the end of
 *    the round.
 * 3. Classification: StakeDAO delegators from the delegation contract; VP is
 *    the wallet's OWN vote VP (or its on-chain VP when it did not vote) —
 *    never the delegate contributing weights, which belong to the
 *    repartition_delegation pipeline.
 *
 * Votium attributes rewards to each underlying wallet even behind a delegate
 * (that is what its forward registry exists for), so a wallet delegating to
 * The Union while forwarding to us earns its slice of The Union's vote here.
 * Membership is resolved on-chain at the epoch — a hardcoded list used to
 * pin it (with fixed VP), and one listed wallet had moved its delegation to
 * StakeDAO, getting paid twice for the same vlCVX.
 */
export async function getAllForwarders(
  space: string,
  proposal: any,
  proposalVoters: any[],
  blockSnapshotEnd: number,
  currentEpoch: number
): Promise<Forwarder[]> {
  // The proposal and its voters are fetched ONCE in main and passed down, so
  // every step of a run works on the same pinned round (a proposal created
  // mid-run must not shift later reads).
  const voteByAddress = new Map<string, any>();
  for (const vote of proposalVoters) {
    voteByAddress.set(vote.voter.toLowerCase(), vote);
  }

  let indexedForwarders: string[] = [];
  try {
    indexedForwarders = await processAllForwarders(currentEpoch, VOTIUM_FORWARDER, "1");
  } catch (error) {
    console.warn("Could not load indexed forwarders, using voters only");
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const address of [
    ...proposalVoters.map((v: any) => v.voter),
    ...indexedForwarders,
  ]) {
    const addrLower = address.toLowerCase();
    if (seen.has(addrLower)) continue;
    seen.add(addrLower);
    candidates.push(address);
  }

  // The Votium registry names each wallet's forward target at the end of the
  // round. A failed check throws: a silent non-forwarder default would move
  // that wallet's rewards into the delegators pool. StakeDAO's own delegate
  // wallets are excluded — the on-chain delegation voter (the seed remapped
  // StakeDAO's delegate there) and the legacy Snapshot delegation address
  // both vote FOR the delegation, and must not be paid as individuals.
  console.log(`Checking forwarding status of ${candidates.length} addresses...`);
  const forwardTargets = await getForwardedDelegators(candidates, blockSnapshotEnd);
  const votiumForwarderLower = VOTIUM_FORWARDER.toLowerCase();
  const stakeDaoWallets = new Set([
    VLCVX_ONCHAIN_DELEGATION_ADDRESS.toLowerCase(),
    DELEGATION_ADDRESS.toLowerCase(),
  ]);
  const forwarderAddresses = candidates.filter(
    (address, index) =>
      forwardTargets[index]?.toLowerCase() === votiumForwarderLower &&
      !stakeDaoWallets.has(address.toLowerCase())
  );

  // Delegation data only identifies who are StakeDAO delegators. Its
  // `votingPowers` are the GaugeVoteHelper contributing weights of the
  // delegate vote and must never replace a wallet's own vote VP here.
  const delegatorData = await fetchDelegatorData(space, proposal);
  const delegatorSet = new Set<string>(
    (delegatorData?.delegators ?? []).map((delegator) => delegator.toLowerCase())
  );

  const epoch = Number(proposal.snapshot); // vlCVX epoch
  const client = await getClient(1);
  const nonVoters = forwarderAddresses.filter(
    (address) => !voteByAddress.has(address.toLowerCase())
  );
  const onChainVotingPowers =
    nonVoters.length > 0
      ? await getOnChainVotingPower(epoch, nonVoters, client)
      : {};

  // Union membership is a per-wallet reverse lookup on the same delegation
  // contract the delegator set comes from: one delegate per wallet per epoch,
  // so a StakeDAO delegator can never also be a Union delegator.
  const delegateOf = await getDelegatesAtEpoch(
    CVX_GAUGE_DELEGATION,
    epoch,
    forwarderAddresses,
    client
  );
  const theUnionLower = THE_UNION_ADDRESS.toLowerCase();

  // A union delegator's slice of The Union's vote is its weight AS COUNTED in
  // that vote on this platform proposal — not its raw vlCVX balance. The
  // helper replays sync-nonce accounting: a wallet that voted directly or
  // synced after The Union's vote contributes less (usually 0).
  const unionDelegatorAddresses = forwarderAddresses.filter(
    (address) => delegateOf[address.toLowerCase()] === theUnionLower
  );
  const unionContributingWeights =
    unionDelegatorAddresses.length > 0
      ? await getContributingWeightsAtVote(
          CVX_GAUGE_VOTE_HELPER,
          proposal.author,
          Number(proposal.id),
          THE_UNION_ADDRESS,
          unionDelegatorAddresses,
          client
        )
      : {};

  const forwarders: Forwarder[] = forwarderAddresses.map((address) => {
    const addrLower = address.toLowerCase();
    const vote = voteByAddress.get(addrLower);
    const votingPower = vote
      ? vote.vp ?? 0
      : onChainVotingPowers[address] ?? onChainVotingPowers[addrLower] ?? 0;
    const isUnionDelegator = delegateOf[addrLower] === theUnionLower;

    return {
      address: addrLower,
      type: delegatorSet.has(addrLower)
        ? ("delegator" as const)
        : ("direct-voter" as const),
      votingPower,
      delegatedTo: isUnionDelegator ? THE_UNION_ADDRESS : undefined,
      isUnionDelegator,
      unionContributingWeight: isUnionDelegator
        ? unionContributingWeights[addrLower] ?? 0
        : undefined,
    };
  });

  return forwarders.sort((a, b) => b.votingPower - a.votingPower);
}

/**
 * Compute vote shares for a gauge
 */
function computeVoteSharesForGauge(
  votes: any[],
  gaugeChoiceId: number,
  forwarders: Forwarder[],
  totalChoiceScore: number
): Map<string, number> {
  const shares = new Map<string, number>();
  const forwarderAddresses = new Set(forwarders.map((f) => f.address));
  const forwarderMap = new Map(forwarders.map((f) => [f.address, f]));

  // Create a map of Union delegators for quick lookup
  const unionDelegators = new Map<string, Forwarder>();
  forwarders.forEach((f) => {
    if (f.isUnionDelegator && (f.unionContributingWeight ?? 0) > 0) {
      unionDelegators.set(f.address, f);
    }
  });

  const voterVp = new Map<string, number>();

  // Find The Union's vote for this gauge
  let unionVoteChoice: any = null;
  const unionVote = votes.find(
    (v) => v.voter.toLowerCase() === THE_UNION_ADDRESS.toLowerCase()
  );
  if (unionVote && unionVote.choice && unionVote.choice[gaugeChoiceId] !== undefined) {
    unionVoteChoice = unionVote.choice;
  }

  // Calculate effective VP for each forwarder on this gauge
  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      const voter = vote.voter.toLowerCase();

      // Skip if not a forwarder AND not The Union
      if (!forwarderAddresses.has(voter) && voter !== THE_UNION_ADDRESS.toLowerCase()) return;

      // Handle Union delegators separately
      if (voter === THE_UNION_ADDRESS.toLowerCase() && unionDelegators.size > 0) {
        unionDelegators.forEach((delegator) => {
          let vpChoiceSum = 0;
          let gaugeChoiceValue = 0;

          Object.keys(unionVoteChoice).forEach((choiceId) => {
            const val = unionVoteChoice[choiceId];
            vpChoiceSum += val;
            if (parseInt(choiceId) === gaugeChoiceId) {
              gaugeChoiceValue = val;
            }
          });

          if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
            const effectiveVp =
              ((delegator.unionContributingWeight ?? 0) * gaugeChoiceValue) /
              vpChoiceSum;
            voterVp.set(delegator.address, (voterVp.get(delegator.address) || 0) + effectiveVp);
          }
        });
        return;
      }

      // Regular forwarder processing
      if (forwarderAddresses.has(voter)) {
        let vpChoiceSum = 0;
        let gaugeChoiceValue = 0;

        Object.keys(vote.choice).forEach((choiceId) => {
          const val = vote.choice[choiceId];
          vpChoiceSum += val;
          if (parseInt(choiceId) === gaugeChoiceId) {
            gaugeChoiceValue = val;
          }
        });

        if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
          const forwarder = forwarderMap.get(voter);
          const forwarderVotingPower = forwarder ? forwarder.votingPower : vote.vp;
          const effectiveVp = (forwarderVotingPower * gaugeChoiceValue) / vpChoiceSum;
          voterVp.set(voter, (voterVp.get(voter) || 0) + effectiveVp);
        }
      }
    }
  });

  // Calculate shares based on total choice score from Snapshot
  forwarders.forEach((forwarder) => {
    const vp = voterVp.get(forwarder.address) || 0;
    const share = totalChoiceScore > 0 ? vp / totalChoiceScore : 0;
    shares.set(forwarder.address, share);
  });

  return shares;
}

/**
 * Aggregate bribes by token for overall distribution
 */
async function aggregateBribesByToken(
  gaugeBribes: any[],
  matchingBribesAggregated: any,
  delegationShare: number,
  bribesType: "curve" | "fxn"
) {
  for (const bribe of gaugeBribes) {
    const tokenKey = await getTokenAddress(bribe.token);

    if (!matchingBribesAggregated[tokenKey]) {
      matchingBribesAggregated[tokenKey] = {
        curveAmount: BigInt(0),
        fxnAmount: BigInt(0),
        bribes: [],
        symbol: bribe.token, // Keep the original symbol for reference
      };
    }

    // Check if bribe amount is already in wei or needs conversion
    const brideAmountNum = Number(bribe.amount);
    let delegatedClaimOverall: bigint;

    if (brideAmountNum > 1e10) {
      // Looks like wei already
      delegatedClaimOverall = BigInt(
        Math.floor(Number(bribe.amount) * delegationShare)
      );
    } else {
      // Convert bribe amount to wei
      const decimals = await getTokenDecimals(tokenKey);
      delegatedClaimOverall = BigInt(
        Math.floor(Number(bribe.amount) * delegationShare * 10 ** decimals)
      );
    }

    if (bribesType === "curve") {
      matchingBribesAggregated[tokenKey].curveAmount += delegatedClaimOverall;
    } else {
      matchingBribesAggregated[tokenKey].fxnAmount += delegatedClaimOverall;
    }

    matchingBribesAggregated[tokenKey].bribes.push({
      ...bribe,
      delegationShare,
      type: bribesType,
    });
  }
}

/**
 * Compute delegation share for a gauge based on forwarder votes
 */
function computeDelegationShareForGauge(
  votes: any[],
  gaugeChoiceId: number,
  forwarders: Forwarder[]
): number {
  const forwarderAddresses = new Set(forwarders.map((f) => f.address));
  const forwarderMap = new Map(forwarders.map((f) => [f.address, f]));

  // Create a map of Union delegators
  const unionDelegators = new Map<string, Forwarder>();
  forwarders.forEach((f) => {
    if (f.isUnionDelegator && (f.unionContributingWeight ?? 0) > 0) {
      unionDelegators.set(f.address, f);
    }
  });

  let totalEffectiveVp = 0;
  let delegationEffectiveVp = 0;

  // Find The Union's vote
  const unionVote = votes.find(
    (v) => v.voter.toLowerCase() === THE_UNION_ADDRESS.toLowerCase()
  );
  let unionChoice: any = null;
  if (
    unionVote &&
    unionVote.choice &&
    unionVote.choice[gaugeChoiceId] !== undefined
  ) {
    unionChoice = unionVote.choice;
  }

  votes.forEach((vote) => {
    if (vote.choice && vote.choice[gaugeChoiceId] !== undefined) {
      const voter = vote.voter.toLowerCase();

      // Handle Union vote separately
      if (
        voter === THE_UNION_ADDRESS.toLowerCase() &&
        unionDelegators.size > 0
      ) {
        // Calculate effective VP for Union delegators
        unionDelegators.forEach((delegator) => {
          let vpChoiceSum = 0;
          let gaugeChoiceValue = 0;

          Object.keys(unionChoice).forEach((choiceId) => {
            const val = unionChoice[choiceId];
            vpChoiceSum += val;
            if (parseInt(choiceId) === gaugeChoiceId) {
              gaugeChoiceValue = val;
            }
          });

          if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
            const effectiveVp =
              ((delegator.unionContributingWeight ?? 0) * gaugeChoiceValue) /
              vpChoiceSum;
            totalEffectiveVp += effectiveVp;
            delegationEffectiveVp += effectiveVp;
          }
        });
        return; // Don't count The Union's vote itself
      }

      // Regular vote processing
      let vpChoiceSum = 0;
      let gaugeChoiceValue = 0;

      Object.keys(vote.choice).forEach((choiceId) => {
        const val = vote.choice[choiceId];
        vpChoiceSum += val;
        if (parseInt(choiceId) === gaugeChoiceId) {
          gaugeChoiceValue = val;
        }
      });

      if (vpChoiceSum > 0 && gaugeChoiceValue > 0) {
        // Use actual voting power for forwarders
        let votingPower = vote.vp;
        if (forwarderAddresses.has(voter)) {
          const forwarder = forwarderMap.get(voter);
          if (forwarder) {
            votingPower = forwarder.votingPower;
          }
          delegationEffectiveVp +=
            (votingPower * gaugeChoiceValue) / vpChoiceSum;
        }
        totalEffectiveVp += (votingPower * gaugeChoiceValue) / vpChoiceSum;
      }
    }
  });

  return totalEffectiveVp > 0 ? delegationEffectiveVp / totalEffectiveVp : 0;
}

/**
 * Process gauge votes and distribute bribes
 */
async function processGaugeVotes(
  space: string,
  proposal: any,
  votes: any[],
  gaugeFetcher: () => Promise<any>,
  bribesData: any,
  forwarders: Forwarder[],
  tokenAllocations: Record<string, TokenAllocation>,
  perAddressTokenAllocations: Record<string, Record<string, bigint>>,
  matchingBribesAggregated: any,
  bribesType: "curve" | "fxn",
  transformGauges = false
): Promise<number> {
  // Proposal and votes are fetched ONCE in main and passed down (pinned round)
  const proposalId = proposal.id;
  console.log(`\nUsing on-chain proposal: ${proposalId} (${votes.length} votes)`);

  // Final round-alignment defense (the primary alignment happens at bribes
  // selection time in fetchBribes): voted rewards and the treasury fee must
  // never be computed on mismatched rounds.
  const bribesRoundEnd = Number(bribesData?.epoch?.end);
  if (Number.isFinite(bribesRoundEnd) && bribesRoundEnd > 0 &&
      Math.abs(bribesRoundEnd - proposal.end) > 3 * 86400) {
    throw new Error(
      `Votium bribes round (end ${bribesRoundEnd}) does not align with the ` +
        `on-chain proposal ${proposalId} (end ${proposal.end}) for ${bribesType} — ` +
        `refusing to compute forwarders voted rewards on mismatched rounds`
    );
  }

  // Get gauges
  let gauges = await gaugeFetcher();
  if (transformGauges) {
    gauges = gauges.map((gauge: any) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  // Map gauges to proposal choices (on-chain choices are gauge addresses)
  const gaugeMapping = associateGaugesPerIdOnChain(proposal, gauges);
  let processedGauges = 0;

  // Process each gauge
  for (const gaugeAddress in gaugeMapping) {
    const gaugeInfo = gaugeMapping[gaugeAddress];

    // Debug: Log gauge 395
    if (gaugeInfo.choiceId === 395) {
      console.log(`\nProcessing gauge for choice 395: ${gaugeAddress}`);
    }

    // Find matching gauge details
    const gaugeDetails = gauges.find(
      (g: any) =>
        g.gauge.toLowerCase() === gaugeAddress.toLowerCase() ||
        (g.rootGauge &&
          g.rootGauge.toLowerCase() === gaugeAddress.toLowerCase())
    );

    if (!gaugeDetails) {
      // Skip known non-gauge choices silently
      const knownNonGauges = ["vefunder", "vecrv", "other"];
      const isKnownNonGauge = knownNonGauges.some((ng) =>
        gaugeInfo.shortName?.toLowerCase().includes(ng)
      );
      if (!isKnownNonGauge) {
        console.log(
          `Warning: No matching gauge found for choice: ${gaugeInfo.shortName}`
        );
      }
      continue;
    }

    // Get votes for this gauge
    const votesForGauge = votes.filter(
      (vote: any) =>
        vote.choice && vote.choice[gaugeInfo.choiceId] !== undefined
    );

    if (votesForGauge.length === 0) continue;

    // Total on-chain vote weight for this gauge (choiceId is 1-indexed)
    const totalChoiceScore = proposal.scores[gaugeInfo.choiceId - 1] || 0;

    // Per-address vote shares for this gauge (reused for every bribe below)
    const addressShares = computeVoteSharesForGauge(
      votesForGauge,
      gaugeInfo.choiceId,
      forwarders,
      totalChoiceScore
    );

    // Get bribes for this gauge — match by gauge ADDRESS only. The Llama
    // `choice` field was derived from the Snapshot proposal ordering and has
    // no relation to the on-chain choice indices: matching on it would
    // produce false positives. Match against the ROOT/CHILD alias set: the
    // on-chain choice may be the root gauge while Votium/Llama indexed the
    // deposit on the child gauge (or vice versa) — a bribe silently dropped
    // here would understate the treasury fee and the covered-amount
    // subtraction downstream.
    const gaugeAliases = new Set(
      [gaugeAddress, gaugeDetails.gauge, gaugeDetails.rootGauge]
        .filter(Boolean)
        .map((a: string) => a.toLowerCase())
    );
    const gaugeBribes =
      bribesData?.epoch?.bribes?.filter((bribe: any) =>
        gaugeAliases.has(bribe.gauge.toLowerCase())
      ) || [];

    // Aggregate bribes for overall distribution (matching working version)
    const delegationShare = computeDelegationShareForGauge(
      votesForGauge,
      gaugeInfo.choiceId,
      forwarders
    );

    await aggregateBribesByToken(
      gaugeBribes,
      matchingBribesAggregated,
      delegationShare,
      bribesType
    );

    // Distribute bribes among forwarders for per-address tracking
    for (const bribe of gaugeBribes) {
      const amountInDollars = bribe.amountDollars || 0;


      for (const forwarder of forwarders) {
        const share = addressShares.get(forwarder.address) || 0;
        if (share > 0) {
          const allocatedDollars = amountInDollars * share;
          const allocatedAmount = (Number(bribe.amount) * share).toFixed(6);

          if (!tokenAllocations[forwarder.address]) {
            tokenAllocations[forwarder.address] = {};
          }

          const tokenKey = await getTokenAddress(bribe.token);

          if (!tokenAllocations[forwarder.address][tokenKey]) {
            tokenAllocations[forwarder.address][tokenKey] = {
              amount: "0",
              usd: 0,
            };
          }

          // Add to existing allocation
          const existing = tokenAllocations[forwarder.address][tokenKey];
          tokenAllocations[forwarder.address][tokenKey] = {
            amount: (Number(existing.amount) + Number(allocatedAmount)).toFixed(6),
            usd: existing.usd + allocatedDollars,
          };

          // Also track for per-address token allocations (for claimed bounties)
          const tokenAddress = tokenKey;

          // Check if the bribe amount looks like it's already in wei
          const brideAmountNum = Number(bribe.amount);
          let amountInWei: bigint;

          if (brideAmountNum > 1e10) {
            amountInWei = BigInt(Math.floor(Number(bribe.amount) * share));
          } else {
            const decimals = await getTokenDecimals(tokenAddress);
            amountInWei = BigInt(Math.floor(Number(bribe.amount) * share * 10 ** decimals));
          }

          if (!perAddressTokenAllocations[forwarder.address][tokenAddress]) {
            perAddressTokenAllocations[forwarder.address][tokenAddress] = BigInt(0);
          }
          perAddressTokenAllocations[forwarder.address][tokenAddress] += amountInWei;
        }
      }
    }

    if (gaugeBribes.length > 0) {
      processedGauges++;
    }
  }

  return processedGauges;
}

/**
 * Clean per-address output to remove empty entries
 */
function cleanPerAddressOutput(perAddressOutput: any) {
  const cleaned: any = {};

  // Clean votes sections: remove addresses with empty vote objects
  ["curveVotes", "fxnVotes"].forEach((section) => {
    if (perAddressOutput[section]) {
      const newSection: any = {};
      for (const addr in perAddressOutput[section]) {
        const entry = perAddressOutput[section][addr];
        // Only keep if the object has at least one property
        if (entry && Object.keys(entry).length > 0) {
          newSection[addr] = entry;
        }
      }
      if (Object.keys(newSection).length > 0) {
        cleaned[section] = newSection;
      }
    }
  });

  // Clean tokenAllocations: for each address, remove tokens with a zero allocation
  if (perAddressOutput.tokenAllocations) {
    const cleanedAllocations: any = {};
    for (const addr in perAddressOutput.tokenAllocations) {
      const tokens = perAddressOutput.tokenAllocations[addr];
      const newTokens: any = {};
      for (const token in tokens) {
        const allocation = tokens[token];
        // Convert allocation to a number and skip if zero
        if (Number(allocation.amount) === 0) continue;
        // Token should already be an address, but keep as is
        const newTokenKey = token;
        newTokens[newTokenKey] = allocation;
      }
      // Only include this address if there's at least one token with nonzero allocation
      if (Object.keys(newTokens).length > 0) {
        cleanedAllocations[addr] = newTokens;
      }
    }
    if (Object.keys(cleanedAllocations).length > 0) {
      cleaned.tokenAllocations = cleanedAllocations;
    }
  }
  return cleaned;
}

/**
 * Process votes with address breakdown
 */
async function fetchProposalVotesWithAddressBreakdown(
  space: string,
  proposal: any,
  votes: any[],
  gaugeFetcher: () => Promise<any>,
  forwarders: Forwarder[],
  transformGauges = false
) {
  // Proposal and votes are fetched ONCE in main and passed down (pinned round)
  const proposalId = proposal.id;

  let gauges = await gaugeFetcher();
  if (transformGauges) {
    gauges = gauges.map((gauge: any) => ({
      ...gauge,
      shortName: gauge.name,
      gauge: gauge.address,
    }));
  }

  const gaugeMapping = associateGaugesPerIdOnChain(proposal, gauges);
  const gaugeMappingWithInfos: any = {};
  for (const gaugeKey of Object.keys(gaugeMapping)) {
    const match = gauges.find(
      (g: any) =>
        g.gauge.toLowerCase() === gaugeKey.toLowerCase() ||
        (g.rootGauge && g.rootGauge.toLowerCase() === gaugeKey.toLowerCase())
    );
    if (match) {
      gaugeMappingWithInfos[gaugeKey] = {
        shortName: match.shortName,
        choiceId: gaugeMapping[gaugeKey].choiceId,
        gauge: match.gauge,
      };
    }
  }

  const forwarderAddresses = new Set(forwarders.map((f) => f.address));

  // Build per-address vote breakdown using the forwarders list
  const addressBreakdown: Record<string, any[]> = {};
  forwarders.forEach((forwarder) => {
    addressBreakdown[forwarder.address] = [];
  });

  // Create a map to track Union delegators (those who delegated to The Union)
  const unionDelegators = new Map<string, Forwarder>();

  // Use the isUnionDelegator flag to identify Union delegators
  for (const forwarder of forwarders) {
    if (
      forwarder.isUnionDelegator &&
      (forwarder.unionContributingWeight ?? 0) > 0
    ) {
      unionDelegators.set(forwarder.address.toLowerCase(), forwarder);
    }
  }



  const processedVotes = votes.map((vote: any) => {
    let choicesWithInfos: any = {};
    if (vote.choice && typeof vote.choice === "object") {
      Object.keys(vote.choice).forEach((choiceId) => {
        const gaugeKey = Object.keys(gaugeMappingWithInfos).find(
          (key) => gaugeMappingWithInfos[key].choiceId === parseInt(choiceId)
        );
        if (gaugeKey) {
          choicesWithInfos[choiceId] = {
            shortName: gaugeMappingWithInfos[gaugeKey].shortName,
            gauge: gaugeMappingWithInfos[gaugeKey].gauge,
            weight: vote.choice[choiceId],
          };
          const voter = vote.voter.toLowerCase();

          // Check if this is The Union's vote
          if (voter === THE_UNION_ADDRESS.toLowerCase()) {
            // Distribute The Union's votes to delegators who delegated to them
            for (const [delegatorAddress] of unionDelegators) {
              if (forwarderAddresses.has(delegatorAddress)) {
                // Add the vote to the delegator's breakdown
                addressBreakdown[delegatorAddress].push({
                  proposalId,
                  gauge: gaugeMappingWithInfos[gaugeKey].gauge,
                  choiceId: gaugeMappingWithInfos[gaugeKey].choiceId,
                  weight: vote.choice[choiceId],
                  viaUnion: true, // Mark that this came via The Union
                });
              }
            }
          } else if (forwarderAddresses.has(voter)) {
            // Regular forwarder vote
            addressBreakdown[voter].push({
              proposalId,
              gauge: gaugeMappingWithInfos[gaugeKey].gauge,
              choiceId: gaugeMappingWithInfos[gaugeKey].choiceId,
              weight: vote.choice[choiceId],
            });
          }
        }
      });
    }
    return { ...vote, choicesWithInfos };
  });

  return {
    proposalId,
    proposal,
    votes: processedVotes,
    gaugeMapping: gaugeMappingWithInfos,
    addressBreakdown,
  };
}

/**
 * Fetch bribes from Llama Airforce with timeout handling
 */
async function fetchBribes(chain: string, targetEnd?: number) {
  try {
    // Add timeout to fetch requests
    const fetchWithTimeout = async (url: string, timeout = 30000) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    };

    const roundsUrl = `https://api.llama.airforce/bribes/votium/${chain}/rounds`;
    const roundsResponse = await fetchWithTimeout(roundsUrl);
    const roundsData = await roundsResponse.json();

    if (!roundsData.rounds || roundsData.rounds.length === 0) {
      console.warn(`No rounds found for ${chain}`);
      return null;
    }

    // Pick the round ALIGNED with the target proposal, not blindly the max:
    // Llama may already list the currently-active round while we compute the
    // just-ended one (and vice versa). Walk the most recent rounds and keep
    // the first whose end is within 3 days of the proposal end.
    const candidates = [...roundsData.rounds].sort((a, b) => b - a).slice(0, 3);
    for (const round of candidates) {
      const bribesUrl = `https://api.llama.airforce/bribes/votium/${chain}/${round}`;
      const bribesResponse = await fetchWithTimeout(bribesUrl);
      const bribesData = await bribesResponse.json();

      const roundEnd = Number(bribesData?.epoch?.end);
      if (
        !targetEnd ||
        (Number.isFinite(roundEnd) &&
          roundEnd > 0 &&
          Math.abs(roundEnd - targetEnd) <= 3 * 86400)
      ) {
        console.log(`Fetching bribes for ${chain} round ${round}`);
        return bribesData;
      }
      console.log(
        `Skipping ${chain} round ${round} (end ${roundEnd}) — not aligned with proposal end ${targetEnd}`
      );
    }

    console.warn(
      `No ${chain} Votium round aligned with proposal end ${targetEnd} among the last ${candidates.length} rounds`
    );
    return null;
  } catch (error) {
    console.error(`Error fetching bribes for ${chain}:`, error);
    return null;
  }
}

/**
 * Fetch and process claimed bounties from the blockchain
 * This replicates the logic from the working version
 */
async function fetchAndProcessClaimedBounties(
  blockStart: number,
  blockEnd: number,
  matchingBribesAggregated: any
): Promise<{ votiumConvexBounties: any; protocolBounties: any }> {
  const votiumConvexBounties = await fetchVotiumClaimedBounties(
    blockStart,
    Number(blockEnd)
  );

  if (
    !votiumConvexBounties.votiumBounties ||
    votiumConvexBounties.votiumBounties.length === 0
  ) {
    console.warn("No claimed Votium bounties found");
    return {
      votiumConvexBounties,
      protocolBounties: { curve: {}, fxn: {} },
    };
  }

  // Map token addresses to overall bribes data
  const tokenAddressToBribes = matchingBribesAggregated;

  // Group by protocol with proper amount splitting
  const protocolBountiesArrays = {
    curve: [] as any[],
    fxn: [] as any[],
  };

  votiumConvexBounties.votiumBounties.forEach((bounty: any) => {
    const matching =
      tokenAddressToBribes[normalizeVotiumTokenAddress(bounty.rewardToken)];
    if (!matching) return;

    const claimedAmount = BigInt(bounty.amount);
    const curveWeight = BigInt(matching.curveAmount);
    const fxnWeight = BigInt(matching.fxnAmount);
    const totalWeight = curveWeight + fxnWeight;
    let curveAmount = 0n;
    let fxnAmount = 0n;

    if (totalWeight > 0n) {
      curveAmount = (claimedAmount * curveWeight) / totalWeight;
      fxnAmount = claimedAmount - curveAmount;
    } else {
      const hasCurveBribes = matching.bribes.some(
        (bribe: any) => bribe.type === "curve"
      );
      const hasFxnBribes = matching.bribes.some(
        (bribe: any) => bribe.type === "fxn"
      );
      if (hasCurveBribes && hasFxnBribes) {
        curveAmount = claimedAmount / 2n;
        fxnAmount = claimedAmount - curveAmount;
      } else if (hasCurveBribes) {
        curveAmount = claimedAmount;
      } else if (hasFxnBribes) {
        fxnAmount = claimedAmount;
      }
    }

    if (curveAmount > 0n) {
      protocolBountiesArrays.curve.push({ ...bounty, amount: curveAmount });
    }
    if (fxnAmount > 0n) {
      protocolBountiesArrays.fxn.push({ ...bounty, amount: fxnAmount });
    }
  });

  // Convert arrays to objects with numbered keys (matching the working version format)
  const protocolBounties = {
    curve: {} as any,
    fxn: {} as any,
  };

  protocolBountiesArrays.curve.forEach((bounty, index) => {
    protocolBounties.curve[index.toString()] = bounty;
  });

  protocolBountiesArrays.fxn.forEach((bounty, index) => {
    protocolBounties.fxn[index.toString()] = bounty;
  });

  return { votiumConvexBounties, protocolBounties };
}

/**
 * Main function to generate Convex Votium bounties
 */
export async function generateConvexVotiumBounties(
  pastWeek: number = 0
): Promise<void> {
  try {
    console.log("\nGenerating Convex Votium Bounties...");

    // Initialize client
    const ethereumClient = (await getClient(1)) as any;

    // Get current epoch
    const epochAbi = [
      {
        name: "currentEpoch",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const;

    let currentEpoch = await ethereumClient.readContract({
      address: VOTIUM_FORWARDER_REGISTRY as `0x${string}`,
      abi: epochAbi,
      functionName: "currentEpoch",
    });

    // Catch-up support (PAST_WEEK=N): re-target the run N weeks back, as if
    // it had run in its normal Wednesday slot of that week. Only the period
    // targeting shifts; proposal-start sanity checks keep real time.
    const now = Math.floor(Date.now() / 1000) - pastWeek * WEEK;
    if (pastWeek > 0) {
      console.log(`PAST_WEEK=${pastWeek}: targeting period of ${pastWeek} week(s) ago`);
    }
    /*
    // If we are on an even week, take the prev round epoch
    if (!isOddWeek(now)) {
      console.log("using prev round epoch");
      currentEpoch = currentEpoch - BigInt(2 * WEEK)
    }
    */

    console.log(`Epoch: ${currentEpoch} (${new Date(Number(currentEpoch) * 1000).toLocaleDateString('en-GB')})`);

    // TEST-ONLY fork escape hatch (see 2_repartition): allows reading an
    // active proposal and approximating the forwarder-check block. In
    // production (unset) finality is enforced: endTime + equalizer overtime.
    const allowActive = process.env.VLCVX_ALLOW_ACTIVE_PROPOSAL === "true";

    // This slot runs the day after the round ends (Wednesday), i.e. BEFORE
    // the Thursday distribution period that round feeds — pin the proposal to
    // that upcoming period so a delayed re-run cannot drift onto the next
    // round once it finalizes.
    const votiumTargetPeriod = Math.floor(now / WEEK) * WEEK + WEEK;

    // Get the Curve proposal and its votes ONCE — every downstream step
    // (forwarders, breakdown, bribes matching) works on this pinned round. A
    // proposal created mid-run must never shift later reads.
    const curveProposal = await getOnChainProposal(
      CVX_GAUGE_VOTE_PLATFORM_CURVE,
      CVX_SPACE,
      ethereumClient,
      { requireFinal: !allowActive, targetPeriod: votiumTargetPeriod }
    );
    if (curveProposal.start > Math.floor(Date.now() / 1000)) {
      throw new Error(
        `Latest Curve on-chain proposal ${curveProposal.id} has not started yet ` +
          `(start ${curveProposal.start})`
      );
    }
    const curveProposalId = curveProposal.id;
    const curveVotes = await getOnChainVoters(
      CVX_GAUGE_VOTE_PLATFORM_CURVE,
      Number(curveProposalId),
      curveProposal,
      ethereumClient
    );

    // Get block for the forwarder check: on-chain, proposal.snapshot is a
    // vlCVX epoch number, NOT a block — resolve from the proposal end
    // timestamp (same convention as the repartition path).
    // VLCVX_ALLOW_ACTIVE_PROPOSAL=true is the TEST-ONLY fork escape hatch
    // (see 2_repartition): an active proposal has no post-end block yet, and
    // on a fork the Etherscan-resolved mainnet block may not exist.
    const blockSnapshotEnd =
      process.env.VLCVX_ALLOW_ACTIVE_PROPOSAL === "true"
        ? Number(await ethereumClient.getBlockNumber())
        : await getBlockNumberByTimestamp(curveProposal.end, "after", 1);

    // Get all forwarders (delegators + direct voters). Forwarder lists are
    // PER PLATFORM: a wallet's direct effective VP, its choices and its
    // forwarding status can differ between Curve and FXN. StakeDAO delegate
    // contributing weights are intentionally excluded here: they are paid by
    // the separate repartition_delegation pipeline.
    console.log("Fetching Curve forwarders...");
    const curveForwarders = await getAllForwarders(
      CVX_SPACE,
      curveProposal,
      curveVotes,
      blockSnapshotEnd,
      Number(currentEpoch)
    );

    if (curveForwarders.length === 0) {
      console.warn("No forwarders found!");
      return;
    }

    // Initialize tracking structures
    let tokenAllocations: Record<string, TokenAllocation> = {};
    let perAddressTokenAllocations: Record<
      string,
      Record<string, bigint>
    > = {};
    const matchingBribesAggregated: any = {};

    curveForwarders.forEach((f) => {
      tokenAllocations[f.address] = {};
      perAddressTokenAllocations[f.address] = {};
    });

    // Process Curve votes and bribes
    console.log("Processing Curve gauges...");
    const curveBribes = await fetchBribes("cvx-crv", curveProposal.end);

    // Process Curve votes to get address breakdown
    const votesCurveResult = await fetchProposalVotesWithAddressBreakdown(
      CVX_SPACE,
      curveProposal,
      curveVotes,
      getAllCurveGauges,
      curveForwarders,
      false
    );
    const curveAddressBreakdown = votesCurveResult
      ? votesCurveResult.addressBreakdown
      : {};

    const curveGaugesProcessed = await processGaugeVotes(
      CVX_SPACE,
      curveProposal,
      curveVotes,
      getAllCurveGauges,
      curveBribes,
      curveForwarders,
      tokenAllocations,
      perAddressTokenAllocations,
      matchingBribesAggregated,
      "curve",
      false
    );
    console.log(`Processed ${curveGaugesProcessed} Curve gauges with bribes`);

    // Process FXN votes and bribes (skipped cleanly while the FXN platform
    // has no proposal yet — getOnChainProposal throws into this catch)
    console.log("Processing FXN gauges...");
    let fxnGaugesProcessed = 0;
    let fxnAddressBreakdown: any = {};
    let fxnForwarders: Forwarder[] = [];

    try {
      const fxnProposal = await getOnChainProposal(
        CVX_GAUGE_VOTE_PLATFORM_FXN,
        CVX_SPACE,
        ethereumClient,
        { requireFinal: !allowActive, targetPeriod: votiumTargetPeriod }
      );
      if (fxnProposal.start > Math.floor(Date.now() / 1000)) {
        throw new Error(
          `Latest FXN on-chain proposal ${fxnProposal.id} has not started yet`
        );
      }
      const fxnVotes = await getOnChainVoters(
        CVX_GAUGE_VOTE_PLATFORM_FXN,
        Number(fxnProposal.id),
        fxnProposal,
        ethereumClient
      );
      const fxnBribes = await fetchBribes("cvx-fxn", fxnProposal.end);

      // FXN forwarders must be resolved from the FXN proposal itself. The end
      // block is platform-specific even though both platforms currently share
      // the same schedule, and a direct voter's effective VP can differ.
      const fxnBlockSnapshotEnd = allowActive
        ? Number(await ethereumClient.getBlockNumber())
        : await getBlockNumberByTimestamp(fxnProposal.end, "after", 1);

      console.log("Fetching FXN forwarders...");
      fxnForwarders = await getAllForwarders(
        CVX_SPACE,
        fxnProposal,
        fxnVotes,
        fxnBlockSnapshotEnd,
        Number(currentEpoch)
      );

      // A forwarder may exist on FXN only (e.g. delegated after the Curve
      // carve-out): allocation maps must cover the union of both lists —
      // processGaugeVotes assumes perAddressTokenAllocations[addr] exists.
      fxnForwarders.forEach((f) => {
        if (!tokenAllocations[f.address]) tokenAllocations[f.address] = {};
        if (!perAddressTokenAllocations[f.address]) {
          perAddressTokenAllocations[f.address] = {};
        }
      });

      // Process FXN votes to get address breakdown
      const votesFxnResult = await fetchProposalVotesWithAddressBreakdown(
        CVX_SPACE,
        fxnProposal,
        fxnVotes,
        () => getGaugesInfos("fxn"),
        fxnForwarders,
        true
      );
      fxnAddressBreakdown = votesFxnResult
        ? votesFxnResult.addressBreakdown
        : {};

      fxnGaugesProcessed = await processGaugeVotes(
        CVX_SPACE,
        fxnProposal,
        fxnVotes,
        () => getGaugesInfos("fxn"),
        fxnBribes,
        fxnForwarders,
        tokenAllocations,
        perAddressTokenAllocations,
        matchingBribesAggregated,
        "fxn",
        true
      );
      console.log(`Processed ${fxnGaugesProcessed} FXN gauges with bribes`);
    } catch (error) {
      console.error("Error processing FXN gauges:", error);
    }

    // Store original tokenAllocations for USD values
    const originalTokenAllocations: Record<string, TokenAllocation> =
      JSON.parse(JSON.stringify(tokenAllocations));

    // Use the period from VOTIUM_FORWARDER_REGISTRY + one week (bc distribution is done on thursday) instead of current timestamp
    const rootDir = path.resolve(__dirname, "../../..");
    const weeklyBountiesDir = path.join(rootDir, "weekly-bounties");
    ensureDirExists(weeklyBountiesDir);

    const periodFolder = path.join(
      weeklyBountiesDir,
      (Number(currentEpoch) + 604800).toString(),
      "votium"
    );
    ensureDirExists(periodFolder);
    const outputDir = periodFolder;

    // Invalidate any previous output for this period BEFORE computing: if this
    // run fails midway, downstream consumers (delegators merkle fee +
    // votium-covered subtraction) must find NO file — their absent-file path
    // is safe (fee = 0) — rather than silently consume stale allocations.
    fs.rmSync(path.join(outputDir, "forwarders_voted_rewards.json"), {
      force: true,
    });

    // Initialize variables outside try block so they're accessible in summary
    let claimedTokenAmounts: Record<string, bigint> = {};
    let tokenPrices: Record<string, number> = {};

    // Fetch and save claimed bounties
    try {
      // Get block range for claimed bounties
      const blockNumber1 = await getClosestBlockTimestamp(
        "ethereum",
        Number(currentEpoch)
      );
      const latestBlock = await ethereumClient.getBlockNumber();

      // Fetch and process claimed bounties using the aggregated bribes
      const { votiumConvexBounties, protocolBounties } =
        await fetchAndProcessClaimedBounties(
          blockNumber1,
          Number(latestBlock),
          matchingBribesAggregated
        );

      // Save claimed bounties
      const claimedBountiesPath = path.join(
        outputDir,
        "claimed_bounties_convex.json"
      );
      fs.writeFileSync(
        claimedBountiesPath,
        JSON.stringify(protocolBounties, customReplacer, 2)
      );

      // Process all votium bounties to get actual claimed amounts
      // (fetchVotiumClaimedBounties returns {} when no claim is in range)
      for (const bounty of votiumConvexBounties.votiumBounties || []) {
        const token = normalizeVotiumTokenAddress(bounty.rewardToken);
        if (!claimedTokenAmounts[token]) {
          claimedTokenAmounts[token] = 0n;
        }
        claimedTokenAmounts[token] += BigInt(bounty.amount);
      }

      // Get token prices for claimed tokens
      tokenPrices = {};
      const tokenIdentifiers: TokenIdentifier[] = [];

      for (const token of Object.keys(claimedTokenAmounts)) {
        tokenIdentifiers.push({ chainId: 1, address: token });
      }

      const prices = await getTokenPrices(tokenIdentifiers);
      for (const [key, price] of Object.entries(prices)) {
        const address = key.slice(key.indexOf(":") + 1);
        tokenPrices[normalizeVotiumTokenAddress(address)] = price;
      }

      const tokenDecimals: Record<string, number> = {};
      for (const token of Object.keys(claimedTokenAmounts)) {
        tokenDecimals[token] = await getTokenDecimals(token);
      }

      const reconciled = reconcileVotiumClaimAllocations({
        claimedTokenAmounts,
        originalTokenAllocations,
        tokenDecimals,
        tokenPrices,
      });
      tokenAllocations = reconciled.tokenAllocations;
      perAddressTokenAllocations =
        reconciled.perAddressTokenAllocations;

      // Add Telegram logger
      const telegramLogger = new ClaimsTelegramLogger();
      await telegramLogger.logClaims(
        "votium/claimed_bounties_convex.json",
        Number(currentEpoch) + 604800,
        votiumConvexBounties
      );
    } catch (error) {
      console.error("Error reconciling claimed Votium bounties:", error);
      throw error;
    }

    // Recalculate total allocations after adjustments to only include claimed tokens
    const totalAllocations: TokenAllocation = {};
    Object.values(tokenAllocations).forEach((userTokens) => {
      Object.entries(userTokens).forEach(([token, allocation]) => {
        if (!totalAllocations[token]) {
          totalAllocations[token] = {
            amount: "0",
            usd: 0,
          };
        }
        totalAllocations[token] = {
          amount: (
            Number(totalAllocations[token].amount) + Number(allocation.amount)
          ).toFixed(6),
          usd: totalAllocations[token].usd + allocation.usd,
        };
      });
    });

    // Format per-address allocations
    let allTokens: string[] = [];

    // Build a list of unique token addresses from per-address allocations
    for (const voter in perAddressTokenAllocations) {
      for (const token in perAddressTokenAllocations[voter]) {
        if (!allTokens.includes(token)) {
          allTokens.push(token);
        }
      }
    }

    // Format amounts properly using token info
    const formattedPerAddressAllocations: Record<
      string,
      Record<string, string>
    > = {};
    for (const voter in perAddressTokenAllocations) {
      formattedPerAddressAllocations[voter] = {};
      for (const token of allTokens) {
        const rawAmount = perAddressTokenAllocations[voter][token];
        if (rawAmount && rawAmount > 0n) {
          // The amounts in perAddressTokenAllocations are already adjusted to match claimed amounts
          // They are already in the smallest unit (e.g., wei for 18 decimal tokens)
          // So we can use them directly for the merkle tree
          formattedPerAddressAllocations[voter][token] = rawAmount.toString();
        }
      }
    }

    // Prepare per-address output with both formats
    // For the merkle tree, we need wei amounts (from formattedPerAddressAllocations)
    // But we also want to keep the USD values for the combined merkle script
    const tokenAllocationsWithWei: Record<string, Record<string, { amount: string; amountWei: string; usd: number }>> = {};

    for (const voter in tokenAllocations) {
      tokenAllocationsWithWei[voter] = {};
      for (const token in tokenAllocations[voter]) {
        if (formattedPerAddressAllocations[voter] && formattedPerAddressAllocations[voter][token]) {
          tokenAllocationsWithWei[voter][token] = {
            amount: tokenAllocations[voter][token].amount, // Human readable with decimals
            amountWei: formattedPerAddressAllocations[voter][token], // Wei amount as string
            usd: tokenAllocations[voter][token].usd
          };
        }
      }
    }

    const perAddressOutput = {
      curveVotes: curveAddressBreakdown,
      fxnVotes: fxnAddressBreakdown,
      tokenAllocations: tokenAllocationsWithWei,
      // Traceability: which pinned round produced this file (extra top-level
      // key, ignored by the existing consumers)
      meta: {
        curveProposalId,
        curveProposalEnd: curveProposal.end,
        vlcvxEpoch: Number(curveProposal.snapshot),
        generatedAt: Math.floor(Date.now() / 1000),
      },
    };

    // Clean the per-address data (cleanPerAddressOutput rebuilds the object —
    // re-attach the meta block afterwards)
    const cleanedPerAddressOutput = {
      ...cleanPerAddressOutput(perAddressOutput),
      meta: perAddressOutput.meta,
    };

    // Save the cleaned per-address data
    const perAddressPath = path.join(
      outputDir,
      "forwarders_voted_rewards.json"
    );

    fs.writeFileSync(
      perAddressPath,
      JSON.stringify(cleanedPerAddressOutput, customReplacer)
    );

    // Calculate distribution efficiency
    let totalClaimedUsd = 0;
    let totalDistributedUsd = 0;

    for (const [token, claimedAmount] of Object.entries(claimedTokenAmounts)) {
      const decimals = await getTokenDecimals(token);
      const distributedWei = Object.values(perAddressTokenAllocations).reduce(
        (sum, userAllocs) => sum + (userAllocs[token] || 0n),
        0n
      );
      const tokenPrice = tokenPrices?.[token.toLowerCase()] || 0;

      if (tokenPrice > 0) {
        totalClaimedUsd += (Number(claimedAmount) / (10 ** decimals)) * tokenPrice;
        totalDistributedUsd += (Number(distributedWei) / (10 ** decimals)) * tokenPrice;
      }
    }

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    
    // Union of the two per-platform lists (an address may forward on both)
    const forwardersByAddress = new Map<string, Forwarder>();
    for (const f of [...curveForwarders, ...fxnForwarders]) {
      if (!forwardersByAddress.has(f.address)) forwardersByAddress.set(f.address, f);
    }
    const allForwarders = [...forwardersByAddress.values()];
    const delegatorCount = allForwarders.filter((f) => f.type === "delegator").length;
    const directVoterCount = allForwarders.filter((f) => f.type === "direct-voter").length;

    console.log(`Forwarders: ${allForwarders.length} (${delegatorCount} delegators, ${directVoterCount} direct voters)`);
    console.log(`Claimed tokens: ${Object.keys(claimedTokenAmounts).length}`);
    console.log(`Total claimed: $${totalClaimedUsd.toFixed(2)}`);
    console.log(`Total distributed: $${totalDistributedUsd.toFixed(2)}`);
    const distributionEfficiency =
      totalClaimedUsd > 0 ? (totalDistributedUsd * 100) / totalClaimedUsd : 0;
    console.log(`Efficiency: ${distributionEfficiency.toFixed(2)}%`);
    console.log(`Output: ${perAddressPath}`);
    console.log("=".repeat(60));

  } catch (error) {
    console.error("Error generating Convex Votium bounties:", error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  const pastWeek = process.argv[2] ? parseInt(process.argv[2]) : 0;
  generateConvexVotiumBounties(pastWeek)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
