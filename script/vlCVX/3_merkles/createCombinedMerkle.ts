import fs from "fs";
import path from "path";
import * as moment from "moment";
import * as dotenv from "dotenv";
import type { PublicClient } from "viem";
dotenv.config();

import { mainnet } from "../../utils/chains";
import { createCombineDistribution } from "../../utils/merkle/merkle";
import {
  generateMerkleTree,
  mergeMerkleData,
} from "../../shared/merkle/generateMerkleTree";
import { MerkleData } from "../../interfaces/MerkleData";
import {
  CVX_SPACE,
  WEEK,
  CVX_GAUGE_VOTE_PLATFORM_CURVE,
  CVX_GAUGE_VOTE_PLATFORM_FXN,
} from "../../utils/constants";
import { distributionVerifier } from "../../utils/merkle/distributionVerifier";
import {
  findMerkleMatchingRoot,
  findPreviousMerkle,
} from "../../utils/merkle/findPreviousMerkle";
import { canUseStandardGaugeMerge } from "../../utils/merkle/activeGaugeBaseline";
import {
  hasPerDelegateAttribution,
  getExactGroupAmounts,
} from "../../utils/delegationExact";
import {
  computeVotiumRawPayouts,
  hasClaimedVotiumBounties,
  isVotiumClaimPeriod,
  MIN_VOTIUM_RAW_PAYOUT_USD,
} from "../../utils/votiumRawPayouts";
import { VOTIUM_FORWARDER } from "../../utils/constants";
import {
  getOnChainProposal,
  getOnChainVoters,
} from "../../utils/gaugeVotePlatform";
import { getClient } from "../../utils/getClients";

// Round current UTC time down to the nearest week for the current period
const currentPeriodTimestamp = Math.floor(moment.utc().unix() / WEEK) * WEEK;

const VOTERS_DISTRIBUTOR =
  "0x000000006feeE0b7a0564Cd5CeB283e10347C4Db" as const;
const ZERO_ROOT = `0x${"0".repeat(64)}`;

