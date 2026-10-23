Extra-rewards expiry applies to `0xD4898A378eA555595c4E7dbDE722B134a3F346D1` on Ethereum.

- `merkl-toolkit/src/2_distribution.ts` computes allocations per campaign and user.
- `sources.ts` reads each campaign on chain. Only Arbitrum campaigns from the two known VM hooks qualify. Token names and cached `source` labels are not evidence.
- `script/shared/merkle/expiry.ts` dates credits at root activation. Direct, gauge and unknown allocations stay protected. Claims consume VM credits first, oldest first, so recovery cannot consume protected rewards.
- Debt redirects reduce VM eligibility first. Unexplained additions remain protected; incomplete historical roots reset affected balances to protected opening credits.
- The existing expiry runtime prepares a batch, waits at least three hours, then re-reads claims and credits only the remaining approved amount to treasury. Claims stay open.
- `merkl-toolkit/src/3_merkle.ts` adds ordinary rewards to the active tree. The root publisher checks its parent in the same transaction when the expiry module is configured.

Read-only bootstrap, with a current toolkit checkout at `./merkl-toolkit` (an optional block number pins reproduction):

```sh
node --import tsx script/extraRewards/expiry/reconcile.ts
node --import tsx script/vlCVX/expiry/run.ts plan 1 extra
```

State lives under `bounties-reports/expiry/extra/`; it is separate from vlCVX. Replay reads canonical root/claim/recovery events and the existing toolkit allocation files. No additional per-distribution journal is written.

Production remains disabled. Before enabling: review the bootstrap, set the approved policy/notices/treasury, deploy the module with `(distributor, treasury, AllMight)`, enable it on the owner Safe, and configure exact Guard rules for `prepare` and `activate`. The normal publisher uses `checkRoot` as a static call; it needs no additional Guard rule.

Ship the proof API and toolkit generator before the root publisher. Run an ordinary distribution to add any missing zero-amount treasury leaves. Publish the reviewed deployment and bootstrap before enabling `EXTRA_REWARDS_EXPIRY_ENABLED` and pinning `EXTRA_REWARDS_BOUNTIES_REVISION`. The Maestro schedule starts paused.
