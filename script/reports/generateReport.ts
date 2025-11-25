import fs from "fs";
import path from "path";
import { createPublicClient, http } from "viem";
import { mainnet } from "../utils/chains";
import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  getTimestampsBlocks,
  fetchSwapInEvents,
  fetchSwapOutEvents,
  PROTOCOLS_TOKENS,
  processSwapsOTC,
  aggregateBounties,
  collectAllTokens,
  fetchAllTokenInfos,
  processSwaps,
  escapeCSV,
  addGaugeNamesToBounties,
  getGaugesInfos,
  matchWethInWithRewardsOut,
  mapTokenSwapsToOutToken,
  fetchDelegationEvents,
  BOTMARKET,
} from "../utils/reportUtils";
import { ALL_MIGHT } from "../utils/reportUtils";
import { VLCVX_DELEGATORS_RECIPIENT, DELEGATION_RECIPIENT } from "../utils/constants";
import processReport from "./processReport";
import { debug, sampleArray, isDebugEnabled } from "../utils/logger";
import { WETH_CHAIN_IDS } from "../utils/constants";

dotenv.config();

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const WEEK = 604800;
const currentPeriod = Math.floor(Date.now() / 1000 / WEEK) * WEEK;

interface TxExclusionEntry {
  hash: string;
  note?: string;
  periods?: number[];
  startPeriod?: number;
  endPeriod?: number;
}

type TxExclusionConfig = Record<string, Array<string | TxExclusionEntry>>;

const DEFAULT_TX_EXCLUSION_FILE = path.join(
  PROJECT_ROOT,
  "data",
  "excluded-transactions.json"
);

interface ClaimedBounties {
  timestamp1: number;
  timestamp2: number;
  blockNumber1: number;
  blockNumber2: number;
  votemarket: Record<string, any>;
  votemarket_v2: Record<string, any>;
  warden: Record<string, any>;
  hiddenhand: Record<string, any>;
}

// Define raw tokens that should be distributed as-is without wrapping
const RAW_TOKENS = new Set([
  "0x4DF454443D6e9A888e9B1571B2375e8Ab4118d9d".toLowerCase(),
]);

function normalizeTxHash(hash: string): string | null {
  if (!hash) return null;
  const trimmed = hash.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (!normalized.startsWith("0x") || normalized.length !== 66) {
    return null;
  }
  return normalized;
}

function shouldApplyTxExclusion(entry: TxExclusionEntry, period: number): boolean {
  const normalizedPeriods =
    entry.periods?.map((value) => Number(value)).filter((value) => Number.isFinite(value)) || [];
  if (normalizedPeriods.length > 0 && !normalizedPeriods.includes(period)) {
    return false;
  }

  const startPeriod =
    typeof entry.startPeriod === "number" ? entry.startPeriod : undefined;
  if (typeof startPeriod === "number" && period < startPeriod) {
    return false;
  }

  const endPeriod =
    typeof entry.endPeriod === "number" ? entry.endPeriod : undefined;
  if (typeof endPeriod === "number" && period > endPeriod) {
    return false;
  }

  return true;
}

function extractTxHashes(
  entries: Array<string | TxExclusionEntry> | undefined,
  period: number
): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) =>
      typeof entry === "string"
        ? ({ hash: entry } as TxExclusionEntry)
        : entry
    )
    .filter(
      (entry): entry is TxExclusionEntry =>
        Boolean(entry && typeof entry.hash === "string")
    )
    .filter((entry) => shouldApplyTxExclusion(entry, period))
    .map((entry) => entry.hash);
}

function loadDefaultTxExclusions(protocol: string, period: number): string[] {
  if (!fs.existsSync(DEFAULT_TX_EXCLUSION_FILE)) return [];
  try {
    const raw = fs.readFileSync(DEFAULT_TX_EXCLUSION_FILE, "utf8");
    const parsed = JSON.parse(raw) as TxExclusionConfig;
    return extractTxHashes(parsed[protocol], period);
  } catch (error) {
    console.warn(
      `[tx-exclusions] Failed to parse ${DEFAULT_TX_EXCLUSION_FILE}`,
      error
    );
    return [];
  }
}

function parseTxOverridesFile(
  filePath: string,
  protocol: string,
  period: number
): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    if (!content) return [];
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return extractTxHashes(parsed as Array<string | TxExclusionEntry>, period);
      }
      if (typeof parsed === "object" && parsed !== null) {
        const maybeProtocol = (parsed as Record<string, any>)[protocol];
        if (Array.isArray(maybeProtocol)) {
          return extractTxHashes(
            maybeProtocol as Array<string | TxExclusionEntry>,
            period
          );
        }
      }
    } catch {
      // Not JSON, fall back to plain text parsing.
    }

    return content
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
      .flatMap((line) => line.split(","))
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  } catch (error) {
    console.warn(`[tx-exclusions] Failed to read ${filePath}`, error);
    return [];
  }
}

function parseInlineTxArgs(values?: unknown): string[] {
  if (!values) return [];
  const entries = Array.isArray(values) ? values : [values];
  return entries
    .flatMap((value) =>
      value
        .toString()
        .split(",")
        .map((segment) => segment.trim())
    )
    .filter((segment) => segment.length > 0);
}

function buildExcludedTxSet(options: {
  protocol: string;
  period: number;
  inlineTxs: string[];
  filePaths: string[];
  useDefaultFile: boolean;
}): Set<string> {
  const hashes: string[] = [];
  if (options.useDefaultFile) {
    hashes.push(...loadDefaultTxExclusions(options.protocol, options.period));
  }
  for (const filePath of options.filePaths) {
    hashes.push(...parseTxOverridesFile(filePath, options.protocol, options.period));
  }
  hashes.push(...options.inlineTxs);

  const normalized: string[] = [];
  const invalid: string[] = [];

  for (const hash of hashes) {
    const normalizedHash = normalizeTxHash(hash);
    if (normalizedHash) {
      normalized.push(normalizedHash);
    } else {
      invalid.push(hash);
    }
  }

  if (invalid.length > 0) {
    console.warn(
      "[tx-exclusions] Ignoring invalid transaction hashes:",
      invalid.join(", ")
    );
  }

  return new Set(normalized);
}

/**
 * Reads claimed bounties from JSON files and filters the v2 bounties.
 */
async function fetchBountiesData(
  currentPeriod: number
): Promise<ClaimedBounties> {
  const paths = {
    votemarket: `weekly-bounties/${currentPeriod}/votemarket/claimed_bounties.json`,
    votemarket_v2: `weekly-bounties/${currentPeriod}/votemarket-v2/claimed_bounties.json`,
    warden: `weekly-bounties/${currentPeriod}/warden/claimed_bounties.json`,
    hiddenhand: `weekly-bounties/${currentPeriod}/hiddenhand/claimed_bounties.json`,
  };

  const readJsonFile = (filePath: string) => {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      console.warn(`Warning: Could not read ${filePath}`, error);
      return {};
    }
  };

  const votemarket = readJsonFile(paths.votemarket);
  const votemarket_v2 = readJsonFile(paths.votemarket_v2);
  const warden = readJsonFile(paths.warden);
  const hiddenhand = readJsonFile(paths.hiddenhand);

  // Filter out v2 bounties that are explicitly unwrapped
  const filteredV2 = Object.entries(votemarket_v2).reduce(
    (acc, [key, value]: [string, any]) => {
      if (value.isWrapped !== false) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, any>
  );

  return {
    timestamp1: votemarket.timestamp1 || 0,
    timestamp2: votemarket.timestamp2 || 0,
    blockNumber1: votemarket.blockNumber1 || 0,
    blockNumber2: votemarket.blockNumber2 || 0,
    votemarket,
    votemarket_v2: filteredV2,
    warden,
    hiddenhand,
  };
}

/**
 * Separates raw token bounties from regular bounties
 */
