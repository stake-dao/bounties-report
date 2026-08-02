// ABOUTME: Applies a manifest-defined residual WETH catch-up to one protocol report
// ABOUTME: Preserves token provenance and records the cleanup in the attribution sidecar

import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WEI_DECIMALS = 18;
const DRY_RUN_SD_RECEIVED_WEI = 6172n * 10n ** 18n;
const RELATIVE_TOLERANCE_DENOMINATOR = 1_000_000_000n;

interface Manifest {
  protocol: string;
  period: number;
  cleanupTxHash: string;
  actualSdReceivedWei: string;
  totalResidualWethWei: bigint;
  residualWethByTokenWei: Map<string, bigint>;
}

interface CLIOptions {
  manifestPath: string;
  dryRun: boolean;
}

interface CSVRow {
  fields: string[];
  lineNumber: number;
  rewardSdValue: bigint;
}

interface ParsedCSV {
  header: string[];
  rows: CSVRow[];
  rewardTokenIndex: number;
  rewardAddressIndex: number;
  rewardSdValueIndex: number;
  sharePercentageIndex: number;
  rewardSdDecimals: number;
  sharePercentageDecimals: number;
}

interface TokenAllocation {
  address: string;
  residualWethWei: bigint;
  sdWei: bigint;
}

interface RowAllocation {
  rowIndex: number;
  tokenAddress: string;
  delta: bigint;
}

type JSONObject = Record<string, unknown>;

function usage(): string {
  return `Usage: pnpm tsx script/reports/applyResidualCatchup.ts --manifest <path> [--dry-run]

Options:
  --manifest <path>  Residual catch-up manifest to apply
  --dry-run          Validate and print allocations without writing files`;
}

function parseArgs(args: string[]): CLIOptions {
  let manifestPath: string | undefined;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--manifest") {
      if (manifestPath || !args[index + 1] || args[index + 1].startsWith("--")) {
        throw new Error(`--manifest requires exactly one path\n\n${usage()}`);
      }
      manifestPath = path.resolve(args[index + 1]);
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }

  if (!manifestPath) {
    throw new Error(`Missing required --manifest argument\n\n${usage()}`);
  }

  return { manifestPath, dryRun };
}

function readJSONObject(filePath: string, label: string): JSONObject {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${String(error)}`);
  }

  if (!isJSONObject(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }

  return parsed;
}

function isJSONObject(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  object: JSONObject,
  field: string,
  label: string
): string {
  const value = object[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }
  return value;
}

function parseUnsignedInteger(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }

  return BigInt(value);
}

function parseManifest(filePath: string): Manifest {
  const raw = readJSONObject(filePath, "Manifest");
  const protocol = requireString(raw, "protocol", "Manifest");
  const period = raw.period;

  if (!/^[a-z0-9_-]+$/i.test(protocol)) {
    throw new Error("Manifest.protocol contains unsupported characters");
  }
  if (typeof period !== "number" || !Number.isSafeInteger(period) || period <= 0) {
    throw new Error("Manifest.period must be a positive safe integer");
  }

  const cleanupTxHash = requireString(raw, "cleanupTxHash", "Manifest");
  const actualSdReceivedWei = requireString(
    raw,
    "actualSdReceivedWei",
    "Manifest"
  );
  const totalResidualWethWei = parseUnsignedInteger(
    raw.totalResidualWethWei,
    "Manifest.totalResidualWethWei"
  );
  const rawByToken = raw.residualWethByTokenWei;

  if (!isJSONObject(rawByToken) || Object.keys(rawByToken).length === 0) {
    throw new Error(
      "Manifest.residualWethByTokenWei must be a non-empty object"
    );
  }

  const residualWethByTokenWei = new Map<string, bigint>();
  const normalizedAddresses = new Set<string>();
  for (const [address, value] of Object.entries(rawByToken)) {
    const normalizedAddress = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalizedAddress)) {
      throw new Error(`Invalid manifest token address: ${address}`);
    }
    if (normalizedAddresses.has(normalizedAddress)) {
      throw new Error(`Duplicate manifest token address: ${address}`);
    }

    const residualWei = parseUnsignedInteger(
      value,
      `Manifest.residualWethByTokenWei.${address}`
    );
    if (residualWei === 0n) {
      throw new Error(`Residual WETH share must be positive for ${address}`);
    }

    normalizedAddresses.add(normalizedAddress);
    residualWethByTokenWei.set(address, residualWei);
  }

  if (totalResidualWethWei === 0n) {
    throw new Error("Manifest.totalResidualWethWei must be positive");
  }

  return {
    protocol,
    period,
    cleanupTxHash,
    actualSdReceivedWei,
    totalResidualWethWei,
    residualWethByTokenWei,
  };
}

function decimalPlaces(value: string, label: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} is not a non-negative decimal: ${value}`);
  }
  return value.includes(".") ? value.length - value.indexOf(".") - 1 : 0;
}

