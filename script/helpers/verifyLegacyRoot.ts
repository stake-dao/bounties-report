import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getClient } from "../utils/getClients";

const MERKLE_ABI = [
  {
    name: "merkleRoot",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ROOT_PATTERN = /^0x[0-9a-fA-F]{64}$/;

type LegacyRootStatus = "OK" | "WAITING" | "BLOCK";

interface LegacyRootStatusInput {
  source: string;
  onchain: string;
}

interface LegacyMerkleEntry {
  symbol?: unknown;
  address?: unknown;
  root?: unknown;
  chainId?: unknown;
  merkleContract?: unknown;
}

export function classifyLegacyRootStatus(
  input: LegacyRootStatusInput,
): LegacyRootStatus {
  const source = input.source.toLowerCase();
  const onchain = input.onchain.toLowerCase();

  if (source === onchain) return "OK";
  if (onchain === ZERO_ROOT) return "WAITING";
  return "BLOCK";
}

interface RootReader {
  readContract(args: {
    address: `0x${string}`;
    abi: typeof MERKLE_ABI;
    functionName: "merkleRoot";
    args: readonly [`0x${string}`];
  }): Promise<unknown>;
}

export interface LegacyRetirement {
  chainId: number;
  token: string;
  merkleContract: string;
  retiredRoot: string;
  replacementRoot: string;
  transactionHash: string;
}

// Confirmed expiries of whole legacy trees, each tied to its recovery transaction. Reviewed
// as a funds change: a listed tree leaves the carry-over and the V3 continuity check.
const RETIREMENTS_PATH = path.join(__dirname, "..", "..", "data", "retired-legacy-merkles.json");
let legacyRetirements: LegacyRetirement[] | undefined;
const loadLegacyRetirements = (): LegacyRetirement[] =>
  (legacyRetirements ??= JSON.parse(readFileSync(RETIREMENTS_PATH, "utf8")) as LegacyRetirement[]);

// A legacy entry is retired only when it is a recorded expiry (same chain, token, distributor
// and root as a registry record) AND the distributor still holds that record's replacement
// root. An unrecorded mismatch is not proof of expiry, so it returns false and the publish
// gate keeps blocking on it.
export async function isRetiredLegacyEntry(
  client: RootReader,
  entry: LegacyMerkleEntry,
  retirements: LegacyRetirement[] = loadLegacyRetirements(),
): Promise<boolean> {
  if (
    typeof entry.root !== "string" ||
    !ROOT_PATTERN.test(entry.root) ||
    typeof entry.address !== "string" ||
    typeof entry.merkleContract !== "string"
  ) {
    return false;
  }
  const chainId = typeof entry.chainId === "number" ? entry.chainId : 1;
  const record = retirements.find(
    (r) =>
      r.chainId === chainId &&
      r.token.toLowerCase() === (entry.address as string).toLowerCase() &&
      r.merkleContract.toLowerCase() === (entry.merkleContract as string).toLowerCase() &&
      r.retiredRoot.toLowerCase() === (entry.root as string).toLowerCase(),
  );
  if (!record) return false;
  const onchain = await client.readContract({
    address: entry.merkleContract as `0x${string}`,
    abi: MERKLE_ABI,
    functionName: "merkleRoot",
    args: [entry.address as `0x${string}`],
  });
  if (typeof onchain !== "string" || !ROOT_PATTERN.test(onchain)) {
    throw new Error(`invalid on-chain root for ${entry.address}: ${String(onchain)}`);
  }
  return onchain.toLowerCase() === record.replacementRoot.toLowerCase();
}

function emitOutput(key: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${key}=${value}\n`);
}

function parsePeriod(): number {
  const args = process.argv.slice(2);
  const periodIndex = args.indexOf("--period");
  const rawPeriod = periodIndex >= 0 ? args[periodIndex + 1] : undefined;
  const period = Number(rawPeriod);

  if (!rawPeriod || !Number.isInteger(period) || period <= 0) {
    throw new Error("Usage: verifyLegacyRoot --period <timestamp>");
  }
  return period;
}

function parseEthereumEntries(filePath: string): LegacyMerkleEntry[] {
  if (!existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }

  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected an array in ${filePath}`);
  }

  return (parsed as LegacyMerkleEntry[]).filter(
    (entry) => entry.chainId === 1,
  );
}

async function main(): Promise<void> {
  let period: number;
  let entries: LegacyMerkleEntry[];
  try {
    period = parsePeriod();
    entries = parseEthereumEntries(
      path.join("bounties-reports", String(period), "merkle.json"),
    );
    if (entries.length === 0) {
      throw new Error(`No Ethereum entries found for period ${period}`);
    }
  } catch (error) {
    emitOutput("skip", "false");
    console.error(`[BLOCK] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Verifying legacy Ethereum roots for period=${period}`);
  let hasBlock = false;
  let hasWaiting = false;

  for (const entry of entries) {
    const label = typeof entry.symbol === "string" ? entry.symbol : "unknown";
    try {
      if (typeof entry.address !== "string" || !ADDRESS_PATTERN.test(entry.address)) {
        throw new Error("invalid or missing token address");
      }
      if (typeof entry.root !== "string" || !ROOT_PATTERN.test(entry.root)) {
        throw new Error("invalid or missing source root");
      }
      if (
        typeof entry.merkleContract !== "string" ||
        !ADDRESS_PATTERN.test(entry.merkleContract)
      ) {
        throw new Error("invalid or missing merkleContract");
      }

      const client = await getClient(1);
      const onchain = await client.readContract({
        address: entry.merkleContract as `0x${string}`,
        abi: MERKLE_ABI,
        functionName: "merkleRoot",
        args: [entry.address as `0x${string}`],
      });
      if (typeof onchain !== "string" || !ROOT_PATTERN.test(onchain)) {
        throw new Error(`invalid on-chain root: ${String(onchain)}`);
      }

      const status = classifyLegacyRootStatus({
        source: entry.root,
        onchain,
      });
      console.log(`[${status}] ${label} token=${entry.address}`);
      console.log(`   source  : ${entry.root.toLowerCase()}`);
      console.log(`   on-chain: ${onchain.toLowerCase()}`);

      if (status === "BLOCK") hasBlock = true;
      if (status === "WAITING") hasWaiting = true;
    } catch (error) {
      hasBlock = true;
      console.error(
        `[BLOCK] ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (hasBlock) {
    emitOutput("skip", "false");
    console.error("\nLegacy publish blocked — see failures above.");
    process.exitCode = 1;
    return;
  }
  if (hasWaiting) {
    emitOutput("skip", "true");
    console.log("\nLegacy roots are still frozen. Skipping publish.");
    return;
  }

  emitOutput("skip", "false");
  console.log("\nAll legacy on-chain roots match. Safe to publish.");
}

if (require.main === module) {
  main().catch((error) => {
    emitOutput("skip", "false");
    console.error(error);
    process.exit(1);
  });
}
