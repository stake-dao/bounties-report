import fs from "fs";
import os from "os";
import path from "path";
import { utils } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { bootstrapExpiryLedger, expiryDigest, expiryKey, prepareExpiry, recordExpiryDistribution } from "../../shared/merkle/expiry";
import { ALL_MIGHT_V2 } from "../../utils/constants";

const fixture = vi.hoisted(() => ({ deployment: {} as any, policy: {} as any, ledger: null as any, history: {} as Record<string, any>, round: 242, merkle: null as any, claims: {} as Record<string, string>, historicalClaims: {} as Record<string, string>, client: { getBytecode: vi.fn(), getBlock: vi.fn(), getChainId: vi.fn(), readContract: vi.fn() } }));
vi.mock("../../vlCVX/expiry/deployment.json", () => ({ default: { "1": fixture.deployment } }));
vi.mock("../../vlCVX/expiry/policy.json", () => ({ default: { "1": fixture.policy } }));
vi.mock("../../utils/getClients", () => ({ getClient: async () => fixture.client }));
vi.mock("../../vlCVX/expiry/journal", () => ({ replayExpiryJournal: async (_client: any, _directory: string, _module: any, until: any) => structuredClone(until ? fixture.history[String(until.block)] : fixture.ledger), readLedgerClaims: async (_client: any, _ledger: any, block: bigint) => block === 100n ? fixture.historicalClaims : fixture.claims }));
vi.mock("../../vlCVX/expiry/active", () => ({ readActiveVotersMerkle: async () => fixture.merkle }));
vi.mock("../../vlCVX/expiry/round", () => ({ readExpiryRound: async () => ({ round: fixture.round }) }));
import { main } from "../../vlCVX/expiry/run";

const USER = "0x0000000000000000000000000000000000000001";
const TOKEN = "0x0000000000000000000000000000000000000002";
const TREASURY = "0x0000000000000000000000000000000000000003";
const SAFE = "0x0000000000000000000000000000000000000004";
const MODULE = "0x0000000000000000000000000000000000000005";
const ZERO = utils.hexZeroPad("0x00", 32);
const HASH = utils.hexZeroPad("0x01", 32);
const AT = Date.UTC(2026, 9, 29, 12) / 1000;
let directory: string;
let originalDirectory: string;
let values: Record<string, any>;
const decision = () => JSON.parse(fs.readFileSync("expiry-job.json", "utf8"));

beforeEach(() => {
  originalDirectory = process.cwd();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-runtime-"));
  process.chdir(directory);
  vi.stubEnv("MODE", "execute");
  fixture.merkle = generateMerkleTree({ [USER]: { [TOKEN]: "100" }, [TREASURY]: { [TOKEN]: "0" } });
  fixture.claims = { [expiryKey(USER, TOKEN)]: "0", [expiryKey(TREASURY, TOKEN)]: "0" };
  fixture.historicalClaims = { ...fixture.claims };
  fixture.ledger = bootstrapExpiryLedger(1, [{ root: ZERO, block: 0, blockHash: HASH, timestamp: 0, merkle: null }, { root: fixture.merkle.merkleRoot, block: 1, blockHash: HASH, timestamp: AT - 365 * 86400, merkle: fixture.merkle }], fixture.claims, { block: 100, blockHash: HASH });
  fixture.history = { "100": structuredClone(fixture.ledger) };
  fixture.round = 242;
  Object.assign(fixture.deployment, { address: MODULE, safe: SAFE, preparer: ALL_MIGHT_V2, delay: 10800, codeHash: utils.keccak256("0x6000") });
  Object.assign(fixture.policy, { treasury: TREASURY, approval: { reference: "fixture", passedAt: 0 }, notices: [{ url: "https://gov.stakedao.org/t/fixture", announcedAt: 0 }, { url: "https://stakedao.org/fixture", announcedAt: 0 }] });
  for (const folder of ["bounties-reports/expiry/state/1", "bounties-reports/expiry/bootstrap/1"]) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(`${folder}/${folder.includes("state") ? "bootstrap" : "ledger"}.json`, JSON.stringify(fixture.ledger));
  }
  values = { root: fixture.ledger.root, owner: SAFE, timelock: 10800n, pendingRoot: [ZERO, ZERO, 0n], proposal: ZERO, proposedAt: 0n, PREPARER: ALL_MIGHT_V2, SAFE, TREASURY, DELAY: 10800n, DISTRIBUTOR: fixture.ledger.distributor };
  fixture.client.getChainId.mockResolvedValue(1);
  fixture.client.getBytecode.mockResolvedValue("0x6000");
  fixture.client.getBlock.mockImplementation(async () => ({ number: 100n, hash: HASH, timestamp: BigInt(AT) }));
  fixture.client.readContract.mockImplementation(async ({ functionName }) => values[functionName]);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(fs.readFileSync(url.replace("https://raw.githubusercontent.com/stake-dao/bounties-report/main/", "")), { status: 200 })));
});

