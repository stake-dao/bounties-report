import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { erc20Abi, parseAbiItem, type Address, type PublicClient } from "viem";
import { ALL_MIGHT_V2, BOTMARKET } from "../../utils/reportUtils";
import { blockAtOrAfter } from "./reconstructSdMerkle";
import { readClaimLogs } from "./reportSources";
import { CSV_ROUNDING_WEI, reportAmount } from "./reportAmounts";
import { WEEK } from "../../utils/constants";

const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Curve's atomic conversion lane must consume the quantities printed in its report.
// FXN's separate funding/swap/conversion lane is checked by its completion proof.
export async function verifyCurveReportInputs(period: number, client: PublicClient): Promise<number> {
  const directory = `bounties-reports/${period}`;
  const rows = parse(readFileSync(`${directory}/curve.csv`, "utf8"), { columns: true, delimiter: ";", skip_empty_lines: true }) as Array<Record<string, string>>;
  const attribution = JSON.parse(readFileSync(`${directory}/curve-attribution.json`, "utf8")) as { txs: Array<{ tx: string }> };
  const transactions = new Set(attribution.txs.map((tx) => tx.tx.toLowerCase()));
  const [from, end] = await Promise.all([blockAtOrAfter(client, period), blockAtOrAfter(client, period + WEEK)]);
  const tokens = new Set(rows.map((row) => row["Reward Address"].toLowerCase()));
  for (const token of tokens) {
    const matching = rows.filter((row) => row["Reward Address"].toLowerCase() === token);
    const expected = matching.reduce((sum, row) => sum + reportAmount(row["Reward Amount"], `${token} reward amount`), 0n);
    const decimals = await client.readContract({ address: token as Address, abi: erc20Abi, functionName: "decimals" });
    const scale = 10n ** BigInt(decimals);
    const [incoming, outgoing] = await Promise.all([
      readClaimLogs(from, end, (fromBlock, toBlock) => client.getLogs({ address: token as Address, event: transfer, args: { to: ALL_MIGHT_V2 as Address }, fromBlock, toBlock, strict: true })),
      readClaimLogs(from, end, (fromBlock, toBlock) => client.getLogs({ address: token as Address, event: transfer, args: { from: ALL_MIGHT_V2 as Address }, fromBlock, toBlock, strict: true })),
    ]);
    let funded = 0n;
    let consumed = 0n;
    for (const log of incoming) {
      if (!transactions.has(log.transactionHash.toLowerCase())) continue;
      if (log.args.from.toLowerCase() === BOTMARKET.toLowerCase()) funded += log.args.value;
      else consumed -= log.args.value;
    }
    for (const log of outgoing) {
      if (!transactions.has(log.transactionHash.toLowerCase())) continue;
      if (log.args.to.toLowerCase() !== BOTMARKET.toLowerCase()) consumed += log.args.value;
    }
    const minimum = (expected - BigInt(matching.length) * CSV_ROUNDING_WEI) * scale;
    // Extra input can be previously accumulated dust; it does not imply missing rewards.
    if (funded * 10n ** 18n < minimum || consumed * 10n ** 18n < minimum) {
      throw new Error(`curve/${token}: reported reward quantity not fully consumed by attributed conversions (funded=${funded}, consumed=${consumed}, decimals=${decimals})`);
    }
  }
  return tokens.size;
}
