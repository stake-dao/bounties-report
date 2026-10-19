import fs from "fs";
import path from "path";
import pLimit from "p-limit";
import { utils } from "ethers";
import { Address, parseAbi } from "viem";
import { MerkleData } from "../../interfaces/MerkleData";
import { getClient } from "../../utils/getClients";
import { fetchClaimed } from "../../verify/invariants/preservation";
import { bootstrapExpiryLedger, expiryKey, EXPIRY_DISTRIBUTOR, Publication, sixCalendarMonths, verifyExpiryParent, writeExpiryInput } from "../../shared/merkle/expiry";
import unionAgeBound from "./union-age-bound.json";

const chainId = Number(process.argv[2]);
const output = path.resolve("bounties-reports/expiry/bootstrap", String(chainId));
const rootAbi = parseAbi(["function root() view returns (bytes32)"]);
const balanceAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

async function main() {
  if (![1, 8453, 42161].includes(chainId)) throw new Error("reconcile.ts <1|8453|42161>");
  if (fs.existsSync(path.join(output, "ledger.json"))) throw new Error("bootstrap already exists; replay the canonical journal");
  const saved = fs.existsSync(path.join(output, "inputs.json")) ? JSON.parse(fs.readFileSync(path.join(output, "inputs.json"), "utf8")) : null;
  const client = await getClient(chainId);
  const checkpoint = saved ? await client.getBlock({ blockNumber: BigInt(saved.checkpoint.block) }) : await client.getBlock({ blockTag: "finalized" });
  if (checkpoint.number === null || checkpoint.hash === null) throw new Error("finalized checkpoint unavailable");
  if (saved && (saved.chainId !== chainId || saved.checkpoint.blockHash !== checkpoint.hash)) throw new Error("saved bootstrap target or checkpoint changed");
  const activeRoot = await client.readContract({ address: EXPIRY_DISTRIBUTOR, abi: rootAbi, functionName: "root", blockNumber: checkpoint.number });
  const apiKey = process.env.ETHERSCAN_API_KEY || process.env.EXPLORER_KEY;
  if (!apiKey && !saved) throw new Error("explorer credential unavailable");
  const discover = async (event: string): Promise<any[]> => {
    const logs: any[] = [];
    for (let page = 1; ; ++page) {
      const query = new URLSearchParams({ chainid: String(chainId), module: "logs", action: "getLogs", fromBlock: "0", toBlock: checkpoint.number!.toString(), address: EXPIRY_DISTRIBUTOR, topic0: utils.id(event), offset: "1000", page: String(page), apikey: apiKey || "" });
      const response = await fetch(`https://api.etherscan.io/v2/api?${query}`);
      if (!response.ok) throw new Error(`explorer HTTP ${response.status}`);
      const body: any = await response.json();
      if (body.status === "0" && body.message === "No records found") break;
      if (body.status !== "1" || !Array.isArray(body.result)) throw new Error(`explorer response ${body.message}`);
      if (!body.result.length) break;
      logs.push(...body.result);
    }
    return logs;
  };
  const discovered: any[] = saved ? saved.publications.map((publication: any) => ({ transactionHash: publication.transactionHash, logIndex: utils.hexValue(publication.logIndex), topics: [utils.id("RootSet(bytes32,bytes32)"), publication.root] })) : await discover("RootSet(bytes32,bytes32)");
  const claimEvents = saved?.claimEvents ?? await discover("Claimed(address,address,address,uint256)");
  console.log(JSON.stringify({ chainId, rootEvents: discovered.length, claimEvents: claimEvents.length, checkpoint: checkpoint.number.toString() }));
  const roots = new Set(discovered.map(log => log.topics[1].toLowerCase()));
  const artifacts = new Map<string, { merkle: MerkleData; file: string; sha256: string }>();
  for (const publication of saved?.publications ?? []) {
    if (publication.merkle) {
      verifyExpiryParent(publication.merkle);
      artifacts.set(publication.root.toLowerCase(), { merkle: publication.merkle, ...publication.source });
    }
  }
  const rejected: { file: string; error: string }[] = [];
  const periods = saved ? [] : fs.readdirSync("bounties-reports").filter(period => /^\d+$/.test(period)).sort();
  for (const period of periods) {
    const folder = path.join("bounties-reports", period, "vlCVX");
    if (!fs.existsSync(folder)) continue;
    for (const directory of [folder, path.join(folder, "curve"), path.join(folder, "fxn")]) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".json"))) {
        const file = path.join(directory, name);
        let merkle: MerkleData;
        try { merkle = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch { continue; }
        if (!merkle.merkleRoot || !merkle.claims || !roots.has(merkle.merkleRoot.toLowerCase()) || artifacts.has(merkle.merkleRoot.toLowerCase())) continue;
        try {
          const distribution = verifyExpiryParent(merkle);
          const claims: MerkleData["claims"] = {};
          for (const [account, tokens] of Object.entries(distribution)) claims[account] = { tokens: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, { amount, proof: [] }])) };
          artifacts.set(merkle.merkleRoot.toLowerCase(), { merkle: { merkleRoot: merkle.merkleRoot, claims }, file, sha256: utils.sha256(fs.readFileSync(file)) });
        } catch (error: any) { rejected.push({ file, error: error.message }); }
      }
    }
  }
  const limit = pLimit(5);
  const publications: (Publication & { transactionHash: string; logIndex: number; source: { file: string; sha256: string } | null })[] = await Promise.all(discovered.map(log => limit(async () => {
    const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const actual = receipt.logs.find(row => row.address.toLowerCase() === EXPIRY_DISTRIBUTOR.toLowerCase() && row.logIndex === (log.logIndex === "0x" ? 0 : Number(BigInt(log.logIndex))));
    if (!actual || receipt.status !== "success" || receipt.blockHash !== block.hash || actual.topics[0] !== utils.id("RootSet(bytes32,bytes32)") || actual.topics[1] !== log.topics[1] || (log.topics[2] !== undefined && actual.topics[2] !== log.topics[2])) throw new Error("non-canonical publication");
    const artifact = artifacts.get(log.topics[1].toLowerCase());
    return { root: log.topics[1], timestamp: Number(block.timestamp), block: Number(block.number), blockHash: block.hash!, merkle: artifact?.merkle ?? null, transactionHash: log.transactionHash, logIndex: actual.logIndex, source: artifact ? { file: artifact.file, sha256: artifact.sha256 } : null };
  })));
  publications.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  if (!publications.length || publications[publications.length - 1].root.toLowerCase() !== activeRoot.toLowerCase()) throw new Error("active root reconciliation failed");
  const beforeDeployment = await client.getBytecode({ address: EXPIRY_DISTRIBUTOR, blockNumber: BigInt(publications[0].block - 1) });
  if (beforeDeployment && beforeDeployment !== "0x") throw new Error("deployment history incomplete");
  const pairs = new Map<string, [string, string]>();
  for (const publication of publications) {
    for (const [account, claim] of Object.entries(publication.merkle?.claims ?? {})) {
      for (const token of Object.keys(claim.tokens)) pairs.set(expiryKey(account, token), [account.toLowerCase(), token.toLowerCase()]);
    }
  }
  for (const event of claimEvents) {
    const account = `0x${event.topics[1].slice(-40)}`;
    const token = `0x${event.topics[3].slice(-40)}`;
    pairs.set(expiryKey(account, token), [account.toLowerCase(), token.toLowerCase()]);
  }
  const observed = await fetchClaimed(client, { target: "voters", chainId, distributor: EXPIRY_DISTRIBUTOR, pinnedBlock: checkpoint.number }, [...pairs.values()]);
  const claims = Object.fromEntries([...observed].map(([key, amount]) => [key, amount.toString()]));
  if (saved && JSON.stringify(claims) !== JSON.stringify(saved.claims)) throw new Error("saved bootstrap claims changed");
  const unionFile = "script/vlCVX/union_reassign/out/union_end_user_merkle.json";
  const restatementsFile = "script/verify/invariants/restatements.vlcvx.json";
  const unionBinding = JSON.parse(fs.readFileSync(restatementsFile, "utf8")).filter((entry: any) => entry.chainId === 1 && entry.creditsFile === unionFile);
  if (unionBinding.length !== 1) throw new Error("Union credits binding unresolved");
  const unionMerkle = { ...JSON.parse(fs.readFileSync(unionFile, "utf8")), merkleRoot: unionBinding[0].creditsRoot };
  const unionDistribution = verifyExpiryParent(unionMerkle);
  const unionPublication = publications.find(publication => publication.transactionHash.toLowerCase() === "0x9d661baa0d522c8e76a036152281c58ca6856b42f51f0d8b335cbab7286f24bc");
  const ageBoundFile = "script/vlCVX/expiry/union-age-bound.json";
  const ageBound = chainId === 1 ? (saved ? saved.union?.ageBound : unionAgeBound) : undefined;
  if (ageBound && (JSON.stringify(ageBound) !== JSON.stringify(unionAgeBound) || ageBound.chainId !== chainId || ageBound.account.toLowerCase() !== unionMerkle.meta.union.toLowerCase() || ageBound.creditsRoot !== unionBinding[0].creditsRoot || ageBound.roundsDigest !== unionMerkle.meta.roundsDigest || (saved && (saved.unionSource.ageBoundFile !== ageBoundFile || saved.unionSource.ageBoundSha256 !== utils.sha256(fs.readFileSync(ageBoundFile)))))) throw new Error("Union age bound provenance");
  const union = chainId === 1 ? { root: unionPublication?.root ?? null, amounts: Object.fromEntries(Object.entries(unionDistribution).flatMap(([account, tokens]) => Object.entries(tokens).map(([token, amount]) => [expiryKey(account, token), amount]))), ...(ageBound ? { ageBound } : {}) } : null;
  const ledger = bootstrapExpiryLedger(chainId, publications, claims, { block: Number(checkpoint.number), blockHash: checkpoint.hash }, union);
  const tokens = [...new Set(Object.values(ledger.pairs).map(pair => pair.token))];
  const balances = await client.multicall({ contracts: tokens.map(address => ({ address: address as Address, abi: balanceAbi, functionName: "balanceOf" as const, args: [EXPIRY_DISTRIBUTOR] })), blockNumber: checkpoint.number });
  const totals: Record<string, { outstanding: string; ageQualified: string; protected: string; paid: string; paidOffset: string; balance: string | null; shortfall: string | null }> = {};
  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    let outstanding = 0n, qualified = 0n, protectedAmount = 0n, paid = 0n, paidOffset = 0n;
    for (const pair of Object.values(ledger.pairs).filter(pair => pair.token === token)) {
      paid += BigInt(pair.paid);
      if (BigInt(pair.paid) > BigInt(pair.activeAmount)) paidOffset += BigInt(pair.paid) - BigInt(pair.activeAmount);
      for (const credit of pair.credits) {
        const amount = BigInt(credit.granted) - BigInt(credit.paid) - BigInt(credit.recovered);
        outstanding += amount;
        if (credit.protection !== null || credit.activatedAt === null) protectedAmount += amount;
        else if (sixCalendarMonths(credit.ageBoundAt ?? credit.activatedAt) <= Number(checkpoint.timestamp)) qualified += amount;
      }
    }
    const balance = balances[i].status === "success" ? BigInt(balances[i].result as bigint) : null;
    totals[token] = { outstanding: outstanding.toString(), ageQualified: qualified.toString(), protected: protectedAmount.toString(), paid: paid.toString(), paidOffset: paidOffset.toString(), balance: balance?.toString() ?? null, shortfall: balance === null ? null : (outstanding > balance ? outstanding - balance : 0n).toString() };
  }
  const sameCheckpoint = await client.getBlock({ blockNumber: checkpoint.number });
  if (sameCheckpoint.hash !== checkpoint.hash) throw new Error("checkpoint reorg; bootstrap not written");
  fs.mkdirSync(output, { recursive: true });
  if (!saved) writeExpiryInput(path.join(output, "inputs.json"), { chainId, checkpoint: ledger.checkpoint, publications, claims, claimEvents, union, unionSource: { file: unionFile, sha256: utils.sha256(fs.readFileSync(unionFile)), bindingFile: restatementsFile, bindingSha256: utils.sha256(fs.readFileSync(restatementsFile)), ...(ageBound ? { ageBoundFile, ageBoundSha256: utils.sha256(fs.readFileSync(ageBoundFile)) } : {}) }, rejectedArtifacts: rejected });
  if (!fs.existsSync(path.join(output, "report.json"))) writeExpiryInput(path.join(output, "report.json"), { chainId, distributor: EXPIRY_DISTRIBUTOR, productionActive: false, checkpoint: ledger.checkpoint, activeRoot, rootEvents: publications.length, matchedRoots: publications.filter(publication => publication.merkle).length, unresolvedRoots: publications.filter(publication => !publication.merkle && !/^0x0{64}$/i.test(publication.root)).map(({ merkle, ...publication }) => publication), pairs: pairs.size, rejectedArtifacts: saved?.rejectedArtifacts ?? rejected, totals, noticeVerified: false, governanceVerified: false, treasury: null, unionAgeingPolicy: ageBound ?? null, source: "Complete RootSet history, canonical RPC receipt/block validation and finalized claimed/balance reads" });
  writeExpiryInput(path.join(output, "ledger.json"), ledger);
  console.log(JSON.stringify({ chainId, rootEvents: publications.length, matchedRoots: publications.filter(publication => publication.merkle).length, pairs: pairs.size, activeRoot, output }));
}

main().catch(error => { console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, "[RPC]")); process.exitCode = 1; });