afterEach(() => {
  process.chdir(originalDirectory);
  fs.rmSync(directory, { recursive: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("automated expiry prepare", () => {
  it("plans without publication reads and emits prepare only after durable publication", async () => {
    await main("plan", "1");
    expect(decision().status).toBe("prepared");
    expect(fetch).not.toHaveBeenCalled();
    await main("prepare", "1");
    expect(decision()).toMatchObject({ phase: "prepare", status: "ready", target: MODULE });
    expect(decision().calldata.slice(0, 10)).toBe(utils.id("prepare((uint256,uint256,bool,bytes32,bytes32,address,uint256,(address,uint256,uint256)[],bytes,bytes32[]))").slice(0, 10));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires exact durable inputs in execute mode and when mode is unset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await expect(main("prepare", "1")).rejects.toThrow("durably published");
    vi.stubEnv("MODE", undefined);
    await expect(main("prepare", "1")).rejects.toThrow("durably published");
  });

  it("allows test simulation without publishing but still checks immutable preparer", async () => {
    vi.stubEnv("MODE", "test");
    await main("prepare", "1");
    expect(decision()).toMatchObject({ phase: "prepare", status: "ready" });
    expect(fetch).not.toHaveBeenCalled();
    values.PREPARER = USER;
    await expect(main("prepare", "1")).rejects.toThrow("module domain");
  });

  it("never resets an existing proposal or replaces a conflicting proposal", async () => {
    await main("plan", "1");
    values.proposal = decision().digest;
    values.proposedAt = BigInt(AT - 100);
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "waiting", reason: "already prepared" });
    values.proposal = HASH;
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "waiting", reason: "another expiry proposal is pending" });
    expect(values.proposedAt).toBe(BigInt(AT - 100));
  });

  it("waits for pending distributor roots and checks distributor ownership", async () => {
    values.pendingRoot[2] = 1n;
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "waiting", reason: "distributor root is pending" });
    values.owner = USER;
    await expect(main("prepare", "1")).rejects.toThrow("owner changed");
  });

  it("retains the longer distributor timelock before activation", async () => {
    await main("plan", "1");
    values.proposal = decision().digest;
    values.proposedAt = BigInt(AT - 10800);
    values.timelock = 21600n;
    await main("activate", "1");
    expect(decision()).toMatchObject({ phase: "activate", status: "waiting", validAt: AT + 10800 });
    fixture.client.getBlock.mockImplementation(async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 101n, hash: HASH, timestamp: BigInt(blockNumber === 100n ? AT : AT + 10800) }));
    await main("activate", "1");
    expect(decision()).toMatchObject({ phase: "activate", status: "ready" });
  });

  it("preserves the pending digest after a full competing claim", async () => {
    await main("plan", "1");
    const digest = decision().digest;
    values.proposal = digest;
    values.proposedAt = BigInt(AT);
    fixture.claims[expiryKey(USER, TOKEN)] = "100";
    fixture.client.getBlock.mockImplementation(async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 101n, hash: HASH, timestamp: BigInt(blockNumber === 100n ? AT : AT + 100) }));
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "waiting", reason: "already prepared", digest });
    expect(values.proposedAt).toBe(BigInt(AT));
  });

  it("keeps a prepared first batch and its round across epoch rollover", async () => {
    await main("plan", "1");
    const digest = decision().digest;
    values.proposal = digest;
    values.proposedAt = BigInt(AT);
    fixture.round = 244;
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "waiting", reason: "already prepared", round: 242, digest });
  });

  it("selects the onchain proposal when another valid candidate sorts first", async () => {
    await main("plan", "1");
    const first = decision().digest;
    const state = structuredClone(fixture.ledger);
    state.checkpoint = { block: 101, blockHash: HASH };
    fixture.history["101"] = structuredClone(state);
    const other = prepareExpiry(state, fixture.merkle, fixture.policy, TOKEN, 242, 0, AT + 100, { address: MODULE, safe: SAFE, preparer: ALL_MIGHT_V2, delay: 10800 })!;
    const second = expiryDigest(other);
    fs.writeFileSync(`bounties-reports/expiry/state/1/prepared/${second}.json`, JSON.stringify(other));
    values.proposal = [first, second].sort()[1];
    values.proposedAt = BigInt(AT + 100);
    fixture.client.getBlock.mockImplementation(async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 101n, hash: HASH, timestamp: BigInt(blockNumber === 100n ? AT : AT + 100) }));
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "waiting", reason: "already prepared", digest: values.proposal });
  });

  it("replaces only a canonical known proposal invalidated by an ordinary root", async () => {
    await main("plan", "1");
    const stale = decision().digest;
    values.proposal = stale;
    values.proposedAt = BigInt(AT);
    fixture.merkle = generateMerkleTree({ [USER]: { [TOKEN]: "150" }, [TREASURY]: { [TOKEN]: "0" } });
    fixture.ledger = recordExpiryDistribution(fixture.ledger, { root: fixture.merkle.merkleRoot, block: 101, blockHash: HASH, timestamp: AT + 86400, merkle: fixture.merkle }, { [expiryKey(USER, TOKEN)]: "50" }, fixture.claims);
    values.root = fixture.ledger.root;
    fixture.client.getBlock.mockImplementation(async ({ blockNumber }: any = {}) => ({ number: blockNumber ?? 101n, hash: HASH, timestamp: BigInt(blockNumber === 100n ? AT : AT + 86400) }));
    await main("prepare", "1");
    expect(decision()).toMatchObject({ status: "ready", phase: "prepare", replaces: stale });
    expect(decision().digest).not.toBe(stale);
    expect(values.proposedAt).toBe(BigInt(AT));
  });

  it("rejects mutable bootstrap replacement and forged prepared credit ages", async () => {
    fs.writeFileSync("bounties-reports/expiry/state/1/bootstrap.json", "{}");
    await expect(main("plan", "1")).rejects.toThrow("reviewed bootstrap");
    fs.writeFileSync("bounties-reports/expiry/state/1/bootstrap.json", JSON.stringify(fixture.ledger));
    await main("plan", "1");
    const file = decision().input;
    const original = JSON.parse(fs.readFileSync(file, "utf8"));
    original.state.pairs[expiryKey(USER, TOKEN)].credits[0].activatedAt--;
    const forged = prepareExpiry(original.state, original.parent, original.policy, TOKEN, original.batch.round, original.batch.index, original.at, original.module)!;
    fs.unlinkSync(file);
    fs.writeFileSync(path.join(path.dirname(file), `${expiryDigest(forged)}.json`), JSON.stringify(forged));
    await expect(main("prepare", "1")).rejects.toThrow("canonical prepared input");
  });
});
