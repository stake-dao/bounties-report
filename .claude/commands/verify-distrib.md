---
name: verify-distrib
description: Verify vlCVX and vlAURA weekly distributions (repartition, merkles, snapshot, delegations, bounties). For use in bounties-reports repo.
---

# Verify Weekly Distribution

**Arguments**: $ARGUMENTS

## Overview

This skill verifies that vlCVX and vlAURA bounty distributions are complete, consistent, and match on-chain/Snapshot data. Run after generating repartition files and before publishing merkle trees.

## Quick Reference

```bash
/verify-distrib              # Verify current week
/verify-distrib 1769644800   # Verify specific timestamp
/verify-distrib --deep       # Include RPC delegation verification (slower)
/verify-distrib vlAURA       # Verify only vlAURA
/verify-distrib vlCVX        # Verify only vlCVX
```

---


## Step 1: Determine Week Timestamps

Calculate the current and previous week timestamps (Thursday 00:00 UTC epochs):

```bash
node -e "const WEEK=604800; const now=Math.floor(Date.now()/1000); const curr=Math.floor(now/WEEK)*WEEK; console.log('CURRENT_WEEK=' + curr + '  # ' + new Date(curr*1000).toISOString()); console.log('PREV_WEEK=' + (curr-WEEK) + '  # ' + new Date((curr-WEEK)*1000).toISOString())"
```

If a timestamp is provided in `$ARGUMENTS`, use that instead. Store as `WEEK` variable for subsequent steps.

---

## Step 2: Verify Required Files Exist

### vlCVX Structure
```
bounties-reports/{WEEK}/vlCVX/
├── curve/
│   ├── repartition.json
│   ├── repartition_delegation.json
│   ├── repartition_8453.json (Base)
│   ├── repartition_delegation_8453.json (Base)
│   ├── merkle_data_non_delegators.json
│   ├── merkle_data_non_delegators_8453.json (Base)
│   └── votium_forwarders_log.json
├── fxn/
│   ├── repartition.json
│   ├── repartition_delegation.json
│   └── merkle_data_non_delegators.json
├── vlcvx_merkle.json
└── vlcvx_merkle_8453.json (Base)
```

### vlAURA Structure
```
bounties-reports/{WEEK}/vlAURA/
├── repartition.json
├── repartition_delegation.json
├── repartition_42161.json (Arbitrum)
├── repartition_delegation_42161.json (Arbitrum)
├── vlaura_merkle.json
└── vlaura_merkle_42161.json (Arbitrum)
```

Check existence with:
```bash
ls -la bounties-reports/$WEEK/vlCVX/ bounties-reports/$WEEK/vlCVX/curve/ bounties-reports/$WEEK/vlCVX/fxn/ 2>/dev/null
ls -la bounties-reports/$WEEK/vlAURA/ 2>/dev/null
```

---

## Step 3: Verify Delegation Share Sums

Delegation shares must sum to ~1.0 (tolerance: 0.999 - 1.001).

**vlCVX Curve** (forwarders + non-forwarders):
```bash
node -e "const d=require('./bounties-reports/$WEEK/vlCVX/curve/repartition_delegation.json'); const f=parseFloat(d.distribution.totalForwardersShare||0); const nf=parseFloat(d.distribution.totalNonForwardersShare||0); console.log('Curve - Forwarders:', f.toFixed(6), '+ Non-forwarders:', nf.toFixed(6), '= Sum:', (f+nf).toFixed(6), (f+nf)>0.999 && (f+nf)<1.001 ? '✅' : '❌')"
```

**vlCVX FXN**:
```bash
node -e "const d=require('./bounties-reports/$WEEK/vlCVX/fxn/repartition_delegation.json'); const f=parseFloat(d.distribution.totalForwardersShare||0); const nf=parseFloat(d.distribution.totalNonForwardersShare||0); console.log('FXN - Forwarders:', f.toFixed(6), '+ Non-forwarders:', nf.toFixed(6), '= Sum:', (f+nf).toFixed(6), (f+nf)>0.999 && (f+nf)<1.001 ? '✅' : '❌')"
```

