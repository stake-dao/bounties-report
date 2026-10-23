import fs from "fs";
import path from "path";
import net from "net";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { Contract, ContractFactory, providers, utils } from "ethers";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import expiryAbi from "../../../abis/RewardsExpiry.json";
import expiryDeployment from "./fixtures/rewards-expiry.json";
import { ALL_MIGHT_V2 } from "../../utils/constants";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";
import { applyConfirmedExpiry, bootstrapExpiryLedger, EXPIRY_DISTRIBUTOR, EXTRA_REWARDS_DISTRIBUTOR, expiryDigest, expiryKey, expiryRound, prepareExpiry, Publication, recordExpiryDistribution, sixCalendarMonths, syncExpiryClaims, verifyExpiryParent, writeExpiryInput } from "../../shared/merkle/expiry";
import { readVmRewards } from "../../extraRewards/expiry/sources";
import { readConfirmedExpiry } from "../../vlCVX/expiry/chain";
import { replayExpiryJournal } from "../../vlCVX/expiry/journal";
import { readExpiryRound } from "../../vlCVX/expiry/round";
import { readActiveVotersMerkle } from "../../vlCVX/expiry/active";
import { prepareActiveBaseline } from "../../vlCVX/3_merkles/createCombinedMerkle";
import { createCombineDistribution } from "../../utils/merkle/merkle";
import { resolveBaseline } from "../../verify/invariants/baseline";
import { loadArchivedPairs, toPairMap } from "../../verify/invariants/artifact";
import { positiveDeltas } from "../../verify/invariants/exclusivity";