function parseDecimal(value: string, scale: number, label: string): bigint {
  const places = decimalPlaces(value, label);
  if (places > scale) {
    throw new Error(`${label} has more than ${scale} decimal places`);
  }

  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(scale, "0"));
}

function parseCSV(filePath: string): ParsedCSV {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV report not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8").trimEnd();
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error(`CSV report has no data rows: ${filePath}`);
  }

  const header = lines[0].split(";");
  const rewardTokenIndex = header.indexOf("Reward Token");
  const rewardAddressIndex = header.indexOf("Reward Address");
  const rewardSdValueIndex = header.indexOf("Reward sd Value");
  const sharePercentageIndex = header.indexOf("Share % per Protocol");

  if (
    rewardTokenIndex === -1 ||
    rewardAddressIndex === -1 ||
    rewardSdValueIndex === -1 ||
    sharePercentageIndex === -1
  ) {
    throw new Error(`CSV report has an unsupported header: ${filePath}`);
  }

  const rawRows = lines.slice(1).map((line, index) => {
    const fields = line.split(";");
    if (fields.length !== header.length) {
      throw new Error(
        `CSV row ${index + 2} has ${fields.length} columns; expected ${header.length}`
      );
    }
    return { fields, lineNumber: index + 2 };
  });

  const rewardSdDecimals = Math.max(
    ...rawRows.map((row) =>
      decimalPlaces(
        row.fields[rewardSdValueIndex],
        `CSV row ${row.lineNumber} Reward sd Value`
      )
    )
  );
  const sharePercentageDecimals = Math.max(
    ...rawRows.map((row) =>
      decimalPlaces(
        row.fields[sharePercentageIndex],
        `CSV row ${row.lineNumber} Share % per Protocol`
      )
    )
  );

  return {
    header,
    rows: rawRows.map((row) => ({
      ...row,
      rewardSdValue: parseDecimal(
        row.fields[rewardSdValueIndex],
        rewardSdDecimals,
        `CSV row ${row.lineNumber} Reward sd Value`
      ),
    })),
    rewardTokenIndex,
    rewardAddressIndex,
    rewardSdValueIndex,
    sharePercentageIndex,
    rewardSdDecimals,
    sharePercentageDecimals,
  };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Cannot divide by a non-positive value");
  }
  return (numerator + denominator / 2n) / denominator;
}

function roundToScale(
  value: bigint,
  sourceScale: number,
  targetScale: number
): bigint {
  if (sourceScale === targetScale) return value;
  if (sourceScale < targetScale) {
    return value * pow10(targetScale - sourceScale);
  }

  return roundDivide(value, pow10(sourceScale - targetScale));
}

