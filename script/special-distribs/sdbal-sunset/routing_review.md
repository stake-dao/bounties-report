# sdBAL Sunset — Contract Routing Review

BIP-920 pass-through distribution. Snapshot block **25035662** (2026-05-08 18:00 UTC).
[sdBAL](https://etherscan.io/token/0xF24d8651578a55b0C119B9910759a351A3458895) totalSupply 419,528.012.

Phase 1-2 snapshot (cross-checked against an independently built RPC snapshot,
byte-identical): **112 holders** — 64 EOAs (4.69% of supply), 48 contracts (95.30%).

A contract holding sdBAL is almost never the economic owner — it's a gauge, a pool, a
distributor, or a vesting wallet holding it *for someone*. Phase 3 follows the value
through each of those layers until it reaches an address that can actually claim USDC
from the [URD](https://etherscan.io/address/0x6D98023de9AdeEE661E922F58f5c2ff086be1F4e):
an EOA, a Gnosis Safe, or an explicitly reviewed leaf. Result: **206 final
beneficiaries**, every reconciliation exact to the wei.

## Where the supply sits and how it expands

```
419,528 sdBAL total supply
├── 89.87%  sdBAL gauge ──────────────► 81 gauge stakers
│            │                            ├── EOAs (top: 41.8% one wallet)
│            │                            ├── 7 Vesters ──► beneficiary()
│            │                            ├── Alchemix SDTController ──► Alchemix Safe
│            │                            ├── Convergence SdtBlackHole ──► CVG Treasury
│            │                            └── Safes / EIP-7702 wallets (leaf)
├── 4.69%   EOAs holding sdBAL directly (leaf, 64 wallets)
├── 3.36%   Balancer V2 Vault ────────► 2 pools ──► BPT holders
│            │                            ├── Balancer pool gauge (93.49% of BPT)
│            │                            │     ├── Aura VoterProxy (91.2%) ──► Aura depositors
│            │                            │     └── veBAL locker (8.74%) ──► REVIEW
│            │                            ├── Stake DAO sdB vault (6.49%) ──► SD gauge stakers
│            │                            └── small direct BPT holders
├── 1.86%   MultiMerkleStash ─────────► 106 unclaimed bribe claims (frozen merkle)
└── 0.22%   long tail: Safes, routers, fee collectors, dust (leaf / REVIEW)
```

## The two non-obvious holders, explained

### Balancer V2 Vault — [0xBA12222222228d8Ba445958a75a0704d566BF2C8](https://etherscan.io/address/0xBA12222222228d8Ba445958a75a0704d566BF2C8) (3.36%)

In Balancer V2, pools do not custody their own tokens — one singleton Vault holds the
reserves of *every* pool. So "the Vault holds 14,108.59 sdBAL" really means "some
Balancer pools hold 14,108.59 sdBAL of liquidity". The owners are the holders of those
pools' LP tokens (BPT), pro-rata.

Which pools? We scanned every `TokensRegistered` event the Vault ever emitted (1,870
pools) and found exactly two registered with sdBAL:

| Pool | BPT | sdBAL at snapshot |
|---|---|---|
| sdBAL Stable Pool | [0x2d011aDf89f0576C9B722c28269FcB5D50C2d179](https://etherscan.io/address/0x2d011aDf89f0576C9B722c28269FcB5D50C2d179) | 14,108.079 |
| legacy sdBAL pool | [0xabf3eb5ce7fee55b25e2ca65962184979166b228](https://etherscan.io/address/0xabf3eb5ce7fee55b25e2ca65962184979166b228) | 0.506 |

Completeness is re-proved onchain on every run: the two pools' `getPoolTokens` balances
sum to the Vault's sdBAL balance **exactly** (a third place value can hide — Vault
"internal balances" — was scanned via `InternalBalanceChanged` events and is zero at the
snapshot). If a pool were missing, the sum check halts the run.

The main pool's BPT is then expanded like any wrapper. Its holders:

| BPT holder | share | what it is | routed to |
|---|---|---|---|
| [0xdc2df969ee5e66236b950f5c4c5f8abe62035df2](https://etherscan.io/address/0xdc2df969ee5e66236b950f5c4c5f8abe62035df2) | 93.49% | Balancer gauge for the pool (BPT stakers earn BAL) | its stakers, below |
| [0x7ca0a95C96Cd34013d619EFfcb02f200A031210d](https://etherscan.io/address/0x7ca0a95C96Cd34013d619EFfcb02f200A031210d) | 6.49% | Stake DAO sdB-sdBAL-STABLE vault (1:1 BPT wrapper) | holders of SD gauge [0x76fB1951F3395031B3ec703a16567ab92E792770](https://etherscan.io/address/0x76fB1951F3395031B3ec703a16567ab92E792770), where 100% of vault shares are staked |
| small holders | 0.02% | CoW settlement dust + 3 EOAs | leaf |

And the Balancer gauge's stakers in turn:

| Gauge staker | share | what it is | routed to |
|---|---|---|---|
| [0xaF52695E1bB01A16D33D7194C28C42b10e0Dbec2](https://etherscan.io/address/0xaF52695E1bB01A16D33D7194C28C42b10e0Dbec2) | 91.2% | Aura VoterProxy (Aura pool pid 249, wiring re-proved onchain each run) | Aura depositors: holders of deposit token [0x1fd8ee26a9e9d2a0a14e0eace044cf52215c2001](https://etherscan.io/address/0x1fd8ee26a9e9d2a0a14e0eace044cf52215c2001) + stakers in BaseRewardPool [0xDB407ad592F0563250B55261C37e029152128f18](https://etherscan.io/address/0xDB407ad592F0563250B55261C37e029152128f18); Σ matches deposit-token supply exactly |
| [0xea79d1A83Da6DB43a85942767C389fE0ACf336A5](https://etherscan.io/address/0xea79d1A83Da6DB43a85942767C389fE0ACf336A5) | 8.74% | Stake DAO veBAL locker | **REVIEW** — see open decisions |
| [0x154001a2f9f816389b2f6d9e07563ce0359d813d](https://etherscan.io/address/0x154001a2f9f816389b2f6d9e07563ce0359d813d) | 0.04% | EOA | leaf |

### MultiMerkleStash — [0x03E34b085C52985F6a5D27243F20C84bDdc01Db4](https://etherscan.io/address/0x03E34b085C52985F6a5D27243F20C84bDdc01Db4) (1.86%)

This is our own weekly bribe distributor — the contract this repo posts sdToken merkle
roots to every week. sdBAL voting rewards were paid through it as sdBAL tokens; users
claim with merkle proofs. When sdBAL weekly distributions ended with the sunset, the
last sdBAL root froze (root
`0xca4f9798…aea2`, identical onchain and in `bounties-reports/latest/merkle.json`).

The 7,813.43 sdBAL still in the stash is simply **bribes users never claimed**. The
frozen merkle has 119 leaves totalling 9,106.03 sdBAL; reading `isClaimed(sdBAL, index)`
onchain at the snapshot block shows 106 leaves (7,812.88 sdBAL) still unclaimed —
matching the stash balance to within 0.5436 sdBAL. That remainder is residue from
*older* roots that were replaced before being fully claimed — no proof exists for it
anymore, nobody can claim it → routed to Stake DAO governance
([stakedao.eth](https://etherscan.io/address/0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063)).

So: each of the 106 unclaimed leaves gets its USDC share directly. Claimants that are
themselves contracts were classified and recursed like everything else (10 turned out
to be Vesters, 6 EIP-7702 wallets, 5 Safes).

## Vesting — Stake DAO Vester contracts (~8.6% of supply)

Stake DAO deploys one [Vester](https://etherscan.io/address/0x08e828171d7503a34b7e20c1319296a6ee7ac676#code)
per beneficiary, vesting sdBAL-gauge tokens. Routed to each contract's onchain
`beneficiary()` at the snapshot:

| Vester | held via | beneficiary |
|---|---|---|
| [0xaf1a8e24…](https://etherscan.io/address/0xaf1a8e24b85c293b6bc38234c2d14062b9e0ae78) | gauge 3.71% + stash | [0xad2906fa…](https://etherscan.io/address/0xad2906faf5efec651f54372b121414ff0eec6b1d) |
| [0xfe5e6765…](https://etherscan.io/address/0xfe5e6765f820605ad7d58bec0f4e54893bd05bbb) | gauge 1.88% + stash | [0x1b7d0c1d…](https://etherscan.io/address/0x1b7d0c1d2a730fa791a2937ad75fef11aeaca3d4) |
| [0x08e82817…](https://etherscan.io/address/0x08e828171d7503a34b7e20c1319296a6ee7ac676) | gauge 1.16% + stash | [0x7c2ea10d…](https://etherscan.io/address/0x7c2ea10d3e5922ba3bbbafa39dc0677353d2af17) |
| [0xd2da10ef…](https://etherscan.io/address/0xd2da10ef5c78420682269134e543c72dced4cb5a) | gauge 1.16% + stash | [0xfeffd47b…](https://etherscan.io/address/0xfeffd47b42bd7936fcf256e162eedba99bd96556) |
| [0x40a69d79…](https://etherscan.io/address/0x40a69d7966295c6eea95633fa6c0a87f25a89d61) | gauge 0.89% + stash | [0x200550ca…](https://etherscan.io/address/0x200550cad164e8e0cb544a9c7dc5c833122c1438) |
| [0x3d592531…](https://etherscan.io/address/0x3d592531167e5c7c2c7e07d83b4dc4fc74593df3) | gauge 0.64% + stash | [0x99afd53f…](https://etherscan.io/address/0x99afd53f807766a8b98400b0c785e500c041f32b) |
| [0xeb90e295…](https://etherscan.io/address/0xeb90e2953b023d9496b963acd87ac3061fe8ea9e) | gauge 0.08% + stash | [0x72658e9a…](https://etherscan.io/address/0x72658e9a5c55371a5e80559b8e07abc14f212120) |
| [0x17e26dd8…](https://etherscan.io/address/0x17E26Dd811aD09Bd946f3b63a6F256f22c218DA1) | stash only (180.5 sdBAL) | [0x27e472f2…](https://etherscan.io/address/0x27e472f2625d6d4913f6cb5b99daaadb58da1d93) |
| [0xd02c1369…](https://etherscan.io/address/0xD02C136982413e567C373F001eF254c666ff1320) | stash only (93.4 sdBAL) | [0xaffc70b8…](https://etherscan.io/address/0xaffc70b81d54f229a5f50ec07e2c76d2aaad07ae) |
| [0x8ab61e36…](https://etherscan.io/address/0x8aB61e36265c162345b60cBAC8517e7d5dCE8381) | stash only (0.03 sdBAL) | [0x4bc81212…](https://etherscan.io/address/0x4bc8121278056bfcac2bd14d455659224d6ddf48) |

## Redirects (paying the holding contract would strand the USDC)

| Holder | % supply | Identity | Pays |
|---|---|---|---|
| [0x3216d2a5…](https://etherscan.io/address/0x3216d2a52f0094aa860ca090bc5c335de36e6273) | ~3.07% | Alchemix SDTController (single-beneficiary veSDT locker; `sweep()` → owner) | Alchemix Safe [0xdc70b6c0…](https://etherscan.io/address/0xdc70b6c0aeb5c6627eaa707fc6c804a2ec43f937) |
| [0x21777106…](https://etherscan.io/address/0x21777106355Ba506A31FF7984c0aE5C924deB77f) | ~0.39% | Convergence SdtBlackHole (CVG staking custody) | CVG Treasury [0x0af81536…](https://etherscan.io/address/0x0af815364BD9e9E60f3d2D3bAc1320B77d3E35F7) — **REVIEW** |
| [0x6b65525a…](https://etherscan.io/address/0x6b65525a40704a4c48d07c25b8d05654854dfecd) | 0.071% | SdtRewardDistributorV2 (Convergence) — proxy with admin slot zero, no sweep; USDC would strand permanently | CVG Treasury [0x0af81536…](https://etherscan.io/address/0x0af815364BD9e9E60f3d2D3bAc1320B77d3E35F7) |
| [0xea79d1A8…](https://etherscan.io/address/0xea79d1A83Da6DB43a85942767C389fE0ACf336A5) | ~0.275% | Stake DAO veBAL locker (1,155.95 BPT in the Balancer gauge + 1.0 legacy-pool BPT) | Stake DAO governance [0xF930EBBd…](https://etherscan.io/address/0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063) — **REVIEW** |

## Leaves

- **7 Gnosis Safes** (auto-detected via `getOwners()`): incl. Stake DAO governance
  [stakedao.eth](https://etherscan.io/address/0xF930EBBd05eF8b25B1797b9b2109DDC9B0d43063)
  (2.16% of gauge), Bao Finance treasury
  [0x3dfc49e5…](https://etherscan.io/address/0x3dfc49e5112005179da613bde5973229082dac35),
  Convergence ops Safes
  [0x2927d7d7…](https://etherscan.io/address/0x2927d7d70943290529adc517e8e2dc1eee7818b6) /
  [0xd2c46b4c…](https://etherscan.io/address/0xd2c46b4c28f4b7976d9f87687863c46bb2f71dbb).
- **EIP-7702 wallets** (code `0xef0100…` = delegated EOA; key holder claims, auto-leaf):
  [0x345d047d…](https://etherscan.io/address/0x345d047de6fef34d6217ded8de15bb3300e536f1),
  superchainer.eth [0x5c89c420…](https://etherscan.io/address/0x5c89c420a9e82ea9aedbaaab03302e39982919b9)
  (1.82% of gauge), herballemon.eth
  [0xaedc687f…](https://etherscan.io/address/0xaedc687fa5376d2fe9d4b81ebfc8c2ba30ba54ae), and 3 more.
- **Owner-controlled bots**: MEV executor
  [0x03cd656b…](https://etherscan.io/address/0x03cd656b6559b534700e487166f175eb5cd40e11)
  (owner has ERC20 sweep), Ownable bot
  [0xdf640f13…](https://etherscan.io/address/0xdf640f13ef36e22384fb9f0f713c739c34e54521)
  (owner [0xfffde9a2…](https://etherscan.io/address/0xfffde9a2bb7c9a6dfd1f0235f5af4f599e3265ec);
  **REVIEW** — no verified sweep, could redirect to owner instead).
- **Stranded-by-design dust** (~290 sdBAL ≈ 0.069% of supply): CoW
  [GPv2Settlement](https://etherscan.io/address/0x9008D19f58AAbD9eD0D60971565AA8510560ab41) (74.8),
  Uniswap v4 [PoolManager](https://etherscan.io/address/0x000000000004444c5dc75cB358380D2e3dE08A90) (62.1),
  Balancer [ProtocolFeesCollector](https://etherscan.io/address/0xce88686553686DA562CE7Cea497CE749DA109f9F)
  (101.1 — Balancer DAO could sweep this one), 1inch/ParaSwap routers and ~15 unverified
  dust contracts (≤3.5 each). Paid as leaves: their USDC sits unclaimed at the URD,
  recoverable by a future root update.

## Open decisions for sign-off

1. **veBAL locker stake** (~0.275%) — the current sdB vault has no strategy set and all
   its BPT idle, so the locker's Balancer-gauge stake is not mechanically attributable
   to vault users (gauge-deposit history shows mixed entrypoints, incl. a direct
   4,202-BPT deposit from stakedao.eth). Currently → governance. If the team attributes
   it to a user product, switch to expanding SD gauge
   [0x76fB1951…](https://etherscan.io/address/0x76fB1951F3395031B3ec703a16567ab92E792770) holders.
2. **Convergence** (~0.46% combined) — currently → CVG Treasury Safe. Alternative:
   enumerate CVG sdBAL staking-position NFTs (service
   [0xAf5b3f4A…](https://etherscan.io/address/0xAf5b3f4A0b4dc334dB7137E5584E0e971E5e4962))
   and pay NFT holders pro-rata.
3. **Stranded dust policy** (~0.069%) — pay as leaves (current) vs exclude and
   redistribute (changes everyone's amounts by +0.07%).
4. **Stash residue** (0.5436 sdBAL, unclaimable) — currently → governance.
5. **Post-snapshot claims** — stash claimants and Vester beneficiaries can still
   claim/withdraw sdBAL after the snapshot; amounts here are fixed at block 25035662
   (inherent to any snapshot distribution).
6. **$1 payout floor** — pot confirmed at **38,055.351773 USDC**
   ([BIP-920](https://forum.balancer.fi/t/bip-920-vebal-compensation-airdrop/7025):
   500k USDC to veBAL holders, locker share 38,055.35 — not yet received onchain as of
   2026-06-11). A URD claim costs ~$0.5-2 gas, so sub-$1 leaves would never rationally
   be claimed. `payouts.json` is computed with `--min-usdc 1000000`: 102 recipients,
   90 sub-$1 claimers dropped, their 15.41 USDC redistributed pro-rata. Raising to $5
   would drop 27 more recipients holding ~$62. Set `--min-usdc 0` to disable.

## Verification trail

- Phase 1-2 artifacts rebuilt independently via direct RPC + per-address `balanceOf`:
  identical (112/112 holders, same balances, same EOA/contract split).
- Vault: 1,870 `TokensRegistered` events scanned → exactly 2 sdBAL pools;
  `getPoolTokens` sums to the Vault balance to the wei; internal balances zero.
- Stash: onchain root == frozen repo merkle; 106 unclaimed leaves via onchain
  `isClaimed`; Σ unclaimed + residue == stash balance to the wei.
- Aura: deposit-token totalSupply == VoterProxy gauge stake to the wei (12,058.2314);
  pid wiring re-proved on every run.
- Every wrapper expansion reconciles Σ `balanceOf(candidates)` (+ locked MINIMUM_BPT at
  address(0) for Balancer BPTs) == `totalSupply` or hard-fails.
- Final artifact: 206 beneficiaries; Σ == totalSupply exact; 48/48 sources
  value-preserving; every final balance decomposes exactly into expansion contributions
  + direct EOA holding; all 57 contract beneficiaries are Safes, EIP-7702 wallets, or
  reviewed leaves.
- Identification: 2 multi-agent research rounds (29 + 10 agents) over verified source,
  onchain probes at the snapshot block, and protocol docs; every contract ≥100 sdBAL and
  every expansion-type treatment adversarially verified by independent agents.
