import fs from "fs";
import path from "path";
import { getAddress } from "viem";
import { generateMerkleTree, mergeMerkleData } from "../../shared/merkle/generateMerkleTree";
import { MerkleData } from "../../interfaces/MerkleData";
import { UniversalMerkle } from "../../interfaces/UniversalMerkle";
import {
  CVX_SPACE,
  DELEGATION_ADDRESS,
  WEEK,
} from "../../utils/constants";
import {
  fetchLastProposalsIds,
  getProposal,
  getVoters,
  getVotingPower,
} from "../../utils/snapshot";
import { processAllDelegators } from "../../utils/cacheUtils";
import { getBlockNumberByTimestamp } from "../../utils/chainUtils";
import { getForwardedDelegators } from "../../utils/delegationHelper";
import { VOTIUM_FORWARDER } from "../../utils/constants";
import { getClient } from "../../utils/getClients";

// =============================================================================
// TYPES
// =============================================================================

export type RecipientSource =
  | { type: "manual"; addresses: string[] }
  | { type: "delegators"; filter?: "all" | "forwarders" | "nonForwarders" }
  | { type: "snapshot"; proposalId: string; voterFilter?: (voter: any) => boolean };

export type AmountDistribution =
  | { type: "equal" }
  | { type: "proportional"; weights: { [address: string]: number } }
  | { type: "byVotingPower" }
  | { type: "custom"; amounts: { [address: string]: bigint } };

export interface TokenAllocation {
  token: string;
  totalAmount: bigint;
  distribution: AmountDistribution;
}

export interface PersonalizedDistributionConfig {
  // Where to get recipients from
  recipientSource: RecipientSource;

  // Token allocations (supports multiple tokens)
  tokens: TokenAllocation[];

  // Snapshot context (required for delegator-based sources)
  snapshot?: {
    space?: string;
    periodTimestamp?: number;
    proposalId?: string;
  };

  // Output options
  output?: {
    path?: string;
    mergeWithExisting?: string;
  };
}

export interface DistributionResult {
  merkleData: MerkleData;
  summary: {
    recipients: number;
    tokens: {
      [token: string]: {
        total: string;
        distributed: string;
      };
    };
  };
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

export async function createPersonalizedDistribution(
  config: PersonalizedDistributionConfig
): Promise<DistributionResult> {
  console.log("\n========================================");
  console.log("Creating Personalized Distribution");
  console.log("========================================\n");

  // 1. Get recipients based on source
  const recipients = await getRecipients(config);
  console.log(`Found ${recipients.length} recipients`);

  if (recipients.length === 0) {
    throw new Error("No recipients found");
  }

  // 2. Build distribution for each token
  const distribution: UniversalMerkle = {};

  for (const tokenAlloc of config.tokens) {
    console.log(`\nProcessing token: ${tokenAlloc.token}`);
    console.log(`Total amount: ${tokenAlloc.totalAmount.toString()}`);

    const tokenDistribution = await distributeToken(
      tokenAlloc,
      recipients,
      config
    );

    // Merge into main distribution
    for (const [address, amount] of Object.entries(tokenDistribution)) {
      const normalizedAddress = getAddress(address);
      const normalizedToken = getAddress(tokenAlloc.token);

      if (!distribution[normalizedAddress]) {
        distribution[normalizedAddress] = {};
      }
      distribution[normalizedAddress][normalizedToken] = amount.toString();
    }
  }

  // 3. Generate merkle tree
  let merkleData = generateMerkleTree(distribution);
  console.log(`\nGenerated merkle root: ${merkleData.merkleRoot}`);

  // 4. Optionally merge with existing merkle
  if (config.output?.mergeWithExisting) {
    if (fs.existsSync(config.output.mergeWithExisting)) {
      console.log(`\nMerging with existing merkle: ${config.output.mergeWithExisting}`);
      const existingMerkle: MerkleData = JSON.parse(
        fs.readFileSync(config.output.mergeWithExisting, "utf8")
      );
      merkleData = mergeMerkleData(existingMerkle, merkleData);
      console.log(`New merged merkle root: ${merkleData.merkleRoot}`);
    } else {
      console.warn(`Warning: Existing merkle not found at ${config.output.mergeWithExisting}`);
    }
  }

  // 5. Save if output path specified
  if (config.output?.path) {
    const outputDir = path.dirname(config.output.path);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(config.output.path, JSON.stringify(merkleData, null, 2));
    console.log(`\nSaved merkle to: ${config.output.path}`);
  }

  // 6. Build summary
  const summary = buildSummary(distribution, config.tokens);

  return { merkleData, summary };
}

// =============================================================================
// RECIPIENT SOURCES
// =============================================================================

async function getRecipients(
  config: PersonalizedDistributionConfig
): Promise<string[]> {
  const source = config.recipientSource;

  switch (source.type) {
    case "manual":
      return source.addresses.map((a) => getAddress(a));

    case "delegators":
      return await getDelegators(config, source.filter);

    case "snapshot":
      return await getSnapshotVoters(source.proposalId, source.voterFilter);

    default:
      throw new Error(`Unknown recipient source type`);
  }
}

async function getDelegators(
  config: PersonalizedDistributionConfig,
  filter?: "all" | "forwarders" | "nonForwarders"
): Promise<string[]> {
  const space = config.snapshot?.space || CVX_SPACE;
  const periodTimestamp =
    config.snapshot?.periodTimestamp ||
    Math.floor(Date.now() / 1000 / WEEK) * WEEK;

  console.log(`Fetching delegators for space: ${space}, period: ${periodTimestamp}`);

  // Get proposal for this period
  const now = Math.floor(Date.now() / 1000);
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [space],
    now,
    "^(?!FXN ).*Gauge Weight for Week of"
  );
  const proposalId = config.snapshot?.proposalId || proposalIdPerSpace[space];
  const proposal = await getProposal(proposalId);