**vlCVX Curve Base** (if exists):
```bash
node -e "const d=require('./bounties-reports/$WEEK/vlCVX/curve/repartition_delegation_8453.json'); const f=parseFloat(d.distribution.totalForwardersShare||0); const nf=parseFloat(d.distribution.totalNonForwardersShare||0); console.log('Curve Base - Forwarders:', f.toFixed(6), '+ Non-forwarders:', nf.toFixed(6), '= Sum:', (f+nf).toFixed(6), (f+nf)>0.999 && (f+nf)<1.001 ? '✅' : '❌')"
```

**vlAURA** (delegators):
```bash
node -e "const d=require('./bounties-reports/$WEEK/vlAURA/repartition_delegation.json'); const vals=Object.values(d.distribution.delegators||{}); const sum=vals.reduce((s,v)=>s+parseFloat(v),0); console.log('vlAURA - Delegators:', vals.length, '| Shares sum:', sum.toFixed(6), sum>0.999 && sum<1.001 ? '✅' : '❌')"
```

---

## Step 4: DUAL Delegation Verification (CRITICAL)

**ALWAYS verify delegation via BOTH sources:**
1. **Parquet/GraphQL** — indexed event data (can be stale/incomplete)
2. **RPC on-chain** — authoritative source of truth

**Known issue**: Indexers may miss delegation events, causing addresses that un-delegated to still appear as delegators.

### vlCVX Delegator Verification

**Primary verification (parquet-based):**
```bash
pnpm tsx script/vlCVX/verify/verifyDelegators.ts --timestamp $WEEK --gauge-type all
```

This script:
1. Reads delegation events from parquet cache files
2. Cross-references with Snapshot proposal voting data
3. Verifies delegators in file match expected set (minus direct voters, minus zero-VP)
4. Reports any discrepancies

**Expected output**: "RESULT: All delegators correctly accounted for"

**RPC cross-verification (recommended for deep verification):**
```bash
pnpm tsx script/vlCVX/verify-delegators-rpc.ts --timestamp $WEEK --gauge-type all
```

This script:
1. Fetches `SetDelegate`/`ClearDelegate` events directly from Snapshot Delegation Registry (`0x469788fE6E9E9681C6ebF3bF78e7Fd26Fc015446`)
2. Reconstructs delegation state at the snapshot block
3. Compares: RPC delegators vs Parquet delegators vs repartition file
4. Reports any discrepancies between data sources

**Expected output**: "RPC vs Parquet: In RPC but NOT in Parquet: 0"

**Key insight**: Both Curve and FXN gauges use the same `cvx.eth` Snapshot space for delegation. Only the proposal title filter differs (FXN proposals have "FXN" prefix).

### vlAURA Delegator Verification

**RPC Verification (Mandatory):**
```bash
pnpm tsx script/vlAURA/verify-delegators-rpc.ts
```

This script:
1. Fetches `DelegateChanged` events from AuraLocker contracts (ETH + Base)
2. Reconstructs delegation state at the proposal snapshot block
3. Compares: RPC delegators vs GraphQL delegators vs repartition file
4. Reports any discrepancies

**Expected output**: "✅ VERIFIED: RPC delegators match existing repartition file"

### Delegation Timing Verification (CRITICAL)

Verify ALL delegators delegated **BEFORE** the snapshot block (not after):

```bash
pnpm tsx script/vlAURA/verify-delegation-timing.ts
```

This script:
1. Reads delegation events from Parquet cache
2. For each delegator, finds their most recent delegation event before snapshot
3. Verifies that delegation block ≤ snapshot block
4. Reports any delegators who delegated AFTER the snapshot

**Expected output**: "✓ All delegations occurred BEFORE the snapshot block"

