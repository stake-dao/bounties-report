# sdBAL Sunset — Contract Routing Review

BIP-920 pass-through distribution. Snapshot block **25035662** (2026-05-08 18:00 UTC).
sdBAL `0xF24d8651578a55b0C119B9910759a351A3458895`, totalSupply 419,528.012 sdBAL.

Holder snapshot (phase 1-2, cross-checked against an independently built RPC snapshot,
byte-identical): **112 holders** — 64 EOAs (4.69% of supply), 48 contracts (95.30%).

Identification: 2 multi-agent research rounds (29 + 10 agents) over Etherscan source,
onchain probes at the snapshot block, and protocol docs; every contract ≥100 sdBAL plus
every expansion-type treatment adversarially verified by independent agents. All
expansion routes re-prove their provenance onchain at run time and hard-fail on any
reconciliation mismatch.

## Expansion routes (value flows through to ultimate beneficiaries)

| Holder | % supply | Identity | Treatment |
|---|---|---|---|
| `0x3e8c7265…` | 89.866% | Stake DAO sdBAL LiquidityGaugeV4 (staking_token()==sdBAL) | expand to gauge-share holders (81 holders, Σ==totalSupply exact) |
| `0xBA122222…` | 3.362% | Balancer V2 Vault | expand via the 2 pools registered with sdBAL (pool list re-proved: Σ pool balances == Vault balance exactly; internal balances zero) |
| `0x03E34b08…` | 1.862% | Stake DAO MultiMerkleStash | expand to unclaimed sdBAL merkle leaves (root verified onchain; isClaimed read per leaf at snapshot; 106 unclaimed leaves = 7,812.88 sdBAL); contract claimants classify + recurse |
| 10 × Vester | ~8.5% of supply via gauge shares + 273.9 sdBAL via stash leaves | Stake DAO Vester (per-beneficiary vesting) | pay `beneficiary()` read at snapshot (3 of the 10 surfaced as unclaimed stash claimants) |
| `0x7ca0a95C…` | (6.49% of BPT) | Stake DAO sdB-sdBAL-STABLE vault (1:1 BPT wrapper) | expand: 100% staked in SD gauge `0x76fB1951…` → gauge holders |
| `0xdc2df969…` | (93.49% of BPT) | Balancer gauge for the sdBAL pool (lp_token()==BPT) | auto-probed wrapper expansion |
| `0xaf52695E…` | (91.2% of Balancer gauge) | Aura VoterProxy (pid 249, wiring re-proved onchain) | expand: deposit token `0x1fd8ee26…` holders + BaseRewardPool `0xdb407ad5…` stakers, Σ==totalSupply exact |

## Redirects (paying the holding contract would strand the USDC)

| Holder | % supply | Identity | Pays | Note |
|---|---|---|---|---|
| `0x3216d2a5…` | ~3.07% | Alchemix SDTController (single-beneficiary veSDT locker; sweep()→owner) | Alchemix Safe `0xdc70b6c0…` (2-of-3, verified owner()) | confirmed by adversarial verifier |
| `0x21777106…` | ~0.39% | Convergence SdtBlackHole (CVG staking custody) | CVG Treasury Safe `0x0af81536…` (6 signers, verified owner()) | **REVIEW** — alternative: enumerate CVG sdBAL staking-position NFTs (service `0xAf5b3f4A…`) and pay NFT holders pro-rata |
| `0x6b65525a…` | 0.071% | SdtRewardDistributorV2 (Convergence) — proxy with admin slot = 0, no sweep, USDC would strand permanently | CVG Treasury Safe `0x0af81536…` | admin-less proxy verified onchain |
| `0xea79d1A8…` | ~0.275% + 0.0001% | Stake DAO veBAL locker (1,155.95 BPT staked in Balancer gauge + 1.0 legacy-pool BPT). Current sdB vault has **no strategy set and all its BPT idle**, so this stake is NOT attributable to vault users mechanically; gauge-deposit history shows mixed entrypoints incl. a direct 4,202-BPT deposit from stakedao.eth | Stake DAO governance `0xF930EBBd…` (stakedao.eth) | **REVIEW** — team knows whether this stake backs a user product; if so, switch to expanding SD gauge `0x76fB1951…` holders |

