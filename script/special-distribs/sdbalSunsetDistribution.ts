/**
 * sdBAL Sunset USDC Distribution (BIP-920 pass-through).
 *
 * Pipeline (CLI flag --phase selects):
 *   1  snapshot   : sdBAL holder balances at Balancer's BIP-920 snapshot block
 *   2  classify   : split EOA vs contract
 *   3  expand     : recurse contract holders (LP, gauge, vest, Safe)
 *   4  payouts    : compute pro-rata USDC amounts
 *   5  merge      : add USDC entries to data/extra_merkle/merkle.json, regen tree
 *   6  bundle     : Gnosis Safe tx bundles (submitRoot + acceptRoot)
 *   7  verify     : verification gate (alias: --phase verify)
 *   all           : run 1->7 sequentially with pre/post-merge gates
 *                   (halts if Phase 3 finds unknown contracts)
 *
 * Snapshot block 25035662 is fixed (BIP-920 vote start, May 8 2026 18:00 UTC).
 * USDC_RECEIVED is a placeholder until Balancer's airdrop tx lands at the locker.
 *
 *   pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 1
 *   pnpm tsx script/special-distribs/sdbalSunsetDistribution.ts --phase 5 --usdc 12345670000
 */

import fs from "node:fs";
import path from "node:path";
import {
  Address,
  Hex,
  PublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  keccak256,
  toHex,
} from "viem";
import { utils } from "ethers";
import MerkleTree from "merkletreejs";

import { SD_BAL, ETH_CHAIN_ID } from "../utils/constants";
import { createBlockchainExplorerUtils } from "../utils/explorerUtils";
import { getClient } from "../utils/getClients";

// ---------------------------------------------------------------------------
// Constants (BIP-920 anchors)
// ---------------------------------------------------------------------------

const SNAPSHOT_BLOCK = 25035662; // Balancer BIP-920 snapshot block (May 8 2026 18:00 UTC)
// sdBAL deploy block (Etherscan getcontractcreation). Wrappers holding sdBAL
// necessarily postdate it, so it also bounds wrapper Transfer replays; the
// replay-vs-totalSupply reconciliation hard-fails if any transfer were missed.
const SDBAL_DEPLOY_BLOCK = 14_847_930;
const ETH_CHAIN_ID_NUM = Number(ETH_CHAIN_ID);
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const ZERO_ADDR: Address = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

const ROOT_DIR = path.join(__dirname, "..", "..");
const OUT_DIR = path.join(__dirname, "sdbal-sunset");
const EXTRA_MERKLE = path.join(ROOT_DIR, "data", "extra_merkle", "merkle.json");
const EXTRA_SUMMARY = path.join(ROOT_DIR, "data", "extra_merkle", "summary.json");
const EXTRA_REPART = path.join(ROOT_DIR, "data", "extra_merkle", "repartition.json");

// Recursion depth limit. Deepest real chain at the snapshot:
// vault -> BPT -> Balancer gauge -> Aura voter proxy -> Aura reward pool stakers (5).
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BalanceMap {
  [address: string]: string; // bigint as decimal string
}

interface ClassifiedHolders {
  block: number;
  totalSupply: string;
  eoa: BalanceMap;
  contracts: BalanceMap;
}

interface ExpansionEntry {
  source: string; // contract addr that was expanded
  reason: string; // route taken ("curve-lp" / "stakedao-gauge" / "hedgey" / "safe" / ...)
  beneficiaries: BalanceMap;
}

interface ExpansionReport {
  block: number;
  totalSupply: string;
  expanded: ExpansionEntry[];
  finalBalances: BalanceMap;
  unknownContracts: string[]; // halt list
}

interface Payouts {
  block: number;
  usdcReceived: string;
  perAddress: { [address: string]: string };
  dustReassignedTo: string;
  minPayout: string;        // raw USDC floor applied ("0" = none)
  droppedRecipients: number; // recipients removed by the floor
  droppedValue: string;      // their USDC, redistributed pro-rata to the rest
  basis: string;             // "all-holders" or the expansion source the pot is restricted to
}

interface MerkleClaim {
  tokens: { [token: string]: { amount: string; proof: string[] } };
}
interface MerkleData {
  merkleRoot: string;
  claims: { [address: string]: MerkleClaim };
}
interface UniversalMerkle {
  [address: string]: { [token: string]: string };
}

// ---------------------------------------------------------------------------
// Phase 1 — Snapshot sdBAL holders @ block
// ---------------------------------------------------------------------------

