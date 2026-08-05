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

## Votium forwarders money flow

Votium claims all users registered behind Stake DAO's forwarder through one
aggregate leaf. `claims/generateConvexVotium.ts` reconstructs the per-address
attribution and writes both files consumed by the Tuesday Merkle:

- `claimed_bounties_convex.json` contains the tokens actually claimed;
- `forwarders_voted_rewards.json` contains each user's `{ amountWei, usd }`
  attribution.

`3_merkles/createDelegatorsMerkle.ts` pays those users in sCRVUSD before
splitting the remaining pool among Stake DAO delegators. A user who both votes
through Votium and contributes to the Stake DAO delegation receives both
allocations; the Merkle merge sums them. A `direct-voter` forwarded its Votium
claim to Stake DAO but did not contribute voting power to the Stake DAO
delegate. It may have voted itself, or delegated elsewhere (for example, to
The Union): Votium attributes rewards to each underlying wallet even behind a
delegate, so a Union delegator forwarding to us earns its on-chain slice of
The Union's vote. Union membership is resolved on-chain at the round's epoch,
never from a hardcoded list.

The payout path is deliberately strict:

- the attribution file is ignored when absent and rejected when its matching
  claimed-bounties file is absent;
- reward symbols must resolve to canonical Ethereum token addresses;
- only entries with a positive claimed `amountWei` are payable, and allocated
  token totals cannot exceed the claimed totals;
- each token is capped by the aggregate amount actually claimed, split by the
  original USD weights, and valued again from the final `amountWei`;
- realized USD values are rounded down to six decimals and converted to
  sCRVUSD at the vault's current `pricePerShare` with bigint arithmetic;
- payouts below $1 stay in the delegators pool;
- if requested payouts exceed the available sCRVUSD, every payout is capped
  pro rata so the shared pool cannot be over-allocated;
- the merkle step refuses to run when bounties were claimed but the
  attribution file is missing, so a crashed generation cannot silently fold
  forwarder value into the delegators pool.

The applied payouts and the `pricePerShare` used are recorded in
`bounties-reports/<period>/vlCVX/votium_forwarder_payouts.json`;
`verify/verifyForwardersMerkle.ts` reads that artifact to check exact
per-address merkle deltas.

Token pricing can still differ from realized swap proceeds. Missing identities
or prices fail the generation instead of emitting a partial attribution. The
pool cap remains the final protection, and any unallocated remainder goes to
the delegators distribution.

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
