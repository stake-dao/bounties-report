import net from "node:net";
import { spawn } from "node:child_process";
import { Contract, providers, utils } from "ethers";
import { describe, expect, it } from "vitest";
import { createPublicClient, http, zeroHash } from "viem";
import { mainnet } from "viem/chains";
import { announceExpiry, prepareExpiryCut } from "../../recovery/twoPhase";
import { preparePublication, PublicationJournal } from "../../recovery/publicationJournal";
import { reconcilePublication } from "../../recovery/reconcilePublication";
import { appendPublication } from "../../recovery/monthly";
import { EXTRA, TREASURY_RECIPIENT, VOTERS } from "../../recovery/prepare";
import { expiryKey, Ledger } from "../../shared/merkle/expiry";
import { generateMerkleTree } from "../../shared/merkle/generateMerkleTree";

const BLOCK = 26428567;
const TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const A = "0x0000000000000000000000000000000021090000";
const B = "0x0000000000000000000000000000000021090001";
const REDIRECT = "0x0000000000000000000000000000000021090002";
const GUARD = "0x067e4F59F6Bd026897D771Fa430CA261d7C35205";
const SIGNER = "0x2468Fd5868dA9219b50c8d57bB4edba4097Bd20A";
const keyA = expiryKey(A, TOKEN), keyB = expiryKey(B, TOKEN), keyT = expiryKey(TREASURY_RECIPIENT, TOKEN);
const ABI = [
  "function owner() view returns(address)", "function timelock() view returns(uint256)",
  "function root() view returns(bytes32)", "function pendingRoot() view returns(bytes32,bytes32,uint256)",
  "function claimed(address,address) view returns(uint256)", "function recipients(address) view returns(address)",
  "function setRecipient(address,address)", "function setRoot(bytes32,bytes32)", "function submitRoot(bytes32,bytes32)",
  "function acceptRoot()", "function revokePendingRoot()", "function claim(address,address,uint256,bytes32[]) returns(uint256)",
  "event RootSet(bytes32 indexed newRoot,bytes32 indexed newIpfsHash)", "event PendingRootRevoked(address indexed caller)",
];