function separateRawTokenBounties(bounties: Record<string, any>): {
  regular: Record<string, any>;
  raw: Record<string, any>;
} {
  const regular: Record<string, any> = {};
  const raw: Record<string, any> = {};

  for (const [protocol, protocolBounties] of Object.entries(bounties)) {
    regular[protocol] = {};
    raw[protocol] = {};

    for (const [key, bounty] of Object.entries(protocolBounties as Record<string, any>)) {
      if (bounty.rewardToken && RAW_TOKENS.has(bounty.rewardToken.toLowerCase())) {
        raw[protocol][key] = bounty;
      } else {
        regular[protocol][key] = bounty;
      }
    }
  }
  return { regular, raw };
}

/**
 * Processes raw token bounties into CSV format
 */
function processRawTokenBounties(
  rawBounties: Record<string, any>,
  tokenInfos: Record<string, any>,
  gaugesInfo?: Array<any>
): Record<string, Array<{
  gaugeName: string;
  gaugeAddress: string;
  rewardToken: string;
  rewardAddress: string;
  rewardAmount: number;
  rewardRawValue: number;
}>> {
  const result: Record<string, Array<any>> = {};

  for (const [protocol, protocolBounties] of Object.entries(rawBounties)) {
    if (!result[protocol]) {
      result[protocol] = [];
    }

    for (const bounty of Object.values(protocolBounties as Record<string, any>)) {
      const tokenInfo = tokenInfos[bounty.rewardToken.toLowerCase()];

      // Find gauge name and actual gauge address from gaugesInfo array
      let gaugeName = bounty.gauge;
      let gaugeAddress = bounty.gauge;
      if (gaugesInfo) {
        const gaugeInfo = gaugesInfo.find(
          (g: any) => g.address.toLowerCase() === bounty.gauge.toLowerCase()
        );
        if (gaugeInfo) {
          gaugeName = gaugeInfo.name;
          // If this bounty was claimed through a rootGauge, use the actual gauge address
          gaugeAddress = gaugeInfo.actualGauge || bounty.gauge;
        }
      }

      const amount = Number(bounty.amount) / Math.pow(10, tokenInfo?.decimals || 18);

      result[protocol].push({
        gaugeName,
        gaugeAddress,
        rewardToken: tokenInfo?.symbol || "UNKNOWN",
        rewardAddress: bounty.rewardToken,
        rewardAmount: amount,
        rewardRawValue: amount, // For raw tokens, the value is the same as the amount
      });
    }
  }

  return result;
}

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http("https://eth.llamarpc.com"),
});

