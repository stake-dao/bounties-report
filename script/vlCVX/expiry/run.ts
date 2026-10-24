import fs from "fs";
import path from "path";
import { utils } from "ethers";
import { Abi, Address, parseAbi } from "viem";
import expiryAbi from "../../../abis/RewardsExpiry.json";
import policies from "./policy.json";
import deployments from "./deployment.json";
import extraPolicies from "../../extraRewards/expiry/policy.json";
import extraDeployments from "../../extraRewards/expiry/deployment.json";
import { expiryDigest, expiryEffectiveAt, expiryRound, EXPIRY_DISTRIBUTOR, EXTRA_REWARDS_DISTRIBUTOR, ExpiryPolicy, PreparedExpiry, prepareExpiry, isEligibleForExpiry, syncExpiryClaims, verifyExpiryParent, writeExpiryInput } from "../../shared/merkle/expiry";
import { getClient } from "../../utils/getClients";
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
  const parent = await readActiveVotersMerkle(chainId, state.root, client, distributorAddress);
  const rootsDir = path.join(base, "roots", chain);
  fs.mkdirSync(rootsDir, { recursive: true });
  writeExpiryInput(path.join(rootsDir, `${state.root.toLowerCase()}.json`), parent);
  const roundSource = await readExpiryRound(await getClient(1));
  const preparedDir = path.join(directory, "prepared");
  fs.mkdirSync(preparedDir, { recursive: true });
  const inputs = fs.readdirSync(preparedDir).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(preparedDir, file), "utf8")) as PreparedExpiry);
  const proposed = await client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "proposal" });
  const prior = inputs.find(input => expiryDigest(input) === proposed);
  const canonicalInput = async (input: PreparedExpiry) => {
    const canonical = await replayExpiryJournal(client, directory, domain, input.state.checkpoint);
    const block = await client.getBlock({ blockNumber: BigInt(input.state.checkpoint.block) });
    const historical = syncExpiryClaims(canonical, await readLedgerClaims(client, canonical, block.number!));
    historical.checkpoint = { block: Number(block.number), blockHash: block.hash! };
    const expected = prepareExpiry(historical, input.parent, policy, input.batch.token, input.batch.round, input.batch.index, Number(block.timestamp), domain);
    if (JSON.stringify(expected) !== JSON.stringify(input)) throw new Error("canonical prepared input mismatch");
  };
  if (prior) await canonicalInput(prior);
  const round = prior?.batch.parent === root ? prior.batch.round : expiryRound(state, roundSource.round);
  const run = state.runs[String(round)];
  if (run?.complete) {
    result({ status: "complete", chainId, round });
    return;
  }
  const batchIndex = run?.nextBatch ?? 0;
  let input: PreparedExpiry | null;
  if (prior?.batch.parent === root && prior.batch.index === batchIndex) {
    input = prior;
  } else {
    input = inputs.find(candidate =>
      candidate.batch.round === round &&
      candidate.batch.index === batchIndex &&
      candidate.batch.parent === root &&
      JSON.stringify(candidate.module) === JSON.stringify(domain)
    ) ?? null;
  }
  if (input && input !== prior) await canonicalInput(input);
  if (!input) {
    const distribution = verifyExpiryParent(parent);
    for (const token of [...new Set(Object.values(distribution).flatMap(tokens => Object.keys(tokens)))]) {
      input = prepareExpiry(state, parent, policy, token, round, batchIndex, checkpointTime, domain);
      if (input) break;
    }
    if (!input) {
      const eligible = Object.entries(state.pairs).some(([key, pair]) => {
        if (pair.account.toLowerCase() === policy.treasury.toLowerCase()) return false;
        if (run?.processed.includes(key)) return false;
        return pair.credits.some(credit => isEligibleForExpiry(credit, checkpointTime));
      });
      const effectiveAt = expiryEffectiveAt(policy);
      const noticeReady = effectiveAt !== null && effectiveAt <= checkpointTime;
      if (eligible || !noticeReady) {
        result({ status: "waiting", chainId, round, reason: "notice or treasury frontier unavailable" });
        return;
      }
      const entry = { kind: "idle", id: utils.id(`${chainId}:${round}:${root}:${checkpoint.hash}`), round, root, checkpoint: state.checkpoint, claims: Object.fromEntries(Object.entries(state.pairs).map(([key, pair]) => [key, pair.paid])) };
      writeExpiryInput(path.join(directory, "journal", `${utils.sha256(utils.toUtf8Bytes(JSON.stringify(entry)))}.json`), entry);
      await replayExpiryJournal(client, directory, domain);
      result({ status: "complete", chainId, round, reason: "no outstanding eligible rewards" });
      return;
    }
    writeExpiryInput(path.join(preparedDir, `${expiryDigest(input)}.json`), input);
  }
  const digest = expiryDigest(input);
  const calldata = iface.encodeFunctionData("activate", [input.batch]);
  const prepared = { status: "prepared", phase: action, chainId, round, roundSource, digest, target: deployment.address, calldata, input: path.join(preparedDir, `${digest}.json`) };
  if (action === "plan") { result(prepared); return; }
  if (process.env.MODE !== "test") {
    const [publishedInput, publishedParent] = await Promise.all([fetch(`${BASE}${prepared.input}`), fetch(`${BASE}${base}/roots/${chain}/${root.toLowerCase()}.json`)]);
    if (!publishedInput.ok || !publishedParent.ok) throw new Error("immutable input and parent must be durably published before execution");
    const approved: PreparedExpiry = await publishedInput.json() as PreparedExpiry;
    const publishedMerkle: any = await publishedParent.json();
    verifyExpiryParent(publishedMerkle);
    if (JSON.stringify(approved) !== JSON.stringify(input) || publishedMerkle.merkleRoot !== root) throw new Error("published execution inputs mismatch");
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
    const preparation = { ...prepared, calldata: iface.encodeFunctionData("prepare", [input.batch]) };
    if (/^0x0{64}$/.test(String(proposal))) {
      result({ ...preparation, status: "ready" });
      return;
    }
    const stale = prior && expiryDigest(prior) === proposal && prior.batch.parent !== root;
    if (stale) {
      if (process.env.MODE !== "test") {
        const published = await fetch(`${BASE}${preparedDir}/${proposal}.json`);
        if (!published.ok || JSON.stringify(await published.json()) !== JSON.stringify(prior)) throw new Error("stale proposal must be durably published");
      }
      result({ ...preparation, status: "ready", replaces: proposal });
      return;
    }
    const reason = proposal === digest ? "already prepared" : "another expiry proposal is pending";
    result({ ...preparation, status: "waiting", reason });
    return;
  }
  const validAt = Number(proposedAt) + Math.max(deployment.delay, Number(delay));
  const now = Number((await client.getBlock()).timestamp);
  result({ ...prepared, status: proposal === digest && Number(proposedAt) !== 0 && now >= validAt && pending[2] === 0n ? "ready" : "waiting", validAt });
}

if (require.main === module) main().catch(error => { console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, "[RPC]")); process.exitCode = 1; });
