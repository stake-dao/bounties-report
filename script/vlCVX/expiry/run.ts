import fs from "fs";
import path from "path";
import { utils } from "ethers";
import { Abi, Address, parseAbi } from "viem";
import expiryAbi from "../../../abis/RewardsExpiry.json";
import policies from "./policy.json";
import deployments from "./deployment.json";
import { expiryDigest, expiryEffectiveAt, expiryRound, ExpiryPolicy, PreparedExpiry, prepareExpiry, sixCalendarMonths, syncExpiryClaims, verifyExpiryParent, writeExpiryInput } from "../../shared/merkle/expiry";
import { getClient } from "../../utils/getClients";
import { readLedgerClaims, replayExpiryJournal } from "./journal";
import { readActiveVotersMerkle } from "./active";
import { readExpiryRound } from "./round";

const iface = new utils.Interface(expiryAbi);
const URD_ABI = parseAbi(["function root() view returns(bytes32)", "function pendingRoot() view returns(bytes32,bytes32,uint256)", "function owner() view returns(address)", "function timelock() view returns(uint256)"]);
const BASE = "https://raw.githubusercontent.com/stake-dao/bounties-report/main/";

async function main() {
  const [action, chain] = process.argv.slice(2);
  const chainId = Number(chain);
  if (!["plan", "activate", "record"].includes(action) || ![1, 8453, 42161].includes(chainId)) throw new Error("run.ts <plan|activate|record> <1|8453|42161>");
  const policy = (policies as Record<string, ExpiryPolicy | null>)[chain];
  const deployment = (deployments as Record<string, (PreparedExpiry["module"] & { codeHash: string }) | null>)[chain];
  const result = (value: unknown) => fs.writeFileSync("expiry-job.json", JSON.stringify(value, null, 2) + "\n");
  if (!policy || !deployment) { result({ status: "disabled", chainId, reason: "policy and reviewed deployment are required" }); return; }
  const client = await getClient(chainId);
  const code = await client.getBytecode({ address: deployment.address as Address });
  if (!code || utils.keccak256(code) !== deployment.codeHash) throw new Error("reviewed module code mismatch");
  const directory = path.join("bounties-reports/expiry/state", chain);
  fs.mkdirSync(directory, { recursive: true });
  const bootstrap = path.join(directory, "bootstrap.json");
  if (!fs.existsSync(bootstrap)) writeExpiryInput(bootstrap, JSON.parse(fs.readFileSync(`bounties-reports/expiry/bootstrap/${chain}/ledger.json`, "utf8")));
  const ledger = await replayExpiryJournal(client, directory);
  if (action === "record") { result({ status: "recorded", chainId, root: ledger.root, checkpoint: ledger.checkpoint }); return; }
  const checkpoint = await client.getBlock({ blockTag: "finalized" });
  const state = syncExpiryClaims(ledger, await readLedgerClaims(client, ledger, checkpoint.number!));
  state.checkpoint = { block: Number(checkpoint.number), blockHash: checkpoint.hash! };
  const root = await client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "root" });
  if (root !== state.root) { result({ status: "waiting", chainId, reason: "active root is not finalized" }); return; }
  const parent = await readActiveVotersMerkle(chainId, state.root, client);
  const rootsDir = path.join("bounties-reports/expiry/roots", chain);
  fs.mkdirSync(rootsDir, { recursive: true });
  writeExpiryInput(path.join(rootsDir, `${state.root.toLowerCase()}.json`), parent);
  const roundSource = await readExpiryRound(await getClient(1));
  const round = expiryRound(state, roundSource.round);
  const run = state.runs[String(round)];
  if (run?.complete) { result({ status: "complete", chainId, round }); return; }
  const preparedDir = path.join(directory, "prepared");
  fs.mkdirSync(preparedDir, { recursive: true });
  const domain = { address: deployment.address, safe: deployment.safe, delay: deployment.delay };
  const existing = fs.readdirSync(preparedDir).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(preparedDir, file), "utf8")) as PreparedExpiry).find(input => input.batch.round === round && input.batch.index === (run?.nextBatch ?? 0) && input.batch.parent === root && JSON.stringify(input.module) === JSON.stringify(domain));
  let input = existing ?? null;
  if (!input) {
    const distribution = verifyExpiryParent(parent);
    for (const token of [...new Set(Object.values(distribution).flatMap(tokens => Object.keys(tokens)))]) {
      input = prepareExpiry(state, parent, policy, token, round, run?.nextBatch ?? 0, Number(checkpoint.timestamp), domain);
      if (input) break;
    }
    if (!input) {
      const eligible = Object.entries(state.pairs).some(([key, pair]) => pair.account.toLowerCase() !== policy.treasury.toLowerCase() && !(run?.processed ?? []).includes(key) && pair.credits.some(credit => credit.protection === null && credit.activatedAt !== null && BigInt(credit.granted) > BigInt(credit.paid) + BigInt(credit.recovered) && sixCalendarMonths(credit.activatedAt) <= Number(checkpoint.timestamp)));
      const effectiveAt = expiryEffectiveAt(policy);
      const noticeReady = effectiveAt !== null && effectiveAt <= Number(checkpoint.timestamp);
      if (eligible || !noticeReady) { result({ status: "waiting", chainId, round, reason: "notice or treasury frontier unavailable" }); return; }
      const entry = { kind: "idle", id: utils.id(`${chainId}:${round}:${root}:${checkpoint.hash}`), round, root, checkpoint: state.checkpoint, claims: Object.fromEntries(Object.entries(state.pairs).map(([key, pair]) => [key, pair.paid])) };
      writeExpiryInput(path.join(directory, "journal", `${utils.sha256(utils.toUtf8Bytes(JSON.stringify(entry)))}.json`), entry);
      await replayExpiryJournal(client, directory);
      result({ status: "complete", chainId, round, reason: "no outstanding eligible rewards" }); return;
    }
    writeExpiryInput(path.join(preparedDir, `${expiryDigest(input)}.json`), input);
  }
  const digest = expiryDigest(input);
  const calldata = iface.encodeFunctionData("activate", [input.batch]);
  const prepared = { status: "prepared", chainId, round, roundSource, digest, target: deployment.address, calldata, input: path.join(preparedDir, `${digest}.json`), safeTransaction: { to: deployment.address, value: "0", data: iface.encodeFunctionData("prepare", [input.batch]), operation: 0 } };
  if (action === "plan") { result(prepared); return; }
  const [publishedInput, publishedParent] = await Promise.all([fetch(`${BASE}${prepared.input}`), fetch(`${BASE}bounties-reports/expiry/roots/${chain}/${root.toLowerCase()}.json`)]);
  if (!publishedInput.ok || !publishedParent.ok) throw new Error("immutable input and parent must be durably published before activation");
  const approved: PreparedExpiry = await publishedInput.json() as PreparedExpiry;
  const publishedMerkle: any = await publishedParent.json();
  verifyExpiryParent(publishedMerkle);
  if (JSON.stringify(approved) !== JSON.stringify(input) || publishedMerkle.merkleRoot !== root) throw new Error("published activation inputs mismatch");
  const [proposal, proposedAt, owner, delay, pending] = await Promise.all([
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "proposal" }),
    client.readContract({ address: deployment.address as Address, abi: expiryAbi as Abi, functionName: "proposedAt" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "owner" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "timelock" }),
    client.readContract({ address: state.distributor as Address, abi: URD_ABI, functionName: "pendingRoot" }),
  ]);
  if (owner.toLowerCase() !== deployment.safe.toLowerCase()) throw new Error("distributor owner changed");
  const validAt = Number(proposedAt) + Math.max(deployment.delay, Number(delay));
  const now = Number((await client.getBlock()).timestamp);
  result({ ...prepared, status: proposal === digest && Number(proposedAt) !== 0 && now >= validAt && pending[2] === 0n ? "ready" : "waiting", validAt });
}

main().catch(error => { console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, "[RPC]")); process.exitCode = 1; });