async function phase1Snapshot(): Promise<BalanceMap> {
  ensureOut();
  const explorer = createBlockchainExplorerUtils();
  const client = await getClient(ETH_CHAIN_ID_NUM);

  console.log(`Phase 1 — snapshot sdBAL holders @ block ${SNAPSHOT_BLOCK}`);

  const logs = await explorer.getLogsByAddressesAndTopics(
    [SD_BAL],
    SDBAL_DEPLOY_BLOCK,
    SNAPSHOT_BLOCK,
    { "0": TRANSFER_TOPIC },
    ETH_CHAIN_ID_NUM,
  );
  console.log(`  fetched ${logs.result.length} Transfer events`);

  // Logs only DISCOVER the candidate address set; balances are read onchain via
  // balanceOf at the snapshot block. Explorer APIs can silently drop logs
  // (makeRequest falls back to {result: []} after retries) — replay-derived
  // balances would inherit the gap, balanceOf cannot. A dropped log can still
  // hide a holder entirely, which the sum==totalSupply invariant below catches.
  const candidates = new Set<string>();
  for (const log of logs.result) {
    candidates.add(getAddress(`0x${log.topics[1].slice(26)}`));
    candidates.add(getAddress(`0x${log.topics[2].slice(26)}`));
  }
  candidates.delete(ZERO_ADDR);
  console.log(`  candidate addresses: ${candidates.size}`);

  const totalSupply = await client.readContract({
    address: SD_BAL,
    abi: [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "totalSupply",
    blockNumber: BigInt(SNAPSHOT_BLOCK),
  }) as bigint;

  const balances: BalanceMap = {};
  let sum = 0n;
  const addrs = [...candidates];
  for (let i = 0; i < addrs.length; i += 25) {
    const chunk = addrs.slice(i, i + 25);
    const bals = await Promise.all(chunk.map((a) =>
      client.readContract({
        address: SD_BAL, abi: ERC20_ABI as any, functionName: "balanceOf", args: [a],
        blockNumber: BigInt(SNAPSHOT_BLOCK),
      }) as Promise<bigint>,
    ));
    chunk.forEach((a, j) => {
      if (bals[j] === 0n) return;
      if (a === getAddress(SD_BAL)) return; // contract self-balance never expected
      balances[a] = bals[j].toString();
      sum += bals[j];
    });
  }

  console.log(`  holders with positive balance: ${Object.keys(balances).length}`);
  console.log(`  Σ balances : ${sum.toString()}`);
  console.log(`  totalSupply: ${totalSupply.toString()}`);
  if (sum !== totalSupply) {
    throw new Error(`Σ holder balances (${sum}) != totalSupply (${totalSupply}) — holder missing from candidate set (dropped logs?)`);
  }

  writeJson(path.join(OUT_DIR, "holders_raw.json"), {
    block: SNAPSHOT_BLOCK,
    totalSupply: totalSupply.toString(),
    holders: balances,
  });
  console.log(`  wrote holders_raw.json`);
  return balances;
}

// ---------------------------------------------------------------------------
// Phase 2 — Classify EOA vs Contract
// ---------------------------------------------------------------------------

async function phase2Classify(): Promise<ClassifiedHolders> {
  ensureOut();
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const raw = readJson<{ block: number; totalSupply: string; holders: BalanceMap }>(
    path.join(OUT_DIR, "holders_raw.json"),
  );
  const addrs = Object.keys(raw.holders);
  console.log(`Phase 2 — classify ${addrs.length} addresses @ block ${raw.block}`);

  const eoa: BalanceMap = {};
  const contracts: BalanceMap = {};
  const batchSize = 25;
  for (let i = 0; i < addrs.length; i += batchSize) {
    const chunk = addrs.slice(i, i + batchSize);
    const codes = await Promise.all(
      chunk.map((a) =>
        client.getBytecode({ address: a as Address, blockNumber: BigInt(raw.block) }),
      ),
    );
    chunk.forEach((a, j) => {
      const code = codes[j];
      const isContract = code !== undefined && code !== "0x" && code !== null && code.length > 2;
      (isContract ? contracts : eoa)[a] = raw.holders[a];
    });
    if (i % (batchSize * 8) === 0) {
      console.log(`  ${i + chunk.length}/${addrs.length} classified`);
    }
  }

  const out: ClassifiedHolders = {
    block: raw.block,
    totalSupply: raw.totalSupply,
    eoa,
    contracts,
  };
  writeJson(path.join(OUT_DIR, "holders_classified.json"), out);
  console.log(`  EOA      : ${Object.keys(eoa).length}`);
  console.log(`  contract : ${Object.keys(contracts).length}`);
  return out;
}

// ---------------------------------------------------------------------------
// Phase 3 — Expand contract holders (recursive)
//
// Route table is intentionally narrow: contracts not matched halt the script.
// User signoff required before adding routes.
// ---------------------------------------------------------------------------

// Interface probes — used by classifyContract() to auto-route without hardcoded lists.
const SAFE_ABI = [{ name: "getOwners", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] }] as const;
const BPT_ABI = [{ name: "getPoolId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] }] as const;
const CURVE_GAUGE_ABI = [{ name: "lp_token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const SD_GAUGE_ABI = [{ name: "staking_token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ERC4626_ABI = [{ name: "asset", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const VESTER_ABI = [{ name: "beneficiary", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const ERC20_ABI = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Per-deployment overrides. Every entry is an explicit, human-reviewed decision
// (identification evidence verified onchain at the snapshot block).
// "leaf" pays the address itself (URD claims are permissionless; funds land at the
// leaf address — for contracts without a sweep path that strands the USDC, which is
// accepted for dust; flagged per-entry).
const KNOWN_OVERRIDES: Record<string, Route> = {
  // --- expansions ---
  "0xba12222222228d8ba445958a75a0704d566bf2c8": "balancer-vault", // Balancer V2 Vault — sdBAL belongs to BPT holders of the 2 verified pools
  "0x03e34b085c52985f6a5d27243f20c84bddc01db4": "stash",          // Stake DAO MultiMerkleStash — unclaimed sdBAL belongs to merkle claimants
  // Stake DAO Vester (per-beneficiary vesting of gauge tokens) — pay beneficiary()
  "0x08e828171d7503a34b7e20c1319296a6ee7ac676": "vester",
  "0x3d592531167e5c7c2c7e07d83b4dc4fc74593df3": "vester",
  "0x40a69d7966295c6eea95633fa6c0a87f25a89d61": "vester",
  "0xaf1a8e24b85c293b6bc38234c2d14062b9e0ae78": "vester",
  "0xd2da10ef5c78420682269134e543c72dced4cb5a": "vester",
  "0xeb90e2953b023d9496b963acd87ac3061fe8ea9e": "vester",
  "0xfe5e6765f820605ad7d58bec0f4e54893bd05bbb": "vester",
  // Vesters surfacing as unclaimed MultiMerkleStash claimants (vested gauge tokens
  // earned weekly sdBAL bribes that were never claimed)
  "0xd02c136982413e567c373f001ef254c666ff1320": "vester",
  "0x17e26dd811ad09bd946f3b63a6f256f22c218da1": "vester",
  "0x8ab61e36265c162345b60cbac8517e7d5dce8381": "vester",
  // Stake DAO sdB-sdBAL-STABLE vault — plain 1:1 BPT wrapper, 100% staked in SD gauge
  "0x7ca0a95c96cd34013d619effcb02f200a031210d": "wrapper",
  // Aura VoterProxy — Balancer-gauge stake belongs to Aura pid-249 depositors
  "0xaf52695e1bb01a16d33d7194c28c42b10e0dbec2": "aura",
  // --- redirects (see REDIRECTS map) ---
  "0x3216d2a52f0094aa860ca090bc5c335de36e6273": "redirect", // Alchemix SDTController
  "0x21777106355ba506a31ff7984c0ae5c924deb77f": "redirect", // Convergence SdtBlackHole
  // --- leaves: claimable by a controlling party ---
  // (EIP-7702 delegated EOAs — e.g. 0x345d04…, superchainer.eth 0x5c89c4…,
  //  herballemon.eth 0xaedc68… — auto-leaf via the bytecode check in classifyContract)
  "0x03cd656b6559b534700e487166f175eb5cd40e11": "leaf", // personal MEV executor, owner EOA 0x3d782c0c… has ERC20 sweep
  "0xdf640f13ef36e22384fb9f0f713c739c34e54521": "leaf", // Ownable bot, owner EOA 0xfffde9a2… (sweep unverified — review)
  "0xe27baebd7b14602de3797974db9f5f4f8dcb6679": "leaf", // custom governance buyback contract (answers all probes — would false-route as safe)
  // --- leaves: protocol-owned; recipient is the protocol, distribution theirs ---
  "0xce88686553686da562ce7cea497ce749da109f9f": "leaf", // Balancer V2 ProtocolFeesCollector (Balancer DAO fee revenue)
  "0x212f884252792ebaaa811fb0678444b21c7c2879": "leaf", // Balancer/Uni v4 ProtocolFeeController (dust)
  "0xba1333333333a1ba1108e8412f11850a5c319ba9": "leaf", // Balancer V3 Vault (dust)
  "0x00700052c0608f670705380a4900e0a8080010cc": "leaf", // ParaSwap AugustusFeeVault (dust)
  "0x90cbe4bdd538d6e9b379bff5fe72c3d67a521de5": "leaf", // 1inch FeeCollector (dust)
  "0x4d5401b9e9dcd7c9097e1df036c3afafc35d604f": "leaf", // Mimic Finance Depositor (dust)
  "0xea79d1a83da6db43a85942767c389fe0acf336a5": "redirect", // Stake DAO veBAL locker — see REDIRECTS (REVIEW)
  "0x6b65525a40704a4c48d07c25b8d05654854dfecd": "redirect", // SdtRewardDistributorV2 (CVG) — see REDIRECTS
  // --- leaves: stranded-by-design dust (routers/settlement in-flight remnants) ---
  "0x9008d19f58aabd9ed0d60971565aa8510560ab41": "leaf", // CoW GPv2Settlement
  "0x000000000004444c5dc75cb358380d2e3de08a90": "leaf", // Uniswap v4 PoolManager
  "0x1111111254eeb25477b68fb85ed929f73a960582": "leaf", // 1inch AggregationRouterV5
  "0x6a000f20005980200259b80c5102003040001068": "leaf", // ParaSwap AugustusV6
  "0x2c0552e5dcb79b064fd23e358a86810bc5994244": "leaf", // 1inch SwapExecutor
  "0xb2f72662ed42067ccce278f8462a0215b6adcabb": "leaf", // 1inch SwapExecutor
  "0xb634316e06cc0b358437cbadd4dc94f1d3a92b3b": "leaf", // CoW TradeHandler
  "0x30c20ecab96d8d2f3e499eaa4d9b8339035d0b04": "leaf", // settlement/router dust
  "0x39b487c1fb23fb5cc82fb25a0374049ae42c46c3": "leaf", // settlement/router dust
  "0x562f019e21eff3dba7401a569fdc7676abfa4bc6": "leaf", // DEX settlement dust
  "0x47930c76790c865217472f2ddb4d14c640ee450a": "leaf", // legacy game contract dust
  "0x5968ada261a84e19a6c85830e655647752585ed4": "leaf", // unknown operational contract dust
  "0x5b5a0580bcfd3673820bb249514234afad33e209": "leaf", // unknown operational contract dust
  "0x80bf7db69556d9521c03461978b8fc731dbbd4e4": "leaf", // test/junk contract dust
  "0x991493900674b10bdf54bdfe95b4e043257798cf": "leaf", // custom buyAndFree contract dust
  "0xb0bababe78a9be0810fadf99dd2ed31ed12568be": "leaf", // abandoned legacy contract dust
  "0xc139a6fd6db661694b11f0b24bab30f00b3539b8": "leaf", // unknown settlement/bridge dust
  "0xc8b19839ae371bd541f20b15c3a3cb82bfb6a6c6": "leaf", // legacy router dust
  "0xd384cc029b537503895fe252f94fba87a05d677e": "leaf", // legacy LP contract dust
  "0x296e0c21db4061ebf971e55d5db85011e7ff9797": "leaf", // unidentified dust (1.96 sdBAL)
  "0x00000f91109c4d0007e90000d9facad5298a0cac": "leaf", // unknown proxy, 1 wei
  "0x0f4a1d7fdf4890be35e71f3e0bbc4a0ec377eca3": "leaf", // unknown proxy, 1 wei
  "0x1f2f10d1c40777ae1da742455c65828ff36df387": "leaf", // unverified contract, dust
  "0x043dfa52deb97ed9886c8a4d766442b6ee3756cb": "leaf", // unverified contract, dust
  "0x63242a4ea82847b20e506b63b0e2e2eff0cc6cb0": "leaf", // unknown settlement proxy, 1 wei
  "0x6e4141d33021b52c91c28608403db4a0ffb50ec6": "leaf", // unknown whitelist proxy, 1 wei
  "0xf081470f5c6fbccf48cc4e5b82dd926409dcdd67": "leaf", // whitelist manager, 1 wei
};

async function phase3Expand(): Promise<ExpansionReport> {
  ensureOut();
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const classified = readJson<ClassifiedHolders>(path.join(OUT_DIR, "holders_classified.json"));

  console.log(`Phase 3 — expand ${Object.keys(classified.contracts).length} contract holders`);
  const final: Map<string, bigint> = new Map();
  for (const [a, b] of Object.entries(classified.eoa)) final.set(a, BigInt(b));

  const expanded: ExpansionEntry[] = [];
  const unknown: string[] = [];

  for (const [addr, balStr] of Object.entries(classified.contracts)) {
    const bal = BigInt(balStr);
    const route = await classifyContract(client, addr as Address, classified.block, SD_BAL);
    if (!route) {
      unknown.push(addr);
      continue;
    }
    const sub = await expandOne(client, addr as Address, bal, route, classified.block, 0);
    for (const [a, b] of Object.entries(sub.beneficiaries)) {
      final.set(a, (final.get(a) ?? 0n) + BigInt(b));
    }
    expanded.push(sub);
  }

  if (unknown.length > 0) {
    writeJson(path.join(OUT_DIR, "unknown_contracts.json"), { addresses: unknown });
    console.error(`  HALT: ${unknown.length} unknown contracts — see unknown_contracts.json`);
  }

  // Invariant check
  let sum = 0n;
  const finalObj: BalanceMap = {};
  for (const [a, b] of final) {
    if (b <= 0n) continue;
    finalObj[a] = b.toString();
    sum += b;
  }
  if (sum !== BigInt(classified.totalSupply)) {
    console.warn(`  WARN: Σ expanded (${sum}) != totalSupply (${classified.totalSupply})`);
    console.warn(`        diff = ${BigInt(classified.totalSupply) - sum} (likely unknown contracts not yet routed)`);
  }

  const report: ExpansionReport = {
    block: classified.block,
    totalSupply: classified.totalSupply,
    expanded,
    finalBalances: finalObj,
    unknownContracts: unknown,
  };
  writeJson(path.join(OUT_DIR, "holders_expanded.json"), report);
  console.log(`  expanded into ${Object.keys(finalObj).length} final beneficiaries`);
  return report;
}

// Routing taxonomy. Default-DENY: a contract that does not pass an explicit route
// (with provenance assertion that it really holds the parent token via that mechanism)
// halts the run. There is no generic ERC20 fallback — a treasury contract holding sdBAL
// inventory must NOT be treated as a wrapper and redistributed to its token holders.
//   safe          : Gnosis Safe — leaf, no recursion (auto-probed)
//   leaf          : explicitly reviewed leaf — pay the address itself (KNOWN_OVERRIDES only)
//   balancer-bpt  : Balancer BPT — pool contains the parent token (verified via Vault)
//   curve-gauge   : Curve-style gauge — lp_token() == parent token (verified)
//   sd-gauge      : Stake DAO LiquidityGaugeV4 — staking_token() == parent token (verified)
//   erc4626       : ERC4626 vault — asset() == parent token (verified)
//   vester        : Stake DAO Vester — pay beneficiary() (KNOWN_OVERRIDES only)
//   balancer-vault: Balancer V2 Vault — expand via verified pool list (KNOWN_OVERRIDES only)
//   stash         : Stake DAO MultiMerkleStash — expand via repo merkle + onchain isClaimed
//                   (KNOWN_OVERRIDES only)
//   wrapper       : human-verified plain ERC20 wrapper — expandWrapper without probe
//                   (KNOWN_OVERRIDES only)
//   aura          : Aura VoterProxy — expand via deposit token + BaseRewardPool stakers
//                   (KNOWN_OVERRIDES only)
//   redirect      : pay a reviewed substitute recipient from REDIRECTS (KNOWN_OVERRIDES only)
type Route =
  | "safe" | "leaf" | "redirect"
  | "balancer-bpt" | "curve-gauge" | "sd-gauge" | "erc4626" | "wrapper"
  | "vester" | "balancer-vault" | "stash" | "aura";

// Reviewed substitute recipients for "redirect" routes — used where paying the holding
// contract itself would strand the USDC and a controlling party is unambiguous.
const REDIRECTS: Record<string, Address> = {
  // Alchemix SDTController (single-beneficiary veSDT locker; sweep() pays its owner Safe)
  "0x3216d2a52f0094aa860ca090bc5c335de36e6273": getAddress("0xdc70b6c0aeb5c6627eaa707fc6c804a2ec43f937"),
  // Convergence SdtBlackHole (CVG staking custody) -> Convergence Treasury DAO Safe.
  // REVIEW: alternative is enumerating CVG sdBAL staking-position NFTs (service
  // 0xAf5b3f4A0b4dc334dB7137E5584E0e971E5e4962) and paying NFT holders pro-rata.
  "0x21777106355ba506a31ff7984c0ae5c924deb77f": getAddress("0x0af815364BD9e9E60f3d2D3bAc1320B77d3E35F7"),
  // Convergence SdtRewardDistributorV2 (admin-less proxy, USDC would strand) -> CVG Treasury Safe.
  "0x6b65525a40704a4c48d07c25b8d05654854dfecd": getAddress("0x0af815364BD9e9E60f3d2D3bAc1320B77d3E35F7"),
  // Stake DAO veBAL locker (holds legacy-pool BPT + Balancer-gauge stake not attributable
  // to the current sdB-sdBAL-STABLE vault, whose strategy is unset and BPT sits idle).
  // REVIEW: if the team attributes the gauge stake to vault users, switch to expanding
  // gauge 0x76fB1951… holders instead.
  "0xea79d1a83da6db43a85942767c389fe0acf336a5": getAddress("0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063"),
};

const BALANCER_VAULT = getAddress("0xBA12222222228d8Ba445958a75a0704d566BF2C8");
const VAULT_GET_POOL_TOKENS_ABI = [
  { name: "getPoolTokens", type: "function", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "tokens", type: "address[]" }, { name: "balances", type: "uint256[]" }, { name: "lastChangeBlock", type: "uint256" }] },
] as const;

// `wantToken` is the token whose value is being attributed at this recursion level:
// SD_BAL at the top, then the wrapper's own share token for nested levels (a gauge
// holding BPT must prove staking_token()==BPT, not anything about sdBAL).
async function classifyContract(
  client: PublicClient,
  addr: Address,
  block: number,
  wantToken: Address,
): Promise<Route | null> {
  const lower = addr.toLowerCase();
  if (KNOWN_OVERRIDES[lower]) return KNOWN_OVERRIDES[lower];

  // EIP-7702 delegated EOA (code = 0xef0100 ++ delegate address): a personal wallet
  // whose key holder can claim — leaf, not a contract to expand.
  const code = await client.getBytecode({ address: addr, blockNumber: BigInt(block) });
  if (code && code.toLowerCase().startsWith("0xef0100")) return "leaf";

  // Probe interfaces in priority order. Each probe must be backed by a provenance
  // assertion before the route is accepted.
  // 1. Gnosis Safe (no provenance needed — leaf, distributes USDC to Safe addr).
  //    Owners array must be non-empty: a fallback-echoes-everything contract would
  //    otherwise false-positive here.
  const owners = await probeView<Address[]>(client, addr, SAFE_ABI, "getOwners", block);
  if (owners && Array.isArray(owners) && owners.length > 0) return "safe";

  // 2. Balancer BPT — its pool must contain wantToken at the snapshot block.
  const poolId = await probeView<Hex>(client, addr, BPT_ABI, "getPoolId", block);
  if (poolId) {
    if (await assertPoolContains(client, poolId, wantToken, block)) return "balancer-bpt";
    throw new Error(`Contract ${addr} has getPoolId() but pool does not include ${wantToken} — refusing to recurse`);
  }

  // 3. Curve-style gauge — lp_token() must equal wantToken.
  const lp = await probeView<Address>(client, addr, CURVE_GAUGE_ABI, "lp_token", block);
  if (lp) {
    if (getAddress(lp) === getAddress(wantToken)) return "curve-gauge";
    throw new Error(`Contract ${addr} has lp_token()=${lp} (expected ${wantToken}) — refusing to recurse`);
  }

  // 4. Stake DAO gauge — staking_token() must equal wantToken.
  const staking = await probeView<Address>(client, addr, SD_GAUGE_ABI, "staking_token", block);
  if (staking) {
    if (getAddress(staking) === getAddress(wantToken)) return "sd-gauge";
    throw new Error(`Contract ${addr} has staking_token()=${staking} (expected ${wantToken}) — refusing to recurse`);
  }

  // 5. ERC4626 vault — asset() must equal wantToken.
  const asset = await probeView<Address>(client, addr, ERC4626_ABI, "asset", block);
  if (asset) {
    if (getAddress(asset) === getAddress(wantToken)) return "erc4626";
    throw new Error(`Contract ${addr} is ERC4626 with asset()=${asset} (expected ${wantToken}) — refusing to recurse`);
  }

  // No generic ERC20 fallback. Default-deny.
  return null;
}

async function assertPoolContains(client: PublicClient, poolId: Hex, token: Address, block: number): Promise<boolean> {
  try {
    const [tokens] = await client.readContract({
      address: BALANCER_VAULT, abi: VAULT_GET_POOL_TOKENS_ABI as any,
      functionName: "getPoolTokens", args: [poolId],
      blockNumber: BigInt(block),
    }) as [Address[], bigint[], bigint];
    return tokens.some((t) => getAddress(t) === getAddress(token));
  } catch {
    return false;
  }
}

async function probeView<T = unknown>(
  client: PublicClient,
  address: Address,
  abi: readonly { name: string; type: string; stateMutability: string; inputs: readonly unknown[]; outputs: readonly unknown[] }[],
  functionName: string,
  block: number,
): Promise<T | null> {
  try {
    return await client.readContract({
      address, abi: abi as any, functionName,
      blockNumber: BigInt(block),
    }) as T;
  } catch {
    return null;
  }
}

async function expandOne(
  client: PublicClient,
  addr: Address,
  balance: bigint,
  route: Route,
  block: number,
  depth: number,
  visited: Set<string> = new Set(),
): Promise<ExpansionEntry> {
  if (depth >= MAX_DEPTH) {
    throw new Error(`Recursion limit hit at ${addr} (route=${route})`);
  }
  switch (route) {
    case "safe":
    case "leaf":
      return { source: addr, reason: route, beneficiaries: { [addr]: balance.toString() } };
    case "redirect": {
      const to = REDIRECTS[addr.toLowerCase()];
      if (!to) throw new Error(`Route "redirect" for ${addr} has no REDIRECTS entry`);
      return { source: addr, reason: "redirect", beneficiaries: { [to]: balance.toString() } };
    }
    case "balancer-bpt":
    case "curve-gauge":
    case "sd-gauge":
    case "erc4626":
    case "wrapper":
      // Recursive holder split: snapshot the wrapper's own ERC20 holders via Transfer logs,
      // distribute the wrapper's sdBAL-backed value pro-rata, recurse if downstream is a contract.
      return await expandWrapper(client, addr, balance, route, block, depth, visited);
    case "vester":
      return await expandVester(client, addr, balance, block, depth, visited);
    case "balancer-vault":
      return await expandBalancerVault(client, balance, block, depth, visited);
    case "stash":
      return await expandStash(client, addr, balance, block, depth, visited);
    case "aura":
      return await expandAura(client, balance, block, depth, visited);
  }
}

async function expandWrapper(
  client: PublicClient,
  wrapper: Address,
  totalSdBal: bigint,
  route: Route,
  block: number,
  depth: number,
  visited: Set<string> = new Set(),
): Promise<ExpansionEntry> {
  // Cycle detection — same wrapper appearing twice in a recursion chain = misclassification or attack.
  const key = wrapper.toLowerCase();
  if (visited.has(key)) {
    throw new Error(`Cycle detected expanding ${wrapper} (route=${route}, depth=${depth})`);
  }
  visited = new Set([...visited, key]);

  // Transfer logs only DISCOVER candidate holders; per-holder wrapper balances
  // are read onchain via balanceOf at `block` (immune to silently-dropped logs).
  const candidates = await discoverTransferParticipants(client, wrapper, block);
  candidates.delete(getAddress(wrapper));

  // Denominator: onchain totalSupply() at `block` — authoritative, excludes burns.
  const wrapperTotalSupply = await client.readContract({
    address: wrapper, abi: ERC20_ABI as any, functionName: "totalSupply",
    blockNumber: BigInt(block),
  }) as bigint;
  if (wrapperTotalSupply === 0n) {
    throw new Error(`Wrapper ${wrapper} totalSupply==0 at block ${block}`);
  }

  const bal = new Map<string, bigint>();
  const candAddrs = [...candidates];
  for (let i = 0; i < candAddrs.length; i += 25) {
    const chunk = candAddrs.slice(i, i + 25);
    const bals = await Promise.all(chunk.map((a) =>
      client.readContract({
        address: wrapper, abi: ERC20_ABI as any, functionName: "balanceOf", args: [a],
        blockNumber: BigInt(block),
      }) as Promise<bigint>,
    ));
    chunk.forEach((a, j) => { if (bals[j] > 0n) bal.set(a, bals[j]); });
  }

  // Reconcile: a dropped log can still hide a holder from the candidate set.
  // Balancer V2 pools lock MINIMUM_BPT (1e6 wei) at address(0) on init — that locked
  // balance is part of totalSupply but must not be distributed, so include it in the
  // reconciliation and leave it out of the holder map (its pro-rata share lands in the
  // integer-division dust handled below).
  const zeroAddrBal = await client.readContract({
    address: wrapper, abi: ERC20_ABI as any, functionName: "balanceOf", args: [ZERO_ADDR],
    blockNumber: BigInt(block),
  }) as bigint;
  const holderSum = [...bal.values()].reduce((acc, v) => acc + v, 0n);
  if (holderSum + zeroAddrBal !== wrapperTotalSupply) {
    throw new Error(
      `Wrapper ${wrapper} Σ balanceOf over candidates (${holderSum}) + addr(0) locked (${zeroAddrBal}) != totalSupply (${wrapperTotalSupply}) — holder missing from candidate set (dropped logs?) or rebase token; manual review`,
    );
  }

  const beneficiaries: BalanceMap = {};
  const { shares, assigned } = proRataSplit([...bal.entries()], totalSdBal, wrapperTotalSupply);

  for (const [holder, sub] of shares) {
    const code = await client.getBytecode({ address: holder as Address, blockNumber: BigInt(block) });
    const isContract = code !== undefined && code !== null && code !== "0x" && code.length > 2;

    if (isContract) {
      // Nested classification proves provenance against THIS wrapper's share token.
      const subRoute = await classifyContract(client, holder as Address, block, wrapper);
      if (!subRoute) {
        // Halt immediately on nested unknown — do NOT silently mark and continue,
        // because doing so would inflate the dust calc below.
        throw new Error(
          `Nested unknown contract ${holder} inside wrapper ${wrapper} (route=${route}, depth=${depth + 1}) — add explicit route or halt`,
        );
      }
      const sub2 = await expandOne(client, holder as Address, sub, subRoute, block, depth + 1, visited);
      for (const [a, b] of Object.entries(sub2.beneficiaries)) {
        beneficiaries[a] = ((BigInt(beneficiaries[a] ?? "0") + BigInt(b)).toString());
      }
    } else {
      beneficiaries[holder] = ((BigInt(beneficiaries[holder] ?? "0") + sub).toString());
    }
  }

  assignDust(beneficiaries, totalSdBal - assigned);
  return { source: wrapper, reason: route, beneficiaries };
}

// Candidate discovery for wrapper expansions via the viem RPC client (49k-block
// eth_getLogs chunks). The explorer API path used by phase 1 rate-limits hard when
// called repeatedly; balances are read via balanceOf either way, and the
// sum==totalSupply reconciliation catches any dropped log regardless of source.
async function discoverTransferParticipants(
  client: PublicClient,
  token: Address,
  toBlock: number,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  const CHUNK = 49_000;
  for (let from = SDBAL_DEPLOY_BLOCK; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{
        address: token,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [TRANSFER_TOPIC],
      }],
    }) as { topics: Hex[] }[];
    for (const log of logs) {
      if (log.topics.length < 3) continue;
      candidates.add(getAddress(`0x${log.topics[1].slice(26)}`));
      candidates.add(getAddress(`0x${log.topics[2].slice(26)}`));
    }
  }
  candidates.delete(ZERO_ADDR);
  return candidates;
}

// Addresses appearing as topics[1] of the given event on `contract` up to `toBlock`.
async function discoverIndexedParticipants(
  client: PublicClient,
  contract: Address,
  topic0: Hex,
  toBlock: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  const CHUNK = 49_000;
  for (let from = SDBAL_DEPLOY_BLOCK; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    const logs = await client.request({
      method: "eth_getLogs",
      params: [{
        address: contract,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [topic0],
      }],
    }) as { topics: Hex[] }[];
    for (const log of logs) {
      if (log.topics.length < 2) continue;
      out.add(getAddress(`0x${log.topics[1].slice(26)}`));
    }
  }
  out.delete(ZERO_ADDR);
  return out;
}

// Pure pro-rata split: value * holderBal / denominator per holder, zero shares dropped.
// `denominator` may exceed Σ holder balances (e.g. Balancer MINIMUM_BPT locked at
// address(0)) — the shortfall surfaces as dust for assignDust().
export function proRataSplit(
  holders: [string, bigint][],
  totalValue: bigint,
  denominator: bigint,
): { shares: [string, bigint][]; assigned: bigint } {
  const shares: [string, bigint][] = [];
  let assigned = 0n;
  for (const [holder, balance] of holders) {
    const sub = (balance * totalValue) / denominator;
    if (sub <= 0n) continue;
    shares.push([holder, sub]);
    assigned += sub;
  }
  return { shares, assigned };
}

// Integer-division dust → largest beneficiary, so totals reconcile exactly.
export function assignDust(beneficiaries: BalanceMap, dust: bigint): void {
  if (dust <= 0n) return;
  let topAddr: string | undefined;
  let topVal = 0n;
  for (const [a, b] of Object.entries(beneficiaries)) {
    const v = BigInt(b);
    if (v > topVal) { topVal = v; topAddr = a; }
  }
  if (topAddr) beneficiaries[topAddr] = (topVal + dust).toString();
}

// Stake DAO Vester — one contract per beneficiary, vesting sdBAL-gauge tokens.
// Pay beneficiary(); if the beneficiary is itself a contract, classify and recurse.
async function expandVester(
  client: PublicClient,
  vester: Address,
  balance: bigint,
  block: number,
  depth: number,
  visited: Set<string>,
): Promise<ExpansionEntry> {
  const beneficiary = await client.readContract({
    address: vester, abi: VESTER_ABI as any, functionName: "beneficiary",
    blockNumber: BigInt(block),
  }) as Address;
  if (!beneficiary || getAddress(beneficiary) === ZERO_ADDR) {
    throw new Error(`Vester ${vester} has zero beneficiary at block ${block}`);
  }
  const code = await client.getBytecode({ address: beneficiary, blockNumber: BigInt(block) });
  if (code && code !== "0x" && code.length > 2) {
    const subRoute = await classifyContract(client, beneficiary, block, vester);
    if (!subRoute) {
      throw new Error(`Vester ${vester} beneficiary ${beneficiary} is an unknown contract — add explicit route`);
    }
    const sub = await expandOne(client, beneficiary, balance, subRoute, block, depth + 1, visited);
    return { source: vester, reason: "vester", beneficiaries: sub.beneficiaries };
  }
  return { source: vester, reason: "vester", beneficiaries: { [getAddress(beneficiary)]: balance.toString() } };
}

// Balancer V2 Vault custodies pool tokens, so the VAULT shows up as the sdBAL holder.
// The sdBAL belongs to BPT holders of the pools registered with sdBAL. The pool list
// below was enumerated by scanning every Vault TokensRegistered event up to the
// snapshot block and filtering for sdBAL; the assertion that the pools' getPoolTokens
// balances sum EXACTLY to the Vault's sdBAL balance re-proves completeness onchain on
// every run (a third location — internal balances — was scanned and is zero).
const VAULT_SDBAL_POOL_IDS: Hex[] = [
  "0x2d011adf89f0576c9b722c28269fcb5d50c2d17900020000000000000000024d", // Balancer sdBAL Stable Pool (BPT 0x2d011aDf…)
  "0xabf3eb5ce7fee55b25e2ca65962184979166b22800020000000000000000020b", // legacy sdBAL pool (BPT 0xabf3eb5c…)
];

async function expandBalancerVault(
  client: PublicClient,
  vaultSdBal: bigint,
  block: number,
  depth: number,
  visited: Set<string>,
): Promise<ExpansionEntry> {
  const perPool: { bpt: Address; sdbal: bigint }[] = [];
  let poolSum = 0n;
  for (const poolId of VAULT_SDBAL_POOL_IDS) {
    const [tokens, balances] = await client.readContract({
      address: BALANCER_VAULT, abi: VAULT_GET_POOL_TOKENS_ABI as any,
      functionName: "getPoolTokens", args: [poolId],
      blockNumber: BigInt(block),
    }) as [Address[], bigint[], bigint];
    const idx = tokens.findIndex((t) => getAddress(t) === SD_BAL);
    if (idx < 0) throw new Error(`Pool ${poolId} does not contain sdBAL at block ${block}`);
    const bpt = getAddress(`0x${poolId.slice(2, 42)}`);
    perPool.push({ bpt, sdbal: balances[idx] });
    poolSum += balances[idx];
  }
  if (poolSum !== vaultSdBal) {
    throw new Error(
      `Vault pool list incomplete: Σ pool sdBAL (${poolSum}) != Vault sdBAL balance (${vaultSdBal}) — re-enumerate TokensRegistered/internal balances`,
    );
  }

  const beneficiaries: BalanceMap = {};
  for (const { bpt, sdbal } of perPool) {
    if (sdbal === 0n) continue;
    const sub = await expandWrapper(client, bpt, sdbal, "balancer-bpt", block, depth, visited);
    for (const [a, b] of Object.entries(sub.beneficiaries)) {
      beneficiaries[a] = (BigInt(beneficiaries[a] ?? "0") + BigInt(b)).toString();
    }
  }
  return { source: BALANCER_VAULT, reason: "balancer-vault", beneficiaries };
}

// Aura Finance VoterProxy (0xaf5269…) stakes the Balancer-gauge position for Aura
// pid 249. Aura mints its deposit token 1:1 per BPT; users either hold it raw or stake
// it in the BaseRewardPool (whose internal balanceOf tracks stakers — stakes do NOT
// emit deposit-token Transfers to users, the pool holds the tokens). Beneficiaries:
// raw deposit-token holders + reward-pool stakers, reconciled against totalSupply.
const AURA_BOOSTER = getAddress("0xA57b8d98dAE62B26Ec3bcC4a365338157060B234");
const AURA_PID = 249n;
const AURA_DEPOSIT_TOKEN = getAddress("0x1fd8ee26a9e9d2a0a14e0eace044cf52215c2001");
const AURA_REWARD_POOL = getAddress("0xdb407ad592f0563250b55261c37e029152128f18");
const BOOSTER_POOL_INFO_ABI = [
  { name: "poolInfo", type: "function", stateMutability: "view",
    inputs: [{ name: "pid", type: "uint256" }],
    outputs: [
      { name: "lptoken", type: "address" }, { name: "token", type: "address" },
      { name: "gauge", type: "address" }, { name: "crvRewards", type: "address" },
      { name: "stash", type: "address" }, { name: "shutdown", type: "bool" },
    ] },
] as const;

async function expandAura(
  client: PublicClient,
  totalValue: bigint,
  block: number,
  depth: number,
  visited: Set<string>,
): Promise<ExpansionEntry> {
  // Re-prove the hardcoded pid wiring onchain on every run.
  const [, token, , crvRewards] = await client.readContract({
    address: AURA_BOOSTER, abi: BOOSTER_POOL_INFO_ABI as any, functionName: "poolInfo",
    args: [AURA_PID], blockNumber: BigInt(block),
  }) as [Address, Address, Address, Address, Address, boolean];
  if (getAddress(token) !== AURA_DEPOSIT_TOKEN || getAddress(crvRewards) !== AURA_REWARD_POOL) {
    throw new Error(`Aura pid ${AURA_PID} wiring mismatch: token=${token} crvRewards=${crvRewards}`);
  }

  // Candidates: deposit-token Transfer participants UNION reward-pool Staked event
  // emitters. The Booster mints deposit tokens straight to the reward pool on
  // `deposit(pid, amount, true)`, so stakers never appear in token Transfers at all —
  // only in the pool's Staked(user, amount) events.
  const candidates = await discoverTransferParticipants(client, AURA_DEPOSIT_TOKEN, block);
  const STAKED_TOPIC = keccak256(toHex("Staked(address,uint256)"));
  for (const user of await discoverIndexedParticipants(client, AURA_REWARD_POOL, STAKED_TOPIC, block)) {
    candidates.add(user);
  }
  candidates.delete(AURA_REWARD_POOL); // pool's raw balance is its stakers', counted below

  const depositTotalSupply = await client.readContract({
    address: AURA_DEPOSIT_TOKEN, abi: ERC20_ABI as any, functionName: "totalSupply",
    blockNumber: BigInt(block),
  }) as bigint;

  const bal = new Map<string, bigint>();
  const candAddrs = [...candidates];
  for (let i = 0; i < candAddrs.length; i += 25) {
    const chunk = candAddrs.slice(i, i + 25);
    const reads = await Promise.all(chunk.flatMap((a) => [
      client.readContract({
        address: AURA_DEPOSIT_TOKEN, abi: ERC20_ABI as any, functionName: "balanceOf", args: [a],
        blockNumber: BigInt(block),
      }) as Promise<bigint>,
      client.readContract({
        address: AURA_REWARD_POOL, abi: ERC20_ABI as any, functionName: "balanceOf", args: [a],
        blockNumber: BigInt(block),
      }) as Promise<bigint>,
    ]));
    chunk.forEach((a, j) => {
      const combined = reads[j * 2] + reads[j * 2 + 1];
      if (combined > 0n) bal.set(a, combined);
    });
  }

  const holderSum = [...bal.values()].reduce((acc, v) => acc + v, 0n);
  if (holderSum !== depositTotalSupply) {
    throw new Error(
      `Aura Σ (deposit token + staked) over candidates (${holderSum}) != deposit totalSupply (${depositTotalSupply}) — staker missing from candidate set`,
    );
  }

  const beneficiaries: BalanceMap = {};
  const { shares, assigned } = proRataSplit([...bal.entries()], totalValue, depositTotalSupply);
  for (const [holder, sub] of shares) {
    const code = await client.getBytecode({ address: holder as Address, blockNumber: BigInt(block) });
    const isContract = code !== undefined && code !== null && code !== "0x" && code.length > 2;
    if (isContract) {
      const subRoute = await classifyContract(client, holder as Address, block, AURA_DEPOSIT_TOKEN);
      if (!subRoute) {
        throw new Error(`Unknown contract ${holder} holding Aura pid-${AURA_PID} position — add explicit route`);
      }
      const sub2 = await expandOne(client, holder as Address, sub, subRoute, block, depth + 1, visited);
      for (const [a, b] of Object.entries(sub2.beneficiaries)) {
        beneficiaries[a] = (BigInt(beneficiaries[a] ?? "0") + BigInt(b)).toString();
      }
    } else {
      beneficiaries[holder] = (BigInt(beneficiaries[holder] ?? "0") + sub).toString();
    }
  }
  assignDust(beneficiaries, totalValue - assigned);
  return { source: AURA_REWARD_POOL, reason: "aura", beneficiaries };
}

// Stake DAO MultiMerkleStash — the sdBAL it holds is unclaimed reward claims from the
// frozen sdBAL merkle (weekly sdBAL distributions ended with the sunset). Beneficiaries
// are the merkle leaves not yet claimed at the snapshot block; the residue from older
// roots that can no longer be claimed goes to Stake DAO governance.
const MERKLE_JSON = path.join(ROOT_DIR, "bounties-reports", "latest", "merkle.json");
const STAKE_DAO_GOVERNANCE = getAddress("0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063"); // stakedao.eth Safe
const STASH_ABI = [
  { name: "merkleRoot", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }], outputs: [{ type: "bytes32" }] },
  { name: "isClaimed", type: "function", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function expandStash(
  client: PublicClient,
  stash: Address,
  stashBalance: bigint,
  block: number,
  depth: number,
  visited: Set<string>,
): Promise<ExpansionEntry> {
  const reports = readJson<{ symbol: string; address: string; root?: string; merkle: Record<string, { index: number; amount: { hex?: string } | string }> }[]>(MERKLE_JSON);
  const entry = reports.find((t) => t.symbol === "sdBAL" && getAddress(t.address) === SD_BAL);
  if (!entry || !entry.root) {
    throw new Error(`No sdBAL entry with root in ${MERKLE_JSON}`);
  }
  const onchainRoot = await client.readContract({
    address: stash, abi: STASH_ABI as any, functionName: "merkleRoot", args: [SD_BAL],
    blockNumber: BigInt(block),
  }) as Hex;
  if (onchainRoot.toLowerCase() !== entry.root.toLowerCase()) {
    throw new Error(`Stash sdBAL root mismatch: onchain ${onchainRoot} vs repo ${entry.root} — repo merkle is not the live one`);
  }

  const claims = Object.entries(entry.merkle).map(([addr, c]) => ({
    addr: getAddress(addr),
    index: c.index,
    amount: BigInt(typeof c.amount === "string" ? c.amount : c.amount.hex!),
  }));
  const unclaimed: { addr: Address; amount: bigint }[] = [];
  let unclaimedSum = 0n;
  for (let i = 0; i < claims.length; i += 20) {
    const chunk = claims.slice(i, i + 20);
    const flags = await Promise.all(chunk.map((c) =>
      client.readContract({
        address: stash, abi: STASH_ABI as any, functionName: "isClaimed", args: [SD_BAL, BigInt(c.index)],
        blockNumber: BigInt(block),
      }) as Promise<boolean>,
    ));
    chunk.forEach((c, j) => {
      if (flags[j]) return;
      unclaimed.push({ addr: c.addr, amount: c.amount });
      unclaimedSum += c.amount;
    });
  }

  // Claimants can themselves be contracts (e.g. Vesters whose vested gauge tokens
  // earned the bribes) — classify and recurse like every other expansion.
  const beneficiaries: BalanceMap = {};
  for (const { addr, amount } of unclaimed) {
    const code = await client.getBytecode({ address: addr, blockNumber: BigInt(block) });
    const isContract = code !== undefined && code !== null && code !== "0x" && code.length > 2;
    if (isContract) {
      const subRoute = await classifyContract(client, addr, block, stash);
      if (!subRoute) {
        throw new Error(`Unknown contract ${addr} among unclaimed stash leaves — add explicit route`);
      }
      const sub = await expandOne(client, addr, amount, subRoute, block, depth + 1, visited);
      for (const [a, b] of Object.entries(sub.beneficiaries)) {
        beneficiaries[a] = (BigInt(beneficiaries[a] ?? "0") + BigInt(b)).toString();
      }
    } else {
      beneficiaries[addr] = (BigInt(beneficiaries[addr] ?? "0") + amount).toString();
    }
  }
  if (unclaimedSum > stashBalance) {
    throw new Error(`Stash unclaimed (${unclaimedSum}) exceeds stash balance (${stashBalance}) — claims double-counted?`);
  }
  // Residue: sdBAL stranded from pre-freeze roots; no user can claim it → Stake DAO governance.
  const residue = stashBalance - unclaimedSum;
  if (residue > 0n) {
    beneficiaries[STAKE_DAO_GOVERNANCE] = (BigInt(beneficiaries[STAKE_DAO_GOVERNANCE] ?? "0") + residue).toString();
  }
  console.log(`  stash: ${Object.keys(beneficiaries).length} unclaimed leaves, residue ${residue} -> governance`);
  return { source: stash, reason: "stash", beneficiaries };
}

// ---------------------------------------------------------------------------
// Phase 4 — Pro-rata USDC payouts
// ---------------------------------------------------------------------------

// `sourceFilter`: when set (an expansion source address, e.g. the sdBAL gauge), the
// whole pot is distributed pro-rata over THAT entry's beneficiaries only — team
// decision 2026-06-11: rewards are for gauge stakers; pool sdBAL, merkle stash and
// direct holders are not compensated.
function phase4Payouts(usdcReceivedStr: string, minPayout: bigint = 0n, sourceFilter?: string): Payouts {
  ensureOut();
  const report = readJson<ExpansionReport>(path.join(OUT_DIR, "holders_expanded.json"));
  if (report.unknownContracts.length > 0) {
    throw new Error(`Cannot compute payouts — ${report.unknownContracts.length} unknown contracts unresolved`);
  }
  for (const a of Object.keys(report.finalBalances)) {
    if (a.startsWith("__UNKNOWN__")) {
      throw new Error(`Cannot compute payouts — unresolved downstream contract: ${a}`);
    }
  }

  let basis = "all-holders";
  let balances = report.finalBalances;
  let denominator = BigInt(report.totalSupply);
  if (sourceFilter) {
    const entry = report.expanded.find((e) => getAddress(e.source) === getAddress(sourceFilter));
    if (!entry) throw new Error(`--source ${sourceFilter} not found among expanded entries`);
    balances = entry.beneficiaries;
    denominator = Object.values(entry.beneficiaries).reduce((s, v) => s + BigInt(v), 0n);
    basis = getAddress(sourceFilter);
    console.log(`  basis: ${basis} (${entry.reason}) — ${Object.keys(balances).length} beneficiaries, Σ ${denominator}`);
  }

  const totalSupply = denominator;
  const usdcReceived = BigInt(usdcReceivedStr);

  const perAddress: { [a: string]: string } = {};
  let assigned = 0n;
  let topAddr = "";
  let topShare = 0n;

  for (const [a, balStr] of Object.entries(balances)) {
    const bal = BigInt(balStr);
    const amount = (bal * usdcReceived) / totalSupply;
    if (amount <= 0n) continue;
    perAddress[a] = amount.toString();
    assigned += amount;
    if (bal > topShare) { topShare = bal; topAddr = a; }
  }

  const dust = usdcReceived - assigned;
  if (dust > 0n && topAddr) {
    perAddress[topAddr] = (BigInt(perAddress[topAddr]) + dust).toString();
    assigned += dust;
  }
  if (assigned !== usdcReceived) {
    throw new Error(`Payout reconciliation failed: assigned=${assigned} usdcReceived=${usdcReceived}`);
  }

  const { kept, droppedCount, droppedValue } = applyMinPayout(perAddress, minPayout);
  const keptSum = Object.values(kept).reduce((s, v) => s + BigInt(v), 0n);
  if (keptSum !== usdcReceived) {
    throw new Error(`Min-payout reconciliation failed: kept=${keptSum} usdcReceived=${usdcReceived}`);
  }

  const out: Payouts = {
    block: report.block,
    usdcReceived: usdcReceived.toString(),
    perAddress: kept,
    dustReassignedTo: topAddr,
    minPayout: minPayout.toString(),
    droppedRecipients: droppedCount,
    droppedValue: droppedValue.toString(),
    basis,
  };
  writeJson(path.join(OUT_DIR, "payouts.json"), out);
  console.log(`Phase 4 — payouts`);
  console.log(`  recipients : ${Object.keys(kept).length}`);
  console.log(`  USDC total : ${formatUnits(usdcReceived, 6)} USDC`);
  console.log(`  dust to    : ${topAddr}`);
  if (minPayout > 0n) {
    console.log(`  floor      : ${formatUnits(minPayout, 6)} USDC — dropped ${droppedCount} recipients (${formatUnits(droppedValue, 6)} USDC redistributed pro-rata)`);
  }
  return out;
}

// Drop payouts below `min` and redistribute their total pro-rata over the kept
// recipients (by amount), dust to the largest. Sub-floor claims cost more in gas
// than they pay out and would just strand USDC at the URD.
export function applyMinPayout(
  perAddress: { [a: string]: string },
  min: bigint,
): { kept: { [a: string]: string }; droppedCount: number; droppedValue: bigint } {
  if (min <= 0n) return { kept: perAddress, droppedCount: 0, droppedValue: 0n };
  const kept: { [a: string]: string } = {};
  let droppedCount = 0;
  let droppedValue = 0n;
  let keptSum = 0n;
  for (const [a, v] of Object.entries(perAddress)) {
    const amt = BigInt(v);
    if (amt < min) { droppedCount++; droppedValue += amt; continue; }
    kept[a] = v;
    keptSum += amt;
  }
  if (droppedValue === 0n) return { kept, droppedCount, droppedValue };
  if (keptSum === 0n) {
    throw new Error(`Min payout ${min} drops every recipient — floor too high`);
  }
  let redistributed = 0n;
  for (const [a, v] of Object.entries(kept)) {
    const extra = (BigInt(v) * droppedValue) / keptSum;
    kept[a] = (BigInt(v) + extra).toString();
    redistributed += extra;
  }
  assignDust(kept, droppedValue - redistributed);
  return { kept, droppedCount, droppedValue };
}

// ---------------------------------------------------------------------------
// Phase 5 — Merge into extra_merkle/merkle.json (cumulative, URD double-hash)
// ---------------------------------------------------------------------------

const TRANCHE_MANIFEST = path.join(__dirname, "sdbal-sunset", "tranches.json");

interface Tranche {
  trancheId: number;
  appliedAt: number;
  payoutHash: Hex;
  priorRoot: string;
  newRoot: string;
  usdcAdded: string;
  recipients: number;
}

function loadTranches(): Tranche[] {
  if (!fs.existsSync(TRANCHE_MANIFEST)) return [];
  return readJson<Tranche[]>(TRANCHE_MANIFEST);
}

function hashPayouts(p: Payouts): Hex {
  // Order-independent content hash so reordering perAddress doesn't dodge the guard.
  const sorted = Object.keys(p.perAddress).sort();
  const canon = sorted.map((a) => `${a.toLowerCase()}:${p.perAddress[a]}`).join("|");
  return utils.keccak256(utils.toUtf8Bytes(`${p.block}|${p.usdcReceived}|${canon}`)) as Hex;
}

function phase5Merge() {
  const payouts = readJson<Payouts>(path.join(OUT_DIR, "payouts.json"));
  const payoutHash = hashPayouts(payouts);

  // Replay guard: refuse to re-merge the same payouts.json.
  const tranches = loadTranches();
  if (tranches.some((t) => t.payoutHash === payoutHash)) {
    throw new Error(
      `Phase 5 refusing to re-apply: payoutHash ${payoutHash} already in tranches.json. ` +
        `If this is a new tranche, regenerate payouts.json with the new USDC amount.`,
    );
  }

  // Load existing distribution (cumulative across all prior tokens/users).
  const existing = readJson<MerkleData>(EXTRA_MERKLE);
  const distribution: UniversalMerkle = {};
  for (const [addr, claim] of Object.entries(existing.claims)) {
    const c = getAddress(addr);
    distribution[c] = {};
    for (const [tok, td] of Object.entries(claim.tokens)) {
      distribution[c][getAddress(tok)] = td.amount;
    }
  }

  // Cumulative add of new USDC entitlements. Snapshot the per-addr expected delta
  // so verifyPriorLeavesUnchanged can enforce EXACT new-USDC value, not just a
  // monotonic increase.
  const expectedUsdcAfter: Record<string, bigint> = {};
  let usdcAddedTotal = 0n;
  for (const [addr, amount] of Object.entries(payouts.perAddress)) {
    const c = getAddress(addr);
    if (!distribution[c]) distribution[c] = {};
    const prev = BigInt(distribution[c][USDC] ?? "0");
    const next = prev + BigInt(amount);
    distribution[c][USDC] = next.toString();
    expectedUsdcAfter[c] = next;
    usdcAddedTotal += BigInt(amount);
  }
  console.log(`Phase 5 — merge: USDC added to ${Object.keys(payouts.perAddress).length} addresses (Σ=${formatUnits(usdcAddedTotal, 6)} USDC)`);

  const newMerkle = generateUrdMerkle(distribution);

  // Verify: prior non-USDC leaves byte-identical, USDC leaves match expected exact delta.
  verifyPriorLeavesUnchanged(existing, newMerkle, expectedUsdcAfter);

  writeJson(EXTRA_MERKLE, newMerkle);

  // Append tranche record AFTER write succeeds.
  const nextTranche: Tranche = {
    trancheId: tranches.length + 1,
    appliedAt: Math.floor(Date.now() / 1000),
    payoutHash,
    priorRoot: existing.merkleRoot,
    newRoot: newMerkle.merkleRoot,
    usdcAdded: usdcAddedTotal.toString(),
    recipients: Object.keys(payouts.perAddress).length,
  };
  ensureOut();
  writeJson(TRANCHE_MANIFEST, [...tranches, nextTranche]);
  console.log(`  tranche ${nextTranche.trancheId} recorded → ${TRANCHE_MANIFEST}`);

  // summary
  const tokenSummary: Record<string, { total: bigint; recipients: number }> = {};
  for (const [, tokens] of Object.entries(distribution)) {
    for (const [tok, amt] of Object.entries(tokens)) {
      if (!tokenSummary[tok]) tokenSummary[tok] = { total: 0n, recipients: 0 };
      tokenSummary[tok].total += BigInt(amt);
      tokenSummary[tok].recipients++;
    }
  }
  const ts = Math.floor(Date.now() / 1000);
  writeJson(EXTRA_SUMMARY, {
    timestamp: ts,
    merkleRoot: newMerkle.merkleRoot,
    totalRecipients: Object.keys(distribution).length,
    tokens: Object.entries(tokenSummary).map(([token, d]) => ({
      token, totalAmount: d.total.toString(), recipients: d.recipients,
    })),
  });
  writeJson(EXTRA_REPART, { timestamp: ts, distribution });

  console.log(`  new merkleRoot: ${newMerkle.merkleRoot}`);
  console.log(`  recipients    : ${Object.keys(distribution).length}`);
}

// ---------------------------------------------------------------------------
// URD merkle (double-hash leaf, sortPairs) — matches lineaDistribution.ts
// ---------------------------------------------------------------------------

function urdLeaf(user: string, token: string, amount: string): Hex {
  return utils.keccak256(
    utils.solidityPack(
      ["bytes"],
      [
        utils.keccak256(
          utils.defaultAbiCoder.encode(
            ["address", "address", "uint256"],
            [user, token, amount],
          ),
        ),
      ],
    ),
  ) as Hex;
}

function generateUrdMerkle(distribution: UniversalMerkle): MerkleData {
  const leaves: Hex[] = [];
  const claims: MerkleData["claims"] = {};
  for (const [user, tokens] of Object.entries(distribution)) {
    const c = getAddress(user);
    if (!claims[c]) claims[c] = { tokens: {} };
    for (const [tok, amount] of Object.entries(tokens)) {
      const t = getAddress(tok);
      leaves.push(urdLeaf(c, t, amount));
      claims[c].tokens[t] = { amount, proof: [] };
    }
  }
  const tree = new MerkleTree(leaves, utils.keccak256, { sortPairs: true });
  const root = tree.getHexRoot();
  for (const [user, tokens] of Object.entries(distribution)) {
    const c = getAddress(user);
    for (const [tok, amount] of Object.entries(tokens)) {
      const t = getAddress(tok);
      claims[c].tokens[t].proof = tree.getHexProof(urdLeaf(c, t, amount));
    }
  }
  return { merkleRoot: root, claims };
}

function verifyPriorLeavesUnchanged(
  prior: MerkleData,
  next: MerkleData,
  expectedUsdcAfter: Record<string, bigint>,
) {
  // (a) No prior leaf disappears or shrinks; non-USDC leaves byte-identical.
  let checked = 0;
  for (const [addr, c] of Object.entries(prior.claims)) {
    const cChk = getAddress(addr);
    for (const [tok, td] of Object.entries(c.tokens)) {
      const t = getAddress(tok);
      const nextClaim = next.claims[cChk]?.tokens?.[t];
      if (!nextClaim) throw new Error(`Prior leaf dropped: ${cChk} / ${t}`);
      if (t === USDC) {
        // USDC may grow; exact value asserted in pass (b).
        if (BigInt(nextClaim.amount) < BigInt(td.amount)) {
          throw new Error(`Prior USDC shrunk for ${cChk}: ${td.amount} -> ${nextClaim.amount}`);
        }
      } else if (nextClaim.amount !== td.amount) {
        throw new Error(`Non-USDC token amount changed for ${cChk} / ${t}: ${td.amount} -> ${nextClaim.amount}`);
      }
      checked++;
    }
  }

  // (b) For every addr in this tranche, next USDC value EXACTLY equals expected.
  for (const [addr, expected] of Object.entries(expectedUsdcAfter)) {
    const cChk = getAddress(addr);
    const nextClaim = next.claims[cChk]?.tokens?.[USDC];
    if (!nextClaim) throw new Error(`Expected USDC leaf missing for ${cChk}`);
    if (BigInt(nextClaim.amount) !== expected) {
      throw new Error(
        `USDC delta mismatch for ${cChk}: got ${nextClaim.amount}, expected ${expected.toString()}`,
      );
    }
  }

  // (c) No USDC leaf added that wasn't in expectedUsdcAfter.
  for (const [addr, claim] of Object.entries(next.claims)) {
    const cChk = getAddress(addr);
    if (claim.tokens[USDC] && expectedUsdcAfter[cChk] === undefined) {
      // Must have existed in prior with the same value (no new USDC outside this tranche).
      const priorClaim = prior.claims[cChk]?.tokens?.[USDC];
      if (!priorClaim || priorClaim.amount !== claim.tokens[USDC].amount) {
        throw new Error(`Unexpected USDC leaf for ${cChk} not in payouts`);
      }
    }
  }

  console.log(`  invariant ok: ${checked} prior leaves preserved, ${Object.keys(expectedUsdcAfter).length} USDC deltas exact`);
}

// ---------------------------------------------------------------------------
// Phase 6 — Gnosis Safe tx bundle (submitRoot + optional USDC top-up)
// ---------------------------------------------------------------------------

const URD_ADDRESS = getAddress("0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e");
const URD_INTERFACE_ABI = [
  { name: "submitRoot", type: "function", stateMutability: "nonpayable", inputs: [{ name: "newRoot", type: "bytes32" }, { name: "ipfsHash", type: "bytes32" }], outputs: [] },
  { name: "acceptRoot", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { name: "claimed", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "reward", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const ERC20_TRANSFER_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

function phase6SafeBundle(opts: { topupAmount?: string }) {
  // IMPORTANT: the importing Safe is the msg.sender for ALL transactions in this bundle.
  // - The USDC top-up moves funds FROM the importing Safe TO the URD. If the USDC
  //   actually lives at the Balancer veBAL locker (0xea79...36A5) or elsewhere, the
  //   importing Safe must already hold the USDC, or the top-up must be a separate tx.
  // - submitRoot() requires the importing Safe to be the URD owner/updater.
  // Verify both pre-conditions onchain before uploading this bundle.
  const merkle = readJson<MerkleData>(EXTRA_MERKLE);
  const root = merkle.merkleRoot as Hex;
  const ipfs = ("0x" + "00".repeat(32)) as Hex;

  const txs: { to: string; value: string; data: string }[] = [];

  if (opts.topupAmount) {
    txs.push({
      to: USDC,
      value: "0",
      data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [URD_ADDRESS, BigInt(opts.topupAmount)] }),
    });
  }

  txs.push({
    to: URD_ADDRESS,
    value: "0",
    data: encodeFunctionData({ abi: URD_INTERFACE_ABI, functionName: "submitRoot", args: [root, ipfs] }),
  });

  const bundle = {
    version: "1.0",
    chainId: ETH_CHAIN_ID,
    createdAt: Math.floor(Date.now() / 1000),
    meta: {
      name: "sdBAL Sunset USDC Distribution — submitRoot",
      description:
        `Root=${root}. Importing Safe MUST be URD owner/updater. ` +
        (opts.topupAmount
          ? `Top-up tx assumes importing Safe holds ${opts.topupAmount} (raw uint, USDC 6 decimals = ${formatUnits(BigInt(opts.topupAmount), 6)} USDC).`
          : `No top-up included — ensure URD already holds the USDC.`),
    },
    transactions: txs,
  };

  // Separate acceptRoot bundle (post-timelock).
  const acceptBundle = {
    version: "1.0",
    chainId: ETH_CHAIN_ID,
    createdAt: Math.floor(Date.now() / 1000),
    meta: { name: "sdBAL Sunset USDC Distribution — acceptRoot", description: "Run after URD timelock expires (see pendingRoot().validAt)" },
    transactions: [{
      to: URD_ADDRESS, value: "0",
      data: encodeFunctionData({ abi: URD_INTERFACE_ABI, functionName: "acceptRoot", args: [] }),
    }],
  };

  ensureOut();
  writeJson(path.join(OUT_DIR, "safe_submitRoot.json"), bundle);
  writeJson(path.join(OUT_DIR, "safe_acceptRoot.json"), acceptBundle);
  console.log(`Phase 6 — Safe bundles written`);
  console.log(`  safe_submitRoot.json  (root=${root})`);
  console.log(`  safe_acceptRoot.json  (post-timelock)`);
}

// ---------------------------------------------------------------------------
// Phase 7 — verification gate (re-runs ALL invariants from on-disk artifacts)
// ---------------------------------------------------------------------------

// Phase 7 is the release gate. Each check is independently passable; only when ALL
// pass is the new root safe to submit on-chain.
async function phase7Verify() {
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const raw = readJson<{ block: number; totalSupply: string; holders: BalanceMap }>(path.join(OUT_DIR, "holders_raw.json"));
  const cls = readJson<ClassifiedHolders>(path.join(OUT_DIR, "holders_classified.json"));
  const exp = readJson<ExpansionReport>(path.join(OUT_DIR, "holders_expanded.json"));
  const payouts = readJson<Payouts>(path.join(OUT_DIR, "payouts.json"));
  const merkle = readJson<MerkleData>(EXTRA_MERKLE);
  const tranches = loadTranches();
  const thisTranche = tranches.find((t) => t.newRoot === merkle.merkleRoot);

  console.log("Phase 7 — verification gate");
  const checks: { name: string; pass: boolean; detail?: string }[] = [];

  // 1. holders_raw sum
  const sumRaw = Object.values(raw.holders).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({
    name: "Σ raw holders == totalSupply",
    pass: sumRaw.toString() === raw.totalSupply,
    detail: `${sumRaw} vs ${raw.totalSupply}`,
  });

  // 1b. Re-query sdBAL totalSupply onchain at snapshot block.
  const onchainTotalSupply = await client.readContract({
    address: SD_BAL, abi: ERC20_ABI as any, functionName: "totalSupply",
    blockNumber: BigInt(raw.block),
  }) as bigint;
  checks.push({
    name: `sdBAL totalSupply@block${raw.block} matches snapshot`,
    pass: onchainTotalSupply.toString() === raw.totalSupply,
    detail: `onchain=${onchainTotalSupply} file=${raw.totalSupply}`,
  });

  // 2. classified sum == raw sum
  const sumCls = [...Object.values(cls.eoa), ...Object.values(cls.contracts)].reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ classified == Σ raw", pass: sumCls === sumRaw, detail: `${sumCls} vs ${sumRaw}` });

  // 2b. Spot-check EOA classification (5 random addrs) — bytecode at snapshot block still 0x.
  const eoaAddrs = Object.keys(cls.eoa);
  let eoaOk = 0;
  for (let i = 0; i < Math.min(5, eoaAddrs.length); i++) {
    const a = eoaAddrs[Math.floor(Math.random() * eoaAddrs.length)] as Address;
    const code = await client.getBytecode({ address: a, blockNumber: BigInt(raw.block) });
    if (!code || code === "0x") eoaOk++;
  }
  checks.push({ name: "Random EOA bytecode re-check (5)", pass: eoaOk === Math.min(5, eoaAddrs.length), detail: `${eoaOk}/${Math.min(5, eoaAddrs.length)}` });

  // 3. expanded sum == raw sum
  const sumExp = Object.values(exp.finalBalances).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({
    name: "Σ expanded == totalSupply",
    pass: sumExp.toString() === raw.totalSupply,
    detail: `${sumExp} vs ${raw.totalSupply}`,
  });

  // 4. no unknown contracts or sentinels
  checks.push({
    name: "No unknown contracts",
    pass: exp.unknownContracts.length === 0,
    detail: `${exp.unknownContracts.length} unresolved`,
  });
  checks.push({
    name: "No __UNKNOWN__ sentinel addresses in finalBalances",
    pass: !Object.keys(exp.finalBalances).some((a) => a.startsWith("__UNKNOWN__")),
  });

  // 4b. Final beneficiaries: every contract addr in finalBalances must be a Gnosis Safe
  // or an explicitly reviewed "leaf" override (default-deny check).
  const finalContractAddrs: string[] = [];
  for (const addr of Object.keys(exp.finalBalances)) {
    const code = await client.getBytecode({ address: addr as Address, blockNumber: BigInt(raw.block) });
    if (code && code !== "0x" && code.length > 2) finalContractAddrs.push(addr);
  }
  let allContractsApproved = true;
  for (const addr of finalContractAddrs) {
    const route = await classifyContract(client, addr as Address, raw.block, SD_BAL);
    if (route !== "safe" && route !== "leaf") { allContractsApproved = false; break; }
  }
  checks.push({
    name: "All contract beneficiaries are Safes or reviewed leaf overrides",
    pass: allContractsApproved,
    detail: `${finalContractAddrs.length} contracts in final set`,
  });

  // 5. payouts sum == usdcReceived
  const sumPay = Object.values(payouts.perAddress).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({
    name: "Σ payouts == usdcReceived",
    pass: sumPay.toString() === payouts.usdcReceived,
    detail: `${sumPay} vs ${payouts.usdcReceived}`,
  });

  // 6. URD USDC balance ≥ OUTSTANDING USDC liability = Σ max(claimable - claimed, 0).
  // Use cumulative−claimed because URD only pays out `claimable - claimed[user][token]`
  // per call. Summing raw `claimable` would over-state liability and false-fail for
  // any tranche after users start claiming.
  const urdUsdc = await client.readContract({ address: USDC, abi: ERC20_ABI as any, functionName: "balanceOf", args: [URD_ADDRESS] }) as bigint;
  const usdcLeaves: { addr: Address; amount: bigint }[] = [];
  for (const [addr, c] of Object.entries(merkle.claims)) {
    const u = c.tokens[USDC];
    if (u) usdcLeaves.push({ addr: getAddress(addr), amount: BigInt(u.amount) });
  }
  // Batch claimed() reads (parallel, 20 at a time).
  let outstandingUsdc = 0n;
  for (let i = 0; i < usdcLeaves.length; i += 20) {
    const chunk = usdcLeaves.slice(i, i + 20);
    const claimedAmts = await Promise.all(chunk.map((l) =>
      client.readContract({ address: URD_ADDRESS, abi: URD_INTERFACE_ABI as any, functionName: "claimed", args: [l.addr, USDC] }) as Promise<bigint>,
    ));
    chunk.forEach((l, j) => {
      const outstanding = l.amount > claimedAmts[j] ? l.amount - claimedAmts[j] : 0n;
      outstandingUsdc += outstanding;
    });
  }
  checks.push({
    name: "URD USDC balance ≥ outstanding USDC liability (cumulative − claimed)",
    pass: urdUsdc >= outstandingUsdc,
    detail: `URD has ${formatUnits(urdUsdc, 6)} USDC, outstanding ${formatUnits(outstandingUsdc, 6)} USDC across ${usdcLeaves.length} leaves`,
  });

  // 7. ALL leaves verify against root (not just 10).
  const tree = rebuildMerkleFromData(merkle);
  let leafOk = 0, leafTotal = 0;
  for (const [addr, c] of Object.entries(merkle.claims)) {
    for (const [tok, td] of Object.entries(c.tokens)) {
      leafTotal++;
      const leaf = urdLeaf(getAddress(addr), getAddress(tok), td.amount);
      if (tree.verify(td.proof as Hex[], leaf, merkle.merkleRoot as Hex)) leafOk++;
    }
  }
  checks.push({ name: "All leaves verify against root", pass: leafOk === leafTotal, detail: `${leafOk}/${leafTotal}` });

  // 8. Tranche manifest binding — current root + payouts artifact + USDC totals all match the recorded tranche.
  const currentPayoutHash = hashPayouts(payouts);
  const currentSumPay = Object.values(payouts.perAddress).reduce((a, b) => a + BigInt(b), 0n);
  const manifestBindingOk =
    thisTranche !== undefined
    && thisTranche.payoutHash === currentPayoutHash
    && thisTranche.usdcAdded === currentSumPay.toString()
    && thisTranche.recipients === Object.keys(payouts.perAddress).length;
  checks.push({
    name: "Tranche manifest binds current root + payouts.json + totals",
    pass: manifestBindingOk,
    detail: thisTranche
      ? `tranche #${thisTranche.trancheId} payoutHash=${thisTranche.payoutHash.slice(0, 10)}… currentHash=${currentPayoutHash.slice(0, 10)}…`
      : `root ${merkle.merkleRoot.slice(0, 10)}… not found in tranches.json`,
  });

  // Print
  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? "OK  " : "FAIL";
    console.log(`  [${mark}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    if (!c.pass) allPass = false;
  }
  console.log(allPass ? "\nALL GATES PASSED — safe to submit root." : "\nGATE FAILED — do not submit root.");
  if (!allPass) process.exit(1);
}

function rebuildMerkleFromData(merkle: MerkleData): MerkleTree {
  const leaves: Hex[] = [];
  for (const [addr, claim] of Object.entries(merkle.claims)) {
    for (const [tok, td] of Object.entries(claim.tokens)) {
      leaves.push(urdLeaf(getAddress(addr), getAddress(tok), td.amount));
    }
  }
  return new MerkleTree(leaves, utils.keccak256, { sortPairs: true });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function ensureOut() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}
function writeJson(p: string, data: unknown) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

async function main() {
  const phase = arg("phase") ?? "all";
  const usdc = arg("usdc"); // raw uint USDC amount received by locker (decimals=6)
  const minUsdc = BigInt(arg("min-usdc") ?? "0"); // raw uint payout floor; below = dropped + redistributed
  const source = arg("source"); // restrict the pot to one expansion entry's beneficiaries (e.g. the sdBAL gauge)

  switch (phase) {
    case "1":   await phase1Snapshot(); break;
    case "2":   await phase2Classify(); break;
    case "3":   await phase3Expand(); break;
    case "4":
      if (!usdc) throw new Error("--usdc required for phase 4 (uint, USDC 6 decimals)");
      phase4Payouts(usdc, minUsdc, source); break;
    case "5":   phase5Merge(); break;
    case "6": {
      const topupAmount = arg("topup-amount");
      phase6SafeBundle({ topupAmount }); break;
    }
    case "7":
    case "verify": await phase7Verify(); break;
    case "all": {
      // Read-only phases first.
      await phase1Snapshot();
      await phase2Classify();
      await phase3Expand();
      if (!usdc) {
        console.log("Skipping phase 4-7 — pass --usdc <amount> once Balancer airdrop tx lands.");
        return;
      }
      phase4Payouts(usdc, minUsdc, source);
      // Pre-merge gate: verify all read-only artifacts before mutating extra_merkle.
      await preMergeVerify();
      // Mutate.
      phase5Merge();
      phase6SafeBundle({});
      // Post-merge gate (includes onchain checks + full leaf verification).
      await phase7Verify();
      break;
    }
    default: throw new Error(`Unknown --phase ${phase}`);
  }
}

// Pre-merge gate. Runs every deterministic check that doesn't require the post-merge
// merkle.json before phase 5 mutates extra_merkle. A failure here leaves the working
// tree clean. Phase 7 re-runs these plus post-merge-only checks.
async function preMergeVerify() {
  const client = await getClient(ETH_CHAIN_ID_NUM);
  const raw = readJson<{ block: number; totalSupply: string; holders: BalanceMap }>(path.join(OUT_DIR, "holders_raw.json"));
  const cls = readJson<ClassifiedHolders>(path.join(OUT_DIR, "holders_classified.json"));
  const exp = readJson<ExpansionReport>(path.join(OUT_DIR, "holders_expanded.json"));
  const payouts = readJson<Payouts>(path.join(OUT_DIR, "payouts.json"));

  const checks: { name: string; pass: boolean; detail?: string }[] = [];

  const sumRaw = Object.values(raw.holders).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ raw == totalSupply", pass: sumRaw.toString() === raw.totalSupply });

  const onchainTs = await client.readContract({ address: SD_BAL, abi: ERC20_ABI as any, functionName: "totalSupply", blockNumber: BigInt(raw.block) }) as bigint;
  checks.push({ name: "onchain totalSupply matches snapshot", pass: onchainTs.toString() === raw.totalSupply });

  const sumCls = [...Object.values(cls.eoa), ...Object.values(cls.contracts)].reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ classified == Σ raw", pass: sumCls === sumRaw });

  // Random EOA bytecode re-check (5).
  const eoaAddrs = Object.keys(cls.eoa);
  let eoaOk = 0;
  const eoaSample = Math.min(5, eoaAddrs.length);
  for (let i = 0; i < eoaSample; i++) {
    const a = eoaAddrs[Math.floor(Math.random() * eoaAddrs.length)] as Address;
    const code = await client.getBytecode({ address: a, blockNumber: BigInt(raw.block) });
    if (!code || code === "0x") eoaOk++;
  }
  checks.push({ name: "Random EOA bytecode re-check", pass: eoaOk === eoaSample, detail: `${eoaOk}/${eoaSample}` });

  const sumExp = Object.values(exp.finalBalances).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ expanded == totalSupply", pass: sumExp.toString() === raw.totalSupply });
  checks.push({ name: "No unknown contracts", pass: exp.unknownContracts.length === 0 });
  checks.push({ name: "No __UNKNOWN__ sentinels", pass: !Object.keys(exp.finalBalances).some((a) => a.startsWith("__UNKNOWN__")) });

  // Every contract addr in final beneficiaries must classify as a Safe or an
  // explicitly reviewed "leaf" override (default-deny).
  const finalContractAddrs: string[] = [];
  for (const addr of Object.keys(exp.finalBalances)) {
    const code = await client.getBytecode({ address: addr as Address, blockNumber: BigInt(raw.block) });
    if (code && code !== "0x" && code.length > 2) finalContractAddrs.push(addr);
  }
  let allContractsApproved = true;
  let firstBadContract: string | undefined;
  for (const addr of finalContractAddrs) {
    const route = await classifyContract(client, addr as Address, raw.block, SD_BAL);
    if (route !== "safe" && route !== "leaf") { allContractsApproved = false; firstBadContract = addr; break; }
  }
  checks.push({
    name: "All contract beneficiaries are Safes or reviewed leaf overrides",
    pass: allContractsApproved,
    detail: firstBadContract ? `unapproved contract: ${firstBadContract}` : `${finalContractAddrs.length} contracts pass`,
  });

  const sumPay = Object.values(payouts.perAddress).reduce((a, b) => a + BigInt(b), 0n);
  checks.push({ name: "Σ payouts == usdcReceived", pass: sumPay.toString() === payouts.usdcReceived });

  console.log("Pre-merge gate:");
  let allPass = true;
  for (const c of checks) {
    console.log(`  [${c.pass ? "OK  " : "FAIL"}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    if (!c.pass) allPass = false;
  }
  if (!allPass) {
    console.error("\nPre-merge gate failed — aborting before any mutation.");
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
