import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { erc20Abi, formatUnits, getAddress, keccak256, parseAbiItem, PublicClient } from "viem";
import { MerkleData } from "../interfaces/MerkleData";
import { verifyExpiryParent } from "../shared/merkle/expiry";
import { getClient } from "../utils/getClients";
import { sendTelegramMessage } from "../utils/telegramUtils";
import { fetchClaimed } from "../verify/invariants/preservation";
import { ABI, EXTRA, OWNER, RECIPIENT, Review, pairKey, refreshRecovery, safeBatch } from "./prepare";
import { monthlyPeriod, prepareMonthly } from "./monthly";
import configuration from "./config.json";

type Checker = { address: string; codeHash: string } | null;
const event = parseAbiItem("event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");

/** Resolve only reviewed-era artifacts; a missing publication stops preparation. */
export function loadRoot(review: Review, root: string): MerkleData {
  assert(/^0x[0-9a-f]{64}$/i.test(root), "invalid publication root");
  const extra = getAddress(review.distributor) === EXTRA;
  const directory = extra ? "merkl-toolkit/data/distributions" : "bounties-reports";
  const filename = extra ? "merkle.json" : `vlCVX/vlcvx_merkle${review.chainId === 1 ? "" : `_${review.chainId}`}.json`;
  const archive = extra ? "recovery/extra/roots" : "expiry/roots";
  const files = [review.sourceFile, `bounties-reports/${archive}/${review.chainId}/${root}.json`];
  if (fs.existsSync(directory)) for (const period of fs.readdirSync(directory).filter(p => /^\d+$/.test(p) && Number(p) >= review.cutoff).reverse()) {
    files.push(path.join(directory, period, filename));
  }
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const tree = read(file);
    if (tree.merkleRoot === root) { verifyExpiryParent(tree); return tree; }
  }
  throw new Error("Published root artifact unavailable; reconcile a new review");
}

