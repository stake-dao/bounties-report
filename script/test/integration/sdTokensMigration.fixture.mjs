import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { mock } from "bun:test";
import { getAddress, parseEther, zeroHash } from "viem";
import { BigNumber } from "ethers";
import * as constants from "../../utils/constants";
import * as utils from "../../utils/utils";
import * as snapshot from "../../utils/snapshot";
const [directory, periodArg, account, rootCRV = zeroHash, rootFXN = zeroHash, mode] = process.argv.slice(2);
const period = Number(periodArg);
const aladdin = "0x1c0D72a330F2768dAF718DEf8A19BAb019EEAd09";
const carried = "0x2000000000000000000000000000000000000002";
const paid = "0x3000000000000000000000000000000000000003";
const gauge = "0xbbbb22220000000000000000000000000000bbbb";
let currentSpace = constants.SDCRV_SPACE;
mock.module("../../utils/snapshot", () => ({
  ...snapshot,
  getProposal: async () => ({ id: "fixture", end: period, created: period - 604800, snapshot: "26271131", strategies: [], space: { id: currentSpace }, choices: ["Gauge - 0xbbbb2222…bbbb"] }),
  getVoters: async () => [{ voter: constants.DELEGATION_ADDRESS, choice: { "1": 1 }, vp: 0 }],
  getVotingPower: async () => ({ [constants.DELEGATION_ADDRESS.toLowerCase()]: 1000 }),
  formatVotingPowerResult: (voters, vps) => voters.map((v) => ({ ...v, vp: vps[v.voter.toLowerCase()] ?? 0 }))
}));
mock.module("../../utils/utils", () => ({
  ...utils,
  addVotersFromAutoVoter: async (_space, _proposal, voters) => voters,
  getDelegationVotingPower: async () => currentSpace === constants.SDCRV_SPACE ? (mode === "legacy-only" ? { [aladdin]: 100 } : { [aladdin]: 60, [account]: 40 }) : { [account]: 100, [carried]: 20, [paid]: 20 },
  getAllAccountClaimedSinceLastFreeze: async () => ({ [paid.toLowerCase()]: true, ...(mode === "legacy-only" ? { [account.toLowerCase()]: true } : {}) })
}));
mock.module("../../utils/cacheUtils", () => ({ processAllDelegators: async () => [aladdin, account] }));
const { createMultiMerkle } = await import("../../utils/merkle/createMultiMerkle");
const { buildUniversalSdMerkle } = await import("../../utils/merkle/universalSdMerkle");
const { buildDistribution } = await import("../../sdTkns/prepareDistribution");
const { loadUniversalFiles, universalTargets, checkV1, checkV5 } = await import("../../sdTkns/verify/checkBeforeSetRoots");
const { compareUniversalWeeklyDistributions } = await import("../../sdTkns/verify/reconstructSdMerkle");
const diverted = new Map();
fs.mkdirSync(directory, { recursive: true });
process.chdir(directory);
const log = { period, postFreeze: true, DistributionSurplus: { sdCRV: 0 }, Transactions: [], Universal: [] };
const legacy = [];
const balances = new Map;
for (const [space, root] of [[constants.SDCRV_SPACE, rootCRV], [constants.SDFXN_SPACE, rootFXN]]) {
  currentSpace = space;
  const config = constants.UNIVERSAL_SD_MERKLES[space];
  const token = constants.SPACES_TOKENS[space];
  const previousFile = `bounties-reports/${period - 604800}/merkle.json`;
  const previousLegacy = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, "utf8")) : space === constants.SDCRV_SPACE ? [{ address: token, merkle: {
    [account.toLowerCase()]: { amount: BigNumber.from(parseEther("2")), index: 0, proof: [] },
    [carried]: { amount: BigNumber.from(parseEther("5")), index: 1, proof: [] },
    [paid]: { amount: BigNumber.from(parseEther("3")), index: 2, proof: [] }
  } }] : [{ address: token, merkle: { [aladdin.toLowerCase()]: { amount: BigNumber.from(parseEther("1")), index: 0, proof: [] } } }];
  const split = await createMultiMerkle(["fixture"], space, previousLegacy, { [gauge]: space === constants.SDCRV_SPACE ? 10 : mode === "legacy-only" ? 0 : 14 }, { total_vp: 1 }, { total_vp: 1 }, {}, undefined, { legacyRecipients: constants.LEGACY_STASH_RECIPIENTS, readOnlyClaimCache: true });
  if (split.diverted[aladdin.toLowerCase()])
    throw new Error("Aladdin diverted");
  if (space === constants.SDCRV_SPACE) {
    if (split.merkle.merkle[paid])
      throw new Error("paid legacy leaf retained");
    if (!split.merkle.merkle[carried])
      throw new Error("unpaid legacy leaf lost");
    log.Transactions.push({ network: "ethereum", tokenAddressesToFreeze: [token], newMerkleRoots: [split.merkle.root] });
  }
  legacy.push(split.merkle);
  diverted.set(space, split.diverted);
  const built = buildUniversalSdMerkle(period, config.file, split.diverted, token, root);
  const file = path.join("bounties-reports", String(period), config.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(built.merkle));
  if (built.weekly > 0n) log.Universal.push({
    space,
    symbol: constants.SPACES_SYMBOL[space],
    token,
    distributor: config.distributor,
    file: config.file,
    root: built.merkle.merkleRoot,
    previousRoot: built.previous.merkleRoot || null,
    weekly: String(built.weekly),
    total: String(built.total),
    previousTotal: String(built.previousTotal)
  });
  balances.set(token.toLowerCase(), [0n, parseEther("1000")]);
}
const entries = universalTargets(log);
const files = loadUniversalFiles(period, entries);
const targets = { tokens: [constants.SD_CRV.toLowerCase()], roots: [legacy[0].root.toLowerCase()] };
checkV1(legacy, targets, log, entries, files);
assert.deepEqual(compareUniversalWeeklyDistributions(entries, files, diverted), []);
if (entries.length) assert.ok(compareUniversalWeeklyDistributions(entries.slice(1), files, diverted).some(message => message.includes("missing")));
if (process.env.LOCAL_FORK_RPC && entries.length) {
  const { createPublicClient, http } = await import("viem");
  const { mainnet } = await import("viem/chains");
  const client = createPublicClient({chain: mainnet, transport: http(process.env.LOCAL_FORK_RPC)});
  assert.equal((await checkV5(Promise.resolve(client), [], {tokens: [], roots: []}, entries)).ok, true);
}
const distribution = buildDistribution(log, legacy, period, true, balances, files);
fs.writeFileSync(`bounties-reports/${period}/merkle.json`, JSON.stringify(legacy));
fs.writeFileSync(`bounties-reports/${period}/sdtokens-distribution.json`, JSON.stringify(distribution));
fs.writeFileSync("fixture.json", JSON.stringify({ period, account: getAddress(account), aladdin, carried, paid, log, legacy, distribution }));

fs.writeFileSync(`bounties-reports/${period}/delegationsAPRs.json`, "{}");
