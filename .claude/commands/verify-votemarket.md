---
name: verify-votemarket
description: >
  Verify bounties report integrity: CSV files, swap attribution, claimed_bounties.json cross-reference,
  and BotMarket allowlist. Use this skill when asked to: verify, check, or validate bounties reports,
  claimed bounties, gauge distribution accuracy, or CSV vs attribution mismatches.
  Trigger on phrases like "verify votemarket", "verify bounties", "check claimed bounties",
  "votemarket-v2 report", "bounties report".
---

# Verify Bounties Report

**Arguments**: $ARGUMENTS

## Overview

Verifies the integrity of a bounties report epoch by running
`script/verify/verifyBountiesReport.ts`, which checks:

1. **File existence** — CSV, attribution.json, OTC CSV, claimed_bounties.json
2. **CSV integrity** — share sums ≈ 100%, parseable columns
3. **Attribution match** — `sdInTotal` ≈ CSV `Reward sd Value` sum per protocol
4. **Dropped tokens** — tokens in CSV not swapped (ORDER mismatches)
5. **claimed_bounties ↔ CSV** — every VoteMarket claim must appear in CSV
6. **BotMarket allowlist** — claiming addresses are authorized operators

## Quick Reference

```bash
/verify-votemarket              # Latest epoch
/verify-votemarket 1772064000   # Specific epoch
```

---

## Step 1: Determine Epoch

Parse `$ARGUMENTS` for an epoch timestamp. If not provided, find the latest:

```bash
ls bounties-reports/ | sort -n | tail -1
```

---

## Step 2: Run Verification Script

```bash
pnpm tsx script/verify/verifyBountiesReport.ts [--epoch EPOCH]
```

The script reads only local files + one on-chain BotMarket call. No side effects.

**Output sections:**
- File Existence
- Per-protocol CSV + Attribution (curve, balancer, frax, pendle, fxn)
- Protocol Summary table (CSV sdVal, Attr sdVal, Gauges, Tokens, Txs, Dropped)
- claimed_bounties ↔ CSV cross-reference
- BotMarket Allowlist

---

## Step 3: Interpret Results

### Icons

| Icon | Meaning |
|---|---|
| ✅ | Check passed |
| ⚠️  | Warning — known pattern, no action needed |
| ❌ | Failure — requires investigation |

### Known ⚠️ patterns (not failures)

| Warning | Reason |
|---|---|
| `frax-attribution.json` not present | Frax is OTC-only, no aggregator swap |
| `pendle` direct distribution | Pendle uses direct token distribution, `wethNotSwapped=true` |
| `balancer-otc.csv` not present | Balancer has no OTC this week |
| Dropped token (ORDER mismatch) | Token not swapped — usually a cross-chain claim (e.g. Base USDC) |

### ❌ Failure cases

| Failure | Severity | Meaning |
|---|---|---|
| CSV missing | CRITICAL | Protocol has no distribution file |
| `sdInTotal` mismatch > 0.5% | CRITICAL | Swap amounts don't match CSV — funds may be unaccounted |
| gauge in `claimed_bounties` but NOT in CSV | CRITICAL | Claimed on-chain but not distributed — missing entry |
| token mismatch (isWrapped=false) | HIGH | Wrong reward token in CSV for this gauge |
| BotMarket not allowed | HIGH | Claiming address lost authorization — claims would revert |

---

## Step 4: Report

If the result is clean:
**✅ All checks passed — 5 protocols verified, N gauges, no missing claims.**

If there are failures, describe each:
- `missing gauge` → "curve bountyId=1071 on Arbitrum: gauge 0xE40DeF11… claimed on-chain but absent from curve.csv"
- `dropped token` → "curve: USDC on Base (0x833589…) was not swapped — ORDER mismatch"

---

## Protocol Reference

| Protocol | CSV | Attribution | OTC CSV | Notes |
|---|---|---|---|---|
| curve | `curve.csv` | `curve-attribution.json` | `curve-otc.csv` | Multi-chain, has OTC |
| balancer | `balancer.csv` | `balancer-attribution.json` | `balancer-otc.csv` | Usually no OTC |
| frax | `frax.csv` | — (OTC-only) | `frax-otc.csv` | No attribution |
| pendle | `pendle.csv` | `pendle-attribution.json` | `pendle-otc.csv` | Direct distribution |
| fxn | `fxn.csv` | `fxn-attribution.json` | — | No OTC usually |

BotMarket (allowlist): `0xADfBFd06633eB92fc9b58b3152Fe92B0A24eB1FF` (Ethereum mainnet)