export async function prepareOnchain(review: Review, source: MerkleData, client: PublicClient, checker: Checker, resolveRoot?: (root: string) => MerkleData) {
  assert.equal(source.merkleRoot, review.sourceRoot, "reviewed source root mismatch");
  let distribution = verifyExpiryParent(source);
  assert.equal(await client.getChainId(), review.chainId, "RPC chain mismatch");
  const block = await client.getBlock();
  const checkpoint = await client.getBlock({ blockNumber: BigInt(review.checkpoint.block) });
  assert.equal(checkpoint.hash, review.checkpoint.hash, "review checkpoint reorged");
  assert(block.number! >= checkpoint.number! && Number(block.timestamp) >= review.cutoff, "review is from the future");
  const address = getAddress(review.distributor);
  const at = { address, abi: ABI, blockNumber: block.number! };
  const root = await client.readContract({ ...at, functionName: "root" });
  const pending = await client.readContract({ ...at, functionName: "pendingRoot" });
  const context = { chainId: review.chainId, distributor: address, recipient: RECIPIENT, reviewedRoot: review.sourceRoot, sourceRoot: review.sourceRoot, activeRoot: root, pendingRoot: pending[0], pendingValidAt: pending[2].toString(), block: block.number!.toString(), blockHash: block.hash, cutoff: review.cutoff };
  if ((root !== review.sourceRoot && !resolveRoot) || pending[2] !== 0n) {
    return { ...context, status: "waiting", reason: "Reviewed source must be active with no pending root; do not reuse this review against another root" };
  }
  assert.equal(getAddress(await client.readContract({ ...at, functionName: "owner" })), OWNER, "distributor owner changed");
  const recipient = await client.readContract({ ...at, functionName: "recipients", args: [RECIPIENT] });
  assert(/^0x0{40}$/.test(recipient) || getAddress(recipient) === RECIPIENT, "DAO recipient is redirected");
  const original = source;
  let activated = await client.readContract({ ...at, functionName: "root", blockNumber: checkpoint.number! }) === review.sourceRoot;
  // Later distributions may add rewards, but no intermediate reduction or
  // missing artifact is allowed: it might be a recovery followed by a restore.
  for (let start = checkpoint.number! + 1n; start <= block.number!; start += 10000n) {
    const toBlock = start + 9999n < block.number! ? start + 9999n : block.number!;
    const logs = await client.getLogs({ address, event, fromBlock: start, toBlock });
    for (const log of logs) {
      assert(!log.removed && log.args.newRoot, "publication reorged");
      if (!activated) {
        assert.equal(log.args.newRoot, review.sourceRoot, "reviewed root was never activated");
        activated = true;
      }
      if (log.args.newRoot === source.merkleRoot) continue;
      assert(resolveRoot, "Intervening root change: reconcile a new review");
      const next = resolveRoot(log.args.newRoot);
      assert.equal(next.merkleRoot, log.args.newRoot, "publication artifact mismatch");
      const nextDistribution = verifyExpiryParent(next);
      for (const [account, tokens] of Object.entries(distribution)) for (const [token, amount] of Object.entries(tokens)) {
        assert(BigInt(nextDistribution[account]?.[token] ?? "0") >= BigInt(amount), "Intervening reduction: reconcile a new review");
      }
      source = next;
      distribution = nextDistribution;
    }
  }
  assert(activated && source.merkleRoot === root, "active root publication history incomplete");
  context.sourceRoot = source.merkleRoot;
  const keys = Object.entries(distribution).flatMap(([a, amounts]) => Object.keys(amounts).map(t => [a, t] as [string, string]));
  const reviewedKeys = review.rows.map(row => [getAddress(row.account), getAddress(row.token)] as [string, string]);
  const historical = await fetchClaimed(client, { target: "voters", chainId: review.chainId, distributor: address, pinnedBlock: checkpoint.number! }, reviewedKeys, 150);
  for (const row of review.rows) assert.equal(historical.get(pairKey(row.account, row.token))?.toString(), row.claimed, "reviewed claim snapshot mismatch");
  refreshRecovery(review, original, historical); // Original allowance must fit the approved tree, not later additions.
  review = { ...review, sourceRoot: source.merkleRoot };
  const tokens = [...new Set(keys.map(([, token]) => token))];
  for (const token of tokens) if (!keys.some(([account, t]) => account === RECIPIENT && token === t)) keys.push([RECIPIENT, token]);
  const claims = await fetchClaimed(client, { target: "voters", chainId: review.chainId, distributor: address, pinnedBlock: block.number! }, keys, 150);
  let recovery = refreshRecovery(review, source, claims);
  const deficits: { token: string; missing: string }[] = [];
  const amounts: { token: string; symbol: string; decimals: number; grossAmount: string; fundingOffset: string; amount: string; formatted: string }[] = [];
  for (const token of tokens) {
    const liability = keys.filter(([, t]) => t === token).reduce((sum, [account]) => {
      const due = BigInt(distribution[account]?.[token] ?? "0") - claims.get(pairKey(account, token))!;
      return sum + (due > 0n ? due : 0n);
    }, 0n);
    const balance = await client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: block.number! });
    if (balance < liability) deficits.push({ token, missing: (liability - balance).toString() });
    if (recovery.totals[token]) {
      const decimals = await client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "decimals", blockNumber: block.number! });
      const symbol = await client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "symbol", blockNumber: block.number! });
      amounts.push({ token, symbol, decimals, grossAmount: recovery.totals[token].toString(), fundingOffset: "0", amount: recovery.totals[token].toString(), formatted: formatUnits(recovery.totals[token], decimals) });
    }
  }
  const covered = deficits.every(d => BigInt(d.missing) <= (recovery.grossTotals[d.token] ?? 0n));
  const fundingOffsets: Record<string, bigint> = covered ? Object.fromEntries(deficits.map(d => [d.token, BigInt(d.missing)])) : {};
  if (Object.keys(fundingOffsets).length) {
    recovery = refreshRecovery(review, source, claims, fundingOffsets);
    for (const amount of amounts) {
      amount.fundingOffset = (fundingOffsets[amount.token] ?? 0n).toString();
      amount.amount = recovery.totals[amount.token].toString();
      amount.formatted = formatUnits(recovery.totals[amount.token], amount.decimals);
    }
  }
  assert.equal((await client.getBlock({ blockNumber: block.number! })).hash, block.hash, "snapshot reorged");
  const details = { ...context, recoveryRoot: recovery.merkle.merkleRoot, accounts: new Set(recovery.rows.map(row => row.account)).size, amounts, fundingOffsets, deficits: covered ? [] : deficits, recovery };
  if (!covered) return { ...details, status: "blocked", reason: "Funding deficits exceed newly recovered rewards; no Safe batch emitted" };
  if (!recovery.rows.length) return { ...details, status: "noop", reason: "No reviewed old rewards remain unclaimed" };
  if (!checker) return { ...details, status: "blocked", reason: "Stateless checker deployment needs review; no Safe batch emitted" };
  const code = await client.getBytecode({ address: getAddress(checker.address), blockNumber: block.number! });
  assert(code && keccak256(code) === checker.codeHash, "checker runtime differs from reviewed code");
  const batch = safeBatch(review, recovery, checker.address, Number(block.timestamp) * 1000);
  await client.call({ to: getAddress(checker.address), data: batch.transactions[0].data, blockNumber: block.number! });
  return { ...details, status: "awaiting-safe", reason: "Owner-approved immediate setRoot; no recovery timelock. Sign only as one atomic batch", batch };
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const poolNames: Record<string, string> = { "voters-1": "Ethereum · Voters", "voters-8453": "Base · Voters", "voters-42161": "Arbitrum · Voters", "extra-1": "Ethereum · Extra rewards" };
export function notification(pool: string, result: any, runUrl: string): string[] {
  const ready = result.status === "awaiting-safe";
  const status = ready ? "Ready for Safe review" : result.status === "blocked" ? "Blocked — do not sign" : result.status === "noop" ? "Nothing to recover" : "Waiting for distribution";
  const counts = result.accounts === undefined ? "" : `\n${result.accounts} accounts · ${result.amounts?.length ?? 0} tokens · recipient 5DAO`;
  const funding = result.deficits?.length ? "\n⚠ Uncovered deficit — see report." : Object.values(result.fundingOffsets ?? {}).some(value => BigInt(value as string) > 0n) ? "\nDeficit deduction applies to 5DAO only; see report." : "";
  const action = ready ? "Nothing executed. Review and sign the atomic Safe batch." : escape(String(result.reason).slice(0, 300));
  return [`<b>${escape(poolNames[pool] ?? pool)}</b>\n${status}${counts}${funding}\n\n${action}\n\nDetails and downloads:\n${escape(runUrl)}`];
}