const URD_ABI = [
  {
    name: "root",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    name: "claimed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "reward", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

type RawDistribution = {
  [address: string]: { tokens: { [token: string]: bigint } };
};

// Ops instruction for the raw Votium leaves, staged during the curve pass and
// written by main() only after EVERY merkle output landed — a half-finished
// run must not leave an instruction describing unpublished leaves.
let pendingVotiumWithdrawal: {
  period: number;
  source: string;
  destination: string;
  fundingLeg: string;
  tokens: Record<string, string>;
} | null = null;

const votiumWithdrawalPath = () =>
  path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    "votium_thursday_withdrawal.json"
  );

// Global variables to hold Merkle data for each gauge type and chain
let merkleDataByChain: {
  [chainId: string]: {
    curve?: MerkleData;
    fxn?: MerkleData;
  };
} = {};

// Per-gauge bases used to build the current per-gauge artifacts. They are not
// trusted as a decomposition of the live global root until their merged claims
// recompute to that exact root.
let previousMerkleDataByChain: {
  [chainId: string]: {
    curve?: MerkleData;
    fxn?: MerkleData;
  };
} = {};

// Current-week deltas, kept separately from the per-gauge cumulative artifacts.
// The global Merkle is based on the single active global root plus these deltas;
// merging two per-gauge cumulative trees would add the historical base twice.
let currentDistributionByChain: {
  [chainId: string]: {
    curve?: RawDistribution;
    fxn?: RawDistribution;
  };
} = {};

// Define the two gauge types to process
const gaugeTypes = ["curve", "fxn"];

// Define all supported chain IDs
const supportedChainIds = ["1", "42161", "10", "8453", "137"];

/**
 * Main function: process all gauge types and then merge the Merkle data for each chain.
 */
async function main() {
  console.log("Running merkles generation...");

  // Check if merkle files already exist for this period
  const merkleFiles = [
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/curve/merkle_data_non_delegators.json`,
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/fxn/merkle_data_non_delegators.json`,
    `bounties-reports/${currentPeriodTimestamp}/vlCVX/vlcvx_merkle.json`
  ];
  
  const existingFiles = merkleFiles.filter(f => fs.existsSync(f));
  if (existingFiles.length > 0 && process.env.FORCE_UPDATE !== "true") {
    console.error(`⚠️  ERROR: Merkle files already exist for period ${currentPeriodTimestamp}`);
    console.error(`   Files found:`);
    existingFiles.forEach(f => console.error(`   - ${f}`));
    console.error(`   To force regeneration, run with FORCE_UPDATE=true`);
    process.exit(1);
  }

  // Initialize the merkle data structure for all chains
  supportedChainIds.forEach((chainId) => {
    merkleDataByChain[chainId] = {};
    previousMerkleDataByChain[chainId] = {};
    currentDistributionByChain[chainId] = {};
  });

  // Process each gauge type.
  for (const gaugeType of gaugeTypes) {
    processGaugeType(gaugeType);
  }

  // After processing, generate the global merkle for each chain.
  for (const chainId of supportedChainIds) {
    await generateGlobalMerkleForChain(chainId);
  }

  // Every merkle output landed — the ops withdrawal instruction may now be
  // published (staged by applyVotiumRawLeaves during the curve pass).
  if (pendingVotiumWithdrawal) {
    fs.writeFileSync(
      votiumWithdrawalPath(),
      JSON.stringify(pendingVotiumWithdrawal, null, 2)
    );
    console.log(`Votium withdrawal instruction saved to ${votiumWithdrawalPath()}`);
  }
}

/**
 * Generates and saves a global merkle file for a specific chain by merging curve and fxn data if available.
 *
 * @param chainId - The chain identifier (e.g. "1", "42161")
 */
async function generateGlobalMerkleForChain(chainId: string) {
  const chainDeltas = currentDistributionByChain[chainId];
  if (!chainDeltas?.curve && !chainDeltas?.fxn) {
    console.log(`No merkle data available for chain ${chainId}.`);
    return;
  }

  const currentDistribution: RawDistribution = {};
  for (const gaugeDistribution of [chainDeltas.curve, chainDeltas.fxn]) {
    if (!gaugeDistribution) continue;
    for (const [account, claim] of Object.entries(gaugeDistribution)) {
      const normalizedAccount = account.toLowerCase();
      currentDistribution[normalizedAccount] ??= { tokens: {} };
      for (const [token, amount] of Object.entries(claim.tokens)) {
        const normalizedToken = token.toLowerCase();
        currentDistribution[normalizedAccount].tokens[normalizedToken] =
          (currentDistribution[normalizedAccount].tokens[normalizedToken] ?? 0n) +
          amount;
      }
    }
  }

  const numericChainId = Number(chainId);
  const client = await getClient(numericChainId);
  const pinnedBlock = await client.getBlockNumber();
  const activeRoot = (
    await client.readContract({
      address: VOTERS_DISTRIBUTOR,
      abi: URD_ABI,
      functionName: "root",
      blockNumber: pinnedBlock,
    })
  ).toLowerCase();

  const globalRelPath = path.join(
    "vlCVX",
    chainId === "1" ? "vlcvx_merkle.json" : `vlcvx_merkle_${chainId}.json`
  );
  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };
  let matchedPeriod: number | null = null;
  if (activeRoot !== ZERO_ROOT) {
    const resolved = findMerkleMatchingRoot(
      currentPeriodTimestamp,
      globalRelPath,
      activeRoot
    );
    if (!resolved.foundAt) {
      throw new Error(
        `Chain ${chainId}: active root ${activeRoot} at block ${pinnedBlock} ` +
          `does not match any prior ${globalRelPath} artifact; refusing to reset cumulative state`
      );
    }
    previousMerkleData = resolved.data;
    matchedPeriod = Number(
      path.relative("bounties-reports", resolved.foundAt).split(path.sep)[0]
    );
    console.log(
      `Chain ${chainId}: active root ${activeRoot} @ ${pinnedBlock} ` +
        `matches ${resolved.foundAt}`
    );
  } else {
    console.log(
      `Chain ${chainId}: distributor has a zero root; using an empty baseline`
    );
  }

  const previousGaugeGlobal = mergeGaugeMerkles(
    previousMerkleDataByChain[chainId]
  );
  const canUseStandardMerge = canUseStandardGaugeMerge(
    currentPeriodTimestamp,
    matchedPeriod,
    activeRoot,
    previousGaugeGlobal
  );

  let globalMerkle: MerkleData;
  if (canUseStandardMerge) {
    // The per-gauge history is safe only when its merged claims reproduce the
    // live global root AND that root is from the immediately previous period.
    // Both conditions are required: an old tree can match the active root while
    // claimedOnChain has advanced during a long distribution gap.
    globalMerkle = mergeGaugeMerkles(merkleDataByChain[chainId])!;
    console.log(
      `Chain ${chainId}: merged per-gauge baseline matches the active root; ` +
        `using the standard weekly merge`
    );
  } else {
    const preparedBaseline = await prepareActiveBaseline(
      client,
      currentDistribution,
      previousMerkleData,
      pinnedBlock
    );
    globalMerkle = generateMerkleTree(
      createCombineDistribution(
        { distribution: currentDistribution },
        preparedBaseline.previousMerkleData,
        preparedBaseline.reappearingClaimed
      )
    );
    console.log(
      `Chain ${chainId}: no continuous, root-matched per-gauge baseline; ` +
        `rebuilt from the exact active global artifact`
    );
  }

  const reportsDir = path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX"
  );
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const outputName =
    chainId === "1" ? "vlcvx_merkle.json" : `vlcvx_merkle_${chainId}.json`;
  const outputPath = path.join(reportsDir, outputName);
  fs.writeFileSync(outputPath, JSON.stringify(globalMerkle, null, 2));
  console.log(`Global merkle for chain ${chainId} saved as ${outputName}`);
}

