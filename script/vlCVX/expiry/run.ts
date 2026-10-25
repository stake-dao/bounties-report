import fs from "fs";
import path from "path";
import { utils } from "ethers";
import { Abi, Address, parseAbi } from "viem";
import expiryAbi from "../../../abis/RewardsExpiry.json";
import policies from "./policy.json";
import deployments from "./deployment.json";
import extraPolicies from "../../extraRewards/expiry/policy.json";
import extraDeployments from "../../extraRewards/expiry/deployment.json";
import { expiryDigest, expiryEffectiveAt, expiryRound, EXPIRY_DISTRIBUTOR, EXTRA_REWARDS_DISTRIBUTOR, ExpiryPolicy, PreparedExpiry, PreparedRound, prepareExpiryRound, preparePlannedExpiry, expiryPlanDigest, isEligibleForExpiry, syncExpiryClaims, verifyExpiryParent, writeExpiryInput } from "../../shared/merkle/expiry";
import { getClient } from "../../utils/getClients";
import { getTokenPrices, LLAMA_NETWORK_MAPPING } from "../../utils/priceUtils";
import { ALL_MIGHT_V2 } from "../../utils/constants";
import { readLedgerClaims, replayExpiryJournal } from "./journal";
import { readActiveVotersMerkle } from "./active";
import { readExpiryRound } from "./round";

const iface = new utils.Interface(expiryAbi);
const URD_ABI = parseAbi(["function root() view returns(bytes32)", "function pendingRoot() view returns(bytes32,bytes32,uint256)", "function owner() view returns(address)", "function timelock() view returns(uint256)"]);
const BASE = "https://raw.githubusercontent.com/stake-dao/bounties-report/main/";