// Synthetic credits on real deployed contracts. This does not certify the live
// rewards ledger, campaign reserves, Guard permissions or proof-serving API.
describe.skipIf(!process.env.EXPIRY_RPC)("two-phase expiry on deployed Ethereum distributors", () => {
  it("survives permissionless claims and both cancels without a module", async () => {
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const anvil = spawn("anvil", ["--fork-url", process.env.EXPIRY_RPC!, "--fork-block-number", String(BLOCK), "--chain-id", "1", "--port", String(port), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    anvil.stderr.on("data", chunk => { errors += chunk; });
    const provider = new providers.JsonRpcProvider(`http://127.0.0.1:${port}`);
    provider.pollingInterval = 50;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 600; attempt++) {
        if (anvil.exitCode !== null) throw new Error(`Anvil exited: ${errors}`);
        try { ready = await provider.getBlockNumber() === BLOCK; } catch {}
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      expect(ready).toBe(true);
      const unlock = async (account: string) => {
        await provider.send("anvil_impersonateAccount", [account]);
        await provider.send("anvil_setBalance", [account, utils.hexValue(utils.parseEther("100"))]);
        return provider.getSigner(account);
      };
      const outsider = provider.getSigner(0);
      const signer = await unlock(SIGNER);
      const client = createPublicClient({ chain: mainnet, transport: http(`http://127.0.0.1:${port}`), cacheTime: 0 });
      const usdc = new Contract(TOKEN, ["function masterMinter() view returns(address)", "function configureMinter(address,uint256) returns(bool)", "function mint(address,uint256) returns(bool)", "function transfer(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], provider);
      const minter = await unlock(await usdc.masterMinter());
      // Read receipts directly: ethers' block listener keeps a high-water mark
      // across evm_revert and can wait forever for an already mined transaction.
      const mined = async (pending: Promise<any>) => {
        const tx = await pending;
        await provider.send("evm_mine", []);
        const raw = await provider.send("eth_getTransactionReceipt", [tx.hash]);
        expect(raw?.status).toBe("0x1");
        const receipt = provider.formatter.receipt(raw);
        const iface = new utils.Interface(ABI);
        const events = receipt.logs.flatMap(log => {
          try { return [{ ...log, event: iface.parseLog(log).name }]; } catch { return []; }
        });
        return { ...receipt, events };
      };
      await mined(usdc.connect(minter).configureMinter(await outsider.getAddress(), 1000000));
      const mint = (address: string, amount: number) => mined(usdc.connect(outsider).mint(address, amount));
      const baseSnapshot = await provider.send("evm_snapshot", []);
      for (const address of [VOTERS, EXTRA]) {
        // Isolate the distributors' scenarios, including USDC/recipient state.
        if (address === EXTRA) expect(await provider.send("evm_revert", [baseSnapshot])).toBe(true);
        const urd = new Contract(address, ABI, provider);
        const owner = await unlock(await urd.owner());
        const delay = (await urd.timelock()).toNumber();
        expect(delay).toBe(address === VOTERS ? 10800 : 0);
        expect((await urd.claimed(A, TOKEN)).toString()).toBe("0");
        expect((await urd.claimed(B, TOKEN)).toString()).toBe("0");
        const treasuryPaid = (await urd.claimed(TREASURY_RECIPIENT, TOKEN)).toString();
        const now = (await provider.getBlock("latest")).timestamp;
        const old = now - 250 * 86400;
        const first = generateMerkleTree({ [A]: { [TOKEN]: "30" }, [B]: { [TOKEN]: "30" }, [TREASURY_RECIPIENT]: { [TOKEN]: treasuryPaid } });
        const parent = generateMerkleTree({ [A]: { [TOKEN]: "100" }, [B]: { [TOKEN]: "100" }, [TREASURY_RECIPIENT]: { [TOKEN]: treasuryPaid } });
        const empty: Ledger = { version: 1, chainId: 1, distributor: address, root: zeroHash, checkpoint: { block: 1, blockHash: zeroHash }, pairs: {}, recoveries: [], runs: {} };
        let ledger = appendPublication(empty, { root: first.merkleRoot, merkle: first, block: 2, blockHash: zeroHash, timestamp: old }, { [keyA]: "30", [keyB]: "30" });
        ledger = appendPublication(ledger, { root: parent.merkleRoot, merkle: parent, block: 3, blockHash: zeroHash, timestamp: now - 2 * 86400 }, { [keyA]: "70", [keyB]: "70" });
        if (treasuryPaid !== "0") throw new Error("Fork fixture expects no prior Treasury claims");
        const policy = { treasury: TREASURY_RECIPIENT, approval: { reference: "isolated fork", passedAt: old }, notices: [{ url: "https://gov.stakedao.org/t/fork", announcedAt: old }, { url: "https://stakedao.org/fork", announcedAt: old }] };
        const notice = announceExpiry(ledger, policy, "2026-11", now - 86400);
        await mined(urd.connect(owner).setRoot(parent.merkleRoot, zeroHash));
        // These synthetic trees own exactly their minted funding. Remove the
        // unrelated live balance on this disposable fork so it cannot hide a deficit.
        await mined(usdc.connect(await unlock(address)).transfer(await outsider.getAddress(), await usdc.balanceOf(address)));
        await mint(address, 200);
        await mined(urd.connect(await unlock(A)).setRecipient(A, REDIRECT));
        const checkpoint = await provider.getBlock("latest");
        ledger.checkpoint = { block: checkpoint.number, blockHash: checkpoint.hash };
        const cut = prepareExpiryCut(notice, ledger, parent, now);
        let journal: PublicationJournal = {
          version: 1, pool: address === VOTERS ? "voters-1" : "extra-1", revision: 0,
          ledger, merkle: parent, notice, cut, history: [],
          publication: { version: 1, pool: address === VOTERS ? "voters-1" : "extra-1", revision: 0, kind: "cut", parent: parent.merkleRoot, merkle: cut.merkle, gains: {}, sources: [], reserves: { [TOKEN]: "0" }, checkpoint: ledger.checkpoint, ipfsHash: zeroHash },
        };
        const submit = async () => {
          const candidate = journal.publication!;
          const selector = urd.interface.getSighash(delay ? "submitRoot" : "setRoot");
          const command = utils.hexConcat([selector, "0x01", "0x0001ffffffff", "0xff", address]);
          const calldata = new utils.Interface(["function execute(bytes32[],bytes[])"]).encodeFunctionData("execute", [[command], [candidate.merkle.merkleRoot, candidate.ipfsHash]]);
          journal.submission = { calldata };
          journal.execution = { action: "submit", calldata };
          journal.revision++;
          return mined(signer.sendTransaction({ to: GUARD, data: calldata, gasLimit: 1500000 }));
        };
        const reconcile = async () => {
          // Anvil's finalized tag trails the tip; this advances a disposable
          // chain, not an assertion about Ethereum's wall-clock finality.
          await provider.send("anvil_mine", ["0x40"]);
          journal = await reconcilePublication(journal, client);
        };
        const claim = async (tree: typeof parent, account: string) => {
          const leaf = tree.claims[account].tokens[TOKEN];
          return mined(urd.connect(outsider).claim(account, TOKEN, leaf.amount, leaf.proof, { gasLimit: 300000 }));
        };
        const beforeUnsafe = await provider.send("evm_snapshot", []);
        await claim(parent, A);
        const unsafe = generateMerkleTree({ [A]: { [TOKEN]: "70" }, [B]: { [TOKEN]: "70" }, [TREASURY_RECIPIENT]: { [TOKEN]: "60" } });
        await mined(urd.connect(owner).setRoot(unsafe.merkleRoot, zeroHash));
        await claim(unsafe, TREASURY_RECIPIENT);
        const unpaid = unsafe.claims[B].tokens[TOKEN];
        expect((await usdc.balanceOf(address)).toString()).toBe("40");
        await expect(urd.connect(outsider).callStatic.claim(B, TOKEN, unpaid.amount, unpaid.proof)).rejects.toThrow();
        expect(await provider.send("evm_revert", [beforeUnsafe])).toBe(true);
        const mature = async () => {
          const pending = await urd.pendingRoot();
          await provider.send("evm_setNextBlockTimestamp", [pending[2].toNumber()]);
          await provider.send("evm_mine", []);
        };
        if (delay) {
          await submit();
          await expect(urd.connect(outsider).callStatic.acceptRoot()).rejects.toThrow();
          journal.cancelRequested = true;
          const revoked = await mined(urd.connect(owner).revokePendingRoot());
          await reconcile();
          expect(journal.cancelled).toBe(true);
          expect(journal.history.map(event => event.kind)).toEqual(["cancel"]);
          expect(revoked.events.some(event => event.event === "PendingRootRevoked")).toBe(true);
          expect(await urd.root()).toBe(parent.merkleRoot);
          expect((await urd.pendingRoot())[0]).toBe(zeroHash);
          delete journal.cancelRequested;
          delete journal.cancelled;
          await submit();
        }
        // A third party claims A under the parent while the cut is pending.
        const beforeRedirect = await usdc.balanceOf(REDIRECT);
        await claim(parent, A);
        expect((await usdc.balanceOf(REDIRECT)).sub(beforeRedirect).toString()).toBe("100");
        if (delay) {
          await mature();
          await mined(urd.connect(outsider).acceptRoot());
        } else await submit();
        expect(await urd.root()).toBe(cut.merkle.merkleRoot);
        await claim(cut.merkle, B);
        await reconcile();
        expect(journal.adopted!.reserve[TOKEN]).toBe("30"); // A released zero; B released 30.
        expect(journal.ledger.pairs[keyB].paid).toBe("70");
        const settlement = await preparePublication(journal, { [A]: { [TOKEN]: "5" }, [B]: { [TOKEN]: "9" } }, { [TOKEN]: "0" }, client, ["fork:fresh"]);
        journal.publication = settlement;
        const settled = settlement.merkle;
        expect(settled.claims[A].tokens[TOKEN].amount).toBe("105");
        expect(settled.claims[B].tokens[TOKEN].amount).toBe("79");
        expect(settled.claims[TREASURY_RECIPIENT].tokens[TOKEN].amount).toBe("30");
        await mint(address, 14);
        if (delay) {
          await submit();
          const funded = await usdc.balanceOf(address);
          journal.cancelRequested = true;
          await mined(urd.connect(owner).revokePendingRoot());
          await reconcile();
          expect(journal.cancelled).toBe(true);
          expect(await urd.root()).toBe(cut.merkle.merkleRoot);
          expect((await usdc.balanceOf(address)).toString()).toBe(funded.toString());
          // Retry uses already funded gains; no second mint/withdrawal.
          delete journal.cancelRequested;
          delete journal.cancelled;
          await submit();
          await mature();
          journal.cancelRequested = true;
          await mined(urd.connect(outsider).acceptRoot());
          // Revocation after an outsider accepted cannot undo the active root.
          await expect(urd.connect(owner).callStatic.revokePendingRoot()).rejects.toThrow();
          expect(await urd.root()).toBe(settled.merkleRoot);
        } else await submit();
        await reconcile();
        expect(journal.publication).toBeUndefined();
        expect(journal.adopted).toBeUndefined();
        expect(journal.creditedSources).toEqual(["fork:fresh"]);
        if (delay) {
          expect(journal.cancelRequested).toBe(true);
          await expect(preparePublication(journal, {}, { [TOKEN]: "0" }, client, ["fork:next"])).rejects.toThrow(/requires reconciliation/);
          delete journal.cancelRequested;
        }
        await expect(preparePublication(journal, {}, { [TOKEN]: "0" }, client, ["fork:fresh"])).rejects.toThrow(/already credited/);
        const readySnapshot = await provider.send("evm_snapshot", []);
        const beforeBalance = await usdc.balanceOf(address);
        for (const ordering of [[TREASURY_RECIPIENT, A, B], [B, A, TREASURY_RECIPIENT]]) {
          for (const account of ordering) await claim(settled, account);
          expect(beforeBalance.sub(await usdc.balanceOf(address)).toString()).toBe("44");
          expect((await usdc.balanceOf(address)).toString()).toBe("0");
          expect((await urd.claimed(A, TOKEN)).toString()).toBe("105");
          expect((await urd.claimed(B, TOKEN)).toString()).toBe("79");
          expect((await urd.claimed(TREASURY_RECIPIENT, TOKEN)).toString()).toBe("30");
          if (ordering[0] === TREASURY_RECIPIENT) expect(await provider.send("evm_revert", [readySnapshot])).toBe(true);
        }
        console.log(`${address}: Guard submissions + canonical journal replay; parent claim 100; retained claim 70; fresh 5+9; Treasury 30; both payout orders conserve 214; cancel windows ${delay ? "both verified, late halt retained" : "none (timelock=0)"}`);
      }
    } finally {
      anvil.kill("SIGTERM");
      await new Promise<void>(resolve => anvil.exitCode !== null ? resolve() : anvil.once("exit", () => resolve()));
      provider.removeAllListeners();
    }
  }, 240000);
});