function mergeGaugeMerkles(
  gaugeData: { curve?: MerkleData; fxn?: MerkleData } | undefined
): MerkleData | null {
  if (!gaugeData?.curve && !gaugeData?.fxn) return null;
  return mergeMerkleData(
    gaugeData.curve ?? { merkleRoot: "", claims: {} },
    gaugeData.fxn ?? { merkleRoot: "", claims: {} }
  );
}

function pairKey(account: string, token: string): string {
  return `${account.toLowerCase()}:${token.toLowerCase()}`;
}

/**
 * Prepare the active tree for the next cumulative root:
 * - keep every open entitlement from the active root;
 * - omit stale leaves whose amount is already below claimedOnChain;
 * - restore claimedOnChain as the base when a pruned pair reappears.
 *
 * Leaves exactly equal to claimed are retained. This keeps ordinary weekly
 * trees stable and leaves deliberate cleanup to the existing verifier policy.
 */
async function prepareActiveBaseline(
  client: PublicClient,
  currentDistribution: RawDistribution,
  previousMerkleData: MerkleData,
  pinnedBlock: bigint
): Promise<{
  previousMerkleData: MerkleData;
  reappearingClaimed: Map<string, bigint>;
}> {
  const activePairs = new Map<
    string,
    { account: `0x${string}`; token: `0x${string}`; amount: bigint }
  >();
  for (const [account, claim] of Object.entries(
    previousMerkleData.claims ?? {}
  )) {
    for (const [token, tokenClaim] of Object.entries(claim.tokens ?? {})) {
      activePairs.set(pairKey(account, token), {
        account: account as `0x${string}`,
        token: token as `0x${string}`,
        amount: BigInt(tokenClaim.amount),
      });
    }
  }

  const currentPairs = new Map<
    string,
    { account: `0x${string}`; token: `0x${string}` }
  >();
  for (const [account, claim] of Object.entries(currentDistribution)) {
    for (const token of Object.keys(claim.tokens)) {
      currentPairs.set(pairKey(account, token), {
        account: account as `0x${string}`,
        token: token as `0x${string}`,
      });
    }
  }

  const pairsToRead = new Map<
    string,
    { account: `0x${string}`; token: `0x${string}` }
  >();
  for (const [key, pair] of activePairs) pairsToRead.set(key, pair);
  for (const [key, pair] of currentPairs) pairsToRead.set(key, pair);

  const entries = [...pairsToRead.entries()];
  const claimedByPair = new Map<string, bigint>();
  const chunkSize = 400;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const chunk = entries.slice(i, i + chunkSize);
    const results = await client.multicall({
      contracts: chunk.map(([, { account, token }]) => ({
        address: VOTERS_DISTRIBUTOR,
        abi: URD_ABI,
        functionName: "claimed" as const,
        args: [account, token],
      })),
      blockNumber: pinnedBlock,
      allowFailure: false,
    });
    chunk.forEach(([key], index) => {
      claimedByPair.set(key, results[index] as bigint);
    });
  }

  const preparedClaims: MerkleData["claims"] = {};
  let staleLeavesRemoved = 0;
  for (const [key, { account, token, amount }] of activePairs) {
    const claimed = claimedByPair.get(key) ?? 0n;
    if (!currentPairs.has(key) && claimed > amount) {
      staleLeavesRemoved++;
      continue;
    }
    preparedClaims[account] ??= { tokens: {} };
    preparedClaims[account].tokens[token] = {
      amount: amount.toString(),
      proof: [],
    };
  }

  const reappearingClaimed = new Map<string, bigint>();
  for (const [key] of currentPairs) {
    if (activePairs.has(key)) continue;
    const claimed = claimedByPair.get(key) ?? 0n;
    if (claimed > 0n) reappearingClaimed.set(key, claimed);
  }

  if (staleLeavesRemoved > 0) {
    console.log(
      `Removed ${staleLeavesRemoved} stale active leaf/leaves already below claimedOnChain`
    );
  }
  if (reappearingClaimed.size > 0) {
    console.log(
      `Restored claimed cumulative bases for ${reappearingClaimed.size} reappearing pair(s)`
    );
  }
  return {
    previousMerkleData: {
      merkleRoot: previousMerkleData.merkleRoot,
      claims: preparedClaims,
    },
    reappearingClaimed,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * Processes one gauge type (either "curve" or "fxn") by:
 * - Defining the output directory for the current period and gauge type.
 * - Processing Mainnet (chainId "1") and additional chains.
 *
 * @param gaugeType - "curve" or "fxn"
 */
function processGaugeType(gaugeType: string) {
  // Construct the base directory for the current period and gauge type.
  const reportsDir = path.join(
    "bounties-reports",
    currentPeriodTimestamp.toString(),
    "vlCVX",
    gaugeType
  );
  console.log(
    `\nProcessing gauge type "${gaugeType}" in directory ${reportsDir}`
  );

  // File paths for Mainnet (chainId "1")
  const NON_DELEGATORS_FILE = path.join(reportsDir, "repartition.json");
  const DELEGATION_FILE = path.join(reportsDir, "repartition_delegation.json");

  // Process Mainnet first
  processChain(
    gaugeType,
    "1",
    NON_DELEGATORS_FILE,
    DELEGATION_FILE,
    reportsDir
  );

  // Process additional chains
  const otherChainIds = ["42161", "10", "8453", "137"];
  for (const chainId of otherChainIds) {
    const nonDelegatorsFile = path.join(
      reportsDir,
      `repartition_${chainId}.json`
    );
    const delegationFile = path.join(
      reportsDir,
      `repartition_delegation_${chainId}.json`
    );
    processChain(
      gaugeType,
      chainId,
      nonDelegatorsFile,
      delegationFile,
      reportsDir
    );
  }
}

/**
 * Processes data for a given chain:
 * 1. Loads non-delegators data (if available) and builds a combined distribution.
 * 2. Merges in delegation-based distributions (if available).
 * 3. (For curve only on Mainnet) Reads forwarders' voted rewards from the weekly-bounties folder and adds them.
 * 4. Loads previous Merkle data from the previous week period folder (for this gauge type).
 * 5. Generates a new Merkle tree and saves it.
 * 6. Stores the resulting Merkle in the global merkleDataByChain structure.
 *
 * @param gaugeType - The gauge type ("curve" or "fxn")
 * @param chainId - The chain identifier (e.g. "1", "42161")
 * @param nonDelegatorsFilePath - Path to the non-delegators JSON file for the chain.
 * @param delegationFilePath - Path to the delegation JSON file for the chain.
 * @param reportsDir - The base directory for the current gauge type reports.
 */
function processChain(
  gaugeType: string,
  chainId: string,
  nonDelegatorsFilePath: string,
  delegationFilePath: string,
  reportsDir: string
) {
  console.log(`\nProcessing chain ${chainId} for gauge type "${gaugeType}"...`);

  const combined: {
    [address: string]: { tokens: { [token: string]: bigint } };
  } = {};

  // 1. Load non-delegators data (if the file exists)
  if (fs.existsSync(nonDelegatorsFilePath)) {
    const nonDelegatorsData = JSON.parse(
      fs.readFileSync(nonDelegatorsFilePath, "utf8")
    );
    const nonDelegators = nonDelegatorsData.distribution;
    for (const [address, data] of Object.entries(nonDelegators)) {
      const addr = address.toLowerCase();
      combined[addr] = { tokens: {} };
      if (data && typeof data === 'object' && 'tokens' in data) {
        const tokens = (data as any).tokens;
        for (const [token, amountStr] of Object.entries(tokens)) {
          combined[addr].tokens[token] = BigInt(amountStr as string);
        }
      }
    }
    console.log(`Loaded non-delegators data for chain ${chainId}`);
  } else {
    console.log(
      `No non-delegators file found for chain ${chainId}; continuing with delegation data only`
    );
  }

  // 2. Load delegation data (if available)
  let delegationSummary: any = null;
  if (fs.existsSync(delegationFilePath)) {
    const delegationData = JSON.parse(
      fs.readFileSync(delegationFilePath, "utf8")
    );
    delegationSummary = delegationData.distribution;
  } else {
    console.warn(
      `Delegation file not found for chain ${chainId}: ${delegationFilePath}. Using only non-delegators data.`
    );
  }

  // 3. Pay every raw-routed delegator its exact per-delegate attribution —
  // never a pool × scalar-share split. The "nonForwarders" ROUTE covers
  // non-forwarder delegators of every delegate AND the forwarders behind
  // non-Stake-DAO delegates (only Stake DAO delegates' forwarders settle
  // through the Tuesday pot). getExactGroupAmounts re-validates conservation
  // against totalPerGroup before returning, and refuses files without the
  // perDelegate section (pre-cutover periods must be regenerated first).
  if (delegationSummary) {
    if (!hasPerDelegateAttribution(delegationSummary)) {
      throw new Error(
        `Delegation file for chain ${chainId} has no perDelegate attribution ` +
          `(pre-cutover format?) — regenerate the repartition before building merkles`
      );
    }
    const exactRawRouted = getExactGroupAmounts(
      delegationSummary,
      "nonForwarders"
    );
    let walletCount = 0;
    for (const [address, tokens] of Object.entries(exactRawRouted)) {
      const addr = address.toLowerCase();
      if (!combined[addr]) {
        combined[addr] = { tokens: {} };
      }
      for (const [token, amount] of Object.entries(tokens)) {
        if (amount === 0n) continue;
        combined[addr].tokens[token] =
          (combined[addr].tokens[token] || 0n) + amount;
      }
      walletCount++;
    }
    console.log(
      `Chain ${chainId}: ${walletCount} raw-routed delegator wallet(s) paid ` +
        `their per-delegate amounts`
    );
  }

  // 3b. (Curve mainnet merkle, claim weeks only) Pay the individually
  // attributed Votium forwarder legs as RAW TOKEN leaves. The attribution
  // file only ever lists individual legs — own votes (including Stake DAO
  // delegators who voted themselves) and slices of non-Stake-DAO delegates'
  // votes; pooled legs settle through the Tuesday delegators pot. The paid
  // totals are also staged as a withdrawal instruction: the Thursday batch
  // funds them with a dedicated votium-vault → voters-distributor withdraw,
  // and the votium swap job sweeps only the remainder for the Tuesday pot.
  // Runs BEFORE the empty guard: its crash-window checks must fire even on a
  // week with no VotemarketV2 distributions at all.
  if (gaugeType === "curve" && chainId === "1") {
    applyVotiumRawLeaves(combined, reportsDir);
  }

  if (Object.keys(combined).length === 0) {
    console.log(`No distributions to process for chain ${chainId}`);
    return;
  }

  currentDistributionByChain[chainId][gaugeType as "curve" | "fxn"] = combined;

  // 4. Load the newest prior per-gauge artifact, however old it is.
  const merkleFileName =
    chainId === "1"
      ? "merkle_data_non_delegators.json"
      : `merkle_data_non_delegators_${chainId}.json`;
  const relPath = path.join("vlCVX", gaugeType, merkleFileName);
  const { data: previousMerkleData, foundAt } = findPreviousMerkle(
    currentPeriodTimestamp,
    relPath
  );
  if (foundAt) {
    console.log(`Loaded previous merkle data for chain ${chainId} from ${foundAt}`);
  } else {
    console.log(`No previous merkle data found for chain ${chainId} (${relPath})`);
  }
  previousMerkleDataByChain[chainId][gaugeType as "curve" | "fxn"] =
    previousMerkleData;

  // 5. Generate the new Merkle tree
  const currentDistribution = { distribution: combined };
  const universalMerkle = createCombineDistribution(
    currentDistribution,
    previousMerkleData
  );
  const newMerkleData: MerkleData = generateMerkleTree(universalMerkle);
  console.log(`Merkle Root for chain ${chainId}:`, newMerkleData.merkleRoot);

  // 6. Save the new Merkle data to the same reports directory
  const outputName =
    chainId === "1"
      ? "merkle_data_non_delegators.json"
      : `merkle_data_non_delegators_${chainId}.json`;
  const outputPath = path.join(reportsDir, outputName);
  fs.writeFileSync(outputPath, JSON.stringify(newMerkleData, null, 2));
  console.log(
    `Merkle tree for chain ${chainId} generated and saved as ${outputName}`
  );

  // 7. Store the merkle data in the global structure
  if (merkleDataByChain[chainId]) {
    merkleDataByChain[chainId][gaugeType as "curve" | "fxn"] = newMerkleData;
    console.log(
      `Stored ${gaugeType} merkle data for chain ${chainId} in global structure`
    );
  }

  (async () => {
    const platform =
      gaugeType === "fxn"
        ? CVX_GAUGE_VOTE_PLATFORM_FXN
        : CVX_GAUGE_VOTE_PLATFORM_CURVE;
    const client = await getClient(1);
    // Pin the proposal to the period whose merkle was just generated, so a
    // late re-run cannot verify the next round against this period's files.
    const proposal = await getOnChainProposal(platform, CVX_SPACE, client, {
      targetPeriod: currentPeriodTimestamp,
    });
    const votes = await getOnChainVoters(
      platform,
      Number(proposal.id),
      proposal,
      client
    );
    console.log("on-chain proposalId", proposal.id);
    distributionVerifier(
      CVX_SPACE,
      mainnet,
      VOTERS_DISTRIBUTOR,
      newMerkleData,
      previousMerkleData,
      currentDistribution.distribution,
      proposal.id,
      undefined,
      { proposal, votes }
    );
  })().catch(console.error);
}

/**
 * Pays the individually attributed Votium forwarder legs as raw token leaves
 * (claim weeks only) and records the matching ops withdrawal instruction.
 *
 * Crash-window guards mirror both directions: claims without an attribution
 * file mean generateConvexVotium died mid-write — refuse rather than silently
 * fold real forwarder money into the pool; an attribution without claims
 * means nothing was realized — refuse rather than pay unbacked leaves.
 */
function applyVotiumRawLeaves(
  combined: { [address: string]: { tokens: { [token: string]: bigint } } },
  reportsDir: string
) {
  const votiumDir = path.join(
    "weekly-bounties",
    currentPeriodTimestamp.toString(),
    "votium"
  );
  const claimsFile = path.join(votiumDir, "claimed_bounties_convex.json");
  const attributionFile = path.join(votiumDir, "forwarders_voted_rewards.json");
  const logFilePath = path.join(reportsDir, "votium_forwarders_log.json");

  // A FORCE_UPDATE re-run must not leave a stale withdrawal instruction
  // describing leaves that no longer exist. The fresh instruction is staged
  // here and written by main() only after every merkle output landed.
  fs.rmSync(votiumWithdrawalPath(), { force: true });

  // Invariant: on a biweekly claim period the claims data must EXIST (it may
  // record zero claims, but its absence means the convex-votium claims job
  // never ran — 2026-08-20 incident: the update-votium-claims dispatch was
  // dropped, the merkle silently omitted the votium raw leaves and the
  // Thursday batch skipped the vault withdraw). Absence is only a valid
  // "no claim this period" signal on non-claim (even) weeks.
  if (!fs.existsSync(claimsFile) && isVotiumClaimPeriod(currentPeriodTimestamp)) {
    throw new Error(
      `Period ${currentPeriodTimestamp} is a Votium claim week but ` +
        `${claimsFile} is missing — the convex-votium claims job has not run ` +
        `for this period. Dispatch claims.yaml with platform=convex-votium ` +
        `(past_week=1 when running on/after Thursday) before generating ` +
        `this merkle.`
    );
  }

  const claims: unknown = fs.existsSync(claimsFile)
    ? JSON.parse(fs.readFileSync(claimsFile, "utf8"))
    : null;
  const hasClaims = claims !== null && hasClaimedVotiumBounties(claims);

  if (!fs.existsSync(attributionFile)) {
    if (hasClaims) {
      throw new Error(
        `Votium bounties were claimed this period but the forwarder ` +
          `attribution file is missing: ${attributionFile}. Refusing to fold ` +
          `forwarder value into the delegators pool.`
      );
    }
    fs.writeFileSync(
      logFilePath,
      JSON.stringify(
        {
          timestamp: currentPeriodTimestamp,
          message:
            "No Votium claim this period — no raw Votium leaves in this merkle",
        },
        null,
        2
      )
    );
    return;
  }

  const forwardersData = JSON.parse(fs.readFileSync(attributionFile, "utf8"));
  const tokenAllocations = forwardersData.tokenAllocations ?? {};

  if (!hasClaims) {
    if (Object.keys(tokenAllocations).length > 0) {
      throw new Error(
        `Votium forwarder attribution exists without claimed bounties: ` +
          `${attributionFile}. Refusing to pay unbacked raw leaves.`
      );
    }
    fs.writeFileSync(
      logFilePath,
      JSON.stringify(
        {
          timestamp: currentPeriodTimestamp,
          message:
            "Votium attribution present but empty and nothing claimed — no raw Votium leaves",
        },
        null,
        2
      )
    );
    return;
  }

  const raw = computeVotiumRawPayouts({
    claimedBounties: claims,
    minimumPayoutUsd: MIN_VOTIUM_RAW_PAYOUT_USD,
    tokenAllocations,
  });

  let paidWallets = 0;
  for (const [address, tokens] of Object.entries(raw.payouts)) {
    const addr = address.toLowerCase();
    if (!combined[addr]) combined[addr] = { tokens: {} };
    for (const [token, amount] of Object.entries(tokens)) {
      if (amount === 0n) continue;
      combined[addr].tokens[token] =
        (combined[addr].tokens[token] || 0n) + amount;
    }
    paidWallets++;
  }

  const totalsAsStrings = Object.fromEntries(
    Object.entries(raw.totalsPerToken).map(([token, amount]) => [
      token,
      amount.toString(),
    ])
  );

  console.log(
    `\n💰 Votium raw leaves: ${paidWallets} forwarder(s) paid in this merkle` +
      (raw.belowFloor.length
        ? `; ${raw.belowFloor.length} below the $${MIN_VOTIUM_RAW_PAYOUT_USD} floor stay with the pool`
        : "")
  );
  for (const [token, total] of Object.entries(raw.totalsPerToken)) {
    console.log(`   • ${token}: ${total.toString()} wei`);
  }

  fs.writeFileSync(
    logFilePath,
    JSON.stringify(
      {
        timestamp: currentPeriodTimestamp,
        message:
          "Individually attributed Votium forwarder legs are paid as raw token " +
          "leaves in this combined merkle; Stake DAO-pooled legs settle through " +
          "the Tuesday delegators pot",
        forwardersData,
        totalRewardsPaid: totalsAsStrings,
        addressesPaid: Object.keys(raw.payouts),
        belowFloor: raw.belowFloor,
      },
      null,
      2
    )
  );

  if (Object.keys(raw.totalsPerToken).length > 0) {
    // Ops contract: the tokens sit on the Votium vault (the claim recipient).
    // The Thursday batch must carry a dedicated votium-vault →
    // voters-distributor withdraw of EXACTLY these amounts, and the votium
    // swap job must only sweep the remainder into sCRVUSD for the Tuesday
    // pot. withdraw() is caller-gated (AllMight V2 is allowed) — the
    // destination needs no allowlisting.
    pendingVotiumWithdrawal = {
      period: currentPeriodTimestamp,
      source: VOTIUM_FORWARDER,
      destination: VOTERS_DISTRIBUTOR,
      fundingLeg:
        "dedicated votium-vault → voters-distributor withdraw in the Thursday batch",
      tokens: totalsAsStrings,
    };
  }
}