export async function main(action = process.argv[2], chain = process.argv[3], target = process.argv[4] ?? process.env.EXPIRY_TARGET ?? "vlcvx") {
  const chainId = Number(chain);
  if (!["plan", "prepare", "activate", "record"].includes(action) || ![1, 8453, 42161].includes(chainId)) throw new Error("run.ts <plan|prepare|activate|record> <1|8453|42161>");
  if (!["vlcvx", "extra"].includes(target) || (target === "extra" && chainId !== 1)) throw new Error("expiry target");
  const distributorAddress = target === "extra" ? EXTRA_REWARDS_DISTRIBUTOR : EXPIRY_DISTRIBUTOR;
  const base = target === "extra" ? "bounties-reports/expiry/extra" : "bounties-reports/expiry";
  const policy = ((target === "extra" ? extraPolicies : policies) as Record<string, ExpiryPolicy | null>)[chain];
  const deployment = ((target === "extra" ? extraDeployments : deployments) as Record<string, (PreparedExpiry["module"] & { codeHash: string }) | null>)[chain];
  const result = (value: unknown) => fs.writeFileSync("expiry-job.json", JSON.stringify(value, null, 2) + "\n");
  if (!policy || !deployment) { result({ status: "disabled", chainId, reason: "policy and reviewed deployment are required" }); return; }
  const client = await getClient(chainId);
  if (await client.getChainId() !== chainId) throw new Error("expiry RPC chain");
  const code = await client.getBytecode({ address: deployment.address as Address });
  if (!code || utils.keccak256(code) !== deployment.codeHash) throw new Error("reviewed module code mismatch");
  const [preparer, safe, treasury, distributor, moduleDelay] = await Promise.all(["PREPARER", "SAFE", "TREASURY", "DISTRIBUTOR", "DELAY"].map(functionName => client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName })));
  if (deployment.preparer?.toLowerCase() !== ALL_MIGHT_V2.toLowerCase() || String(preparer).toLowerCase() !== deployment.preparer.toLowerCase() || String(safe).toLowerCase() !== deployment.safe.toLowerCase() || String(treasury).toLowerCase() !== policy.treasury.toLowerCase() || String(distributor).toLowerCase() !== distributorAddress.toLowerCase() || Number(moduleDelay) !== deployment.delay) throw new Error("reviewed module domain mismatch");
  const domain = { address: deployment.address, safe: deployment.safe, preparer: deployment.preparer, delay: deployment.delay };
  const directory = path.join(base, "state", chain);
  fs.mkdirSync(directory, { recursive: true });
  const bootstrap = path.join(directory, "bootstrap.json");
  const baseline = JSON.parse(fs.readFileSync(`${base}/bootstrap/${chain}/ledger.json`, "utf8"));
  if (!fs.existsSync(bootstrap)) writeExpiryInput(bootstrap, baseline);
  if (JSON.stringify(JSON.parse(fs.readFileSync(bootstrap, "utf8"))) !== JSON.stringify(baseline)) throw new Error("state differs from reviewed bootstrap");
  if (baseline.distributor !== distributorAddress) throw new Error("bootstrap distributor mismatch");
  const ledger = await replayExpiryJournal(client, directory, domain);
  if (action === "record") { result({ status: "recorded", chainId, root: ledger.root, checkpoint: ledger.checkpoint }); return; }
  const checkpoint = await client.getBlock({ blockTag: "finalized" });
  const claims = await readLedgerClaims(client, ledger, checkpoint.number!);
  const state = syncExpiryClaims(ledger, claims);
  const checkpointTime = Number(checkpoint.timestamp);
  state.checkpoint = { block: Number(checkpoint.number), blockHash: checkpoint.hash! };
  const root = await client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "root" });
  if (root !== state.root) { result({ status: "waiting", chainId, reason: "active root is not finalized" }); return; }
  const [activeRound, nextBatch, complete] = await Promise.all(["round", "nextBatch", "complete"].map(functionName =>
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName })));
  const recorded = state.runs[String(activeRound)];
  if (Number(nextBatch) > (recorded?.nextBatch ?? 0) || (complete && !recorded?.complete)) {
    result({ status: "waiting", chainId, reason: "expiry activation is not finalized" }); return;
  }
  const parent = await readActiveVotersMerkle(chainId, state.root, client, distributorAddress);
  const rootsDir = path.join(base, "roots", chain);
  fs.mkdirSync(rootsDir, { recursive: true });
  writeExpiryInput(path.join(rootsDir, `${state.root.toLowerCase()}.json`), parent);
  const roundSource = await readExpiryRound(client);
  const preparedDir = path.join(directory, "prepared");
  fs.mkdirSync(preparedDir, { recursive: true });
  const plansDir = path.join(directory, "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  const [proposed, expectedRoot] = await Promise.all([
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "proposal" }),
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "expectedRoot" }),
  ]);
  const canonicalState = async (checkpoint: PreparedExpiry["state"]["checkpoint"]) => {
    const canonical = await replayExpiryJournal(client, directory, domain, checkpoint);
    const block = await client.getBlock({ blockNumber: BigInt(checkpoint.block) });
    const historical = syncExpiryClaims(canonical, await readLedgerClaims(client, canonical, block.number!));
    historical.checkpoint = { block: Number(block.number), blockHash: block.hash! };
    return { historical, at: Number(block.timestamp) };
  };
  const plans: PreparedRound[] = fs.readdirSync(plansDir).filter(file => file.endsWith(".json")).map(file =>
    JSON.parse(fs.readFileSync(path.join(plansDir, file), "utf8")));
  let plan: PreparedRound | null = plans.find(candidate => expiryPlanDigest(candidate) === proposed) ?? null;
  if (!plan && !/^0x0{64}$/.test(String(proposed))) throw new Error("immutable expiry round missing");
  const committedRound = plan && !state.runs[String(plan.plan.round)]?.complete ? plan.plan.round : null;
  if (expectedRoot !== root || committedRound === null) plan = null;
  const round = committedRound ?? expiryRound(state, roundSource.round);
  const run = state.runs[String(round)];
  if (run?.complete) { result({ status: "complete", chainId, round }); return; }
  if (committedRound === null && !run && (state.lastDistributionAt ?? 0) < roundSource.startsAt) {
    result({ status: "waiting", chainId, round, reason: "no finalized ordinary distribution this month" }); return;
  }
  const pendingRoot = await client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "pendingRoot" });
  if (pendingRoot[2] !== 0n) { result({ status: "waiting", chainId, round, reason: "distributor root is pending" }); return; }
  const batchIndex = run?.nextBatch ?? 0;
  plan ??= plans.find(candidate => candidate.plan.round === round && candidate.plan.index === batchIndex && candidate.plan.parent === root) ?? null;
  if (plan) {
    if (!plan.prices) throw new Error("expiry round missing price snapshot");
    const { historical, at } = await canonicalState(plan.state.checkpoint);
    const expected = prepareExpiryRound(historical, plan.parent, policy, plan.plan.round, at, domain, 64, plan.prices);
    if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error("canonical expiry round mismatch");
  } else {
    const tokens = [...new Set(Object.entries(state.pairs).filter(([key, pair]) =>
      pair.account.toLowerCase() !== policy.treasury.toLowerCase() && !run?.processed.includes(key) &&
      pair.credits.some(credit => isEligibleForExpiry(credit, checkpointTime) && BigInt(credit.granted) > BigInt(credit.paid) + BigInt(credit.recovered)))
      .map(([, pair]) => pair.token))];
    const quotes = await getTokenPrices(tokens.map(address => ({ chainId, address })));
    const prices: NonNullable<PreparedRound["prices"]> = {};
    for (const token of tokens) {
      const usd = quotes[`${LLAMA_NETWORK_MAPPING[chainId]}:${token.toLowerCase()}`];
      if (!Number.isFinite(usd) || usd <= 0 || usd.toFixed(18) === "0.000000000000000000") continue;
      const decimals = await client.readContract({ address: token as Address, abi: parseAbi(["function decimals() view returns(uint8)"]), functionName: "decimals", blockNumber: checkpoint.number! }).catch(() => null);
      if (decimals !== null) prices[token] = { usd: usd.toFixed(18), decimals };
    }
    plan = prepareExpiryRound(state, parent, policy, round, checkpointTime, domain, 64, prices);
  }
  if (!plan) {
    const eligible = Object.entries(state.pairs).some(([key, pair]) =>
      pair.account.toLowerCase() !== policy.treasury.toLowerCase() && !run?.processed.includes(key) &&
      pair.credits.some(credit => isEligibleForExpiry(credit, checkpointTime) && BigInt(credit.granted) > BigInt(credit.paid) + BigInt(credit.recovered)));
    const effectiveAt = expiryEffectiveAt(policy);
    if (eligible && !run && effectiveAt !== null && effectiveAt <= checkpointTime) {
      result({ status: "skipped", chainId, round, reason: "no executable recovery at $100 per token: below minimum, unpriced, or missing treasury leaf" }); return;
    }
    if (effectiveAt === null || effectiveAt > checkpointTime) {
      result({ status: "waiting", chainId, round, reason: "notice or treasury frontier unavailable" }); return;
    }
    const entry = { kind: "idle", id: utils.id(`${chainId}:${round}:${root}:${checkpoint.hash}`), round, root, checkpoint: state.checkpoint, claims: Object.fromEntries(Object.entries(state.pairs).map(([key, pair]) => [key, pair.paid])) };
    writeExpiryInput(path.join(directory, "journal", `${utils.sha256(utils.toUtf8Bytes(JSON.stringify(entry)))}.json`), entry);
    await replayExpiryJournal(client, directory, domain);
    result({ status: "complete", chainId, round, reason: eligible ? "remaining recovery below $100, unpriced, or missing treasury leaf" : "no outstanding eligible rewards" }); return;
  }
  const planDigest = expiryPlanDigest(plan);
  const roundInput = path.join(plansDir, `${planDigest}.json`);
  writeExpiryInput(roundInput, plan);
  let input: PreparedExpiry | undefined = fs.readdirSync(preparedDir).filter(file => file.endsWith(".json")).map(file =>
    JSON.parse(fs.readFileSync(path.join(preparedDir, file), "utf8")) as PreparedExpiry).find(candidate =>
      candidate.plan === planDigest && candidate.batch.index === batchIndex && candidate.batch.parent === root);
  if (input) {
    const { historical } = await canonicalState(input.state.checkpoint);
    if (JSON.stringify(preparePlannedExpiry(historical, input.parent, plan, batchIndex)) !== JSON.stringify(input)) throw new Error("canonical expiry batch mismatch");
  } else input = preparePlannedExpiry(state, parent, plan, batchIndex);
  writeExpiryInput(path.join(preparedDir, `${expiryDigest(input)}.json`), input);
  const digest = expiryDigest(input);
  const calldata = iface.encodeFunctionData("activate", [input.batch]);
  const prepared = { status: "prepared", phase: action, chainId, round, roundSource, digest, planDigest, roundInput, target: deployment.address, calldata, input: path.join(preparedDir, `${digest}.json`) };
  if (action === "plan") { result(prepared); return; }
  if (process.env.MODE !== "test") {
    const [publishedInput, publishedParent, publishedPlan] = await Promise.all([fetch(`${BASE}${prepared.input}`), fetch(`${BASE}${base}/roots/${chain}/${root.toLowerCase()}.json`), fetch(`${BASE}${roundInput}`)]);
    if (!publishedInput.ok || !publishedParent.ok || !publishedPlan.ok) throw new Error("immutable input and parent must be durably published before execution");
    const approved: PreparedExpiry = await publishedInput.json() as PreparedExpiry;
    const publishedMerkle: any = await publishedParent.json();
    verifyExpiryParent(publishedMerkle);
    if (JSON.stringify(approved) !== JSON.stringify(input) || publishedMerkle.merkleRoot !== root || JSON.stringify(await publishedPlan.json()) !== JSON.stringify(plan)) throw new Error("published execution inputs mismatch");
  }
  const [proposal, proposedAt, owner, delay, pending, latestRoot] = await Promise.all([
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "proposal" }),
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "proposedAt" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "owner" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "timelock" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "pendingRoot" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "root" }),
  ]);
  if (owner.toLowerCase() !== deployment.safe.toLowerCase()) throw new Error("distributor owner changed");
  if (latestRoot !== root) { result({ ...prepared, status: "waiting", reason: "distributor root changed" }); return; }
  if (pending[2] !== 0n) { result({ ...prepared, status: "waiting", reason: "distributor root is pending" }); return; }
  if (action === "prepare") {
    const preparation = { ...prepared, calldata: iface.encodeFunctionData("prepare", [plan.plan]) };
    if (proposal !== planDigest) {
      result({ ...preparation, status: "ready", replaces: proposal }); return;
    }
    result({ ...preparation, status: "waiting", reason: "already prepared" }); return;
  }
  const validAt = Number(proposedAt) + Math.max(deployment.delay, Number(delay));
  const now = Number((await client.getBlock()).timestamp);
  result({ ...prepared, status: proposal === planDigest && Number(proposedAt) !== 0 && now >= validAt && pending[2] === 0n ? "ready" : "waiting", validAt });
}

if (require.main === module) main().catch(error => { console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, "[RPC]")); process.exitCode = 1; });
