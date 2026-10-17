import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, parseAbi, parseAbiItem, parseUnits, toFunctionSelector } from "viem";
import { ContractRegistry } from "../../utils/contractRegistry";
import { FXN_STAKE_DAO_LOCKER, STAKE_DAO_LOCKER, VOTEMARKET_PLATFORM_CONFIGS, WEEK } from "../../utils/constants";
import { PROTOCOLS_TOKENS } from "../../utils/reportUtils";

const execute = promisify(execFile);
const root = process.cwd();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
const period = 1792022400;
const gauge = `0x${"1".repeat(40)}` as const;
const legacyGauge = `0x${"2".repeat(40)}` as const;
const zero = `0x${"0".repeat(40)}` as const;
const hash = `0x${"3".repeat(64)}` as const;
const claimV1 = parseAbiItem("event Claimed(address indexed user, address rewardToken, uint256 indexed bountyId, uint256 amount, uint256 protocolFees, uint256 period)");
const claimV2 = parseAbiItem("event Claim(uint256 indexed campaignId, address indexed account, uint256 amount, uint256 fee, uint256 epoch)");
const abi = parseAbi([
  "function getCampaign(uint256) view returns (uint256, address, address, address, uint8, uint256, uint256, uint256, uint256, uint256, address)",
  "function getBounty(uint256) view returns ((address gauge, address manager, address rewardToken, uint8 numberOfPeriods, uint256 endTimestamp, uint256 maxRewardPerVote, uint256 totalRewardAmount, address[] blacklist))",
  "function isWrapped(address) view returns (bool)",
  "function nativeTokens(address) view returns (address)",
  "function decimals() view returns (uint8)",
]);