  console.log(`Using proposal: ${proposalId}`);

  // Get snapshot block timestamp
  const publicClient = await getClient(1);
  const block = await (publicClient as any).getBlock({
    blockNumber: BigInt(proposal.snapshot),
  });
  const snapshotBlockTimestamp = block.timestamp;

  // Get all delegators
  const allDelegators = await processAllDelegators(
    space,
    Number(snapshotBlockTimestamp),
    DELEGATION_ADDRESS
  );

  // Get voters to exclude delegators who voted directly
  const votes = await getVoters(proposalId);
  const directVoters = new Set(votes.map((v: any) => v.voter.toLowerCase()));

  let delegators = allDelegators.filter(
    (d) => !directVoters.has(d.toLowerCase())
  );

  console.log(`Found ${delegators.length} delegators (excluding direct voters)`);

  // Filter by forwarder status if needed
  if (filter && filter !== "all") {
    const blockSnapshotEnd = await getBlockNumberByTimestamp(
      proposal.end,
      "after",
      1
    );

    const forwardedStatuses = await getForwardedDelegators(
      delegators,
      blockSnapshotEnd
    );

    const forwarderSet = new Set<string>();
    const nonForwarderSet = new Set<string>();

    delegators.forEach((delegator, idx) => {
      const forwardedTo = forwardedStatuses[idx]?.toLowerCase();
      if (forwardedTo === VOTIUM_FORWARDER.toLowerCase()) {
        forwarderSet.add(delegator.toLowerCase());
      } else {
        nonForwarderSet.add(delegator.toLowerCase());
      }
    });

    if (filter === "forwarders") {
      delegators = delegators.filter((d) => forwarderSet.has(d.toLowerCase()));
      console.log(`Filtered to ${delegators.length} forwarders`);
    } else if (filter === "nonForwarders") {
      delegators = delegators.filter((d) => nonForwarderSet.has(d.toLowerCase()));
      console.log(`Filtered to ${delegators.length} non-forwarders`);
    }
  }

  return delegators.map((d) => getAddress(d));
}

async function getSnapshotVoters(
  proposalId: string,
  voterFilter?: (voter: any) => boolean
): Promise<string[]> {
  const votes = await getVoters(proposalId);
  let voters = votes;

  if (voterFilter) {
    voters = votes.filter(voterFilter);
  }

  return voters.map((v: any) => getAddress(v.voter));
}

// =============================================================================
// TOKEN DISTRIBUTION
// =============================================================================

async function distributeToken(
  tokenAlloc: TokenAllocation,
  recipients: string[],
  config: PersonalizedDistributionConfig
): Promise<{ [address: string]: bigint }> {
  const { totalAmount, distribution } = tokenAlloc;
  const result: { [address: string]: bigint } = {};

  switch (distribution.type) {
    case "equal":
      return distributeEqual(recipients, totalAmount);

    case "proportional":
      return distributeProportional(recipients, totalAmount, distribution.weights);

    case "byVotingPower":
      return await distributeByVotingPower(recipients, totalAmount, config);

    case "custom":
      return distributeCustom(recipients, distribution.amounts);

    default:
      throw new Error(`Unknown distribution type`);
  }
}

function distributeEqual(
  recipients: string[],
  totalAmount: bigint
): { [address: string]: bigint } {
  const result: { [address: string]: bigint } = {};
  const amountPerRecipient = totalAmount / BigInt(recipients.length);
  let distributed = 0n;

  for (let i = 0; i < recipients.length; i++) {
    const address = recipients[i];
    let amount: bigint;

    // Last recipient gets remainder
    if (i === recipients.length - 1) {
      amount = totalAmount - distributed;
    } else {
      amount = amountPerRecipient;
    }

    result[address] = amount;
    distributed += amount;
  }

  return result;
}