**Manual verification for a specific address:**
```bash
pnpm tsx -e "
const hyparquet = await import('hyparquet');
const ADDRESS = '{DELEGATOR_ADDRESS}'.toLowerCase();
const SNAPSHOT_BLOCK = {BLOCK_NUMBER};

let events = [];
await hyparquet.parquetRead({
  file: await hyparquet.asyncBufferFromFile('data/vlaura-delegations/1/0x3Fa73f1E5d8A792C80F426fc8F84FBF7Ce9bBCAC.parquet'),
  rowFormat: 'object',
  onComplete: (r) => { events = r; }
});

const userEvents = events.filter(e => e.delegator === ADDRESS && e.event !== 'EndBlock');
userEvents.forEach(e => {
  const status = Number(e.blockNumber) <= SNAPSHOT_BLOCK ? '✅ BEFORE' : '❌ AFTER';
  console.log('Block ' + e.blockNumber + ': -> ' + e.toDelegate + ' ' + status);
});
"
```

### Investigating Discrepancies

**If addresses are in file but NOT in RPC (vlAURA):**
```bash
# Check on-chain delegate at snapshot block
pnpm tsx -e "
const { getClient } = require('./script/utils/getClients');
const { getAddress } = require('viem');
const AURA_LOCKER = '0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac';
const ADDRESS = '{PROBLEM_ADDRESS}';
const SNAPSHOT_BLOCK = {BLOCK_NUMBER}n;

const client = await getClient(1);
const delegate = await client.readContract({
  address: getAddress(AURA_LOCKER),
  abi: [{name: 'delegates', type: 'function', inputs: [{type: 'address'}], outputs: [{type: 'address'}], stateMutability: 'view'}],
  functionName: 'delegates',
  args: [getAddress(ADDRESS)],
  blockNumber: SNAPSHOT_BLOCK
});
console.log('Delegate at snapshot:', delegate);
console.log('Is StakeDAO:', delegate.toLowerCase() === '0x52ea58f4fc3ced48fa18e909226c1f8a0ef887dc');
"
```

**If RPC shows different delegate, search for missing events:**
```bash
pnpm tsx -e "
const { getClient } = require('./script/utils/getClients');
const { getAddress, parseAbiItem } = require('viem');
const client = await getClient(1);
const events = await client.getLogs({
  address: getAddress('0x3fa73f1e5d8a792c80f426fc8f84fbf7ce9bbcac'),
  event: parseAbiItem('event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate)'),
  args: { delegator: getAddress('{PROBLEM_ADDRESS}') },
  fromBlock: {LAST_INDEXED_BLOCK}n,
  toBlock: {SNAPSHOT_BLOCK}n
});
events.forEach(e => console.log('Block', e.blockNumber, ':', e.args.fromDelegate, '->', e.args.toDelegate));
"
```

---

## Step 5: Verify Merkle Data Integrity

### Check Merkle Roots Exist and Are Valid
```bash
echo "vlCVX mainnet root: $(jq -r '.merkleRoot // .root' bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json)"
echo "vlCVX Base root: $(jq -r '.merkleRoot // .root' bounties-reports/$WEEK/vlCVX/vlcvx_merkle_8453.json 2>/dev/null || echo 'N/A')"
echo "vlAURA mainnet root: $(jq -r '.merkleRoot // .root' bounties-reports/$WEEK/vlAURA/vlaura_merkle.json 2>/dev/null || echo 'N/A')"
echo "vlAURA Arbitrum root: $(jq -r '.merkleRoot // .root' bounties-reports/$WEEK/vlAURA/vlaura_merkle_42161.json 2>/dev/null || echo 'N/A')"
```

Merkle roots should be valid 66-character hex strings starting with `0x`.

### Check Claim Counts and Token Counts
```bash
echo "=== vlCVX ==="
echo "Mainnet claims: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json)"
echo "Mainnet unique tokens: $(jq '[.claims | to_entries[] | .value.tokens | keys[]] | unique | length' bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json)"
echo "Base claims: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlCVX/vlcvx_merkle_8453.json 2>/dev/null || echo 'N/A')"

echo "=== vlAURA ==="
echo "Mainnet claims: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlAURA/vlaura_merkle.json 2>/dev/null || echo 'N/A')"
echo "Arbitrum claims: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlAURA/vlaura_merkle_42161.json 2>/dev/null || echo 'N/A')"
```

