import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getClient } from "../utils/getClients";
import { BOTMARKET, PROTOCOLS_TOKENS, type SwapEvent } from "../utils/reportUtils";

const INPUT = "/tmp/fxn-swaps-completion.input.json";
const RESULT = process.env.JOB_RESULT_PATH || "/tmp/job_result.json";
const SOURCES = { votemarket_v1: "votemarket", votemarket_v2: "votemarket-v2", warden: "warden", hiddenhand: "hiddenhand" };
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export interface FxnCompletion {
  schema: number;
  chainId: number;
  protocol: string;
  epoch: number;
  laneId: string;
  pipelineRun: string | null;
  checkRunId: string;
  checkRunAttempt: string;
  guardCommit: string;
  sourceCommit: string;
  sourceDigest: string;
  sources: Record<string, { path: string; digest: string }>;
  fromBlock: number;
  checkedBlock: number;
  checkedBlockHash: `0x${string}`;
  confirmations: number;
  expected: Record<string, string>;
  sold: Record<string, string>;
  nativeFunded: string;
  nativeConverted: string;
  sdProduced: string;
  sdDelivered: string;
  remaining: Record<string, string>;
  delegated: Record<string, string>;
  transactions: Array<{
    hash: string;
    blockNumber: number;
    blockHash: string;
    logIndices: number[];
    sold: Record<string, string>;
    swaps: Array<{ logIndex: number; sellToken: string; amountIn: string; amountOut: string }>;
    nativeFunded: string;
    nativeBought: string;
    nativeConverted: string;
    sdProduced: string;
    sdDelivered: string;
  }>;
}

