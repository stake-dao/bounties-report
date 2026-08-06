# vlCVX Rewards Distribution

The vlCVX pipeline distributes Convex voting rewards to direct voters, Stake DAO delegators, and Votium forwarders.

## Process

1. Fetch claims.
   - Votemarket v2 claims use `claims/generateConvexVotemarketV2.ts`.
   - Votium forwarded rewards use `claims/generateConvexVotium.ts`.
2. Generate reports with `1_report.ts`.
   - Outputs `bounties-reports/{timestamp}/cvx.csv` and, when applicable, `cvx_fxn.csv`.
3. Generate repartition data with `2_repartition/index.ts`.
   - Writes Curve/FXN repartitions under `bounties-reports/{timestamp}/vlCVX/curve/` and `.../vlCVX/fxn/`.
   - Writes delegation repartitions for forwarders and non-forwarders.
4. Generate voter merkles with `3_merkles/createCombinedMerkle.ts`.
   - Outputs `vlcvx_merkle.json` and chain-specific `vlcvx_merkle_{chainId}.json`.
5. Generate forwarded-delegator merkle with `3_merkles/createDelegatorsMerkle.ts`.
   - Outputs `merkle_data_delegators.json`.
6. Verify on-chain roots and publish current files to `bounties-reports/latest/vlCVX/`.

On-chain swaps, root submission, and final publish are handled outside these scripts by automation jobs and the `vlCVX: Distribution` workflow.

## Payment routing: Tuesday pool vs Thursday raw

Only wallets that forward to Stake DAO's Votium forwarder AND delegate to a
Stake DAO delegate (`VLCVX_POOLED_DELEGATES`) AND did not vote themselves on
that platform settle through the pooled Tuesday sCRVUSD merkle. Every other
leg — own votes (including by Stake DAO delegators), and slices of other
delegates' votes (for example, The Union's) — is paid raw tokens in the
Thursday combined merkle. Routing is per platform: a wallet can be pooled on
FXN and raw on Curve.

In `repartition_delegation.json`, the `perDelegate` sections keep registry
facts (who forwards), while `totalPerGroup` carries the payment routes:
`forwarders` = pooled Tuesday, `nonForwarders` = raw Thursday (including the
forwarders behind non-Stake-DAO delegates). The ops swap sizes the Tuesday
pot from `totalPerGroup.forwarders`.

## Votium forwarders money flow

Votium claims all users registered behind Stake DAO's forwarder through one
aggregate leaf, landing on the rewards recipient (`VOTIUM_FORWARDER`).
`claims/generateConvexVotium.ts` reconstructs the per-address attribution for
every INDIVIDUALLY routed leg (pooled legs never appear in it) and writes:

- `claimed_bounties_convex.json` — the tokens actually claimed;
- `forwarders_voted_rewards.json` — each user's `{ amountWei, usd }`
  attribution, already reconciled against the claimed amounts.

`3_merkles/createCombinedMerkle.ts` pays those legs as RAW TOKEN leaves in
the Thursday voters merkle (curve/mainnet pass, claim weeks only) via
`utils/votiumRawPayouts.ts`, and stages the matching ops instruction
`bounties-reports/<period>/vlCVX/votium_thursday_withdrawal.json`: the
Thursday batch must carry a dedicated votium-vault → voters-distributor
withdraw of exactly these amounts, and the votium swap job sweeps only the
remainder into sCRVUSD for the Tuesday pot.

The payout path is deliberately strict:

- the attribution file is ignored when absent and rejected when its matching
  claimed-bounties file is absent — and the merkle step refuses to run when
  bounties were claimed but the attribution file is missing, so a crashed
  generation cannot silently fold forwarder value into the delegators pool;
- reward symbols must resolve to canonical Ethereum token addresses;
- only entries with a positive claimed `amountWei` are payable, and allocated
  token totals cannot exceed the claimed totals (re-validated at merkle time);
- wallets whose total attributed value is below $1 are not paid raw leaves;
  their value stays with the pool and settles through the Tuesday pot;
- the withdrawal instruction is written only after every merkle output
  landed, so a half-finished run cannot describe unpublished leaves.

`createDelegatorsMerkle.ts` carries no Votium machinery anymore: the Tuesday
pot is all sCRVUSD received by the delegators distributor, split by the
pooled wallets' USD-valued VotemarketV2 entitlements
(`delegators_split_breakdown.json` records the split;
`verify/verifyForwardersMerkle.ts` checks exact per-address deltas from it).

## Commands

```bash
# Report and repartition
make -f automation/reports.mk run-weekly-vlcvx
make -f automation/distribution.mk validate-reports PROTOCOL=vlCVX
make -f automation/distribution.mk run-repartition PROTOCOL=vlCVX

# Voter merkle
make -f automation/distribution.mk run-merkles PROTOCOL=vlCVX TYPE=non-delegators

# Forwarded-delegator merkle
make -f automation/distribution.mk run-merkles PROTOCOL=vlCVX TYPE=delegators

# User diagnostics
pnpm vlcvx-diagnose
```

Set `FORCE_UPDATE=true` when a script refuses to overwrite existing period files.

## Outputs

Weekly files:

- `bounties-reports/{timestamp}/vlCVX/curve/repartition*.json`
- `bounties-reports/{timestamp}/vlCVX/fxn/repartition*.json`
- `bounties-reports/{timestamp}/vlCVX/vlcvx_merkle.json`
- `bounties-reports/{timestamp}/vlCVX/vlcvx_merkle_{chainId}.json`
- `bounties-reports/{timestamp}/vlCVX/merkle_data_delegators.json`
- `bounties-reports/{timestamp}/vlCVX/APRs.json`

Published files:

- `bounties-reports/latest/vlCVX/vlcvx_merkle.json`
- `bounties-reports/latest/vlCVX/vlcvx_merkle_{chainId}.json`
- `bounties-reports/latest/vlCVX/vlcvx_merkle_delegators.json`
- `bounties-reports/latest/vlCVX/APRs.json`

## Verification

```bash
pnpm tsx script/verify/aiVerify.ts --protocol vlCVX
pnpm tsx script/vlCVX/verify/distribution.ts --timestamp 1771459200
pnpm tsx script/vlCVX/verify/rewardFlow.ts --timestamp 1771459200
pnpm tsx script/vlCVX/verify/verifyDelegators.ts --timestamp 1771459200 --gauge-type all
pnpm tsx script/vlCVX/verify/delegators-rpc.ts --timestamp 1771459200 --gauge-type all
```