describe("V2-only source-to-report gates", () => {
  it.each(["curve", "fxn"] as const)("validates %s files, RPC claims and allocations together", async (protocol) => {
    const directory = mkdtempSync(path.join(tmpdir(), "report-gate-v2-"));
    const token = PROTOCOLS_TOKENS[protocol].native.toLowerCase() as `0x${string}`;
    const account = protocol === "curve" ? STAKE_DAO_LOCKER : FXN_STAKE_DAO_LOCKER;
    const platform = ContractRegistry.getAddress(`${protocol.toUpperCase()}_VOTEMARKET_V2`, 42161);
    const legacyPlatform = VOTEMARKET_PLATFORM_CONFIGS[protocol][0].platform;
    const amount = parseUnits("100", 18);
    let legacy = false;
    let rpcFailure = false;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpc = JSON.parse(body);
      let result: unknown;
      if (rpc.method === "eth_blockNumber") result = "0x2";
      else if (rpc.method === "eth_getBlockByNumber") {
        const block = Number(BigInt(rpc.params[0]));
        result = { number: rpc.params[0], timestamp: `0x${[period - 1, period, period + WEEK][block].toString(16)}`, hash };
      } else if (rpc.method === "eth_getLogs") {
        const address = rpc.params[0].address.toLowerCase();
        const v1 = legacy && address === legacyPlatform.toLowerCase();
        const v2 = address === platform.toLowerCase();
        result = (request.url === "/1" && v1) || (request.url === "/42161" && v2) ? [{
          address, blockHash: hash, blockNumber: "0x1", logIndex: "0x0", transactionHash: hash, transactionIndex: "0x0", removed: false,
          topics: v1 ? encodeEventTopics({ abi: [claimV1], eventName: "Claimed", args: { user: account, bountyId: 1n } })
            : encodeEventTopics({ abi: [claimV2], eventName: "Claim", args: { account, campaignId: 1n } }),
          data: v1 ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [token, amount, 0n, BigInt(period)])
            : encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [amount, 0n, BigInt(period)]),
        }] : [];
      } else if (rpc.method === "eth_call") {
        const address = rpc.params[0].to.toLowerCase();
        result = address === platform.toLowerCase()
          ? encodeFunctionResult({ abi, functionName: "getCampaign", result: [1n, gauge, zero, token, 0, 0n, 0n, 0n, 0n, 0n, zero] })
          : address === legacyPlatform.toLowerCase()
            ? encodeFunctionResult({ abi, functionName: "getBounty", result: { gauge: legacyGauge, manager: zero, rewardToken: token, numberOfPeriods: 1, endTimestamp: 0n, maxRewardPerVote: 0n, totalRewardAmount: amount, blacklist: [] } })
            : address === token ? encodeFunctionResult({ abi, functionName: "decimals", result: 18 })
              : rpc.params[0].data.startsWith(toFunctionSelector("nativeTokens(address)"))
                ? encodeFunctionResult({ abi, functionName: "nativeTokens", result: token })
                : encodeFunctionResult({ abi, functionName: "isWrapped", result: true });
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(rpcFailure || result === undefined
        ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "RPC unavailable" } }
        : { jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const file = (relative: string, data: unknown) => {
      const target = path.join(directory, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, typeof data === "string" ? data : JSON.stringify(data));
    };
    const v1Path = `weekly-bounties/${period}/votemarket/claimed_bounties.json`;
    const v2Path = `weekly-bounties/${period}/votemarket-v2/claimed_bounties.json`;
    const claim = { bountyId: "1", gauge, rewardToken: token, amount: amount.toString(), chainId: 42161, isWrapped: true };
    const v2 = () => file(v2Path, { [protocol]: { 1: claim } });
    const report = (shift = false) => {
      file(`bounties-reports/${period}/${protocol}.csv`, [
        "Gauge Name;Gauge Address;Reward Token;Reward Address;Reward Amount;Reward sd Value;Share % per Protocol",
        `Current;${gauge};NATIVE;${token};100;${legacy && !shift ? 50 : 100};${legacy && !shift ? 50 : 100}`,
        ...(legacy ? [`Legacy;${legacyGauge};NATIVE;${token};100;${shift ? 0 : 50};${shift ? 0 : 50}`] : []),
      ].join("\n"));
      file(`bounties-reports/${period}/${protocol}-attribution.json`, {
        period, protocol, totals: { sdInTotal: 100 }, perToken: { [token]: { sd: 100 } },
        txs: [{ tx: hash, sdIn: 100, tokenSd: { [token]: 100 } }],
      });
    };
    const runner = path.join(directory, "gate.ts");
    writeFileSync(runner, `
      import { createPublicClient, http } from ${JSON.stringify(path.join(root, "node_modules/viem/_cjs/index.js"))};
      import { runR1, runR2, runR4 } from ${JSON.stringify(path.join(root, "script/sdTkns/verify/reportGate.ts"))};
      import { verifySourceClaims } from ${JSON.stringify(path.join(root, "script/sdTkns/verify/reportSources.ts"))};
      import { loadCompletion, verifySources } from ${JSON.stringify(path.join(root, "script/reports/guardCompletion.ts"))};
      async function main() {
        if (process.argv[2] === 'proof') {
          verifySources(loadCompletion('completion.json', '${protocol}'));
          console.log('proof verified');
          return;
        }
        const client = (chain) => createPublicClient({ transport: http('http://127.0.0.1:${port}/' + chain, { retryCount: 0 }) });
        const results = [runR1(${period}, ['${protocol}'])];
        if (!results[0].ok) throw new Error(results[0].detail);
        const claims = await verifySourceClaims(${period}, ['${protocol}'], async (chain) => client(chain));
        results.push(await runR2(${period}, ['${protocol}'], client(1)), runR4(${period}, ['${protocol}']));
        if (results.some((result) => !result.ok)) throw new Error(JSON.stringify(results));
        console.log(JSON.stringify({ claims, checks: results.map((result) => result.id) }));
      }
      main().catch((error) => { console.error(error.message); process.exitCode = 1; });
    `);
    const run = (mode = "gate") => execute(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), runner, mode], {
      cwd: directory, env: { PATH: process.env.PATH, GIT_DIR: gitDirectory, GIT_WORK_TREE: directory }, timeout: 15000,
    });
    try {
      v2(); report();
      expect((await run()).stdout).toContain('"claims":1,"checks":["R1","R2","R4"]');
      legacy = true;
      await expect(run()).rejects.toThrow(/curve\/v1|fxn\/v1/);
      file(v1Path, { [protocol]: { 1: { ...claim, gauge: legacyGauge, chainId: 1, isWrapped: false } } });
      report();
      expect((await run()).stdout).toContain('"claims":2,"checks":["R1","R2","R4"]');
      report(true);
      await expect(run()).rejects.toThrow(/gauge allocation weight differs/);
      report();
      file(v1Path, "{");
      await expect(run()).rejects.toThrow(/JSON|property name/);
      rmSync(path.join(directory, v1Path)); legacy = false; report();
      file(v2Path, { [protocol]: { 1: claim, 2: claim } });
      await expect(run()).rejects.toThrow(/extra in file/);
      file(v2Path, { [protocol]: { 1: { ...claim, amount: "1" } } });
      await expect(run()).rejects.toThrow(/mismatch/);
      file(v2Path, "{");
      await expect(run()).rejects.toThrow(/JSON|property name/);
      rmSync(path.join(directory, v2Path));
      await expect(run()).rejects.toThrow(/votemarket_v2: weekly claims file missing/);
      v2(); rpcFailure = true;
      await expect(run()).rejects.toThrow(/RPC unavailable/);
      file(v2Path, readFileSync(path.join(root, v2Path), "utf8"));
      file("completion.json", {
        schema: 1, chainId: 1, protocol, epoch: period, laneId: hash, pipelineRun: null,
        checkRunId: "1", checkRunAttempt: "1", guardCommit: commit, sourceCommit: commit, sourceDigest: hash,
        sources: { votemarket_v2: { path: v2Path, digest: hash } },
        fromBlock: 1, checkedBlock: 2, checkedBlockHash: hash, confirmations: 12,
        expected: {}, sold: {}, remaining: {}, delegated: {}, transactions: [],
        nativeFunded: "0", nativeConverted: "0", sdProduced: "0", sdDelivered: "0",
      });
      expect((await run("proof")).stdout).toContain("proof verified");
      file(v1Path, {});
      await expect(run("proof")).rejects.toThrow(/source changed/);
      rmSync(path.join(directory, v1Path));
      v2();
      await expect(run("proof")).rejects.toThrow(/source changed/);
      rmSync(path.join(directory, v2Path));
      await expect(run("proof")).rejects.toThrow(/source changed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