function distributeProportional(
  recipients: string[],
  totalAmount: bigint,
  weights: { [address: string]: number }
): { [address: string]: bigint } {
  const result: { [address: string]: bigint } = {};

  // Normalize weights for recipients only
  const recipientWeights: { [address: string]: number } = {};
  let totalWeight = 0;

  for (const recipient of recipients) {
    const normalizedRecipient = getAddress(recipient);
    // Find weight (case-insensitive)
    const weight = Object.entries(weights).find(
      ([addr]) => getAddress(addr) === normalizedRecipient
    )?.[1] || 0;

    recipientWeights[normalizedRecipient] = weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    throw new Error("Total weight is 0, cannot distribute proportionally");
  }

  // Distribute
  let distributed = 0n;
  const sortedRecipients = Object.keys(recipientWeights);

  for (let i = 0; i < sortedRecipients.length; i++) {
    const address = sortedRecipients[i];
    const weight = recipientWeights[address];
    let amount: bigint;

    // Last recipient gets remainder
    if (i === sortedRecipients.length - 1) {
      amount = totalAmount - distributed;
    } else {
      const share = weight / totalWeight;
      amount = BigInt(Math.floor(Number(totalAmount) * share));
    }

    if (amount > 0n) {
      result[address] = amount;
      distributed += amount;
    }
  }

  return result;
}

async function distributeByVotingPower(
  recipients: string[],
  totalAmount: bigint,
  config: PersonalizedDistributionConfig
): Promise<{ [address: string]: bigint }> {
  const space = config.snapshot?.space || CVX_SPACE;

  // Get proposal
  const now = Math.floor(Date.now() / 1000);
  const proposalIdPerSpace = await fetchLastProposalsIds(
    [space],
    now,
    "^(?!FXN ).*Gauge Weight for Week of"
  );
  const proposalId = config.snapshot?.proposalId || proposalIdPerSpace[space];
  const proposal = await getProposal(proposalId);

  console.log("Fetching voting power for recipients...");

  // Get voting power
  const votingPowers = await getVotingPower(proposal, recipients);

  // Convert to weights
  const weights: { [address: string]: number } = {};
  for (const recipient of recipients) {
    weights[recipient] = votingPowers[recipient] || 0;
  }

  return distributeProportional(recipients, totalAmount, weights);
}

function distributeCustom(
  recipients: string[],
  amounts: { [address: string]: bigint }
): { [address: string]: bigint } {
  const result: { [address: string]: bigint } = {};

  for (const recipient of recipients) {
    const normalizedRecipient = getAddress(recipient);
    // Find amount (case-insensitive)
    const amount = Object.entries(amounts).find(
      ([addr]) => getAddress(addr) === normalizedRecipient
    )?.[1];

    if (amount && amount > 0n) {
      result[normalizedRecipient] = amount;
    }
  }

  return result;
}

// =============================================================================
// HELPERS
// =============================================================================

function buildSummary(
  distribution: UniversalMerkle,
  tokens: TokenAllocation[]
): DistributionResult["summary"] {
  const tokenSummary: {
    [token: string]: { total: string; distributed: string };
  } = {};

  for (const tokenAlloc of tokens) {
    const normalizedToken = getAddress(tokenAlloc.token);
    let distributed = 0n;

    for (const [, userTokens] of Object.entries(distribution)) {
      if (userTokens[normalizedToken]) {
        distributed += BigInt(userTokens[normalizedToken]);
      }
    }

    tokenSummary[normalizedToken] = {
      total: tokenAlloc.totalAmount.toString(),
      distributed: distributed.toString(),
    };
  }

  return {
    recipients: Object.keys(distribution).length,
    tokens: tokenSummary,
  };
}

// =============================================================================
// CLI EXAMPLE
// =============================================================================

async function main() {
  // Example 1: Equal distribution to specific addresses
  console.log("\n=== Example 1: Manual addresses, equal distribution ===");

  const result1 = await createPersonalizedDistribution({
    recipientSource: {
      type: "manual",
      addresses: [
        "0x1234567890123456789012345678901234567890",
        "0x2345678901234567890123456789012345678901",
        "0x3456789012345678901234567890123456789012",
      ],
    },
    tokens: [
      {
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
        totalAmount: BigInt(1000 * 1e6), // 1000 USDC
        distribution: { type: "equal" },
      },
    ],
    output: {
      path: "output/example1_merkle.json",
    },
  });

  console.log("\nSummary:", JSON.stringify(result1.summary, null, 2));

  // Example 2: Distribute to delegators by voting power
  // Uncomment to run (requires network calls)
  /*
  console.log("\n=== Example 2: Delegators (non-forwarders), by voting power ===");

  const result2 = await createPersonalizedDistribution({
    recipientSource: {
      type: "delegators",
      filter: "nonForwarders",
    },
    tokens: [
      {
        token: "0xD533a949740bb3306d119CC777fa900bA034cd52", // CRV
        totalAmount: BigInt("1000000000000000000000"), // 1000 CRV
        distribution: { type: "byVotingPower" },
      },
      {
        token: "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B", // CVX
        totalAmount: BigInt("500000000000000000000"), // 500 CVX
        distribution: { type: "byVotingPower" },
      },
    ],
    snapshot: {
      space: CVX_SPACE,
    },
    output: {
      path: "output/delegators_merkle.json",
      mergeWithExisting: "bounties-reports/1760572800/vlCVX/vlcvx_merkle.json",
    },
  });

  console.log("\nSummary:", JSON.stringify(result2.summary, null, 2));
  */
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