### Verify Critical Tokens Are Present (vlCVX)
SDT token should be in vlCVX merkle when SDT bounties exist:
```bash
jq '[.claims | to_entries[] | .value.tokens | keys[]] | unique | map(select(test("73968"; "i"))) | if length > 0 then "SDT: ✅ Present" else "SDT: ❌ Missing" end' bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json
```

---

## Step 6: Compare With Previous Week

### Claim Count Comparison
```bash
PREV_WEEK=$((WEEK-604800))
echo "=== Claim Count Comparison ==="
echo "vlCVX mainnet: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json) (this) vs $(jq '.claims | keys | length' bounties-reports/$PREV_WEEK/vlCVX/vlcvx_merkle.json 2>/dev/null || echo 'N/A') (prev)"
echo "vlCVX Base: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlCVX/vlcvx_merkle_8453.json 2>/dev/null || echo 'N/A') (this) vs $(jq '.claims | keys | length' bounties-reports/$PREV_WEEK/vlCVX/vlcvx_merkle_8453.json 2>/dev/null || echo 'N/A') (prev)"
echo "vlAURA mainnet: $(jq '.claims | keys | length' bounties-reports/$WEEK/vlAURA/vlaura_merkle.json 2>/dev/null || echo 'N/A') (this) vs $(jq '.claims | keys | length' bounties-reports/$PREV_WEEK/vlAURA/vlaura_merkle.json 2>/dev/null || echo 'N/A') (prev)"
```

Claim counts should be similar week-to-week (±20% typical). Large deviations warrant investigation.

### Week A/B Round Detection

Snapshot proposals span 2 distribution weeks. Week B must use identical delegation data as Week A.

**Check proposal IDs in repartition files or via Snapshot API:**
```bash
# Check if proposals are stored in files (preferred)
echo "This week Curve proposal: $(jq -r '.proposalId // "not stored"' bounties-reports/$WEEK/vlCVX/curve/repartition_delegation.json)"
echo "Prev week Curve proposal: $(jq -r '.proposalId // "not stored"' bounties-reports/$((WEEK-604800))/vlCVX/curve/repartition_delegation.json)"
```

**If Week B** (same proposal as previous week): Delegator sets MUST be identical to Week A. If different, copy Week A delegation files.

---

## Step 7: Token Completeness Check (CRITICAL)

Verify ALL bounty tokens appear in the correct merkle for each chain.

### vlCVX Token Verification

**Mainnet Curve tokens:**
```bash
WEEK=1770249600  # Set your week
MERKLE_TOKENS=$(jq -r '[.claims | to_entries[] | .value.tokens | keys[]] | unique | map(ascii_downcase) | .[]' bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json)
echo "=== Mainnet Curve Bounty Tokens ==="
cat bounties-reports/$WEEK/cvx.csv | tail -n +2 | grep "^1;" | cut -d';' -f5 | sort -u | while read token; do
  if echo "$MERKLE_TOKENS" | grep -qi "${token:2}"; then echo "✅ $token"; else echo "❌ MISSING: $token"; fi
done
```

**Mainnet FXN tokens:**
```bash
echo "=== Mainnet FXN Bounty Tokens ==="
cat bounties-reports/$WEEK/cvx_fxn.csv | tail -n +2 | grep "^1;" | cut -d';' -f5 | sort -u | while read token; do
  if echo "$MERKLE_TOKENS" | grep -qi "${token:2}"; then echo "✅ $token"; else echo "❌ MISSING: $token"; fi
done
```

