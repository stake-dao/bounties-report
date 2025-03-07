import { Chain, createPublicClient, http, parseAbi } from "viem";
import { Distribution } from "../interfaces/Distribution";
import { DistributionRow } from "../interfaces/DistributionRow";
import { MerkleData } from "../interfaces/MerkleData";
import { formatAddress } from "./address";
import {
  delegationLogger,
  proposalInformationLogger,
} from "./delegationHelper";
import { getLastClosedProposal, getVoters } from "./snapshot";
import fs from "fs";
import path from "path";

const merkleAbi = parseAbi([
  "function claimed(address,address) external view returns(uint256)",
]);

const setupLogging = (proposalId: string): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDir = path.join(process.cwd(), "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  return path.join(tempDir, `proposal-${proposalId}-${timestamp}.log`);
};

export const distributionVerifier = async (
  space: string,
  merkleChain: Chain,
  merkleAddress: `0x${string}`,
  currentMerkleFile: string,
  previousMerkleFile: string,
  repartitionFile: string
) => {
  let merkleData: MerkleData = { merkleRoot: "", claims: {} };
  let previousMerkleData: MerkleData = { merkleRoot: "", claims: {} };

  if (fs.existsSync(currentMerkleFile)) {
    merkleData = JSON.parse(fs.readFileSync(currentMerkleFile, "utf-8"));
  }
  if (fs.existsSync(previousMerkleFile)) {
    previousMerkleData = JSON.parse(
      fs.readFileSync(previousMerkleFile, "utf-8")
    );
  }

  const currentDistribution: { distribution: Distribution } = JSON.parse(
    fs.readFileSync(repartitionFile, "utf-8")
  );

  const addressCount = Object.keys(currentDistribution.distribution).length;
  console.log(`Current Distribution has ${addressCount} addresses.`);
  const tokenSums: { [token: string]: bigint } = {};
  for (const data of Object.values(currentDistribution.distribution)) {
    for (const [token, amountStr] of Object.entries(data.tokens)) {
      tokenSums[token] = (tokenSums[token] || 0n) + BigInt(amountStr);
    }
  }
  console.log("Token totals in current distribution:");
  for (const [token, sum] of Object.entries(tokenSums)) {
    console.log(`${token}: ${sum.toString()}`);
  }

  const proposal = await getLastClosedProposal(space);
  const votes = await getVoters(proposal.id);
  const logPath = setupLogging(proposal.id);
  const log = (message: string) => {
    fs.appendFileSync(logPath, `${message}\n`);
    console.log(message);
  };

  proposalInformationLogger(space, proposal, log);
  log("\n=== Delegation Information ===");
  await delegationLogger(space, proposal, votes, log);
  log(`\nTotal Votes: ${votes.length}`);
  log(`\nHolder Distribution:`);

  const comparisonRows = await compareMerkleData(
    merkleData,
    previousMerkleData,
    currentDistribution.distribution,
    merkleChain,
    merkleAddress
  );
  logDistributionRowsToFile(comparisonRows, log);

  // Optionally, send additional data to Telegram here.
};

const compareMerkleData = async (
  currentMerkleData: MerkleData,
  previousMerkleData: MerkleData,
  distribution: Distribution,
  chain: Chain,
  merkleAddress: `0x${string}`
): Promise<DistributionRow[]> => {
  const client = createPublicClient({
    chain,
    transport: http(),
  });

  const calls: any[] = [];
  const addressMapping: Array<{ address: string; tokenAddress: string }> = [];

  for (const address in currentMerkleData.claims) {
    const currentClaims = currentMerkleData.claims[address];
    for (const tokenAddress in currentClaims.tokens) {
      calls.push({
        address: merkleAddress,
        abi: merkleAbi,
        functionName: "claimed",
        args: [address, tokenAddress],
      });
      addressMapping.push({ address, tokenAddress });
    }
  }

  // Execute multicall
  const results = await client.multicall({
    contracts: calls,
  });

  const distributionRows: DistributionRow[] = [];

  // Parcourt tous les addresses du MerkleData actuel
  for (const address in currentMerkleData.claims) {
    const currentClaims = currentMerkleData.claims[address];
    const previousClaims = previousMerkleData.claims[address] || { tokens: {} };

    // Parcourt tous les tokens pour cette adresse
    for (const tokenAddress in currentClaims.tokens) {
      const currentTokenClaim = currentClaims.tokens[tokenAddress];
      const previousTokenClaim = previousClaims.tokens[tokenAddress] || {
        amount: "0",
      };

      const previousClaim = BigInt(previousTokenClaim.amount || "0");
      const weekChange = BigInt(currentTokenClaim.amount) - previousClaim;

      let distributionAmount = BigInt(0);
      const distributionUser = Object.keys(distribution).find(
        (user) => user.toLowerCase() === address.toLowerCase()
      );
      if (distributionUser) {
        const distributionToken = Object.keys(
          distribution[distributionUser].tokens
        ).find((token) => token.toLowerCase() === tokenAddress.toLowerCase());
        if (distributionToken) {
          distributionAmount = BigInt(
            distribution[distributionUser].tokens[distributionToken]
          );
        }
      }

      const isAmountDifferent =
        distributionAmount !== BigInt(currentTokenClaim.amount) - previousClaim;
      const claimedAmount = BigInt((results.shift()?.result as bigint) || "0");

      const row: DistributionRow = {
        address,
        tokenAddress,
        prevAmount: previousClaim,
        newAmount: BigInt(currentTokenClaim.amount),
        weekChange,
        distributionAmount,
        claimed: claimedAmount === previousClaim,
        isError: isAmountDifferent,
      };

      distributionRows.push(row);
    }
  }

  return distributionRows;
};

const logDistributionRowsToFile = (
  distributionRows: DistributionRow[],
  log: (message: string) => void
) => {
  const headers = [
    "Address",
    "Token Address",
    "Previous Amount",
    "New Amount",
    "Week Change",
    "Distribution Amount",
    "Claimed",
    "Distribution correct",
  ];

  const rows = distributionRows.map((row) => [
    formatAddress(row.address),
    formatAddress(row.tokenAddress),
    row.prevAmount.toString(),
    row.newAmount.toString(),
    row.weekChange.toString(),
    row.distributionAmount.toString(),
    row.claimed ? `✅` : `❌`,
    row.isError ? `❌` : `✅`,
  ]);

  const columnWidths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const headerLine = headers
    .map((header, index) => header.padEnd(columnWidths[index]))
    .join(" | ");

  const separatorLine = columnWidths
    .map((width) => "-".repeat(width))
    .join("-|-");

  const formattedRows = rows.map((row) =>
    row.map((cell, index) => cell.padEnd(columnWidths[index])).join(" | ")
  );

  const fileContent = [headerLine, separatorLine, ...formattedRows].join("\n");

  log(fileContent + "\n\n");
};