function formatDecimal(
  value: bigint,
  sourceScale: number,
  targetScale: number,
  trimTrailingZeroes = false
): string {
  const rounded = roundToScale(value, sourceScale, targetScale);
  if (targetScale === 0) return rounded.toString();

  const base = pow10(targetScale);
  const whole = rounded / base;
  const fraction = (rounded % base).toString().padStart(targetScale, "0");
  const formatted = `${whole}.${fraction}`;

  if (!trimTrailingZeroes) return formatted;
  return formatted.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function findLargestEntry<T>(
  entries: T[],
  valueOf: (entry: T) => bigint
): T {
  if (entries.length === 0) {
    throw new Error("Cannot select the largest item from an empty list");
  }

  return entries.slice(1).reduce(
    (largest, entry) =>
      valueOf(entry) > valueOf(largest) ? entry : largest,
    entries[0]
  );
}

function allocateByResidualShare(
  manifest: Manifest,
  actualSdReceivedWei: bigint
): TokenAllocation[] {
  const allocations = Array.from(
    manifest.residualWethByTokenWei,
    ([address, residualWethWei]) => ({
      address,
      residualWethWei,
      sdWei:
        (actualSdReceivedWei * residualWethWei) /
        manifest.totalResidualWethWei,
    })
  );
  const allocated = allocations.reduce((sum, item) => sum + item.sdWei, 0n);
  const remainder = actualSdReceivedWei - allocated;
  const largest = findLargestEntry(allocations, (item) => item.residualWethWei);
  largest.sdWei += remainder;

  return allocations;
}

function allocateAcrossRows(
  csv: ParsedCSV,
  tokenAllocations: TokenAllocation[],
  mathScale: number
): RowAllocation[] {
  const weiToMathMultiplier = pow10(mathScale - WEI_DECIMALS);
  const allocations: RowAllocation[] = [];

  for (const token of tokenAllocations) {
    const normalizedAddress = token.address.toLowerCase();
    const matchingRows = csv.rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(
        ({ row }) =>
          row.fields[csv.rewardAddressIndex].trim().toLowerCase() ===
          normalizedAddress
      );

    gate(
      matchingRows.length > 0,
      `CSV rows for ${token.address}`,
      `${matchingRows.length} matching row(s)`
    );

    const totalWeight = matchingRows.reduce(
      (sum, { row }) => sum + row.rewardSdValue,
      0n
    );
    if (totalWeight <= 0n) {
      throw new Error(
        `Matching CSV rows for ${token.address} have no positive Reward sd Value weight`
      );
    }

    const tokenDelta = token.sdWei * weiToMathMultiplier;
    const tokenRows = matchingRows.map(({ row, rowIndex }) => ({
      rowIndex,
      tokenAddress: token.address,
      delta: (tokenDelta * row.rewardSdValue) / totalWeight,
      weight: row.rewardSdValue,
    }));
    const allocated = tokenRows.reduce((sum, item) => sum + item.delta, 0n);
    const largest = findLargestEntry(tokenRows, (item) => item.weight);
    largest.delta += tokenDelta - allocated;

    allocations.push(
      ...tokenRows.map(({ rowIndex, tokenAddress, delta }) => ({
        rowIndex,
        tokenAddress,
        delta,
      }))
    );
  }

  return allocations;
}

function gate(condition: boolean, label: string, detail: string): void {
  if (!condition) {
    throw new Error(`${label} gate failed: ${detail}`);
  }
  console.log(`✅ ${label}: ${detail}`);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function numberFromWei(value: bigint, label: string): number {
  const converted = Number(
    formatDecimal(value, WEI_DECIMALS, WEI_DECIMALS, true)
  );
  if (!Number.isFinite(converted)) {
    throw new Error(`${label} is too large to store in the attribution sidecar`);
  }
  return converted;
}

function readSidecar(
  sidecarPath: string,
  manifest: Manifest
): {
  sidecar: JSONObject;
  totals: JSONObject;
  cleanupTransactions: unknown[];
} {
  const sidecar = readJSONObject(sidecarPath, "Attribution sidecar");
  if (
    sidecar.protocol !== manifest.protocol ||
    sidecar.period !== manifest.period
  ) {
    throw new Error(
      "Attribution sidecar protocol/period does not match the manifest"
    );
  }
  if (!isJSONObject(sidecar.totals)) {
    throw new Error("Attribution sidecar totals must be an object");
  }
  if (
    typeof sidecar.totals.sdInTotal !== "number" ||
    !Number.isFinite(sidecar.totals.sdInTotal) ||
    typeof sidecar.totals.sdAssigned !== "number" ||
    !Number.isFinite(sidecar.totals.sdAssigned)
  ) {
    throw new Error(
      "Attribution sidecar totals.sdInTotal and totals.sdAssigned must be finite numbers"
    );
  }
  if (
    sidecar.cleanupTransactions !== undefined &&
    !Array.isArray(sidecar.cleanupTransactions)
  ) {
    throw new Error("Attribution sidecar cleanupTransactions must be an array");
  }

  return {
    sidecar,
    totals: sidecar.totals,
    cleanupTransactions: sidecar.cleanupTransactions || [],
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifest = parseManifest(options.manifestPath);
  const residualSum = Array.from(
    manifest.residualWethByTokenWei.values()
  ).reduce((sum, value) => sum + value, 0n);

  gate(
    residualSum === manifest.totalResidualWethWei,
    "Manifest residual sum",
    `sum=${residualSum} expected=${manifest.totalResidualWethWei}`
  );

  const pendingSd = manifest.actualSdReceivedWei.toUpperCase() === "PENDING";
  const pendingTx = manifest.cleanupTxHash.toUpperCase() === "PENDING";
  if (!options.dryRun && (pendingSd || pendingTx)) {
    throw new Error(
      "Manifest actualSdReceivedWei and cleanupTxHash must be finalized before a write run"
    );
  }

  const actualSdReceivedWei = pendingSd
    ? DRY_RUN_SD_RECEIVED_WEI
    : parseUnsignedInteger(
        manifest.actualSdReceivedWei,
        "Manifest.actualSdReceivedWei"
      );
  if (actualSdReceivedWei === 0n) {
    throw new Error("Manifest.actualSdReceivedWei must be positive");
  }
  if (pendingSd) {
    console.log(
      `ℹ️  Dry-run placeholder sd received: ${formatDecimal(
        actualSdReceivedWei,
        WEI_DECIMALS,
        WEI_DECIMALS,
        true
      )} (${actualSdReceivedWei} wei)`
    );
  }

  const reportDirectory = path.join(
    PROJECT_ROOT,
    "bounties-reports",
    manifest.period.toString()
  );
  const csvPath = path.join(reportDirectory, `${manifest.protocol}.csv`);
  const sidecarPath = path.join(
    reportDirectory,
    `${manifest.protocol}-attribution.json`
  );
  const csv = parseCSV(csvPath);
  const { sidecar, totals, cleanupTransactions } = readSidecar(
    sidecarPath,
    manifest
  );

  if (pendingTx) {
    gate(
      options.dryRun,
      "Cleanup transaction idempotency",
      "cleanupTxHash is PENDING and is permitted only for dry-run"
    );
  } else {
    const alreadyApplied = cleanupTransactions.some(
      (entry) =>
        isJSONObject(entry) &&
        typeof entry.tx === "string" &&
        entry.tx.toLowerCase() === manifest.cleanupTxHash.toLowerCase()
    );
    gate(
      !alreadyApplied,
      "Cleanup transaction idempotency",
      alreadyApplied
        ? `${manifest.cleanupTxHash} is already listed`
        : `${manifest.cleanupTxHash} is not yet listed`
    );
  }

  const tokenAllocations = allocateByResidualShare(
    manifest,
    actualSdReceivedWei
  );
  const allocatedSdWei = tokenAllocations.reduce(
    (sum, item) => sum + item.sdWei,
    0n
  );
  gate(
    allocatedSdWei === actualSdReceivedWei,
    "Per-token sd allocation",
    `sum=${allocatedSdWei} expected=${actualSdReceivedWei}`
  );

  const mathScale = Math.max(WEI_DECIMALS, csv.rewardSdDecimals);
  const csvToMathMultiplier = pow10(mathScale - csv.rewardSdDecimals);
  const weiToMathMultiplier = pow10(mathScale - WEI_DECIMALS);
  const rowAllocations = allocateAcrossRows(csv, tokenAllocations, mathScale);
  const allocationByRow = new Map(
    rowAllocations.map((allocation) => [allocation.rowIndex, allocation])
  );

  const updatedExactValues = csv.rows.map((row, rowIndex) => {
    const oldValue = row.rewardSdValue * csvToMathMultiplier;
    return oldValue + (allocationByRow.get(rowIndex)?.delta || 0n);
  });
  const renderedValues = updatedExactValues.map((value) =>
    formatDecimal(value, mathScale, csv.rewardSdDecimals)
  );
  const renderedScaledValues = renderedValues.map((value, rowIndex) =>
    parseDecimal(
      value,
      csv.rewardSdDecimals,
      `Rendered CSV row ${csv.rows[rowIndex].lineNumber} Reward sd Value`
    )
  );
  const oldGrandTotal = csv.rows.reduce(
    (sum, row) => sum + row.rewardSdValue * csvToMathMultiplier,
    0n
  );
  const newGrandTotal = renderedScaledValues.reduce(
    (sum, value) => sum + value * csvToMathMultiplier,
    0n
  );
  const expectedGrandTotal =
    oldGrandTotal + actualSdReceivedWei * weiToMathMultiplier;
  const grandTotalDifference = absolute(newGrandTotal - expectedGrandTotal);
  const withinTolerance =
    grandTotalDifference * RELATIVE_TOLERANCE_DENOMINATOR <=
    absolute(expectedGrandTotal);
  gate(
    withinTolerance,
    "CSV grand total",
    `old=${formatDecimal(
      oldGrandTotal,
      mathScale,
      csv.rewardSdDecimals
    )} new=${formatDecimal(
      newGrandTotal,
      mathScale,
      csv.rewardSdDecimals
    )} expected=${formatDecimal(
      expectedGrandTotal,
      mathScale,
      WEI_DECIMALS,
      true
    )} difference=${formatDecimal(
      grandTotalDifference,
      mathScale,
      WEI_DECIMALS,
      true
    )}`
  );

  const updatedRows = csv.rows.map((row, rowIndex) => {
    const fields = [...row.fields];
    fields[csv.rewardSdValueIndex] = renderedValues[rowIndex];
    fields[csv.sharePercentageIndex] = formatDecimal(
      roundDivide(
        renderedScaledValues[rowIndex] *
          100n *
          pow10(csv.sharePercentageDecimals),
        renderedScaledValues.reduce((sum, value) => sum + value, 0n)
      ),
      csv.sharePercentageDecimals,
      csv.sharePercentageDecimals
    );
    return fields;
  });
  const updatedCSV = [csv.header, ...updatedRows]
    .map((fields) => fields.join(";"))
    .join("\n");

  const tokenDeltaTable = tokenAllocations.map((allocation) => ({
    token: csv.rows.find(
      (row) =>
        row.fields[csv.rewardAddressIndex].trim().toLowerCase() ===
        allocation.address.toLowerCase()
    )?.fields[csv.rewardTokenIndex],
    address: allocation.address,
    residualWeth: formatDecimal(
      allocation.residualWethWei,
      WEI_DECIMALS,
      WEI_DECIMALS,
      true
    ),
    sdDelta: formatDecimal(
      allocation.sdWei,
      WEI_DECIMALS,
      WEI_DECIMALS,
      true
    ),
  }));
  const rowDeltaTable = rowAllocations.map((allocation) => {
    const row = csv.rows[allocation.rowIndex];
    return {
      token: row.fields[csv.rewardTokenIndex],
      address: allocation.tokenAddress,
      row: row.lineNumber,
      gauge: row.fields[0].trim(),
      oldSd: formatDecimal(
        row.rewardSdValue,
        csv.rewardSdDecimals,
        csv.rewardSdDecimals
      ),
      sdDelta: formatDecimal(
        allocation.delta,
        mathScale,
        WEI_DECIMALS,
        true
      ),
      newSd: renderedValues[allocation.rowIndex],
    };
  });

  console.log("\nPer-token deltas");
  console.table(tokenDeltaTable);
  console.log("Per-row deltas");
  console.table(rowDeltaTable);

  const perTokenSd = Object.fromEntries(
    tokenAllocations.map((allocation) => [
      allocation.address.toLowerCase(),
      numberFromWei(allocation.sdWei, `sd allocation for ${allocation.address}`),
    ])
  );
  const residualWethConsumed = Object.fromEntries(
    tokenAllocations.map((allocation) => [
      allocation.address.toLowerCase(),
      numberFromWei(
        allocation.residualWethWei,
        `residual WETH for ${allocation.address}`
      ),
    ])
  );
  const residualWethByToken = Object.fromEntries(
    tokenAllocations.map((allocation) => [
      allocation.address.toLowerCase(),
      0,
    ])
  );
  const actualSdReceived = numberFromWei(
    actualSdReceivedWei,
    "actual sd received"
  );
  const updatedSidecar = {
    ...sidecar,
    totals: {
      ...totals,
      sdInTotal: (totals.sdInTotal as number) + actualSdReceived,
      sdAssigned: (totals.sdAssigned as number) + actualSdReceived,
    },
    cleanupTransactions: [
      ...cleanupTransactions,
      {
        tx: manifest.cleanupTxHash,
        sdReceived: actualSdReceived,
        perTokenSd,
        residualWethConsumed,
      },
    ],
    residualWethByToken,
  };

  if (options.dryRun) {
    console.log("\n✅ Dry-run complete: all gates passed; no files written.");
    return;
  }

  fs.writeFileSync(csvPath, updatedCSV, "utf-8");
  fs.writeFileSync(
    sidecarPath,
    `${JSON.stringify(updatedSidecar, null, 2)}\n`,
    "utf-8"
  );
  console.log(`\n✅ Updated ${csvPath}`);
  console.log(`✅ Updated ${sidecarPath}`);
}

try {
  main();
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
