# bounties-report

Stake DAO's vote incentive distributions: it turns claimed bounties, Snapshot votes and delegations into per-period reports and the merkle trees users claim from. Real user funds depend on every root. Pipelines and their gates live in the `README.md`, `script/vlCVX/README.md`, `script/sdTkns/verify/README.md` and `docs/`.

## Ways to hurt yourself

- **Running a pipeline script locally.** The report, merkle, publish, IPFS pin and special distribution scripts rewrite committed files or call the chain and external services. The dispatched workflows run them and push to `main` through `commit-and-push`, which stages only the paths its caller lists, so a new output root must be added to that step's `paths` input or it is left behind.
- **Hand-editing a generated file.** The period reports and merkles under `bounties-reports/`, `log.json`, `data/merkle_updates/**`, `data/ipfs-index.json` and `data/round_metadata.json` are written by the pipelines, and a pinned file edited by hand drifts from the IPFS index.
- **Mixing the two tree models.** The legacy sdToken merkle carries previous rewards over only for accounts that have not claimed since the freeze. The universal and vlCVX trees are cumulative and keyed by checksummed address. Code written for one does not apply to the other.
- **Trusting a green PR.** No workflow runs `pnpm test` on a pull request. Run the suite locally before the merge.
- **Editing `data/excluded-transactions.json` lightly.** Report generation applies it by default, so a change there changes report totals.

## Code Review Rules

### Merkle

- P0: a change to `generateMerkleTree` keeps the leaf encoding and sorted pairs the distributors verify, and its mirror in the verifier changes with it (source: script/verify/invariants/artifact.ts)
- P0: in a cumulative tree, no `(account, token)` amount sits below its on-chain `claimed` amount or decreases, except a confirmed expiry of unclaimed rewards. A pair disappears only once fully claimed on chain, or through a registered restatement removal matching its baseline root and amount. Anything else needs a capped waiver for that exact pair (source: script/verify/invariants/preservation.ts)
- P0: a cumulative generator never builds on an empty baseline when a prior tree exists. The vlCVX voters path picks the tree whose root matches the on-chain root, while the other generators take the newest prior artifact, so a change to either selection keeps that distinction explicit (source: script/utils/merkle/findPreviousMerkle.ts)
- P1: amounts reach the generator already summed per checksummed `(account, token)`, since `generateMerkleTree` keeps only the last value of a duplicate key (source: script/shared/merkle/generateMerkleTree.ts)

### Amounts

- P0: new amount code stays in integer wei strings and `bigint`, never `number`, `parseFloat` or a division by a power of ten. The legacy float path in `createMultiMerkle.ts` is not a pattern to extend (source: script/utils/merkle/createMultiMerkle.ts)
- P0: a tree's total never exceeds what funds it, and a report's totals reconcile with the tokens actually received, each claim counted exactly once (source: script/sdTkns/verify/README.md)
- P1: in the legacy `createMultiMerkle` path, rewards a gauge cannot allocate, with no usable voter or no voting power, go to the delegation address. `sdTokensMerkleGenerator.ts` and the Spectra path have no such fallback, so a change there handles that case rather than dropping or dividing by zero (source: script/test/unit/zeroVpGaugeFallback.test.ts)
- P1: a change to the price source of a value-weighted split keeps the peg band and the cross-source deviation check, since one wrong price moves money between wallets while every sum still balances (source: script/utils/priceSanity.ts)

### Routing

- P0: a wallet is paid once per source: a pooled delegator on a platform gets no raw leg on that platform, and an unexplained overlap fails closed (source: script/verify/invariants/addressExclusivity.ts)
- P1: delegation applies once per vote: direct voters' power is removed from their delegators, and a change to snapshot blocks or the delegation data is checked against RPC, not only the cache (source: script/utils/merkle/createMultiMerkle.ts)
- P1: a legacy sdToken leaf carries over only for an account that has not claimed since the last freeze (source: docs/sdtokens-freeze-verification.md)

### Gates

- P0: the legacy sdToken and vlCVX publish steps copy to `bounties-reports/latest/` only after their root check (`verifyLegacyRoot`, `verifyOnchainRoot`) passes. A change to a publish step keeps its check, and a new one adds one, since claim UIs build proofs from `latest/` (source: docs/sdtokens-freeze-verification.md)
- P0: the deterministic checks before a root is set stay blocking, never `continue-on-error`, including the gates `verificationScripts.ts` registers inside the AI verify step, whose model assessment alone is advisory. A new root target or token updates the scope check, the reconstruction and its unit test (source: script/verify/verificationScripts.ts)
- P1: a new chain, token or distributor reaches every consumer: the generator, the verifiers, the publish copy and the IPFS pin list, and an unsupported chain throws rather than falls back (source: script/helpers/verifyOnchainRoot.ts)
- P1: amounts moved between accounts in an already published tree go through the restatement or waiver registry, or the expiry ledger for a confirmed expiry, and a change to those files is reviewed as a funds change (source: script/verify/invariants/restatements.ts)
- P0: reward expiry recovers only what is provably unclaimed under an approved policy, to a treasury that is set and is not the distributor (source: script/shared/merkle/expiry.ts)