**Base chain tokens (8453):**
```bash
MERKLE_TOKENS_BASE=$(jq -r '[.claims | to_entries[] | .value.tokens | keys[]] | unique | map(ascii_downcase) | .[]' bounties-reports/$WEEK/vlCVX/vlcvx_merkle_8453.json)
echo "=== Base Chain Bounty Tokens ==="
cat bounties-reports/$WEEK/cvx.csv | tail -n +2 | grep "^8453;" | cut -d';' -f5 | sort -u | while read token; do
  if echo "$MERKLE_TOKENS_BASE" | grep -qi "${token:2}"; then echo "✅ $token (Base)"; else echo "❌ MISSING: $token (Base)"; fi
done
```

---

## Step 8: Exclusion Verification (CRITICAL)

### Direct Voters NOT in Delegation Rewards

Direct voters should be excluded from `repartition_delegation.json` but may appear in `merkle_data_non_delegators.json` (for their direct gauge votes).

```bash
# Get direct voters from parquet verification output, then check exclusion:
DIRECT_VOTERS='["0xff6faf21b2812ee1db1bf2c3f02a7fa7b8f6adc8"]'  # Replace with actual list from Step 4
echo "=== Direct Voters Exclusion Check ==="
for voter in $(echo $DIRECT_VOTERS | jq -r '.[]'); do
  if jq -e ".distribution.forwarders[\"$voter\"] // .distribution.nonForwarders[\"$voter\"]" bounties-reports/$WEEK/vlCVX/curve/repartition_delegation.json > /dev/null 2>&1; then
    echo "❌ $voter IN repartition_delegation (WRONG - voted directly)"
  else
    echo "✅ $voter excluded from delegation rewards"
  fi
done
```

### Delegation Address NOT in Merkle

The StakeDAO delegation address itself must NEVER receive rewards:
```bash
DELEGATION_ADDR="0x52ea58f4FC3CEd48fa18E909226c1f8A0EF887DC"
echo "=== Delegation Address Exclusion ==="
if jq -e ".claims[\"$DELEGATION_ADDR\"]" bounties-reports/$WEEK/vlCVX/vlcvx_merkle.json > /dev/null 2>&1; then
  echo "❌ Delegation address IN merkle (CRITICAL ERROR)"
else
  echo "✅ Delegation address excluded from merkle"
fi
```

### Zero-VP Delegators NOT in File

The parquet verification (Step 4) reports "Minus zero VP" count. These addresses delegated but have no voting power at snapshot (expired locks). Verify count matches RPC discrepancy:

```bash
# From parquet verification output:
# "Minus zero VP: -81" should match "In RPC but NOT in file: 81"
```

---

## Step 9: Shares Calculation Verification

### Internal Share Sums (Normalized)

Each group (forwarders/nonForwarders) has internal shares that sum to 1.0:
```bash
node -e "
const d = require('./bounties-reports/$WEEK/vlCVX/curve/repartition_delegation.json');
const fwd = Object.values(d.distribution.forwarders).reduce((s,v) => s + parseFloat(v), 0);
const nfwd = Object.values(d.distribution.nonForwarders).reduce((s,v) => s + parseFloat(v), 0);
console.log('Curve forwarders internal sum:', fwd.toFixed(6), fwd > 0.999 && fwd < 1.001 ? '✅' : '❌');
console.log('Curve non-forwarders internal sum:', nfwd.toFixed(6), nfwd > 0.999 && nfwd < 1.001 ? '✅' : '❌');
"
```

### Group Allocation (Total Distribution)

The `totalForwardersShare` + `totalNonForwardersShare` must sum to 1.0:
```bash
node -e "
const d = require('./bounties-reports/$WEEK/vlCVX/curve/repartition_delegation.json');
const totalF = parseFloat(d.distribution.totalForwardersShare);
const totalNF = parseFloat(d.distribution.totalNonForwardersShare);
console.log('Group allocation:');
console.log('  Forwarders:', (totalF * 100).toFixed(2) + '%');
console.log('  Non-forwarders:', (totalNF * 100).toFixed(2) + '%');
console.log('  Total:', ((totalF + totalNF) * 100).toFixed(2) + '%', Math.abs(totalF + totalNF - 1) < 0.001 ? '✅' : '❌');
"
```

---

## Verification Report Template