function displayAmount(amount: string, decimals: number): string {
  const [whole, fraction = ""] = formatUnits(BigInt(amount), decimals).split(".");
  const approximate = /[1-9]/.test(fraction.slice(6));
  const shown = fraction.slice(0, 6).replace(/0+$/, "");
  if (whole === "0" && !shown && approximate) return "&lt;0.000001";
  return `${approximate ? "≈" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${shown ? `.${shown}` : ""}`;
}

export function recoverySummary(pool: string, result: any): string {
  const cell = (value: string) => escape(value).replace(/\|/g, "&#124;").replace(/[\r\n]/g, " ");
  const lines = [`## ${poolNames[pool] ?? pool}`, "", `**${result.status}** — ${cell(result.reason)}`, "", `Recipient: **5DAO** · Affected accounts: **${result.accounts ?? "not computed"}**`, "", "Amounts below use at most six decimals (≈ means truncated). Exact amounts, token addresses, proofs and Safe batches are in the run's downloadable recovery artifact."];
  if (result.amounts?.length) {
    lines.push("", "| Token | Gross recovery | Deficit deduction | Net 5DAO credit |", "| --- | ---: | ---: | ---: |");
    for (const token of result.amounts) lines.push(`| <code>${cell(token.symbol)}</code> | ${displayAmount(token.grossAmount, token.decimals)} | ${displayAmount(token.fundingOffset ?? "0", token.decimals)} | ${displayAmount(token.amount, token.decimals)} |`);
  }
  if (result.deficits?.length) {
    lines.push("", "**STOP: uncovered funding deficits. No Safe batch is ready for this pool.**", "", "| Token address | Missing raw units |", "| --- | ---: |");
    for (const deficit of result.deficits) lines.push(`| <code>${cell(deficit.token)}</code> | ${cell(deficit.missing)} |`);
  }
  lines.push("", "<details><summary>Technical details</summary>", "", `- Cutoff (UTC): ${new Date(result.cutoff * 1000).toISOString()}`, `- Snapshot block: ${result.block ?? "unavailable"}`, `- Source root: ${result.sourceRoot ?? "unavailable"}`, `- Recovery root: ${result.recoveryRoot ?? "not computed"}`, "", "</details>", "");
  return lines.join("\n");
}