async function main() {
  const argv = yargs<{
    protocol: string;
    excludeTx?: (string | number)[];
    excludeTxFile?: (string | number)[];
    noDefaultExclusions?: boolean;
  }>(hideBin(process.argv))
    .scriptName("generateReport")
    .usage("$0 <protocol> [options]")
    .command(
      "$0 <protocol>",
      "Generate a weekly sdToken report",
      (yargsBuilder) =>
        yargsBuilder.positional("protocol", {
          describe: "Protocol to process",
          type: "string",
          choices: ["curve", "balancer", "fxn", "frax", "pendle"],
        })
    )
    .option("excludeTx", {
      alias: ["exclude-tx", "x"],
      type: "array",
      string: true,
      describe:
        "Transaction hashes to exclude (repeat the flag or provide comma-separated values)",
    })
    .option("excludeTxFile", {
      alias: ["exclude-tx-file", "xf"],
      type: "array",
      string: true,
      describe:
        "Path to a file with transaction hashes to exclude (newline, comma-separated, or JSON)",
    })
    .option("noDefaultExclusions", {
      type: "boolean",
      default: false,
      describe: `Ignore ${DEFAULT_TX_EXCLUSION_FILE} when building the exclusion list`,
    })
    .alias("noDefaultExclusions", "no-default-exclusions")
    .help()
    .strict()
    .parseSync();

  const protocol = argv.protocol;
  const inlineExcludedTxs = parseInlineTxArgs(argv.excludeTx);
  const excludeTxFilesRaw = (argv.excludeTxFile || []) as (string | number)[];
  const excludeTxFiles = excludeTxFilesRaw.map((value) =>
    path.resolve(value.toString())
  );
  const excludedTxHashes = buildExcludedTxSet({
    protocol,
    period: currentPeriod,
    inlineTxs: inlineExcludedTxs,
    filePaths: excludeTxFiles,
    useDefaultFile: !argv.noDefaultExclusions,
  });

  if (excludedTxHashes.size > 0) {
    console.log(
      `Excluding ${excludedTxHashes.size} transaction(s) for ${protocol} computations`
    );
    if (isDebugEnabled()) {
      debug("[tx-exclusions] hashes", Array.from(excludedTxHashes));
    }
  }

  // Get block numbers and timestamps (timestamps are not used later)
  const { blockNumber1, blockNumber2 } = await getTimestampsBlocks(
    publicClient,
    0
  );

  const totalBounties = await fetchBountiesData(currentPeriod);
  if (isDebugEnabled()) {
    const protocolsForDebug = ["curve", "balancer", "fxn", "frax", "pendle"];
    const countSource = (src: Record<string, any>) =>
      Object.fromEntries(
        protocolsForDebug.map((p) => [
          p,
          src?.[p] ? Object.keys(src[p]).length : 0,
        ])
      );
    debug("[bounties] timestamps", {
      currentPeriod,
      blockNumber1,
      blockNumber2,
      timestamp1: totalBounties.timestamp1,
      timestamp2: totalBounties.timestamp2,
    });
    debug("[bounties] counts per source", {
      votemarket: countSource(totalBounties.votemarket || {}),
      votemarket_v2: countSource(totalBounties.votemarket_v2 || {}),
      warden: countSource(totalBounties.warden || {}),
      hiddenhand: countSource(totalBounties.hiddenhand || {}),
    });
  }
  let aggregatedBounties = aggregateBounties(totalBounties);

  // Separate raw token bounties from regular bounties
  const { regular: regularBounties, raw: rawBounties } = separateRawTokenBounties(aggregatedBounties);

  // Keep bounties only for the specified protocol
  aggregatedBounties = { [protocol]: regularBounties[protocol] || {} };
  const rawProtocolBounties = { [protocol]: rawBounties[protocol] || {} };

  // Collect tokens and fetch their info (including raw tokens)
  const protocolTokens = { [protocol]: PROTOCOLS_TOKENS[protocol] };

  // Convert aggregatedBounties back to array format for collectAllTokens
  const aggregatedBountiesForTokens: Record<string, any[]> = {};
  for (const [p, bounties] of Object.entries(aggregatedBounties)) {
    aggregatedBountiesForTokens[p] = Object.values(bounties || {});
  }

  const allTokens = collectAllTokens(aggregatedBountiesForTokens, protocolTokens);
  if (isDebugEnabled()) {
    debug("[tokens] protocol", protocol);
    debug("[tokens] total unique", allTokens.size);
    debug("[tokens] sample", sampleArray(Array.from(allTokens), 10));
  }

  // Add raw tokens to the set
  for (const protocolRawBounties of Object.values(rawProtocolBounties)) {
    for (const bounty of Object.values(protocolRawBounties as Record<string, any>)) {
      if (bounty.rewardToken) {
        allTokens.add(bounty.rewardToken.toLowerCase());
      }
    }
  }

  const tokenInfos = await fetchAllTokenInfos(
    Array.from(allTokens),
    publicClient
  );
  if (isDebugEnabled()) {
    const ti = Object.fromEntries(
      sampleArray(Object.entries(tokenInfos), 10).map(([a, i]) => [a, i?.symbol])
    );
    debug("[tokenInfos] sample symbols", ti);
  }

  // Fetch gauge infos and add gauge names to bounties
  let gaugesInfo;
  switch (protocol) {
    case "curve":
      gaugesInfo = await getGaugesInfos("curve");
      break;
    case "balancer":
      gaugesInfo = await getGaugesInfos("balancer");
      break;
    case "frax":
      gaugesInfo = await getGaugesInfos("frax");
      break;
    case "fxn":
      gaugesInfo = await getGaugesInfos("fxn");
      break;
    case "pendle":
      gaugesInfo = await getGaugesInfos("pendle");
      break;
  }
  // Convert aggregatedBounties to array format for processReport
  const aggregatedBountiesArray: Record<string, any[]> = {};
  for (const [p, bounties] of Object.entries(aggregatedBounties)) {
    aggregatedBountiesArray[p] = Object.values(bounties || {});
  }

  if (gaugesInfo) {
    aggregatedBountiesArray[protocol] = addGaugeNamesToBounties(
      aggregatedBountiesArray[protocol],
      gaugesInfo
    );
  }

  // Fetch swap events
  const swapIn = await fetchSwapInEvents(
    1,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    ALL_MIGHT
  );
  const swapOut = await fetchSwapOutEvents(
    1,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    ALL_MIGHT
  );
  if (isDebugEnabled()) {
    debug("[swaps] fetched", {
      inCount: swapIn.length,
      outCount: swapOut.length,
      inSample: sampleArray(
        swapIn.map((s) => ({
          block: s.blockNumber,
          logIndex: s.logIndex,
          token: s.token,
          tx: s.transactionHash,
          from: s.from,
          to: s.to,
        })),
        5
      ),
      outSample: sampleArray(
        swapOut.map((s) => ({
          block: s.blockNumber,
          logIndex: s.logIndex,
          token: s.token,
          tx: s.transactionHash,
          from: s.from,
          to: s.to,
        })),
        5
      ),
    });
  }

  // Get blocks to exclude for vlCVX recipient swaps
  const vlcvxRecipientSwapsIn = await fetchSwapInEvents(
    1,
    blockNumber1,
    blockNumber2,
    [PROTOCOLS_TOKENS.curve.sdToken],
    VLCVX_DELEGATORS_RECIPIENT
  );
  const vlcvxRecipientSwapsInBlockNumbers = vlcvxRecipientSwapsIn.map(
    (swap) => swap.blockNumber
  );
  console.log(
    "vlCVX recipient blocks to exclude:",
    vlcvxRecipientSwapsInBlockNumbers
  );
  debug("[swaps] vlcvx excluded blocks count", vlcvxRecipientSwapsInBlockNumbers.length);

  // Fetch delegation events for tokens sent to delegation address
  const delegationEvents = await fetchDelegationEvents(
    1,
    blockNumber1,
    blockNumber2,
    Array.from(allTokens),
    DELEGATION_RECIPIENT
  );
  console.log(
    "Delegation events detected:",
    delegationEvents.length
  );
  debug("[delegation] events count", delegationEvents.length);
  if (isDebugEnabled() && delegationEvents.length > 0) {
    debug("[delegation] sample events", sampleArray(
      delegationEvents.map((e) => ({
        block: e.blockNumber,
        token: e.token,
        amount: e.amount.toString(),
        tx: e.transactionHash,
      })),
      10
    ));
  }

  // Process delegation events - create a map of delegated tokens (NOT entire transactions)
  const delegatedTokens = new Map<string, Set<string>>(); // token -> Set of tx hashes
  const delegatedTokensByBounty: Record<string, {
    token: string;
    eventAmount: bigint;
    matchedAmount: bigint;
    gauge: string;
    transactionHash: string;
  }[]> = {};

  for (const delEvent of delegationEvents) {
    const tokenLower = delEvent.token.toLowerCase();
    const txLower = (delEvent.transactionHash || "").toLowerCase();

    // Track which tokens were delegated in which transactions
    if (!delegatedTokens.has(tokenLower)) {
      delegatedTokens.set(tokenLower, new Set());
    }
    delegatedTokens.get(tokenLower)!.add(txLower);

    // Find matching bounties for this token and amount
    for (const bounty of aggregatedBountiesArray[protocol] || []) {
      const bountyToken = (bounty.rewardToken || "").toLowerCase();
      const bountyAmount = BigInt(bounty.amount || "0");
      const tokenInfo = tokenInfos[bountyToken];
      const decimals = tokenInfo?.decimals ?? 18;
      // Allow a small tolerance so rounding/bridging differences don't keep delegated transfers from matching
      const baseTolerance =
        decimals > 6 ? BigInt(10) ** BigInt(decimals - 6) : 1n; // ~1e-6 of a token in base units
      const relativeTolerance =
        bountyAmount > 0n ? bountyAmount / 10_000n : 0n; // 0.01% of the amount
      const tolerance =
        relativeTolerance > baseTolerance ? relativeTolerance : baseTolerance;

      if (
        delEvent.token.toLowerCase() === bountyToken &&
        (delEvent.amount === bountyAmount ||
          (delEvent.amount > bountyAmount
            ? delEvent.amount - bountyAmount <= tolerance
            : bountyAmount - delEvent.amount <= tolerance))
      ) {
        const key = `${delEvent.token.toLowerCase()}_${bounty.gauge.toLowerCase()}`;
        if (!delegatedTokensByBounty[key]) {
          delegatedTokensByBounty[key] = [];
        }
        delegatedTokensByBounty[key].push({
          token: delEvent.token,
          eventAmount: delEvent.amount,
          matchedAmount: bountyAmount,
          gauge: bounty.gauge,
          transactionHash: delEvent.transactionHash || "",
        });
      }
    }
  }

  if (isDebugEnabled()) {
    debug("[delegation] matched bounties", Object.keys(delegatedTokensByBounty).length);
    debug("[delegation] delegated tokens", delegatedTokens.size);
    if (delegatedTokens.size > 0) {
      const tokenTxCounts = Array.from(delegatedTokens.entries()).map(([token, txs]) => ({
        token,
        txCount: txs.size
      }));
      debug("[delegation] token->tx counts", tokenTxCounts);
    }
    if (Object.keys(delegatedTokensByBounty).length > 0) {
      debug("[delegation] sample matches",
        sampleArray(
          Object.entries(delegatedTokensByBounty).map(([key, events]) => ({
            key,
            count: events.length,
            sample: events[0],
          })),
          5
        )
      );
    }
  }

  // Process swaps and filter out OTC swaps by block number, and delegated tokens
  const swapOTC = processSwapsOTC(swapIn, tokenInfos);
  let swapInFiltered = processSwaps(swapIn, tokenInfos);
  let swapOutFiltered = processSwaps(swapOut, tokenInfos);

  // Filter out OTC swaps
  swapInFiltered = swapInFiltered.filter(
    (swap) =>
      !swapOTC.some((otcSwap) => otcSwap.blockNumber === swap.blockNumber)
  );
  swapOutFiltered = swapOutFiltered.filter(
    (swap) =>
      !swapOTC.some((otcSwap) => otcSwap.blockNumber === swap.blockNumber)
  );

  if (excludedTxHashes.size > 0) {
    const beforeManualFilterIn = swapInFiltered.length;
    const beforeManualFilterOut = swapOutFiltered.length;

    swapInFiltered = swapInFiltered.filter((swap) => {
      const tx = (swap.transactionHash || "").toLowerCase();
      return !tx || !excludedTxHashes.has(tx);
    });
    swapOutFiltered = swapOutFiltered.filter((swap) => {
      const tx = (swap.transactionHash || "").toLowerCase();
      return !tx || !excludedTxHashes.has(tx);
    });

    const removedIn = beforeManualFilterIn - swapInFiltered.length;
    const removedOut = beforeManualFilterOut - swapOutFiltered.length;
    if (removedIn > 0 || removedOut > 0) {
      console.log(
        `[tx-exclusions] Removed ${removedIn} swap-in and ${removedOut} swap-out events`
      );
    }
    if (isDebugEnabled()) {
      debug("[tx-exclusions] manual filter", {
        removedIn,
        removedOut,
      });
    }
  }

  if (protocol === "pendle") {
    const PENDLE_FEE_RECIPIENT =
      "0xe42a462dbf54f281f95776e663d8c942dcf94f17".toLowerCase();
    const USDT_ADDRESS =
      "0xdac17f958d2ee523a2206206994597c13d831ec7".toLowerCase();
    const feeRecipientTxs = new Set<string>();

    for (const swap of swapInFiltered) {
      if (
        swap.token.toLowerCase() === USDT_ADDRESS &&
        swap.from.toLowerCase() === PENDLE_FEE_RECIPIENT &&
        swap.transactionHash
      ) {
        feeRecipientTxs.add(swap.transactionHash.toLowerCase());
      }
    }

    swapInFiltered = swapInFiltered.filter((swap) => {
      if (swap.token.toLowerCase() !== USDT_ADDRESS) return true;
      return swap.from.toLowerCase() !== PENDLE_FEE_RECIPIENT;
    });

    swapOutFiltered = swapOutFiltered.filter((swap) => {
      if (swap.token.toLowerCase() !== USDT_ADDRESS) return true;
      const txLower = (swap.transactionHash || "").toLowerCase();
      return !feeRecipientTxs.has(txLower);
    });
  }

  // Filter out delegated tokens (NOT entire transactions, just the specific tokens that were delegated)
  const beforeDelegationFilterIn = swapInFiltered.length;
  const beforeDelegationFilterOut = swapOutFiltered.length;

  swapInFiltered = swapInFiltered.filter((swap) => {
    const tokenLower = swap.token.toLowerCase();
    const txLower = (swap.transactionHash || "").toLowerCase();
    const delegatedTxs = delegatedTokens.get(tokenLower);
    // Exclude only if this specific token was delegated in this transaction
    return !delegatedTxs || !delegatedTxs.has(txLower);
  });

  swapOutFiltered = swapOutFiltered.filter((swap) => {
    const tokenLower = swap.token.toLowerCase();
    const txLower = (swap.transactionHash || "").toLowerCase();
    const delegatedTxs = delegatedTokens.get(tokenLower);
    // Exclude only if this specific token was delegated in this transaction
    return !delegatedTxs || !delegatedTxs.has(txLower);
  });

  // Filter to only include transactions that involve this protocol's sdToken
  // This prevents cross-protocol contamination (e.g., Balancer TX appearing in Curve report)
  const sdTokenAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();
  const txHashesWithSdToken = new Set<string>();

  // Find all transactions that have the protocol's sdToken
  for (const swap of swapInFiltered) {
    if (swap.token.toLowerCase() === sdTokenAddr) {
      txHashesWithSdToken.add((swap.transactionHash || "").toLowerCase());
    }
  }
  for (const swap of swapOutFiltered) {
    if (swap.token.toLowerCase() === sdTokenAddr) {
      txHashesWithSdToken.add((swap.transactionHash || "").toLowerCase());
    }
  }

  // Only keep swaps from transactions that involve the protocol's sdToken
  const beforeSdFilterIn = swapInFiltered.length;
  const beforeSdFilterOut = swapOutFiltered.length;

  swapInFiltered = swapInFiltered.filter(
    (swap) => txHashesWithSdToken.has((swap.transactionHash || "").toLowerCase())
  );
  swapOutFiltered = swapOutFiltered.filter(
    (swap) => txHashesWithSdToken.has((swap.transactionHash || "").toLowerCase())
  );

  if (isDebugEnabled()) {
    debug("[swaps] otc blocks count", new Set(swapOTC.map((s) => s.blockNumber)).size);
    debug("[swaps] delegation tokens excluded", {
      tokens: delegatedTokens.size,
      swapsRemoved: {
        in: beforeDelegationFilterIn - swapInFiltered.length,
        out: beforeDelegationFilterOut - swapOutFiltered.length
      }
    });
    debug("[swaps] sdToken filter", {
      protocol,
      sdToken: sdTokenAddr,
      txWithSdToken: txHashesWithSdToken.size,
      beforeFilter: { in: beforeSdFilterIn, out: beforeSdFilterOut },
      afterFilter: { in: swapInFiltered.length, out: swapOutFiltered.length },
      removed: {
        in: beforeSdFilterIn - swapInFiltered.length,
        out: beforeSdFilterOut - swapOutFiltered.length
      }
    });
    debug("[swaps] filtered counts", {
      inFiltered: swapInFiltered.length,
      outFiltered: swapOutFiltered.length,
    });
  }

  // Filter out delegated bounties from the main processing
  // Create a set of delegated bounty identifiers for quick lookup
  const delegatedBountyIds = new Set<string>();
  for (const [key, events] of Object.entries(delegatedTokensByBounty)) {
    for (const event of events) {
      const bountyId = `${event.token.toLowerCase()}_${event.gauge.toLowerCase()}_${event.matchedAmount.toString()}`;
      delegatedBountyIds.add(bountyId);
    }
  }

  // Filter delegated bounties from aggregatedBountiesArray
  const filteredBountiesArray: Record<string, any[]> = {};
  for (const [proto, bounties] of Object.entries(aggregatedBountiesArray)) {
    filteredBountiesArray[proto] = bounties.filter((bounty) => {
      const bountyId = `${(bounty.rewardToken || "").toLowerCase()}_${bounty.gauge.toLowerCase()}_${bounty.amount}`;
      return !delegatedBountyIds.has(bountyId);
    });
  }

  if (isDebugEnabled()) {
    const originalCount = aggregatedBountiesArray[protocol]?.length || 0;
    const filteredCount = filteredBountiesArray[protocol]?.length || 0;
    debug("[delegation] bounties filtered", {
      original: originalCount,
      filtered: filteredCount,
      removed: originalCount - filteredCount,
    });
  }
  const processedReport = processReport(
    1,
    swapInFiltered,
    swapOutFiltered,
    filteredBountiesArray,
    tokenInfos,
    vlcvxRecipientSwapsInBlockNumbers
  );
  // Pendle-specific logic removed in favor of universal pass below

  // Generic: drop tokens that were not swapped for this protocol (all protocols)
  try {
    const txHashes = Array.from(
      new Set(
        [...swapInFiltered, ...swapOutFiltered]
          .map((s) => s.transactionHash)
          .filter(Boolean) as string[]
      )
    );
    const wethAddr = WETH_CHAIN_IDS[1].toLowerCase();
    const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();
    const includedTokens = new Set<string>();
    // Use filteredBountiesArray to exclude delegated tokens
    for (const b of filteredBountiesArray[protocol] || []) {
      const t = (b.rewardToken || "").toLowerCase();
      if (t && t !== nativeAddr && t !== sdAddr) {
        // Keep WETH alongside every other bounty token so we can re-map
        // WETH-denominated rewards when they route through the aggregator.
        includedTokens.add(t);
      }
    }

    const tokenSwapWeth: Record<string, number> = {};
    let totalWethOutUsed = 0;

    for (const tx of txHashes) {
      const inTx = swapInFiltered.filter((e) => e.transactionHash === tx);
      const outTx = swapOutFiltered.filter((e) => e.transactionHash === tx);
      const totalWethInTx = inTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const totalWethOutTx = outTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      let mapped: Record<string, bigint> = {};
      try {
        mapped = await mapTokenSwapsToOutToken(
          publicClient,
          tx as `0x${string}`,
          includedTokens,
          wethAddr,
          ALL_MIGHT
        );
      } catch (e) {
        // Ignore mapping errors and continue
      }
      const mappedWethSum = Object.values(mapped).reduce(
        (s, v) => s + Number(v) / 1e18,
        0
      );
      for (const [tok, amt] of Object.entries(mapped)) {
        const tl = tok.toLowerCase();
        tokenSwapWeth[tl] = (tokenSwapWeth[tl] || 0) + Number(amt) / 1e18;
      }
      totalWethOutUsed += totalWethOutTx;
    }

    const tokensNotSwapped: string[] = [];
    for (const t of includedTokens) {
      if (!tokenSwapWeth[t] || tokenSwapWeth[t] === 0) tokensNotSwapped.push(t);
    }
    const tokensNotSwappedFiltered = tokensNotSwapped.filter((t) => t !== wethAddr);
    const wethNotSwapped = totalWethOutUsed === 0;

    if (isDebugEnabled()) {
      debug("[not-swapped detection]", {
        protocol,
        tokensNotSwapped: tokensNotSwappedFiltered,
        wethNotSwapped,
      });
    }

    if (processedReport[protocol]) {
      processedReport[protocol] = processedReport[protocol].filter((row) => {
        const addr = row.rewardAddress.toLowerCase();
        if (addr === nativeAddr || addr === sdAddr) return true;
        if (addr === wethAddr) return !wethNotSwapped;
        return !tokensNotSwappedFiltered.includes(addr);
      });
    }
  } catch (e) {
    debug("[not-swapped detection] error", String(e));
  }

  let finalTokenTotals: Record<string, number> | undefined;
  // Generic per-token reallocation using receipt-level attribution (all protocols)
  try {
    const txHashes = Array.from(
      new Set(
        [...swapInFiltered, ...swapOutFiltered]
          .map((s) => s.transactionHash)
          .filter(Boolean) as string[]
      )
    );
    const wethAddr = WETH_CHAIN_IDS[1].toLowerCase();
    const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

    const includedTokens = new Set<string>();
    // Use filteredBountiesArray to exclude delegated tokens
    for (const b of filteredBountiesArray[protocol] || []) {
      const t = (b.rewardToken || "").toLowerCase();
      if (t && t !== nativeAddr && t !== sdAddr) {
        includedTokens.add(t);
      }
    }

    const includedSdByToken: Record<string, number> = {};

    const botmarketAddrForWeth = BOTMARKET.toLowerCase();

    for (const tx of txHashes) {
      const inTx = swapInFiltered.filter((e) => e.transactionHash === tx);
      const outTx = swapOutFiltered.filter((e) => e.transactionHash === tx);
      const totalWethInTx = inTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const totalWethOutTx = outTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const sdInTx = inTx
        .filter((e) => e.token.toLowerCase() === sdAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);

      if (sdInTx <= 0) continue;

      const wethBasis = totalWethInTx > 0 ? totalWethInTx : totalWethOutTx;
      const nativeInTx = inTx
        .filter((e) => e.token.toLowerCase() === nativeAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const nativeOutTx = outTx
        .filter((e) => e.token.toLowerCase() === nativeAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      // Portion of sd clearly originating from native bounties this tx
      // Prefer Botmarket -> ALL_MIGHT native transfers as the source of native-based sd
      // Use net native outflow as the basis for native-attributed sd (CRV -> sdCRV)
      const nativeBasis = Math.max(0, nativeOutTx - nativeInTx);
      const nativeShareSd = Math.min(sdInTx, nativeBasis);
      if (nativeShareSd > 0) {
        includedSdByToken[nativeAddr] =
          (includedSdByToken[nativeAddr] || 0) + nativeShareSd;
      }
      // Attribute remainder via WETH flows if present
      const remSd = sdInTx - nativeShareSd;

      if (remSd <= 0) continue;
      if (wethBasis <= 0) {
        // No WETH basis; attribute remaining sd to native as well (pure native mint)
        includedSdByToken[nativeAddr] = (includedSdByToken[nativeAddr] || 0) + remSd;
        continue;
      }

      // Special case: WETH bounties come in from BOTMARKET and are already WETH
      // They should be directly attributed as WETH (mappedWeth = wethIn amount from BOTMARKET)
      // NOTE: Use raw swapIn data since BOTMARKET transfers are filtered out in swapInFiltered
      const wethInFromBotmarket = swapIn
        .filter(
          (e) =>
            e.transactionHash === tx &&
            e.token.toLowerCase() === wethAddr &&
            e.from.toLowerCase() === botmarketAddrForWeth
        )
        .reduce((a, b) => a + Number(b.amount) / 1e18, 0);

      let tokenToOut: Record<string, bigint> = {};
      try {
        tokenToOut = await mapTokenSwapsToOutToken(
          publicClient,
          tx as `0x${string}`,
          includedTokens,
          wethAddr,
          ALL_MIGHT
        );
      } catch (e) {
        continue;
      }

      const sdPerWeth = remSd / wethBasis;
      const totalMappedWeth = Object.values(tokenToOut).reduce(
        (s, v) => s + Number(v) / 1e18,
        0
      );
      for (const [tok, amount] of Object.entries(tokenToOut)) {
        const tokLower = tok.toLowerCase();
        if (!includedTokens.has(tokLower)) continue;
        const wethAmt = Number(amount) / 1e18;
        includedSdByToken[tokLower] = (includedSdByToken[tokLower] || 0) + wethAmt * sdPerWeth;
      }
      // WETH bounties: WETH from BOTMARKET is directly attributed as WETH
      // This handles the special case where WETH is one step shorter (no token->WETH swap)
      if (wethInFromBotmarket > 0) {
        includedSdByToken[wethAddr] =
          (includedSdByToken[wethAddr] || 0) + wethInFromBotmarket * sdPerWeth;
      }
      // Assign any remaining leftover WETH (not from BOTMARKET and not mapped) to WETH
      const residualWeth = Math.max(0, wethBasis - totalMappedWeth - wethInFromBotmarket);
      if (residualWeth > 0) {
        includedSdByToken[wethAddr] =
          (includedSdByToken[wethAddr] || 0) + residualWeth * sdPerWeth;
      }
    }

    if (isDebugEnabled()) debug("[generic per-token sd]", Object.entries(includedSdByToken).map(([k, v]) => ({ token: k, sd: v })));

    if (processedReport[protocol] && Object.keys(includedSdByToken).length > 0) {
      const rows = processedReport[protocol] || [];
      const rowsByToken: Record<string, typeof rows> = {};
      for (const row of rows) {
        const tok = row.rewardAddress.toLowerCase();
        (rowsByToken[tok] ||= []).push(row);
      }
      // Re-target sd onto tokens traced back to WETH outflows
      for (const [tok, tokenRows] of Object.entries(rowsByToken)) {
        if (tok === sdAddr) continue;
        if (!(tok in includedSdByToken)) {
          continue;
        }
        const targetSd = includedSdByToken[tok];
        if (targetSd <= 0) {
          tokenRows.forEach((r) => (r.rewardSdValue = 0));
          continue;
        }
        let sumOldSd = tokenRows.reduce((s, r) => s + (r.rewardSdValue || 0), 0);
        let weights: number[] = [];
        if (sumOldSd > 0) {
          weights = tokenRows.map((r) => (r.rewardSdValue || 0) / sumOldSd);
        } else {
          const sumAmt = tokenRows.reduce((s, r) => s + (r.rewardAmount || 0), 0);
          weights = tokenRows.map((r) => ((r.rewardAmount || 0) / (sumAmt || 1)));
        }
        tokenRows.forEach((r, idx) => {
          r.rewardSdValue = targetSd * (weights[idx] || 0);
        });
      }
      // If native was only routing through the aggregator, zero its sd unless we attributed native sd
      const nativeRows = rowsByToken[nativeAddr];
      if (nativeRows) {
        const tolerance = 1e-9;
        const botmarketAddr = BOTMARKET.toLowerCase();
        // If the aggregator sent out more native token than it received (once bot withdrawals are ignored),
        // those native rewards were only routing through and should not contribute sd value.
        const nativeInAdjusted = swapInFiltered
          .filter(
            (e) =>
              e.token.toLowerCase() === nativeAddr &&
              e.from.toLowerCase() !== botmarketAddr
          )
          .reduce((a, b) => a + b.formattedAmount, 0);
        const nativeOutTotal = swapOutFiltered
          .filter((e) => e.token.toLowerCase() === nativeAddr)
          .reduce((a, b) => a + b.formattedAmount, 0);
        const assignedNativeSd = includedSdByToken[nativeAddr] || 0;
        if (assignedNativeSd <= tolerance && nativeOutTotal > nativeInAdjusted + tolerance) {
          nativeRows.forEach((r) => {
            r.rewardSdValue = 0;
          });
          if (isDebugEnabled()) {
            debug("[native swap detection]", {
              nativeInAdjusted,
              nativeOutTotal,
              assignedNativeSd,
              rowsCleared: nativeRows.length,
            });
          }
        }
      }
      // Similarly for WETH: zero sd when it's a pure routing tx
      const wethRows = rowsByToken[wethAddr];
      if (wethRows) {
        const tolerance = 1e-9;
        const botmarketAddr = BOTMARKET.toLowerCase();
        // Same idea for WETH: pure routing transactions get zero sd so the CSV reflects only real WETH bounties.
        const wethInAdjusted = swapInFiltered
          .filter(
            (e) =>
              e.token.toLowerCase() === wethAddr &&
              e.from.toLowerCase() !== botmarketAddr
          )
          .reduce((a, b) => a + b.formattedAmount, 0);
        const wethOutTotal = swapOutFiltered
          .filter((e) => e.token.toLowerCase() === wethAddr)
          .reduce((a, b) => a + b.formattedAmount, 0);
        const assignedWethSd = includedSdByToken[wethAddr] || 0;
        if (assignedWethSd <= tolerance && wethOutTotal > wethInAdjusted + tolerance) {
          wethRows.forEach((r) => {
            r.rewardSdValue = 0;
          });
          if (isDebugEnabled()) {
            debug("[weth swap detection]", {
              wethInAdjusted,
              wethOutTotal,
              rowsCleared: wethRows.length,
            });
          }
        }
      }
      const finalTotal = rows.reduce((s, r) => s + (r.rewardSdValue || 0), 0);
      if (finalTotal > 0) rows.forEach((r) => (r.sharePercentage = ((r.rewardSdValue || 0) / finalTotal) * 100));

      // Keep only native/sdToken or tokens explicitly attributed; drop others
      const includedSet = new Set(Object.keys(includedSdByToken).map((t) => t.toLowerCase()));
      const beforeCount = rows.length;
      processedReport[protocol] = rows.filter((r) => {
        const addr = r.rewardAddress.toLowerCase();
        if (addr === nativeAddr) {
          return (r.rewardSdValue || 0) > 1e-9;
        }
        if (addr === sdAddr || addr === wethAddr) return true;
        return includedSet.has(addr);
      });
      const afterCount = processedReport[protocol].length;
      if (isDebugEnabled() && afterCount !== beforeCount) {
        debug("[filter rows by attribution]", { beforeCount, afterCount });
      }

      // Recompute shares after drop
      const finalTotal2 = processedReport[protocol].reduce((s, r) => s + (r.rewardSdValue || 0), 0);
      if (finalTotal2 > 0) processedReport[protocol].forEach((r) => (r.sharePercentage = ((r.rewardSdValue || 0) / finalTotal2) * 100));
      if (isDebugEnabled()) {
        const tokenTotals = Object.fromEntries(
          Object.entries(rowsByToken).map(([t, rs]) => [
            t,
            rs.reduce((s, r) => s + (r.rewardSdValue || 0), 0),
          ])
        );
        debug("[generic per-token reallocated]", { finalTotal: finalTotal2, tokenTotals });
      }
    }

    // Normalize non-sd rewards so their SD equivalents add up to the actual mint that hit ALL_MIGHT
    if (processedReport[protocol]) {
      const rows = processedReport[protocol];
      const sdMintedTotal = swapInFiltered
        .filter((swap) => swap.token.toLowerCase() === sdAddr)
        .reduce((acc, swap) => acc + swap.formattedAmount, 0);
      const totalSd = rows.reduce((sum, r) => sum + (r.rewardSdValue || 0), 0);
      const fixedSd = rows
        .filter((r) => r.rewardAddress.toLowerCase() === sdAddr)
        .reduce((sum, r) => sum + (r.rewardSdValue || 0), 0);
      const adjustableRows = rows.filter(
        (r) => r.rewardAddress.toLowerCase() !== sdAddr
      );
      const adjustableTotal = totalSd - fixedSd;
      const targetAdjustable = sdMintedTotal - fixedSd;

      if (
        adjustableRows.length > 0 &&
        adjustableTotal > 0 &&
        targetAdjustable > 0 &&
        Math.abs(adjustableTotal - targetAdjustable) > 1e-6
      ) {
        const scale = targetAdjustable / adjustableTotal;
        adjustableRows.forEach((row) => {
          row.rewardSdValue = (row.rewardSdValue || 0) * scale;
        });
        const scaledTotal = rows.reduce(
          (sum, r) => sum + (r.rewardSdValue || 0),
          0
        );
        if (scaledTotal > 0) {
          rows.forEach((row) => {
            row.sharePercentage = ((row.rewardSdValue || 0) / scaledTotal) * 100;
          });
        }
      }
      processedReport[protocol] = rows.filter((row) => {
        const addr = row.rewardAddress.toLowerCase();
        if ((row.rewardSdValue || 0) > 1e-9) return true;
        return addr === nativeAddr || addr === wethAddr;
      });
    }
  } catch (e) {
    debug("[generic per-token reallocation] error", String(e));
  }


  // Protocol-specific blocks removed in favor of universal attribution
  if (isDebugEnabled()) {
    const summary: Record<string, any> = {};
    for (const [p, rows] of Object.entries(processedReport)) {
      const total = (rows || []).reduce((acc, r) => acc + (r.rewardSdValue || 0), 0);
      summary[p] = { rows: rows?.length || 0, totalSd: Number(total.toFixed(6)) };
    }
    debug("[report] processed summary", summary);
  }

  // Emit attribution sidecar JSON (per protocol)
  try {
    if (processedReport[protocol]) {
      // Snapshot the post-filter totals so the sidecar echoes exactly what the CSV contains
      finalTokenTotals = processedReport[protocol].reduce(
        (acc, row) => {
          const addr = row.rewardAddress.toLowerCase();
          acc[addr] = (acc[addr] || 0) + (row.rewardSdValue || 0);
          return acc;
        },
        {} as Record<string, number>
      );
    }
    const txHashes = Array.from(
      new Set(
        [...swapInFiltered, ...swapOutFiltered]
          .map((s) => s.transactionHash)
          .filter(Boolean) as string[]
      )
    );
    const wethAddr = WETH_CHAIN_IDS[1].toLowerCase();
    const nativeAddr = PROTOCOLS_TOKENS[protocol].native.toLowerCase();
    const sdAddr = PROTOCOLS_TOKENS[protocol].sdToken.toLowerCase();

    const includedTokens = new Set<string>();
    // Use filteredBountiesArray to exclude delegated tokens
    for (const b of filteredBountiesArray[protocol] || []) {
      const t = (b.rewardToken || "").toLowerCase();
      if (t && t !== nativeAddr && t !== sdAddr) {
        includedTokens.add(t);
      }
    }

    if (isDebugEnabled()) {
      debug("[sidecar] includedTokens", {
        count: includedTokens.size,
        tokens: Array.from(includedTokens).slice(0, 10)
      });
    }

    const tokenMappedWeth: Record<string, number> = {};
    const includedSdByToken: Record<string, number> = {};
    const txAttributions: Array<{
      tx: string;
      wethIn: number;
      wethOut: number;
      sdIn: number;
      nativeIn?: number;
      nativeOut?: number;
      nativeShareSd?: number;
      wethBasis?: number;
      tokenWeth: Record<string, number>;
      tokenSd: Record<string, number>;
    }> = [];
    let sdInTotal = 0;
    let wethInTotal = 0;
    let wethOutTotal = 0;

    for (const tx of txHashes) {
      const inTx = swapInFiltered.filter((e) => e.transactionHash === tx);
      const outTx = swapOutFiltered.filter((e) => e.transactionHash === tx);
      const totalWethInTx = inTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const totalWethOutTx = outTx
        .filter((e) => e.token.toLowerCase() === wethAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const sdInTx = inTx
        .filter((e) => e.token.toLowerCase() === sdAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);

      // Only track transactions that have sdToken involvement for this protocol
      if (sdInTx <= 0) {
        continue; // Skip transactions with no sdToken for this protocol
      }

      if (totalWethInTx > 0 || totalWethOutTx > 0 || sdInTx > 0) {
        wethInTotal += totalWethInTx;
        wethOutTotal += totalWethOutTx;
        sdInTotal += sdInTx;
      }

      let tokenToOut: Record<string, bigint> = {};
      try {
        tokenToOut = await mapTokenSwapsToOutToken(
          publicClient,
          tx as `0x${string}`,
          includedTokens,
          wethAddr,
          ALL_MIGHT
        );
      } catch (e) {
        // On decode issues, still attribute native share and include native in/out in sidecar
        const tokenWeth: Record<string, number> = {};
        const tokenSd: Record<string, number> = {};
        const nativeInTx = inTx
          .filter((ev) => ev.token.toLowerCase() === nativeAddr)
          .reduce((a, b) => a + b.formattedAmount, 0);
        const nativeOutTx = outTx
          .filter((ev) => ev.token.toLowerCase() === nativeAddr)
          .reduce((a, b) => a + b.formattedAmount, 0);
        const nativeBasis = Math.max(0, nativeOutTx - nativeInTx);
        const nativeShareSd = Math.min(sdInTx, nativeBasis);
        if (nativeShareSd > 0) {
          tokenSd[nativeAddr] = (tokenSd[nativeAddr] || 0) + nativeShareSd;
          includedSdByToken[nativeAddr] = (includedSdByToken[nativeAddr] || 0) + nativeShareSd;
        }
        txAttributions.push({
          tx, wethIn: totalWethInTx, wethOut: totalWethOutTx, sdIn: sdInTx,
          nativeIn: nativeInTx, nativeOut: nativeOutTx, nativeShareSd, wethBasis: 0,
          tokenWeth, tokenSd
        });
        continue;
      }

      const wethBasis = totalWethInTx > 0 ? totalWethInTx : totalWethOutTx;
      // Prepare per-tx maps and split sd between native and WETH-driven share for this tx
      const tokenWeth: Record<string, number> = {};
      const tokenSd: Record<string, number> = {};
      const nativeInTx2 = inTx
        .filter((ev) => ev.token.toLowerCase() === nativeAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const nativeOutTx2 = outTx
        .filter((ev) => ev.token.toLowerCase() === nativeAddr)
        .reduce((a, b) => a + b.formattedAmount, 0);
      const nativeBasis2 = Math.max(0, nativeOutTx2 - nativeInTx2);
      const nativeShareSd2 = Math.min(sdInTx, nativeBasis2);
      const remSd2 = Math.max(0, sdInTx - nativeShareSd2);
      if (nativeShareSd2 > 0) {
        tokenSd[nativeAddr] = (tokenSd[nativeAddr] || 0) + nativeShareSd2;
        includedSdByToken[nativeAddr] = (includedSdByToken[nativeAddr] || 0) + nativeShareSd2;
      }
      if (wethBasis <= 0 && remSd2 > 0) {
        // No WETH basis; attribute remaining sd to native
        tokenSd[nativeAddr] = (tokenSd[nativeAddr] || 0) + remSd2;
        includedSdByToken[nativeAddr] = (includedSdByToken[nativeAddr] || 0) + remSd2;
      }

      // Special case: WETH bounties come in from BOTMARKET and are already WETH
      // They should be directly attributed as WETH (mappedWeth = wethIn amount from BOTMARKET)
      // NOTE: Use raw swapIn data since BOTMARKET transfers are filtered out in swapInFiltered
      const botmarketAddrSidecar = BOTMARKET.toLowerCase();
      const wethInFromBotmarketSidecar = swapIn
        .filter(
          (e) =>
            e.transactionHash === tx &&
            e.token.toLowerCase() === wethAddr &&
            e.from.toLowerCase() === botmarketAddrSidecar
        )
        .reduce((a, b) => a + Number(b.amount) / 1e18, 0);

      const sdPerWeth = wethBasis > 0 ? remSd2 / wethBasis : 0;
      const totalMappedWeth = Object.values(tokenToOut).reduce(
        (s, v) => s + Number(v) / 1e18,
        0
      );
      for (const [tok, amount] of Object.entries(tokenToOut)) {
        const tokLower = tok.toLowerCase();
        const wethAmt = Number(amount) / 1e18;
        tokenWeth[tokLower] = (tokenWeth[tokLower] || 0) + wethAmt;
        tokenSd[tokLower] = (tokenSd[tokLower] || 0) + wethAmt * sdPerWeth;
        tokenMappedWeth[tokLower] = (tokenMappedWeth[tokLower] || 0) + wethAmt;
        includedSdByToken[tokLower] = (includedSdByToken[tokLower] || 0) + wethAmt * sdPerWeth;
      }
      // WETH bounties: WETH from BOTMARKET is directly attributed as WETH
      // This handles the special case where WETH is one step shorter (no token->WETH swap)
      if (wethInFromBotmarketSidecar > 0) {
        tokenWeth[wethAddr] = (tokenWeth[wethAddr] || 0) + wethInFromBotmarketSidecar;
        tokenSd[wethAddr] = (tokenSd[wethAddr] || 0) + wethInFromBotmarketSidecar * sdPerWeth;
        tokenMappedWeth[wethAddr] = (tokenMappedWeth[wethAddr] || 0) + wethInFromBotmarketSidecar;
        includedSdByToken[wethAddr] =
          (includedSdByToken[wethAddr] || 0) + wethInFromBotmarketSidecar * sdPerWeth;
      }
      // Assign any remaining leftover WETH (not from BOTMARKET and not mapped) to WETH
      const residualWeth = Math.max(0, wethBasis - totalMappedWeth - wethInFromBotmarketSidecar);
      if (residualWeth > 0) {
        tokenWeth[wethAddr] = (tokenWeth[wethAddr] || 0) + residualWeth;
        tokenSd[wethAddr] = (tokenSd[wethAddr] || 0) + residualWeth * sdPerWeth;
        tokenMappedWeth[wethAddr] = (tokenMappedWeth[wethAddr] || 0) + residualWeth;
        includedSdByToken[wethAddr] =
          (includedSdByToken[wethAddr] || 0) + residualWeth * sdPerWeth;
      }

      txAttributions.push({
        tx,
        wethIn: totalWethInTx,
        wethOut: totalWethOutTx,
        sdIn: sdInTx,
        nativeIn: nativeInTx2,
        nativeOut: nativeOutTx2,
        nativeShareSd: nativeShareSd2,
        wethBasis,
        tokenWeth,
        tokenSd
      });
    }

    const tokensNotSwapped = Array.from(includedTokens).filter(
      (t) => !tokenMappedWeth[t] || tokenMappedWeth[t] === 0
    );
    // Do not flag WETH as "not swapped"—we still want to keep the row even if it
    // ended up being a pure passthrough.
    const tokensNotSwappedFiltered = tokensNotSwapped.filter((t) => t !== wethAddr);
    const perToken: Record<string, { mappedWeth: number; sd: number }> = {};
    for (const t of includedTokens) {
      perToken[t] = {
        mappedWeth: tokenMappedWeth[t] || 0,
        sd: includedSdByToken[t] || 0,
      };
    }
    if (finalTokenTotals) {
      for (const [addr, sdValue] of Object.entries(finalTokenTotals)) {
        const lower = addr.toLowerCase();
        if (!perToken[lower]) {
          perToken[lower] = { mappedWeth: 0, sd: sdValue };
        } else {
          perToken[lower].sd = sdValue;
        }
      }
    }
    const sdAssignedCalculated = Object.values(perToken).reduce(
      (sum, entry) => sum + (entry.sd || 0),
      0
    );

    const sidecar = {
      protocol,
      period: currentPeriod,
      aggregator: ALL_MIGHT,
      totals: {
        sdInTotal,
        sdAssigned: sdAssignedCalculated,
        wethInTotal,
        wethOutTotal,
      },
      dropped: { tokensNotSwapped: tokensNotSwappedFiltered, wethNotSwapped: wethOutTotal === 0 },
      perToken,
      txs: txAttributions,
    };

    const dirPath2 = path.join(PROJECT_ROOT, "bounties-reports", currentPeriod.toString());
    fs.mkdirSync(dirPath2, { recursive: true });
    const jsonPath = path.join(dirPath2, `${protocol}-attribution.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
    if (isDebugEnabled()) debug("[sidecar written]", jsonPath);
  } catch (e) {
    debug("[sidecar error]", String(e));
  }

  // Process raw token bounties
  const rawTokenReport = processRawTokenBounties(rawProtocolBounties, tokenInfos, gaugesInfo);

  // Generate CSV reports in the designated directory
  const dirPath = path.join(
    PROJECT_ROOT,
    "bounties-reports",
    currentPeriod.toString()
  );
  fs.mkdirSync(dirPath, { recursive: true });

  // Create raw subdirectory for raw token reports
  const rawDirPath = path.join(dirPath, "raw");
  if (Object.keys(rawTokenReport).some(p => rawTokenReport[p] && rawTokenReport[p].length > 0)) {
    fs.mkdirSync(rawDirPath, { recursive: true });
  }

  const formattedDate = new Date(currentPeriod * 1000).toLocaleDateString(
    "en-GB"
  );
  console.log("Generating reports for the week of:", formattedDate);

  // Generate regular CSV reports
  for (const [protocol, rows] of Object.entries(processedReport)) {
    // Skip if no data
    if (!rows || rows.length === 0) {
      console.log(`No data to report for ${protocol}`);
      continue;
    }

    // Special handling for Pendle protocol
    if (protocol === "pendle") {
      const fileName = `${protocol}-otc.csv`;
      const filePath = path.join(dirPath, fileName);
      const header =
        "Period;Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol";

      const maybeUnquote = (value: string): string => {
        const trimmed = value.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          return trimmed.slice(1, -1).replace(/""/g, '"');
        }
        return trimmed;
      };

      const parseExistingRows = () => {
        if (!fs.existsSync(filePath)) {
          return [];
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return content
          .split(/\r?\n/)
          .slice(1) // drop header
          .filter((line) => line.trim().length > 0)
          .map((line) => line.split(";"))
          .filter((parts) => parts.length >= 8)
          .map((parts) => ({
            period: Number(maybeUnquote(parts[0])),
            gaugeName: maybeUnquote(parts[1]),
            gaugeAddress: maybeUnquote(parts[2]),
            rewardToken: maybeUnquote(parts[3]),
            rewardAddress: maybeUnquote(parts[4]),
            rewardAmount: Number(maybeUnquote(parts[5])),
            rewardSdValue: Number(maybeUnquote(parts[6])),
            sharePercentage: Number(maybeUnquote(parts[7])),
          }));
      };

      const existingRows: Array<{
        period: number;
        gaugeName: string;
        gaugeAddress: string;
        rewardToken: string;
        rewardAddress: string;
        rewardAmount: number;
        rewardSdValue: number;
        sharePercentage: number;
      }> = parseExistingRows();
      const newRows = rows.map((row) => ({
        period: currentPeriod,
        gaugeName: row.gaugeName,
        gaugeAddress: row.gaugeAddress,
        rewardToken: row.rewardToken,
        rewardAddress: row.rewardAddress,
        rewardAmount: row.rewardAmount,
        rewardSdValue: row.rewardSdValue,
        sharePercentage: 0,
      }));

      const buildKey = (row: {
        period: number;
        gaugeAddress: string;
        rewardAddress: string;
        rewardToken: string;
      }) =>
        `${row.period}|${row.gaugeAddress.toLowerCase()}|${row.rewardAddress.toLowerCase()}|${row.rewardToken.toLowerCase()}`;

      const newKeys = new Set(newRows.map(buildKey));
      const mergedRows: Array<{
        period: number;
        gaugeName: string;
        gaugeAddress: string;
        rewardToken: string;
        rewardAddress: string;
        rewardAmount: number;
        rewardSdValue: number;
        sharePercentage: number;
      }> = [
          ...existingRows.filter((row) => !newKeys.has(buildKey(row))),
          ...newRows,
        ];

      const totalSdValue = mergedRows.reduce(
        (sum, row) => sum + row.rewardSdValue,
        0
      );
      mergedRows.forEach((row) => {
        row.sharePercentage =
          totalSdValue > 0 ? (row.rewardSdValue / totalSdValue) * 100 : 0;
      });

      const csvContent = [
        header,
        ...mergedRows.map(
          (row) =>
            `${row.period};${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};${escapeCSV(
              row.rewardAddress
            )};${row.rewardAmount.toFixed(6)};${row.rewardSdValue.toFixed(
              6
            )};${row.sharePercentage.toFixed(2)}`
        ),
      ].join("\n");

      fs.writeFileSync(filePath, csvContent);
      console.log(`Report updated for ${protocol}: ${fileName}`);
    } else {
      // Standard format for other protocols
      const csvContent = [
        "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
        ...rows.map(
          (row) =>
            `${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};` +
            `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(
              6
            )};${row.rewardSdValue.toFixed(6)};` +
            `${row.sharePercentage.toFixed(2)}`
        ),
      ].join("\n");

      const fileName = `${protocol}.csv`;
      fs.writeFileSync(path.join(dirPath, fileName), csvContent);
      console.log(`Report generated for ${protocol}: ${fileName}`);
    }
  }

  // Generate raw token CSV reports
  for (const [protocol, rows] of Object.entries(rawTokenReport)) {
    if (rows && rows.length > 0) {
      debug("[raw] rows", protocol, rows.length);
      const rawCsvContent = [
        "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount",
        ...rows.map(
          (row) =>
            `${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};` +
            `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(6)}`
        ),
      ].join("\n");

      const rawFileName = `${protocol}.csv`;
      const protocolRawDir = path.join(rawDirPath, protocol);
      fs.mkdirSync(protocolRawDir, { recursive: true });
      fs.writeFileSync(path.join(protocolRawDir, rawFileName), rawCsvContent);
      console.log(`Raw token report generated for ${protocol}: raw/${protocol}/${rawFileName}`);
    }
  }

  // Generate delegation CSV report
  if (Object.keys(delegatedTokensByBounty).length > 0) {
    const delegationRows: Array<{
      gaugeName: string;
      gaugeAddress: string;
      rewardToken: string;
      rewardAddress: string;
      rewardAmount: number;
      transactionHash: string;
    }> = [];

    for (const [key, events] of Object.entries(delegatedTokensByBounty)) {
      for (const event of events) {
        const tokenInfo = tokenInfos[event.token.toLowerCase()];
        const amount = Number(event.eventAmount) / Math.pow(10, tokenInfo?.decimals || 18);

        // Find gauge name
        let gaugeName = event.gauge;
        let gaugeAddress = event.gauge;
        if (gaugesInfo) {
          const gaugeInfo = gaugesInfo.find(
            (g: any) => g.address.toLowerCase() === event.gauge.toLowerCase()
          );
          if (gaugeInfo) {
            gaugeName = gaugeInfo.name;
            gaugeAddress = gaugeInfo.actualGauge || event.gauge;
          }
        }

        delegationRows.push({
          gaugeName,
          gaugeAddress,
          rewardToken: tokenInfo?.symbol || "UNKNOWN",
          rewardAddress: event.token,
          rewardAmount: amount,
          transactionHash: event.transactionHash,
        });
      }
    }

    if (delegationRows.length > 0) {
      const delegationCsvContent = [
        "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Transaction Hash",
        ...delegationRows.map(
          (row) =>
            `${escapeCSV(row.gaugeName)};${escapeCSV(
              row.gaugeAddress
            )};${escapeCSV(row.rewardToken)};` +
            `${escapeCSV(row.rewardAddress)};${row.rewardAmount.toFixed(6)};` +
            `${escapeCSV(row.transactionHash)}`
        ),
      ].join("\n");

      const delegationDirPath = path.join(dirPath, "delegation");
      fs.mkdirSync(delegationDirPath, { recursive: true });
      const delegationFileName = `${protocol}.csv`;
      fs.writeFileSync(
        path.join(delegationDirPath, delegationFileName),
        delegationCsvContent
      );
      console.log(
        `Delegation report generated for ${protocol}: delegation/${delegationFileName}`
      );
      debug("[delegation] rows written", delegationRows.length);
    }
  }
}

main().catch(console.error);