Generate a summary report after all checks:

```markdown
## Weekly Distribution Verification Report

**Week**: {WEEK} ({ISO_DATE})
**Previous Week**: {PREV_WEEK}
**Round**: Week A / Week B

### File Checks
| Component | Status |
|-----------|--------|
| vlCVX files exist | ✅/❌ |
| vlAURA files exist | ✅/❌ |

### Delegation Verification
| Check | Status | Details |
|-------|--------|---------|
| vlCVX Curve shares sum | ✅/❌ | {sum} |
| vlCVX FXN shares sum | ✅/❌ | {sum} |
| vlCVX Curve Base shares sum | ✅/❌ | {sum} |
| vlCVX parquet verification | ✅/❌ | Curve: {n}/{n}, FXN: {n}/{n} |
| vlCVX RPC verification | ✅/❌ | RPC={n}, Parquet={n}, File={n} |
| vlAURA shares sum | ✅/❌ | {sum} ({count} delegators) |
| vlAURA RPC verification | ✅/❌ | RPC={n}, GraphQL={n}, File={n} |
| vlAURA delegation timing | ✅/❌ | All delegated BEFORE snapshot |

### Token Completeness
| Chain | Bounty Tokens | In Merkle | Status |
|-------|---------------|-----------|--------|
| Mainnet Curve | {n} | {n} | ✅/❌ |
| Mainnet FXN | {n} | {n} | ✅/❌ |
| Base (8453) | {n} | {n} | ✅/❌ |

### Exclusion Checks
| Check | Status |
|-------|--------|
| Direct voters excluded from delegation | ✅/❌ |
| Delegation address (0x52ea...) NOT in merkle | ✅/❌ |
| Zero-VP delegators excluded | ✅/❌ ({n} excluded) |

### Shares Calculation
| Component | Internal Sum | Group Allocation | Total |
|-----------|--------------|------------------|-------|
| Curve Forwarders | 1.0 ✅/❌ | {%} | - |
| Curve Non-Forwarders | 1.0 ✅/❌ | {%} | {sum} ✅/❌ |
| FXN Forwarders | 1.0 ✅/❌ | {%} | - |
| FXN Non-Forwarders | 1.0 ✅/❌ | {%} | {sum} ✅/❌ |

### Merkle Status
| Component | Root | Claims | Tokens |
|-----------|------|--------|--------|
| vlcvx_merkle.json | `0x...` | {n} | {n} |
| vlcvx_merkle_8453.json | `0x...` | {n} | {n} |
| vlaura_merkle.json | `0x...` | {n} | {n} |

### Week-over-Week Comparison
| Component | This Week | Prev Week | Change |
|-----------|-----------|-----------|--------|
| vlCVX mainnet claims | {n} | {n} | {%} |
| vlCVX Base claims | {n} | {n} | {%} |
| vlAURA mainnet claims | {n} | {n} | {%} |

### Bounties Summary
| Source | Gauges | Tokens |
|--------|--------|--------|
| cvx.csv (Curve) | {n} | {list} |
| cvx_fxn.csv (FXN) | {n} | {list} |

### Delegator Breakdown
| Gauge | Forwarders | Non-Forwarders | Total |
|-------|------------|----------------|-------|
| Curve | {n} | {n} | {n} |
| FXN | {n} | {n} | {n} |

### Issues Found
- {List discrepancies}

### Verdict
✅ All distributions verified
OR
⚠️ Discrepancies found - manual review required
```

---

## Key Verification Points

### Checklist (Copy-Paste for Quick Verification)