## Leaves — Safes & claim-capable wallets (auto-probed or reviewed)

7 Gnosis Safes auto-detected (incl. Stake DAO governance `0xF930EBBd…` 2.16% of gauge,
Bao Finance treasury, Convergence ops Safes, others). 3 EIP-7702 wallets
(`0x345d047d…`, superchainer.eth `0x5c89c420…` 1.82% of gauge, herballemon.eth) — key
holders claim directly. Personal MEV bot `0x03cd656b…` (owner has ERC20 sweep) and
Ownable bot `0xdf640f13…` (owner `0xfffde9a2…`; **REVIEW** — no verified sweep; could
redirect to owner EOA instead).

## Leaves — stranded-by-design dust (REVIEW: strand vs exclude)

Router/settlement/fee contracts where no party can claim: CoW GPv2Settlement (74.8
sdBAL), Uniswap v4 PoolManager (62.1), Balancer ProtocolFeesCollector (101.1 — Balancer
DAO could sweep this one via governance), 1inch/ParaSwap routers and ~15 unverified
dust contracts (≤3.5 sdBAL each). Total ≈ 290 sdBAL ≈ **0.069% of supply**.
Decision: pay them anyway (USDC sits unclaimed at the URD — recoverable by a future
root update) vs exclude and redistribute (changes everyone's amounts by +0.07%).
Current implementation: pay them (leaf), i.e. value parks at the URD until claimed.

## Residual decisions for sign-off

1. **MultiMerkleStash residue** — 0.5436 sdBAL of pre-freeze unclaimable leftovers →
   currently routed to Stake DAO governance.
2. **SdtBlackHole / SdtRewardDistributorV2** → CVG Treasury Safe vs full CVG NFT
   position enumeration (~0.46% of supply combined).
3. **veBAL locker stake attribution** (~0.275%) — governance vs SD gauge holders.
4. **Stranded dust policy** (~0.069%) — leaf (current) vs exclude.
5. **Post-snapshot claims**: stash claimants and Vester beneficiaries can still
   claim/withdraw sdBAL after the snapshot — inherent to any snapshot distribution;
   amounts are fixed at block 25035662 in all cases.

## Verification trail

- Phase 1-2 artifacts independently rebuilt via direct RPC + per-address balanceOf:
  identical (112/112 holders, same balances, same EOA/contract split).
- Balancer Vault breakdown: TokensRegistered scan (1,870 events) → exactly 2 pools with
  sdBAL; getPoolTokens sums to the Vault balance to the wei; InternalBalanceChanged
  scan → zero internal balances at snapshot.
- Stash: onchain sdBAL root == frozen repo merkle root; 106 unclaimed leaves enumerated
  via onchain isClaimed at snapshot; Σ unclaimed (7,812.88) + residue (0.5436) == stash
  balance to the wei. Contract claimants (10 Vesters, 6 EIP-7702 wallets, 5 Safes)
  classified and recursed like every other expansion.
- Final artifact: 206 beneficiaries; Σ == totalSupply exact; 48/48 sources
  value-preserving; every final balance decomposes exactly into expansion
  contributions + direct EOA holding; all 57 contract beneficiaries are Safes,
  EIP-7702 wallets, or reviewed leaf overrides.
- Aura: depositToken totalSupply == VoterProxy gauge stake to the wei (12,058.2314);
  pid wiring re-proved on every run.
- All wrapper expansions reconcile Σ balanceOf(candidates) (+ locked MINIMUM_BPT at
  address(0) for Balancer BPTs) == totalSupply or hard-fail.