export function loadCompletion(file: string): FxnCompletion {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as FxnCompletion;
  if (value.schema !== 1 || value.chainId !== 1 || value.protocol !== "fxn" ||
      !Number.isSafeInteger(value.epoch) || value.epoch <= 0 || value.epoch % 604800 ||
      !SHA.test(value.guardCommit) || !SHA.test(value.sourceCommit) || !HASH.test(value.sourceDigest) ||
      !HASH.test(value.checkedBlockHash) || !HASH.test(value.laneId) ||
      !Number.isSafeInteger(value.fromBlock) || value.fromBlock <= 0 ||
      !Number.isSafeInteger(value.checkedBlock) || value.checkedBlock < value.fromBlock ||
      !Number.isSafeInteger(value.confirmations) || value.confirmations < 12 ||
      !Array.isArray(value.transactions) || Object.keys(value.remaining).length || Object.keys(value.delegated).length) {
    throw new Error("Invalid or incomplete FXN completion proof");
  }
  for (const field of ["nativeFunded", "nativeConverted", "sdProduced", "sdDelivered"] as const) {
    if (!UINT.test(value[field])) throw new Error(`Invalid FXN completion amount: ${field}`);
  }
  for (const amounts of [value.expected, value.sold]) {
    for (const [token, amount] of Object.entries(amounts)) {
      if (!/^0x[0-9a-f]{40}$/.test(token) || !UINT.test(amount)) throw new Error("Invalid FXN token amount");
    }
  }
  if (!value.sources.votemarket_v1 || !value.sources.votemarket_v2) throw new Error("Missing FXN claim sources");
  for (const [name, source] of Object.entries(value.sources)) {
    if (!(name in SOURCES) || source.path !== `weekly-bounties/${value.epoch}/${SOURCES[name as keyof typeof SOURCES]}/claimed_bounties.json`) {
      throw new Error("Invalid FXN source path");
    }
  }
  const seen = new Set<string>();
  for (const tx of value.transactions) {
    if (!HASH.test(tx.hash) || !HASH.test(tx.blockHash) || seen.has(tx.hash) ||
        !Number.isSafeInteger(tx.blockNumber) || tx.blockNumber < value.fromBlock || tx.blockNumber > value.checkedBlock) {
      throw new Error("Invalid FXN transaction evidence");
    }
    seen.add(tx.hash);
  }
  return value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function verifySources(proof: FxnCompletion, ref?: string): void {
  for (const [name, directory] of Object.entries(SOURCES)) {
    const file = `weekly-bounties/${proof.epoch}/${directory}/claimed_bounties.json`;
    const atRef = (revision: string) => {
      const entry = git("ls-tree", revision, "--", file);
      return entry ? git("rev-parse", `${revision}:${file}`) : null;
    };
    const expected = atRef(proof.sourceCommit);
    if (Boolean(expected) !== Boolean(proof.sources[name])) throw new Error(`FXN source set changed: ${file}`);
    const actual = ref ? atRef(ref) : fs.existsSync(file) ? git("hash-object", file) : null;
    if (actual !== expected) throw new Error(`FXN source changed: ${file}; run a fresh completion check`);
  }
}

export function verifyReportEvents(
  proof: FxnCompletion,
  inputs: SwapEvent[],
  outputs: SwapEvent[],
  swaps: Array<{ transactionHash?: string; logIndex: number; sellToken: string; amountIn: bigint; amountOut: bigint }>,
): void {
  const records = new Map(proof.transactions.map((tx) => [tx.hash, tx]));
  const native = PROTOCOLS_TOKENS.fxn.native.toLowerCase();
  const sd = PROTOCOLS_TOKENS.fxn.sdToken.toLowerCase();
  const botmarket = BOTMARKET.toLowerCase();
  const sum = (events: SwapEvent[], token: string, key: "from" | "to", address: string) =>
    events.filter((event) => event.token.toLowerCase() === token && event[key].toLowerCase() === address)
      .reduce((total, event) => total + event.amount, 0n);
  const sold: Record<string, bigint> = {};
  const seen = new Set<string>();
  for (const swap of swaps) {
    const hash = (swap.transactionHash || "").toLowerCase();
    const expected = records.get(hash)?.swaps.find((event) => event.logIndex === swap.logIndex);
    const id = `${hash}:${swap.logIndex}`;
    if (!expected || seen.has(id) || expected.sellToken !== swap.sellToken.toLowerCase() ||
        BigInt(expected.amountIn) !== swap.amountIn || BigInt(expected.amountOut) !== swap.amountOut) {
      throw new Error("Report contains an unverified FXN swap");
    }
    seen.add(id);
    const token = swap.sellToken.toLowerCase();
    sold[token] = (sold[token] || 0n) + swap.amountIn;
  }
  if (seen.size !== proof.transactions.reduce((count, tx) => count + tx.swaps.length, 0)) throw new Error("FXN report omits confirmed swaps");
  for (const token of new Set([...Object.keys(sold), ...Object.keys(proof.sold)])) {
    if ((sold[token] || 0n) !== BigInt(proof.sold[token] || "0")) throw new Error(`FXN sold amount differs: ${token}`);
  }
  if (sum(inputs, native, "from", botmarket) !== BigInt(proof.nativeFunded) ||
      sum(outputs, sd, "to", botmarket) !== BigInt(proof.sdDelivered)) {
    throw new Error("FXN report funding/delivery differs from confirmed completion");
  }
  for (const tx of proof.transactions) {
    const txInputs = inputs.filter((event) => event.transactionHash?.toLowerCase() === tx.hash);
    const txOutputs = outputs.filter((event) => event.transactionHash?.toLowerCase() === tx.hash);
    if (sum(txInputs, native, "from", botmarket) !== BigInt(tx.nativeFunded) ||
        sum(txOutputs, sd, "to", botmarket) !== BigInt(tx.sdDelivered)) {
      throw new Error(`FXN report transaction differs: ${tx.hash}`);
    }
  }
}

async function github(route: string): Promise<any> {
  const response = await fetch(`https://api.github.com/repos/stake-dao/automation-guard/${route}`, {
    headers: { Authorization: `Bearer ${process.env.GIT_ACCESS_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} reading FXN execution evidence`);
  return response.json();
}

async function download(): Promise<void> {
  const dispatch = process.env.DISPATCH_ID || "";
  const match = /^(fxn-swaps-guard:[0-9]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):step:report-[0-9]+$/.exec(dispatch);
  const explicit = process.env.CHECK_RUN_ID || "";
  if (explicit && !/^[1-9][0-9]*$/.test(explicit)) throw new Error("Invalid check_run_id");
  if ((!match && !/^[1-9][0-9]*$/.test(explicit)) || (dispatch && !match)) throw new Error("An exact Maestro run or check_run_id is required");
  let run: any;
  if (explicit) run = await github(`actions/runs/${explicit}`);
  else {
    for (let page = 1; page <= 10 && !run; page++) {
      const { workflow_runs: runs } = await github(`actions/workflows/fxn-swaps.yaml/runs?branch=main&event=workflow_dispatch&per_page=100&page=${page}`);
      if (!runs.length) break;
      for (const candidate of runs) {
        if (candidate.conclusion !== "success") continue;
        const { jobs } = await github(`actions/runs/${candidate.id}/attempts/${candidate.run_attempt}/jobs?per_page=100`);
        if (jobs.some((job: any) => job.steps?.some((step: any) =>
          step.name.startsWith(`dispatch_id:${match![1]}:step:check-`) && step.conclusion === "success"))) {
          run = candidate;
          break;
        }
      }
    }
  }
  if (!run || run.conclusion !== "success" || run.head_branch !== "main" || run.event !== "workflow_dispatch" ||
      run.path !== ".github/workflows/fxn-swaps.yaml" || !SHA.test(run.head_sha)) throw new Error("No successful main FXN completion check matches this run");
  const { artifacts } = await github(`actions/runs/${run.id}/artifacts?per_page=100`);
  const artifact = artifacts.find((item: any) => item.name === "fxn-swaps-completion" && !item.expired);
  if (!artifact) throw new Error("FXN completion artifact is missing or expired");
  const response = await fetch(`https://api.github.com/repos/stake-dao/automation-guard/actions/artifacts/${artifact.id}/zip`, {
    headers: { Authorization: `Bearer ${process.env.GIT_ACCESS_TOKEN}` },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} downloading FXN completion`);
  const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fxn-proof-")), "proof.zip");
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  fs.writeFileSync(INPUT, execFileSync("unzip", ["-p", archive, "fxn-swaps-completion.json"], { maxBuffer: 2 * 1024 * 1024 }));
  const proof = loadCompletion(INPUT);
  if (proof.checkRunId !== String(run.id) || proof.checkRunAttempt !== String(run.run_attempt) || proof.guardCommit !== run.head_sha ||
      (match && proof.pipelineRun !== match[1])) throw new Error("FXN completion artifact belongs to another run/attempt");
  verifySources(proof);
  fs.appendFileSync(process.env.GITHUB_OUTPUT!, `guard_commit=${proof.guardCommit}\nperiod=${proof.epoch}\n`);
}

async function publish(): Promise<void> {
  const proof = loadCompletion(INPUT);
  const folder = `bounties-reports/${proof.epoch}`;
  const files = [`${folder}/fxn.csv`, `${folder}/fxn-attribution.json`, `${folder}/raw/fxn/fxn.csv`, `${folder}/delegation/fxn.csv`];
  for (const file of files.slice(0, 2)) if (!fs.existsSync(file)) throw new Error(`Missing FXN output: ${file}`);
  const hashes = Object.fromEntries(files.map((file) => [file, fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null]));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    epoch: proof.epoch, sourceDigest: proof.sourceDigest, transactions: proof.transactions, expected: proof.expected, hashes,
  })).digest("hex");
  const proofPath = `${folder}/fxn-completion.json`;
  fs.writeFileSync(proofPath, JSON.stringify({ ...proof, reportFingerprint: fingerprint, outputs: hashes }, null, 2) + "\n");
  const client = await getClient(1);
  for (let attempt = 0; attempt < 3; attempt++) {
    git("fetch", "origin", "main");
    const head = git("rev-parse", "origin/main");
    verifySources(proof, head);
    const block = await client.getBlock({ blockNumber: BigInt(proof.checkedBlock) });
    if (block.hash !== proof.checkedBlockHash) throw new Error("FXN completion block was reorganized");
    const oldEntry = git("ls-tree", head, "--", proofPath);
    if (oldEntry) {
      const old = JSON.parse(git("show", `${head}:${proofPath}`));
      if (old.reportFingerprint === fingerprint && files.every((file) => {
        const entry = git("ls-tree", head, "--", file);
        return hashes[file] === null ? !entry : Boolean(entry) && createHash("sha256").update(execFileSync("git", ["show", `${head}:${file}`])).digest("hex") === hashes[file];
      })) {
        fs.writeFileSync(RESULT, JSON.stringify({ status: "noop", reason: "Identical verified FXN report already published", commitHash: head }));
        return;
      }
    }
    const env = { ...process.env, GIT_INDEX_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fxn-index-")), "index") };
    const indexGit = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8" }).trim();
    indexGit("read-tree", head);
    for (const file of [...files, proofPath]) {
      if (fs.existsSync(file)) indexGit("update-index", "--add", "--cacheinfo", `100644,${git("hash-object", "-w", file)},${file}`);
      else indexGit("update-index", "--force-remove", "--", file);
    }
    const tree = indexGit("write-tree");
    const commit = execFileSync("git", ["commit-tree", tree, "-p", head], { encoding: "utf8", input: `chore(fxn): publish verified weekly report for ${proof.epoch}\n` }).trim();
    try {
      git("push", "origin", `${commit}:refs/heads/main`);
      fs.writeFileSync(RESULT, JSON.stringify({ status: "executed", commitHash: commit }));
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

if (require.main === module) {
  const command = process.argv[2];
  Promise.resolve().then(() => {
    if (command === "fetch") return download();
    if (command === "publish") return publish();
    throw new Error("Expected fetch or publish");
  }).catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "fxn_completion_failed", command, reason }));
    fs.writeFileSync(RESULT, JSON.stringify({ status: "error", reason }));
    process.exitCode = 1;
  });
}