```
[ ] 1. Files exist (all repartition + merkle files present)
[ ] 2. Delegation shares sum to ~1.0 (tolerance: 0.999-1.001)
[ ] 3. Parquet delegator verification passes
[ ] 4. RPC delegator verification passes (RPC vs Parquet = 0 discrepancies)
[ ] 5. Delegation timing verified (ALL delegators delegated BEFORE snapshot)
[ ] 6. ALL bounty tokens present in merkle (per chain)
[ ] 7. Direct voters EXCLUDED from repartition_delegation
[ ] 8. Delegation address (0x52ea58f4...) NOT in merkle
[ ] 9. Zero-VP delegators correctly excluded (count matches RPC diff)
[ ] 10. Internal share sums = 1.0 (forwarders + non-forwarders each)
[ ] 11. Group allocation sums to 1.0 (totalForwardersShare + totalNonForwardersShare)
[ ] 12. Merkle roots valid (66-char hex starting with 0x)
[ ] 13. Claim counts reasonable vs previous week (±20%)
[ ] 14. Week A/B consistency (same proposal = same delegators)
```

### Detailed Verification Points

1. **DUAL verification: Parquet/GraphQL + RPC** — RPC is authoritative; cached data can be stale
2. **Delegation shares sum to ~1.0** — Mathematical correctness check
3. **RPC delegation matches file** — On-chain source of truth for who is delegating
4. **Delegation timing verified** — ALL delegators must have delegated BEFORE the snapshot block (not after)
5. **ALL bounty tokens in merkle** — Every token from CSV must appear in corresponding chain's merkle
6. **Direct voters excluded** — Anyone who voted directly gets rewards via non-delegators, not delegation
7. **DELEGATION_ADDRESS excluded** — Rewards go to individual delegators, not the delegation contract
8. **Zero-VP delegators excluded** — Delegators with 0 voting power at snapshot don't get rewards
9. **Week B = identical delegators to Week A** — Same Snapshot proposal must have same delegation snapshot
9. **Internal shares normalized** — Each group's shares sum to exactly 1.0
10. **Group allocation correct** — totalForwardersShare + totalNonForwardersShare = 1.0
11. **Merkle roots are valid** — 66-char hex strings starting with 0x
12. **Critical tokens present** — SDT should be in vlCVX when SDT bounties exist
13. **Claim counts reasonable** — Sudden large changes indicate problems

### Delegation Mechanisms

| Protocol | Delegation Contract | Events | Space |
|----------|---------------------|--------|-------|
| vlCVX | Snapshot Delegation Registry (`0x469788fE...`) | `SetDelegate`/`ClearDelegate` | `cvx.eth` |
| vlAURA | AuraLocker (`0x3fa73f1e...`) | `DelegateChanged` | N/A (contract-based) |

### Known Indexer Issues

- **GraphQL/Parquet indexers** may miss delegation events
- Addresses that un-delegated may still appear as active delegators
- **Always trust RPC over cached data when they disagree**

---

## Remediation Commands

If issues found, suggest these (do NOT run automatically):

```bash
# === Update Parquet Caches (run weekly before distribution) ===
# vlCVX delegations
pnpm tsx script/indexer/delegators.ts

# vlAURA delegations (ETH + Base)
pnpm tsx script/indexer/vlauraDelegators.ts

# === vlCVX Verification & Regeneration ===
# Full vlCVX delegator verification
pnpm tsx script/vlCVX/verify/verifyDelegators.ts --gauge-type all

# vlCVX RPC cross-verification
pnpm tsx script/vlCVX/verify-delegators-rpc.ts --gauge-type all

# Regenerate vlCVX repartition
pnpm tsx script/vlCVX/2_repartition/index.ts

# Regenerate vlCVX merkles
pnpm tsx script/vlCVX/3_merkles/createCombinedMerkle.ts

# === vlAURA Verification & Regeneration ===
# vlAURA RPC verification
pnpm tsx script/vlAURA/verify-delegators-rpc.ts

# vlAURA delegation timing verification
pnpm tsx script/vlAURA/verify-delegation-timing.ts

# Regenerate vlAURA repartition
FORCE_UPDATE=true pnpm tsx script/vlAURA/2_repartition/index.ts

# Regenerate vlAURA merkles
pnpm tsx script/vlAURA/3_merkles/createMerkle.ts
```

---

## STOP Condition

**After presenting the verification report, STOP.** Do not automatically fix issues.

Present findings and let the user decide on remediation.
