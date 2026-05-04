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
