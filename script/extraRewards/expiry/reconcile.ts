import fs from "fs";
import path from "path";
import { Address, parseAbi, parseAbiItem } from "viem";
import { getClient } from "../../utils/getClients";
import { bootstrapExpiryLedger, EXTRA_REWARDS_DISTRIBUTOR, expiryKey, Publication, verifyExpiryParent, writeExpiryInput } from "../../shared/merkle/expiry";
import { readLedgerClaims } from "../../vlCVX/expiry/journal";
import { readExtraPublication, readVmRewards } from "./sources";

async function main() {
  const output = "bounties-reports/expiry/extra/bootstrap/1";
  if (fs.existsSync(path.join(output, "ledger.json"))) throw new Error("bootstrap already exists");
  const client = await getClient(1);
  if (await client.getChainId() !== 1) throw new Error("extra rewards chain");
  const finalized = await client.getBlock({ blockTag: "finalized" });
  const checkpoint = process.argv[2] ? await client.getBlock({ blockNumber: BigInt(process.argv[2]) }) : finalized;
  if (checkpoint.number! > finalized.number!) throw new Error("bootstrap is not finalized");
  const address = EXTRA_REWARDS_DISTRIBUTOR as Address;
  const event = parseAbiItem("event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)");
  let low = 0n, high = checkpoint.number!;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    const code = await client.getBytecode({ address, blockNumber: middle });
    if (code && code !== "0x") high = middle;
    else low = middle;
  }
  const publications: Publication[] = [];
  let parent = `0x${"0".repeat(64)}`;
  let previous: Record<string, string> = {};
  for (let start = high; start <= checkpoint.number!; start += 10000n) {
    const end = start + 9999n < checkpoint.number! ? start + 9999n : checkpoint.number!;
    const logs = await client.getLogs({ address, event, fromBlock: start, toBlock: end });
    for (const log of logs) {
      if (log.removed || !log.args.newRoot || log.blockNumber === null) throw new Error("invalid root event");
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      if (block.hash !== log.blockHash) throw new Error("publication reorg");
      const root = log.args.newRoot;
      const publication: Publication = { root, timestamp: Number(block.timestamp), block: Number(block.number), blockHash: block.hash!, logIndex: log.logIndex!, transactionHash: log.transactionHash!, merkle: null };
      if (!/^0x0{64}$/.test(root)) {
        const source = readExtraPublication(root, parent);
        if (!source) {
          publications.push(publication);
          previous = {};
          parent = root;
          continue;
        }
        const amounts = verifyExpiryParent(source.merkle);
        const rewards: Record<string, string> = {};
        const current: Record<string, string> = {};
        for (const [account, tokens] of Object.entries(amounts)) {
          for (const [token, amount] of Object.entries(tokens)) {
            const key = expiryKey(account, token);
            current[key] = amount;
            const delta = BigInt(amount) - BigInt(previous[key] ?? "0");
            if (delta > 0n) rewards[key] = delta.toString();
          }
        }
        publication.merkle = { merkleRoot: root, claims: Object.fromEntries(Object.entries(amounts).map(([account, tokens]) => [account, { tokens: Object.fromEntries(Object.entries(tokens).map(([token, amount]) => [token, { amount, proof: [] }])) }])) };
        publication.vmRewards = await readVmRewards(client, source.allocations, rewards, block.number!);
        previous = current;
        parent = root;
      }
      publications.push(publication);
    }
  }
  const root = await client.readContract({ address, abi: parseAbi(["function root() view returns(bytes32)"]), functionName: "root", blockNumber: checkpoint.number! });
  if (parent !== root) throw new Error("extra rewards history incomplete");
  const pairs = Object.fromEntries(publications.flatMap(publication => Object.entries(publication.merkle?.claims ?? {}).flatMap(([account, claim]) => Object.keys(claim.tokens).map(token => [expiryKey(account, token), { account, token }]))));
  const claims = await readLedgerClaims(client, { distributor: address, pairs }, checkpoint.number!);
  const ledger = bootstrapExpiryLedger(1, publications, claims, { block: Number(checkpoint.number), blockHash: checkpoint.hash! }, null, address);
  if ((await client.getBlock({ blockNumber: checkpoint.number! })).hash !== checkpoint.hash) throw new Error("bootstrap reorg");
  fs.mkdirSync(output, { recursive: true });
  writeExpiryInput(path.join(output, "ledger.json"), ledger);
  console.log(JSON.stringify({ root, publications: publications.length, unresolvedRoots: publications.filter(publication => !publication.merkle && !/^0x0{64}$/.test(publication.root)).map(publication => publication.root), pairs: Object.keys(pairs).length, checkpoint: ledger.checkpoint }));
}

main().catch(error => { console.error(String(error.message).replace(/https?:\/\/[^\s]+/g, "[RPC]")); process.exitCode = 1; });