describe.skipIf(!process.env.EXPIRY_RPC)("expiry lifecycle on deployed URD and Safe", () => {
  it("records live recoveries, preserves recent credits and resumes the next round", async () => {
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const processHandle: ChildProcess = spawn("anvil", ["--fork-url", process.env.EXPIRY_RPC!, "--fork-block-number", "26190047", "--chain-id", "1", "--port", String(port), "--silent", "--no-mining"], { stdio: "ignore" });
    const directory = fs.mkdtempSync(path.resolve("script/test/integration/expiry-run-"));
    const stateDir = path.join(directory, "state/1");
    const rootsDir = path.join(directory, "roots/1");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(rootsDir, { recursive: true });
    let serving: ChildProcess | undefined;
    try {
      const provider = new providers.JsonRpcProvider(`http://127.0.0.1:${port}`);
      let ready = false;
      for (let attempt = 0; attempt < 300; ++attempt) {
        if (processHandle.exitCode !== null) throw new Error("isolated fork process exited");
        try { ready = await provider.getBlockNumber() === 26190047; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      const client = createPublicClient({ chain: mainnet, transport: http(`http://127.0.0.1:${port}`) });
      const urd = new Contract(EXPIRY_DISTRIBUTOR, ["function owner() view returns(address)", "function timelock() view returns(uint256)", "function root() view returns(bytes32)", "function claimed(address,address) view returns(uint256)", "function submitRoot(bytes32,bytes32)", "function acceptRoot()", "function claim(address,address,uint256,bytes32[]) returns(uint256)"], provider);
      const safe = await urd.owner();
      expect(safe.toLowerCase()).toBe("0xb0552b6860ce5c0202976db056b5e3cc4f9cc765");
      expect((await urd.timelock()).toNumber()).toBe(10800);
      const unlock = async (account: string) => {
        await provider.send("anvil_impersonateAccount", [account]);
        await provider.send("anvil_setBalance", [account, utils.hexValue(utils.parseEther("100"))]);
        return provider.getSigner(account);
      };
      const safeSigner = await unlock(safe);
      const signer = provider.getSigner(0);
      const mine = async (pending: Promise<any>) => {
        const transaction = await pending;
        await provider.send("evm_mine", []);
        return { transaction, receipt: await transaction.wait() };
      };
      const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const usdc = new Contract(token, ["function masterMinter() view returns(address)", "function configureMinter(address,uint256) returns(bool)", "function mint(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], provider);
      const minter = await unlock(await usdc.masterMinter());
      await mine(usdc.connect(minter).configureMinter(await signer.getAddress(), 10000000));
      const treasury = utils.getAddress("0x000000000000000000000000000000002109ffff");
      const competing = utils.getAddress("0x0000000000000000000000000000000021090000");
      const protectedUser = utils.getAddress("0x0000000000000000000000000000000021090001");
      const recent = utils.getAddress("0x000000000000000000000000000000002109fffe");
      const module = await new ContractFactory(expiryAbi, expiryDeployment.creationBytecode, signer).deploy(EXPIRY_DISTRIBUTOR, treasury, ALL_MIGHT_V2);
      await provider.send("evm_mine", []);
      await module.deployed();
      const domain = { address: module.address, safe, preparer: ALL_MIGHT_V2, delay: 10800 };
      expect(await module.PREPARER()).toBe(ALL_MIGHT_V2);
      const manager = new Contract(safe, ["function enableModule(address)"], safeSigner);
      await mine(manager.enableModule(module.address));
      const guardedPrepare = async (input: ReturnType<typeof prepareExpiry>, ready?: any) => {
        const decisionFile = path.join(directory, "prepare-guard-input.json");
        const resultFile = path.join(directory, "prepare-guard-result.json");
        fs.writeFileSync(decisionFile, JSON.stringify(ready ?? { phase: "prepare", chainId: 1, target: module.address, calldata: module.interface.encodeFunctionData("prepare", [input!.batch]) }));
        const run = spawnSync(path.resolve("../../../automation-guard/.venv/bin/python"), ["-m", "pytest", "-q", "tests/jobs/vlcvx_expiry/test_expiry_fork.py", "-k", "guarded_activation"], { cwd: path.resolve("../automation-guard"), env: { ...process.env, EXPIRY_JOB_RPC: `http://127.0.0.1:${port}`, EXPIRY_JOB_INPUT: decisionFile, EXPIRY_JOB_RESULT: resultFile }, encoding: "utf8", timeout: 60000 });
        if (run.status !== 0) throw new Error(`${run.error ?? ""}${run.stdout}${run.stderr}`);
        return JSON.parse(fs.readFileSync(resultFile, "utf8"));
      };
      const inputs = JSON.parse(fs.readFileSync("bounties-reports/expiry/bootstrap/1/inputs.json", "utf8"));
      const publications = inputs.publications.filter(publication => publication.block <= 26190047);
      const activeRoot = (await urd.root()).toLowerCase();
      const known = [...publications].reverse().find(publication => publication.root.toLowerCase() === activeRoot && publication.merkle);
      const preceding = [...publications].reverse().find(publication => publication.block < known.block && !/^0x0{64}$/.test(publication.root));
      const original = generateMerkleTree(verifyExpiryParent(known.merkle));
      expect(await urd.root()).toBe(original.merkleRoot);
      const distribution = verifyExpiryParent(original);
      const readClaims = async () => {
        const pairs = Object.entries(distribution).flatMap(([account, tokens]) => Object.keys(tokens).map(token => ({ account, token })));
        const claims: Record<string, string> = {};
        const abi = [{ type: "function", name: "claimed", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const;
        for (let offset = 0; offset < pairs.length; offset += 200) {
          const chunk = pairs.slice(offset, offset + 200);
          const values = await client.multicall({ allowFailure: false, contracts: chunk.map(pair => ({ address: EXPIRY_DISTRIBUTOR as `0x${string}`, abi, functionName: "claimed" as const, args: [pair.account as `0x${string}`, pair.token as `0x${string}`] })) });
          chunk.forEach((pair, i) => { claims[expiryKey(pair.account, pair.token)] = (values[i] as bigint).toString(); });
        }
        return claims;
      };
      const initialClaims = await readClaims();
      for (const [account, tokens] of Object.entries(distribution)) {
        for (const reward of Object.keys(tokens)) {
          const paid = BigInt(initialClaims[expiryKey(account, reward)]);
          if (BigInt(tokens[reward]) < paid) tokens[reward] = paid.toString();
        }
      }
      const ordinary = async (when: number): Promise<Publication> => {
        const merkle = generateMerkleTree(distribution);
        await provider.send("evm_setNextBlockTimestamp", [when - 10800]);
        await mine(urd.connect(safeSigner).submitRoot(merkle.merkleRoot, utils.hexZeroPad("0x00", 32)));
        await provider.send("evm_setNextBlockTimestamp", [when]);
        const { receipt } = await mine(urd.connect(signer).acceptRoot({ gasLimit: 150000 }));
        const block = await provider.getBlock(receipt.blockNumber);
        return { root: merkle.merkleRoot, timestamp: block.timestamp, block: block.number, blockHash: block.hash, merkle };
      };
      distribution[competing] = { [token]: "1000000" };
      distribution[protectedUser] = { [token]: "1000000" };
      distribution[treasury] = { [token]: "0" };
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 2000000));
      const first = await ordinary(Date.UTC(2026, 9, 31, 12) / 1000);
      const firstClaims = await readClaims();
      let ledger = bootstrapExpiryLedger(1, [inputs.publications[0], { ...preceding, merkle: null }, known, first], firstClaims, { block: first.block, blockHash: first.blockHash });
      writeExpiryInput(path.join(directory, "bootstrap.json"), ledger);
      writeExpiryInput(path.join(stateDir, "bootstrap.json"), ledger);
      distribution[competing][token] = "1400000";
      distribution[protectedUser][token] = "1400000";
      distribution[recent] = { [token]: "1000000" };
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 1800000));
      const expires = sixCalendarMonths(first.timestamp);
      expect(new Date(expires * 1000).toISOString()).toBe("2027-04-30T12:00:00.000Z");
      const second = await ordinary(expires);
      const rewards = { [expiryKey(competing, token)]: "400000", [expiryKey(protectedUser, token)]: "400000", [expiryKey(recent, token)]: "1000000" };
      ledger = recordExpiryDistribution(ledger, second, rewards, await readClaims());
      writeExpiryInput(path.join(rootsDir, `${second.root.toLowerCase()}.json`), second.merkle);
      writeExpiryInput(path.join(rootsDir, `${second.root.toLowerCase()}.rewards.json`), { chainId: 1, distributor: EXPIRY_DISTRIBUTOR, parent: first.root, root: second.root, rewards });
      await provider.send("anvil_mine", ["0x40"]);
      const beforeExpiry = await replayExpiryJournal(client, stateDir, domain);
      expect(beforeExpiry.root).toBe(second.root);
      expect(beforeExpiry.pairs[expiryKey(protectedUser, token)].credits).toEqual(ledger.pairs[expiryKey(protectedUser, token)].credits);
      const parentFile = path.join(directory, "published-parent.json");
      const readyFile = path.join(directory, "http-ready.json");
      fs.writeFileSync(parentFile, JSON.stringify(second.merkle));
      let servingError = "";
      serving = spawn("bun", ["test/expiryServing.fixture.ts", `http://127.0.0.1:${port}`, parentFile, readyFile], { cwd: path.resolve("../backend-monorepo/packages/hono-api"), env: { ...process.env, HONO_DB_PATH: ":memory:" }, stdio: ["ignore", "ignore", "pipe"] });
      serving.stderr!.on("data", data => { servingError += String(data); });
      for (let attempt = 0; attempt < 300 && !fs.existsSync(readyFile); ++attempt) {
        if (serving.exitCode !== null) throw new Error(servingError.slice(-3000));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const servingPort = JSON.parse(fs.readFileSync(readyFile, "utf8")).port;
      const servedClaim = async (account: string) => {
        const response = await fetch(`http://127.0.0.1:${servingPort}/v1/merkles?user=${account}`);
        const body: any = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(body));
        const claim = body.find((entry: any) => entry.chainId === 1 && entry.merkleContract.toLowerCase() === EXPIRY_DISTRIBUTOR.toLowerCase() && entry.address.toLowerCase() === token.toLowerCase());
        if (!claim) throw new Error(`missing served claim ${account}: ${servingError.slice(-2000)}`);
        return claim.merkle;
      };
      expect((await servedClaim(protectedUser)).amount).toBe("1400000");
      expect((await servedClaim(protectedUser)).amount).toBe("1400000");
      const policy = { treasury, approval: { reference: "isolated fork fixture", passedAt: first.timestamp - 31 * 86400 }, notices: [{ url: "https://gov.stakedao.org/t/isolated-fork-fixture", announcedAt: first.timestamp - 31 * 86400 }, { url: "https://stakedao.org/isolated-fork-fixture", announcedAt: first.timestamp - 31 * 86400 }] };
      const runtimeRoots = path.join(directory, "bounties-reports/expiry/roots");
      const runtimeState = path.join(directory, "bounties-reports/expiry/state");
      const runtimeBootstrap = path.join(directory, "bounties-reports/expiry/bootstrap/1");
      fs.mkdirSync(runtimeRoots, { recursive: true });
      fs.mkdirSync(runtimeState, { recursive: true });
      fs.mkdirSync(runtimeBootstrap, { recursive: true });
      fs.symlinkSync(rootsDir, path.join(runtimeRoots, "1"));
      fs.symlinkSync(stateDir, path.join(runtimeState, "1"));
      fs.copyFileSync(path.join(stateDir, "bootstrap.json"), path.join(runtimeBootstrap, "ledger.json"));
      vi.doMock("../../vlCVX/expiry/policy.json", () => ({ default: { "1": policy } }));
      const codeHash = utils.keccak256(await provider.getCode(module.address));
      vi.doMock("../../vlCVX/expiry/deployment.json", () => ({ default: { "1": { ...domain, codeHash } } }));
      vi.doMock("../../utils/getClients", () => ({ getClient: async () => client }));
      const { main: runExpiry } = await import("../../vlCVX/expiry/run");
      let published = false;
      const runtime = async (phase: string) => {
        const beforeDirectory = process.cwd();
        const beforeFetch = globalThis.fetch;
        const beforeMode = process.env.MODE;
        try {
          process.chdir(directory);
          process.env.MODE = "execute";
          globalThis.fetch = ((input, init) => {
            const prefix = "https://raw.githubusercontent.com/stake-dao/bounties-report/main/";
            if (!String(input).startsWith(prefix)) return beforeFetch(input, init);
            const file = path.join(directory, String(input).slice(prefix.length));
            return Promise.resolve(published && fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response(null, { status: 404 }));
          }) as typeof fetch;
          await runExpiry(phase, "1");
          return JSON.parse(fs.readFileSync("expiry-job.json", "utf8"));
        } finally {
          process.chdir(beforeDirectory);
          globalThis.fetch = beforeFetch;
          if (beforeMode === undefined) delete process.env.MODE;
          else process.env.MODE = beforeMode;
        }
      };
      const roundSource = await readExpiryRound(client);
      const { round } = roundSource;
      expect(prepareExpiry(ledger, second.merkle!, policy, token, round, 0, expires - 1, domain)).toBeNull();
      expect(new Date(sixCalendarMonths(Date.UTC(2027, 7, 31, 12) / 1000) * 1000).toISOString()).toBe("2028-02-29T12:00:00.000Z");
      const planned = await runtime("plan");
      const prepared = JSON.parse(fs.readFileSync(path.join(directory, planned.input), "utf8"));
      await expect(runtime("prepare")).rejects.toThrow("durably published");
      published = true;
      const preparation = await runtime("prepare");
      expect(preparation).toMatchObject({ status: "ready", phase: "prepare", digest: expiryDigest(prepared) });
      expect(prepared.batch.rows.map(row => row.account)).toEqual([competing, protectedUser]);
      expect(await module.digest(prepared.batch)).toBe(expiryDigest(prepared));
      writeExpiryInput(path.join(directory, "prepared.json"), prepared);
      const preparedDir = path.join(stateDir, "prepared");
      fs.mkdirSync(preparedDir, { recursive: true });
      const preparedFile = path.join(preparedDir, `${expiryDigest(prepared)}.json`);
      writeExpiryInput(preparedFile, prepared);
      const snapshot = await provider.send("evm_snapshot", []);
      await guardedPrepare(prepared, preparation);
      const proposedAt = await module.proposedAt();
      expect(await runtime("prepare")).toMatchObject({ status: "waiting", reason: "already prepared", digest: expiryDigest(prepared) });
      expect((await module.proposedAt()).eq(proposedAt)).toBe(true);
      expect(await runtime("activate")).toMatchObject({ status: "waiting", phase: "activate" });
      const competingClaim = second.merkle!.claims[competing].tokens[token];
      await mine(urd.connect(signer).claim(competing, token, competingClaim.amount, competingClaim.proof));
      const balance = await usdc.balanceOf(EXPIRY_DISTRIBUTOR);
      await provider.send("evm_increaseTime", [10800]);
      await provider.send("evm_mine", []);
      const activationReady = await runtime("activate");
      expect(activationReady).toMatchObject({ status: "ready", phase: "activate", digest: expiryDigest(prepared) });
      const decisionFile = path.join(directory, "guard-input.json");
      const guardResultFile = path.join(directory, "guard-result.json");
      fs.writeFileSync(decisionFile, JSON.stringify(activationReady));
      const guardRun = spawnSync(path.resolve("../../../automation-guard/.venv/bin/python"), ["-m", "pytest", "-q", "tests/jobs/vlcvx_expiry/test_expiry_fork.py"], { cwd: path.resolve("../automation-guard"), env: { ...process.env, EXPIRY_JOB_RPC: `http://127.0.0.1:${port}`, EXPIRY_JOB_INPUT: decisionFile, EXPIRY_JOB_RESULT: guardResultFile }, encoding: "utf8", timeout: 60000 });
      if (guardRun.status !== 0) throw new Error(`${guardRun.error ?? ""}${guardRun.stdout}${guardRun.stderr}`);
      const guardResult = JSON.parse(fs.readFileSync(guardResultFile, "utf8"));
      const transaction = await provider.getTransaction(guardResult.hash);
      const receipt = await provider.getTransactionReceipt(guardResult.hash);
      expect(await readConfirmedExpiry(client, prepared, transaction.hash as `0x${string}`)).toBeNull();
      await provider.send("anvil_mine", ["0x40"]);
      const activation = await readConfirmedExpiry(client, prepared, transaction.hash as `0x${string}`);
      expect(activation).not.toBeNull();
      expect(activation!.recovered).toBe("1000000");
      expect((await usdc.balanceOf(EXPIRY_DISTRIBUTOR)).eq(balance)).toBe(true);
      const applied = applyConfirmedExpiry(ledger, prepared, activation!);
      fs.renameSync(preparedFile, `${preparedFile}.missing`);
      await expect(replayExpiryJournal(client, stateDir, domain)).rejects.toThrow();
      fs.renameSync(`${preparedFile}.missing`, preparedFile);
      fs.unlinkSync(path.join(stateDir, "current.json"));
      await runtime("prepare");
      const pointer = JSON.parse(fs.readFileSync(path.join(stateDir, "current.json"), "utf8"));
      const replayed = JSON.parse(fs.readFileSync(path.join(stateDir, "states", `${pointer.state}.json`), "utf8"));
      expect(replayed.root).toBe(applied.merkle.merkleRoot);
      expect(replayed.pairs[expiryKey(protectedUser, token)].credits).toEqual(applied.ledger.pairs[expiryKey(protectedUser, token)].credits);
      expect((await replayExpiryJournal(client, stateDir, domain)).recoveries).toEqual(replayed.recoveries);
      ledger = applied.ledger;
      expect(await urd.root()).toBe(applied.merkle.merkleRoot);
      expect((await servedClaim(protectedUser)).amount).toBe("400000");
      expect((await servedClaim(recent)).amount).toBe("1000000");
      writeExpiryInput(path.join(directory, "activation.json"), activation);
      writeExpiryInput(path.join(directory, "ledger.json"), ledger);
      writeExpiryInput(path.join(directory, "proofs.json"), applied.merkle);
      expect(await provider.send("evm_revert", [snapshot])).toBe(true);
      expect(await urd.root()).toBe(second.root);
      expect((await servedClaim(protectedUser)).amount).toBe("1400000");
      await provider.send("anvil_mine", ["0x40"]);
      const rolledBack = await replayExpiryJournal(client, stateDir, domain);
      expect(rolledBack.root).toBe(second.root);
      expect(rolledBack.recoveries).toEqual([]);
      await expect(readConfirmedExpiry(client, prepared, transaction.hash as `0x${string}`)).rejects.toThrow();
      ledger = JSON.parse(fs.readFileSync(path.join(directory, "prepared.json"), "utf8")).state;
      await guardedPrepare(prepared);
      await mine(urd.connect(signer).claim(competing, token, competingClaim.amount, competingClaim.proof));
      await provider.send("evm_increaseTime", [10800]);
      const { transaction: retried } = await mine(module.connect(signer).activate(prepared.batch, { gasLimit: 12000000 }));
      await provider.send("anvil_mine", ["0x40"]);
      const confirmedRetry = await readConfirmedExpiry(client, prepared, retried.hash);
      const restored = applyConfirmedExpiry(ledger, prepared, confirmedRetry!);
      const retriedState = await replayExpiryJournal(client, stateDir, domain);
      expect(retriedState.root).toBe(restored.merkle.merkleRoot);
      expect(retriedState.recoveries).toHaveLength(1);
      fs.unlinkSync(path.join(rootsDir, `${restored.merkle.merkleRoot.toLowerCase()}.json`));
      const localRoots = path.join(directory, "bounties-reports/expiry/roots");
      fs.mkdirSync(localRoots, { recursive: true });
      expect(fs.realpathSync(path.join(localRoots, "1"))).toBe(fs.realpathSync(rootsDir));
      const originalDirectory = process.cwd();
      const originalFetch = globalThis.fetch;
      try {
        process.chdir(directory);
        globalThis.fetch = ((input, init) => {
          if (String(input).startsWith("https://hub.stakedao.org") || String(input).startsWith("https://raw.githubusercontent.com")) return Promise.reject(new Error("isolated publication/API outage"));
          return originalFetch(input, init);
        }) as typeof fetch;
        const localBaseline = await readActiveVotersMerkle(1, restored.merkle.merkleRoot, client);
        expect(localBaseline.merkleRoot).toBe(restored.merkle.merkleRoot);
        expect(localBaseline.claims[protectedUser].tokens[token].amount).toBe("400000");
        writeExpiryInput(path.join(rootsDir, `${localBaseline.merkleRoot.toLowerCase()}.json`), localBaseline);
        const violations: any[] = [];
        const preserved = await resolveBaseline({ target: "voters", chainId: 1, distributor: EXPIRY_DISTRIBUTOR, relPath: "vlCVX/vlcvx_merkle.json" }, client, confirmedRetry!.timestamp, path.join(directory, "bounties-reports"), violations, await client.getBlockNumber({ cacheTime: 0 }));
        expect(violations).toEqual([]);
        expect(preserved.pairs.get(protectedUser)!.get(token)).toBe(400000n);
      } finally {
        process.chdir(originalDirectory);
        globalThis.fetch = originalFetch;
      }
      ledger = restored.ledger;
      expect(restored.merkle.merkleRoot).toBe(applied.merkle.merkleRoot);
      for (const account of [protectedUser, recent, treasury]) {
        const claim = await servedClaim(account);
        await mine(urd.connect(signer).claim(account, token, claim.amount, claim.proof));
      }
      expect((await urd.claimed(protectedUser, token)).toString()).toBe("400000");
      expect(() => applyConfirmedExpiry(ledger, prepared, confirmedRetry!)).toThrow("replayed or stale");
      for (const [account, claim] of Object.entries(restored.merkle.claims)) distribution[account] = Object.fromEntries(Object.entries(claim.tokens).map(([reward, value]) => [reward, value.amount]));
      const fresh = { [protectedUser]: { tokens: { [token]: 100000n } } };
      const baseline = await prepareActiveBaseline(client, fresh, restored.merkle, await client.getBlockNumber({ cacheTime: 0 }));
      const combined = createCombineDistribution({ distribution: fresh }, baseline.previousMerkleData, baseline.reappearingClaimed);
      for (const account of Object.keys(distribution)) delete distribution[account];
      Object.assign(distribution, combined);
      expect(distribution[protectedUser][token]).toBe("500000");
      const fundingFile = path.join(directory, "funding-input.json");
      fs.writeFileSync(fundingFile, JSON.stringify({ period: Math.floor(confirmedRetry!.timestamp / 604800) * 604800, parent: restored.merkle.merkleRoot, merkle: generateMerkleTree(distribution) }));
      const fundingRun = spawnSync(path.resolve("../../../automation-guard/.venv/bin/python"), ["-m", "pytest", "-q", "tests/jobs/vlcvx_expiry/test_expiry_fork.py", "-k", "funding_baseline"], { cwd: path.resolve("../automation-guard"), env: { ...process.env, EXPIRY_JOB_RPC: `http://127.0.0.1:${port}`, EXPIRY_FUNDING_INPUT: fundingFile, EXPIRY_HTTP: `http://127.0.0.1:${servingPort}` }, encoding: "utf8", timeout: 60000 });
      if (fundingRun.status !== 0) throw new Error(`${fundingRun.error ?? ""}${fundingRun.stdout}${fundingRun.stderr}`);
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 100000));
      const next = await ordinary(confirmedRetry!.timestamp + 14 * 86400);
      writeExpiryInput(path.join(rootsDir, `${next.root.toLowerCase()}.json`), next.merkle);
      const nextPeriod = Math.floor(next.timestamp / 604800) * 604800;
      writeExpiryInput(path.join(rootsDir, `${next.root.toLowerCase()}.rewards.json`), { chainId: 1, distributor: EXPIRY_DISTRIBUTOR, period: nextPeriod, parent: restored.merkle.merkleRoot, root: next.root, rewards: { [expiryKey(protectedUser, token)]: "100000" } });
      const archivedDelta = loadArchivedPairs(path.join(directory, "bounties-reports"), nextPeriod, "vlCVX/vlcvx_merkle.json", 12, next.root);
      expect(positiveDeltas(toPairMap(next.merkle!), archivedDelta.pairs).get(protectedUser)!.get(token)).toBe(100000n);
      const carriedDelta = loadArchivedPairs(path.join(directory, "bounties-reports"), nextPeriod + 604800, "vlCVX/vlcvx_merkle.json", 12, next.root);
      expect(positiveDeltas(toPairMap(next.merkle!), carriedDelta.pairs).size).toBe(0);
      fs.writeFileSync(parentFile, JSON.stringify(next.merkle));
      ledger = recordExpiryDistribution(ledger, next, { [expiryKey(protectedUser, token)]: "100000" }, await readClaims());
      expect(prepareExpiry(ledger, next.merkle!, policy, token, round + 2, 0, next.timestamp, domain)).toBeNull();
      const claim = await servedClaim(protectedUser);
      expect(claim.amount).toBe("500000");
      await mine(urd.connect(signer).claim(protectedUser, token, claim.amount, claim.proof));
      ledger = syncExpiryClaims(ledger, await readClaims());
      expect(ledger.pairs[expiryKey(protectedUser, token)].credits.reduce((amount, credit) => amount + BigInt(credit.recovered), 0n)).toBe(1000000n);
      expect(ledger.pairs[expiryKey(protectedUser, token)].paid).toBe("500000");
      expect(ledger.runs[String(round)].complete).toBe(true);
      expect(await urd.owner()).toBe(safe);
      expect((await urd.timelock()).toNumber()).toBe(10800);
      await provider.send("anvil_mine", ["0x40"]);
      expect((await replayExpiryJournal(client, stateDir, domain)).root).toBe(next.root);
      const idleCheckpoint = await client.getBlock({ blockTag: "finalized" });
      const idleEntry = { kind: "idle", id: utils.id(`1:${round + 2}:${next.root}:${idleCheckpoint.hash}`), round: round + 2, root: next.root, checkpoint: { block: Number(idleCheckpoint.number), blockHash: idleCheckpoint.hash }, claims: Object.fromEntries(Object.entries(ledger.pairs).map(([key, pair]) => [key, pair.paid])) };
      writeExpiryInput(path.join(stateDir, "journal", `${utils.sha256(utils.toUtf8Bytes(JSON.stringify(idleEntry)))}.json`), idleEntry);
      const idleLedger = await replayExpiryJournal(client, stateDir, domain);
      expect(idleLedger.runs[String(round + 2)].complete).toBe(true);
      expect((await replayExpiryJournal(client, stateDir, domain)).pairs[expiryKey(protectedUser, token)].paid).toBe("500000");
      ledger = idleLedger;
      distribution[competing][token] = "1700000";
      distribution[protectedUser][token] = "800000";
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 600000));
      const partialStart = await ordinary(Date.UTC(2027, 5, 1, 12) / 1000);
      ledger = recordExpiryDistribution(ledger, partialStart, { [expiryKey(competing, token)]: "300000", [expiryKey(protectedUser, token)]: "300000" }, await readClaims());
      distribution[competing][token] = "1800000";
      distribution[protectedUser][token] = "900000";
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 200000));
      const partialParent = await ordinary(sixCalendarMonths(partialStart.timestamp));
      ledger = recordExpiryDistribution(ledger, partialParent, { [expiryKey(competing, token)]: "100000", [expiryKey(protectedUser, token)]: "100000" }, await readClaims());
      await provider.send("anvil_mine", ["0x40"]);
      const partialRound = (await readExpiryRound(client)).round;
      const part1 = prepareExpiry(ledger, partialParent.merkle!, policy, token, partialRound, 0, partialParent.timestamp, domain, 1)!;
      expect(part1.batch.last).toBe(false);
      await guardedPrepare(part1);
      await provider.send("evm_increaseTime", [10800]);
      const firstPart = await mine(module.connect(signer).activate(part1.batch, { gasLimit: 12000000 }));
      await provider.send("anvil_mine", ["0x40"]);
      const firstActual = await readConfirmedExpiry(client, part1, firstPart.transaction.hash);
      const firstState = applyConfirmedExpiry(ledger, part1, firstActual!);
      ledger = firstState.ledger;
      await provider.send("evm_increaseTime", [14 * 86400]);
      await provider.send("anvil_mine", ["0x41"]);
      const pollRound = (await readExpiryRound(client)).round;
      expect(pollRound).toBe(partialRound + 2);
      expect(expiryRound(ledger, pollRound)).toBe(partialRound);
      const part2 = prepareExpiry(ledger, firstState.merkle, policy, token, expiryRound(ledger, pollRound), 1, Number((await client.getBlock({ blockTag: "finalized" })).timestamp), domain, 1)!;
      expect(part2.batch.last).toBe(true);
      await guardedPrepare(part2);
      await provider.send("evm_increaseTime", [10800]);
      const secondPart = await mine(module.connect(signer).activate(part2.batch, { gasLimit: 12000000 }));
      await provider.send("anvil_mine", ["0x40"]);
      const secondActual = await readConfirmedExpiry(client, part2, secondPart.transaction.hash);
      const secondState = applyConfirmedExpiry(ledger, part2, secondActual!);
      expect(BigInt(firstActual!.recovered) + BigInt(secondActual!.recovered)).toBe(600000n);
      expect(secondState.ledger.runs[String(partialRound)].complete).toBe(true);
      expect(expiryRound(secondState.ledger, pollRound)).toBe(pollRound);
      for (const [account, amount] of [[competing, "100000"], [protectedUser, "100000"], [treasury, "600000"]]) {
        const leaf = secondState.merkle.claims[account].tokens[token];
        const before = await urd.claimed(account, token);
        const claimed = await mine(urd.connect(signer).claim(account, token, leaf.amount, leaf.proof));
        expect(claimed.receipt.status).toBe(1);
        expect((await urd.claimed(account, token)).sub(before).toString()).toBe(amount);
      }
      fs.writeFileSync(parentFile, JSON.stringify(partialParent.merkle));
      const active: any = await (await fetch(`http://127.0.0.1:${servingPort}/v1/merkles/active?chainId=1`)).json();
      expect(generateMerkleTree(verifyExpiryParent(active)).merkleRoot).toBe(secondState.merkle.merkleRoot);

      const unionAccount = utils.getAddress("0x0000000000000000000000000000000021090010");
      const unionUser = utils.getAddress("0x0000000000000000000000000000000021090011");
      Object.assign(distribution, verifyExpiryParent(secondState.merkle));
      distribution[unionAccount] = { [token]: "100000" };
      distribution[unionUser] = { [token]: "50000" };
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 150000));
      const unionSource = await ordinary((await provider.getBlock("latest")).timestamp + 14 * 86400);
      const ownClaim = unionSource.merkle!.claims[unionUser].tokens[token];
      await mine(urd.connect(signer).claim(unionUser, token, ownClaim.amount, ownClaim.proof));
      distribution[unionAccount][token] = "0";
      distribution[unionUser][token] = "200000";
      await mine(usdc.connect(signer).mint(EXPIRY_DISTRIBUTOR, 50000));
      const unionAssigned = await ordinary(sixCalendarMonths(unionSource.timestamp));
      const unionLedger = bootstrapExpiryLedger(1, [inputs.publications[0], { root: secondActual!.root, block: secondActual!.block, blockHash: secondActual!.blockHash, timestamp: secondActual!.timestamp, merkle: null }, unionSource, unionAssigned], await readClaims(), { block: unionAssigned.block, blockHash: unionAssigned.blockHash }, {
        root: unionAssigned.root,
        amounts: { [expiryKey(unionUser, token)]: "100000" },
        ageBound: { account: unionAccount, witness: { root: unionSource.root, block: unionSource.block, blockHash: unionSource.blockHash, timestamp: unionSource.timestamp }, roots: [unionSource.root, unionAssigned.root], amounts: { [token]: "100000" } },
      });
      const unionCredits = unionLedger.pairs[expiryKey(unionUser, token)].credits;
      expect(unionCredits[0].paid).toBe("50000");
      expect(unionCredits[2]).toMatchObject({ granted: "100000", paid: "0", activatedAt: unionAssigned.timestamp, ageBoundAt: unionSource.timestamp, protection: null });
      const unionRound = (await readExpiryRound(client)).round;
      const unionPrepared = prepareExpiry(unionLedger, unionAssigned.merkle!, policy, token, unionRound, 0, unionAssigned.timestamp, domain)!;
      expect(unionPrepared.batch.rows).toEqual([{ account: unionUser, amount: "200000", expiredThrough: "150000" }]);
      await guardedPrepare(unionPrepared);
      const unionSnapshot = await provider.send("evm_snapshot", []);
      const fullUnionClaim = unionAssigned.merkle!.claims[unionUser].tokens[token];
      await mine(urd.connect(signer).claim(unionUser, token, fullUnionClaim.amount, fullUnionClaim.proof));
      await provider.send("evm_increaseTime", [10800]);
      const racedUnion = await mine(module.connect(signer).activate(unionPrepared.batch, { gasLimit: 12000000 }));
      await provider.send("anvil_mine", ["0x40"]);
      const racedActual = await readConfirmedExpiry(client, unionPrepared, racedUnion.transaction.hash);
      expect(racedActual!.recovered).toBe("0");
      const racedState = applyConfirmedExpiry(unionLedger, unionPrepared, racedActual!);
      expect(racedState.ledger.pairs[expiryKey(unionUser, token)].credits[2]).toMatchObject({ paid: "100000", recovered: "0" });
      expect(await urd.root()).toBe(unionAssigned.root);
      expect(await provider.send("evm_revert", [unionSnapshot])).toBe(true);
      await provider.send("evm_increaseTime", [10800]);
      const recoveredUnion = await mine(module.connect(signer).activate(unionPrepared.batch, { gasLimit: 12000000 }));
      await provider.send("anvil_mine", ["0x40"]);
      const unionActual = await readConfirmedExpiry(client, unionPrepared, recoveredUnion.transaction.hash);
      expect(unionActual!.recovered).toBe("100000");
      const unionState = applyConfirmedExpiry(unionLedger, unionPrepared, unionActual!);
      expect(unionState.ledger.pairs[expiryKey(unionUser, token)].credits[1]).toMatchObject({ granted: "50000", paid: "0", recovered: "0", activatedAt: unionAssigned.timestamp });
      expect(unionState.ledger.pairs[expiryKey(unionUser, token)].credits[2]).toMatchObject({ paid: "0", recovered: "100000" });
      for (const [account, expected] of [[unionUser, "50000"], [treasury, "100000"]]) {
        const leaf = unionState.merkle.claims[account].tokens[token];
        const before = await urd.claimed(account, token);
        await mine(urd.connect(signer).claim(account, token, leaf.amount, leaf.proof));
        expect((await urd.claimed(account, token)).sub(before).toString()).toBe(expected);
      }
      const evidence = { productionActive: false, chainId: 1, forkBlock: 26190047, module: module.address, firstPublication: first.root, firstPublishedAt: first.timestamp, calendarExpiry: expires, roundSource, nextRound: round + 2, activeRoot: restored.merkle.merkleRoot, actualRecovery: confirmedRetry!.recovered, activationHash: retried.hash, revertedActivationHash: transaction.hash, guard: guardResult.guard, guardedActivationHash: guardResult.hash, nextRoot: next.root, nextPaid: ledger.pairs[expiryKey(protectedUser, token)].paid, activationGas: receipt.gasUsed.toString(), httpRoute: "/v1/merkles", delayedResultPublication: true, journalReplayedAfterCrash: true, journalReplayedAfterReorg: true, missingInputsRejected: true, noRewardRoundCompleted: true, fundingPreflight: "100000 fresh; no recovery funding", fullTreeRoute: "/v1/merkles/active", cachedResponseAmounts: ["1400000", "400000", "1400000", "400000", "500000"] };
      const destination = path.resolve("script/test/integration/evidence/expiry-lifecycle.json");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + "\n");
    } finally {
      serving?.kill("SIGTERM");
      processHandle.kill("SIGTERM");
      fs.rmSync(directory, { recursive: true });
    }
  }, 900000);
  it("expires only VM allocations in the mixed-source extra rewards distributor", async () => {
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const fork = spawn("anvil", ["--fork-url", process.env.EXPIRY_RPC!, "--fork-block-number", "26190047", "--port", String(port), "--silent"], { stdio: "ignore" });
    const directory = fs.mkdtempSync(path.resolve("script/test/integration/expiry-extra-"));
    const originalDirectory = process.cwd();
    const originalFetch = globalThis.fetch;
    let server: ChildProcess | undefined;
    try {
      const provider = new providers.JsonRpcProvider(`http://127.0.0.1:${port}`);
      for (let attempt = 0; attempt < 300; ++attempt) {
        try { if (await provider.getBlockNumber() === 26190047) break; } catch {}
        if (fork.exitCode !== null) throw new Error("extra rewards fork exited");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const client = createPublicClient({ chain: mainnet, transport: http(`http://127.0.0.1:${port}`) });
      const urd = new Contract(EXTRA_REWARDS_DISTRIBUTOR, ["function owner() view returns(address)", "function timelock() view returns(uint256)", "function root() view returns(bytes32)", "function claimed(address,address) view returns(uint256)", "function setRoot(bytes32,bytes32)", "function claim(address,address,uint256,bytes32[]) returns(uint256)"], provider);
      const safe = await urd.owner();
      expect((await urd.timelock()).toNumber()).toBe(0);
      await provider.send("anvil_impersonateAccount", [safe]);
      await provider.send("anvil_setBalance", [safe, utils.hexValue(utils.parseEther("100"))]);
      const signer = provider.getSigner(0);
      const safeSigner = provider.getSigner(safe);
      const treasury = "0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063";
      const user = "0x0000000000000000000000000000000021090001";
      const competing = "0x0000000000000000000000000000000021090002";
      const gaugeOnly = "0x0000000000000000000000000000000021090003";
      const token = utils.getAddress("0x04ACaF8D2865c0714F79da09645C13FD2888977f");
      const key = expiryKey(user, token);
      const module = await new ContractFactory(expiryAbi, expiryDeployment.creationBytecode, signer).deploy(EXTRA_REWARDS_DISTRIBUTOR, treasury, ALL_MIGHT_V2);
      await module.deployed();
      expect((await module.DELAY()).toNumber()).toBe(10800);
      await (await new Contract(safe, ["function enableModule(address)"], safeSigner).enableModule(module.address)).wait();
      const domain = { address: module.address, safe, preparer: ALL_MIGHT_V2, delay: 10800 };
      const treasuryPaid = (await urd.claimed(treasury, token)).toString();
      const distribution = { [user]: { [token]: "600" }, [treasury]: { [token]: treasuryPaid } };
      const publish = async (parent?: string) => {
        const merkle = generateMerkleTree(distribution);
        let transaction;
        if (parent) {
          const allMight = new Contract(ALL_MIGHT_V2, ["function execute(bytes32[],bytes[]) returns(bytes[])"], safeSigner);
          const commands = [
            utils.hexConcat([module.interface.getSighash("checkRoot"), "0x02", "0x00ffffffffff", "0xff", module.address]),
            utils.hexConcat([urd.interface.getSighash("setRoot"), "0x01", "0x0102ffffffff", "0xff", urd.address]),
          ];
          const state = [parent, merkle.merkleRoot, utils.hexZeroPad("0x00", 32)];
          transaction = await allMight.execute(commands, state);
        } else {
          transaction = await urd.connect(safeSigner).setRoot(merkle.merkleRoot, utils.hexZeroPad("0x00", 32));
        }
        const receipt = await transaction.wait();
        const block = await provider.getBlock(receipt.blockNumber);
        return { root: merkle.merkleRoot, merkle, block: block.number, blockHash: block.hash, timestamp: block.timestamp };
      };
      const first = await publish();
      const leaf = first.merkle.claims[user].tokens[token];
      await (await urd.connect(signer).claim(user, token, leaf.amount, leaf.proof)).wait();
      distribution[user][token] = "2000";
      distribution[competing] = { [token]: "2000" };
      distribution[gaugeOnly] = { [token]: "1000" };
      const old = await publish();
      const allocation = (id: number, account: string, amount: string) => ({ token: { address: token }, distribution: { incentiveId: id }, users: [{ user: account, amount }] });
      const rewards = { [key]: "1400", [expiryKey(competing, token)]: "2000", [expiryKey(gaugeOnly, token)]: "1000" };
      const allocations = [allocation(3, user, "400"), allocation(26, user, "700"), allocation(999999, user, "300"), allocation(3, competing, "1000"), allocation(26, competing, "1000"), allocation(26, gaugeOnly, "1000")];
      const vm = await readVmRewards(client, allocations, rewards, BigInt(old.block));
      expect(vm).toEqual({ [key]: "400", [expiryKey(competing, token)]: "1000" });
      expect(await readVmRewards(client, allocations, { [key]: "1100" }, BigInt(old.block))).toEqual({ [key]: "100" });
      const paid = { [key]: "600", [expiryKey(competing, token)]: "0", [expiryKey(gaugeOnly, token)]: "0", [expiryKey(treasury, token)]: treasuryPaid };
      let ledger = bootstrapExpiryLedger(1, [
        { ...first, root: utils.hexZeroPad("0x00", 32), merkle: null, block: first.block - 1 },
        { ...first, vmRewards: { [key]: "600" } },
        { ...old, vmRewards: vm },
      ], paid, { block: old.block, blockHash: old.blockHash }, null, EXTRA_REWARDS_DISTRIBUTOR);
      const expires = sixCalendarMonths(old.timestamp) + 86400;
      await provider.send("evm_setNextBlockTimestamp", [expires]);
      distribution[user][token] = "2500";
      const fresh = await publish();
      ledger = recordExpiryDistribution(ledger, fresh, { [key]: "500" }, paid, { [key]: "500" });
      const policy = { treasury, approval: { reference: "isolated fork", passedAt: first.timestamp }, notices: [{ url: "https://gov.stakedao.org/t/expiry-test", announcedAt: first.timestamp }, { url: "https://stakedao.org/expiry-test", announcedAt: first.timestamp }] };
      const expected = prepareExpiry(ledger, fresh.merkle, policy, token, 1, 0, expires, domain)!;
      const bootstrap = path.join(directory, "bounties-reports/expiry/extra/bootstrap/1");
      const archived = path.join(directory, "bounties-reports/expiry/extra/roots/1");
      fs.mkdirSync(bootstrap, { recursive: true });
      fs.mkdirSync(archived, { recursive: true });
      writeExpiryInput(path.join(bootstrap, "ledger.json"), ledger);
      writeExpiryInput(path.join(archived, `${fresh.root}.json`), fresh.merkle);
      await provider.send("anvil_mine", ["0x40"]);
      vi.resetModules();
      vi.doMock("../../utils/getClients", () => ({ getClient: async () => client }));
      vi.doMock("../../extraRewards/expiry/policy.json", () => ({ default: { "1": policy } }));
      const codeHash = utils.keccak256(await provider.getCode(module.address));
      vi.doMock("../../extraRewards/expiry/deployment.json", () => ({ default: { "1": { ...domain, codeHash } } }));
      const { main: runExtraExpiry } = await import("../../vlCVX/expiry/run");
      process.chdir(directory);
      await runExtraExpiry("plan", "1", "extra");
      const decision = JSON.parse(fs.readFileSync("expiry-job.json", "utf8"));
      expect(decision.status).toBe("prepared");
      const input = JSON.parse(fs.readFileSync(decision.input, "utf8"));
      expect(input.distributor).toBe(EXTRA_REWARDS_DISTRIBUTOR);
      expect(input.batch.rows).toEqual(expected.batch.rows);
      process.chdir(originalDirectory);
      expect(input.batch.rows.map(row => row.account)).not.toContain(gaugeOnly);
      expect(input.batch.rows.find(row => row.account === user)?.expiredThrough).toBe("1000");
      await (await module.connect(safeSigner).prepare(input.batch)).wait();
      await expect(module.callStatic.activate(input.batch)).rejects.toThrow();
      const competingLeaf = fresh.merkle.claims[competing].tokens[token];
      await (await urd.connect(signer).claim(competing, token, competingLeaf.amount, competingLeaf.proof)).wait();
      await provider.send("evm_increaseTime", [10800]);
      const receipt = await (await module.activate(input.batch)).wait();
      await provider.send("anvil_mine", ["0x40"]);
      const confirmed = await readConfirmedExpiry(client, input, receipt.transactionHash);
      expect(confirmed?.recovered).toBe("400");
      const applied = applyConfirmedExpiry(ledger, input, confirmed!);
      expect(applied.merkle.claims[user].tokens[token].amount).toBe("2100");
      expect(applied.merkle.claims[gaugeOnly].tokens[token].amount).toBe("1000");
      expect(applied.ledger.pairs[key].credits.filter(credit => credit.protection !== null).reduce((sum, credit) => sum + BigInt(credit.granted) - BigInt(credit.paid), 0n)).toBe(1000n);
      await expect(module.checkRoot(fresh.root)).rejects.toThrow();
      const roots = path.join(directory, "bounties-reports/expiry/extra/roots/1");
      fs.mkdirSync(roots, { recursive: true });
      writeExpiryInput(path.join(roots, `${fresh.root}.json`), fresh.merkle);
      process.chdir(directory);
      globalThis.fetch = ((url, init) => String(url).startsWith("http://127.0.0.1") ? originalFetch(url, init) : Promise.reject(new Error("isolated publication outage"))) as typeof fetch;
      const reconstructed = await readActiveVotersMerkle(1, applied.merkle.merkleRoot, client, EXTRA_REWARDS_DISTRIBUTOR);
      expect(reconstructed).toEqual(applied.merkle);
      const parentFile = path.join(directory, "parent.json");
      const readyFile = path.join(directory, "server.json");
      fs.writeFileSync(parentFile, JSON.stringify(fresh.merkle));
      server = spawn("bun", ["run", "test/expiryServing.fixture.ts", `http://127.0.0.1:${port}`, parentFile, readyFile, "extra"], { cwd: path.resolve(originalDirectory, "../backend-monorepo/packages/hono-api"), stdio: "pipe" });
      let serverError = "";
      server.stderr!.on("data", data => { serverError += String(data); });
      for (let attempt = 0; attempt < 300 && !fs.existsSync(readyFile); ++attempt) {
        if (server.exitCode !== null) throw new Error(serverError.slice(-2000));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const apiPort = JSON.parse(fs.readFileSync(readyFile, "utf8")).port;
      const response = await fetch(`http://127.0.0.1:${apiPort}/v1/merkles/active?chainId=1&target=extra`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(applied.merkle);
      vi.doMock("../../../../merkl-toolkit/src/utils/rpc", () => ({ getClient: async () => client }));
      const { default: axios } = await import("../../../../merkl-toolkit/node_modules/axios/index.js");
      const request = vi.spyOn(axios, "get").mockImplementation(async url => ({ data: String(url).includes("raw.githubusercontent.com") ? fresh.merkle : reconstructed }));
      const { activeExpiryBaseline } = await import("../../../../merkl-toolkit/src/utils/expiry");
      const baseline = await activeExpiryBaseline(fresh.merkle);
      expect(baseline.merkle).toEqual(reconstructed);
      const unpublished = verifyExpiryParent(fresh.merkle);
      unpublished[user][token] = "2600";
      const pending = { ...generateMerkleTree(unpublished), parentRoot: fresh.root, firstDistribution: fresh.timestamp + 1 };
      const rebased = await activeExpiryBaseline(pending);
      expect(rebased.merkle.claims[user].tokens[token].amount).toBe("2200");
      expect(rebased.root).toBe(reconstructed.merkleRoot);
      expect(rebased.firstDistribution).toBe(pending.firstDistribution);
      await expect(activeExpiryBaseline(first.merkle)).rejects.toThrow();
      request.mockRestore();

      for (const account of [user, gaugeOnly, treasury]) {
        const claim = reconstructed.claims[account].tokens[token];
        await (await urd.connect(signer).claim(account, token, claim.amount, claim.proof)).wait();
      }
      const next = verifyExpiryParent(baseline.merkle);
      next[user][token] = (BigInt(next[user][token]) + 100n).toString();
      Object.assign(distribution, next);
      await expect(publish(fresh.root)).rejects.toThrow();
      expect(await urd.root()).toBe(reconstructed.merkleRoot);
      const ordinary = await publish(reconstructed.merkleRoot);
      const updatedPaid = { ...paid, [key]: "2100", [expiryKey(competing, token)]: "2000", [expiryKey(gaugeOnly, token)]: "1000", [expiryKey(treasury, token)]: (BigInt(treasuryPaid) + 400n).toString() };
      const resumed = recordExpiryDistribution(applied.ledger, ordinary, { [key]: "100" }, updatedPaid);
      expect(resumed.pairs[key].credits.at(-1)?.protection).toBe("non-VM or unknown source");
      expect(resumed.pairs[key].activeAmount).toBe("2200");
      const state = path.join(directory, "bounties-reports/expiry/extra/state/1");
      fs.mkdirSync(path.join(state, "prepared"), { recursive: true });
      writeExpiryInput(path.join(state, "bootstrap.json"), ledger);
      writeExpiryInput(path.join(state, "prepared", `${expiryDigest(input)}.json`), input);
      const data = path.join(directory, "merkl-toolkit/data");
      const folder = path.join(data, "distributions", String(ordinary.timestamp));
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(data, "distribution.json"), JSON.stringify([{ timestamp: ordinary.timestamp }]));
      fs.writeFileSync(path.join(folder, "merkle.json"), JSON.stringify({ ...ordinary.merkle, parentRoot: applied.merkle.merkleRoot, firstDistribution: ordinary.timestamp }));
      fs.writeFileSync(path.join(folder, "distribution.json"), JSON.stringify({ incentives: [allocation(26, user, "100")] }));
      await provider.send("anvil_mine", ["0x40"]);
      const replayed = await replayExpiryJournal(client, state, domain);
      expect(replayed.root).toBe(resumed.root);
      expect(replayed.pairs[key].credits.at(-1)?.protection).toBe("non-VM or unknown source");

    } finally {
      process.chdir(originalDirectory);
      globalThis.fetch = originalFetch;
      server?.kill("SIGTERM");
      fork.kill("SIGTERM");
      fs.rmSync(directory, { recursive: true });
    }
  }, 300000);
});