export async function main(scope = process.argv[2] ?? "all", output = process.argv[3] ?? "/tmp/rewards-recovery", notify = process.argv.includes("--notify"), monthly = process.argv.includes("--monthly")) {
  assert(["all", "voters", "extra"].includes(scope), "scope must be all, voters or extra");
  let at = Math.floor(Date.now() / 1000);
  if (monthly && process.env.RECOVERY_PERIOD) {
    assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(process.env.RECOVERY_PERIOD), "invalid monthly period");
    const [year, month] = process.env.RECOVERY_PERIOD.split("-").map(Number);
    const window = monthlyPeriod(Date.UTC(year, month, 0, 23) / 1000);
    assert(window.cutoff <= at, "monthly window has not opened");
    at = window.cutoff;
  }
  fs.mkdirSync(output, { recursive: true });
  const results: any[] = [];
  for (const pool of configuration.pools.filter(p => scope === "all" || p.name.startsWith(scope))) {
    const directory = path.join(output, pool.name);
    fs.mkdirSync(directory, { recursive: true });
    for (const file of ["safe-batch.json", "recovery-merkle.json", "reductions.json", "review.json", "source-merkle.json", "ledger.json"]) fs.rmSync(path.join(directory, file), { force: true });
    let result: any;
    let review: Review | undefined;
    try {
      review = read(pool.review);
      const archive = `bounties-reports/recovery/${pool.name}`;
      const completed = fs.existsSync(archive) && fs.readdirSync(archive).filter(file => file.endsWith(".json")).map(file => read(path.join(archive, file))).find(entry =>
        entry.review.sourceRoot === review!.sourceRoot && entry.review.checkpoint.hash === review!.checkpoint.hash);
      if (monthly) {
        const client = await getClient(review!.chainId);
        const prepared = await prepareMonthly(review!, client, at, archive);
        if (!("review" in prepared)) result = prepared;
        else {
          review = prepared.review;
          save(path.join(directory, "review.json"), review);
          save(path.join(directory, "source-merkle.json"), prepared.source);
          save(path.join(directory, "ledger.json"), prepared.ledger);
          const checker = (configuration.checkers as Record<string, Checker>)[String(review.chainId)];
          result = await prepareOnchain(review, prepared.source, client, checker);
          result.period = review.period;
        }
      } else if (completed) {
        result = { status: "noop", reason: "Reviewed round already adopted; new eligibility needs a new review", cutoff: review!.cutoff, recoveryRoot: completed.recoveryRoot };
      } else {
        const checker = (configuration.checkers as Record<string, Checker>)[String(review!.chainId)];
        result = await prepareOnchain(review!, loadRoot(review!, review!.sourceRoot), await getClient(review!.chainId), checker, root => loadRoot(review!, root));
      }
      if (result.recovery) {
        save(path.join(directory, "recovery-merkle.json"), result.recovery.merkle);
        save(path.join(directory, "reductions.json"), result.recovery.rows);
      }
      if (result.batch) save(path.join(directory, "safe-batch.json"), result.batch);
      delete result.recovery;
      delete result.batch;
    } catch (error) {
      // RPC/HTTP exceptions can embed credential-bearing URLs. Keep them out of
      // Actions logs and Telegram; the failing pool must be investigated locally.
      const reason = error instanceof assert.AssertionError ? error.message.split("\n")[0] : "Check reviewed inputs and RPC state";
      result = { status: "blocked", reason: `Preparation failed; no Safe batch emitted. ${reason}`, cutoff: review?.cutoff ?? 0 };
    }
    save(path.join(directory, "report.json"), result);
    results.push({ pool: pool.name, ...result });
    console.log(`${pool.name}: ${result.status} — ${result.reason}`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, recoverySummary(pool.name, result) + "\n");
    if (notify && result.status !== "noop") {
      const url = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "Local preparation";
      for (const message of notification(pool.name, result, url)) await sendTelegramMessage(message, "HTML", true);
    }
  }
  save(path.join(output, "report.json"), results);
  if (results.some(r => r.status === "blocked")) process.exitCode = 2;
}

if (require.main === module) main().catch(() => { console.error("Recovery preparation or notification failed"); process.exitCode = 1; });
