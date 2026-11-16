# Two-phase monthly rewards expiry

This release adds a coordinated publication path, not a contract or a Safe
module. It is **inactive until a reviewed journal is initialized**. The policy
is deliberately `null`. Merging code is not approval to initialize, announce,
sign, grant permissions, deploy Maestro or enable a schedule.

## Accounting contract

An immutable notice caps specific credit IDs. Credits age from their actual
activation, for six calendar months UTC. The initial policy notice is 30 days;
each monthly list waits 24 hours after both IPFS read-back and the alert.
Ordinary roots continue during that notice. Extra expires only proved VM
credits, with conservative VM-first claim attribution. Unproved opening
balances and `ageBoundAt` exceptions stay protected. Treasury, 5DAO and the
existing debt-redirection recipient are excluded.

The cut contains no fresh gains and no Treasury increment. With previous leaf
P, cut leaf K and claims C at activation, realized reserve is max(0, P-max(K,C)).
The following ordinary publication contains max(K,C)+G and credits this reserve
once to `0x9EBBb3d59d53D6aD3FA5464f36c2E84aBb7cf5c1`. Claims may cross the cut;
they reduce its proceeds rather than invalidate it. Existing timelocks remain
extra=0 and voters=3h for each submitted root.

Coverage is checked per token as positive unclaimed liabilities plus off-tree
commitments. Future debt repayments are not cash. Extra reserves all recorded
campaign funding minus archived allocations, including non-VM campaigns. A
new campaign invalidates an older reserve snapshot. Unexplained refunds,
legacy adjustments and deficits require reconciliation; expiry does not hide
them. These reserves must be audited against production history at cutover.

## Release and initialization gates

Release bounties-report, merkl-toolkit and automation-guard together before
deploying the dependent orchestrator definitions. The Guard and bounties PRs
target develop; production dispatch still reads main. Never initialize a
journal while an old publisher can write that distributor.

Before initialization, obtain explicit approval for:

1. The policy, public channels and completed 30-day initial notice.
2. The canonical seed for each pool, including historical recoveries, paid
   offsets, age/provenance and protected credits. Do not bootstrap from an
   old pre-expiry tree or turn an unknown-age balance into a new aged credit.
3. The reserve audit for every token and campaign, including generated but
   unsubmitted gains and any refunds. Exclude unsupported rebasing/fee tokens.
4. The additional Guard rule `revokePendingRoot()` on voters-1. Boss Safe is
   the fallback; stopping a workflow does not revoke a pending root.
5. The deployment/cutover and schedule activation. Check any outstanding Safe
   proposal for the abandoned module separately; closing its PRs did not cancel it.

Seed `bounties-reports/monthly-expiry/<voters-1|extra-1>.json` with a version-1
`PublicationJournal`: pool, revision=0, complete `ledger`, matching `merkle`,
`history=[]`, and `creditedSources`. The ledger checkpoint must be a finalized
**end-of-block** snapshot with matching root, block hash and paid counters.
No pending root, unpublished unknown transaction or in-flight writer may exist.
For extra include `reserves` and `campaignCount` at that same snapshot. Record
already-adopted `voters:<week>` / `extra:<timestamp>` sources so a rerun cannot
credit them again. Keep pending extra gains in `data/last_publication.json`,
not in the active baseline. There is intentionally no blind bootstrap command.

Verify proof resolution by root from the consumer API/front, including an
accepted cut before the next ordinary distribution. The cut is pinned before
submission; final reconciliation updates the active Git proof pointer. A
consumer that reads only a stale weekly file must not be used at cutover.
The API/front integration is a release gate, not certified by these PRs.

Keep journals after activation: deleting one re-enables the legacy path.
Restrict writes to reviewed operators and these workflows. A compromised
authorized publisher can still publish arbitrary roots; this design does not
add an on-chain security boundary against that key.

## Workflow sequence after approval

All workflow names below are dispatches, not commands to run against production
from a developer checkout. New schedules ship paused. Announcement and cut
submission are explicit operator actions in this first version.

1. Bounties `monthly-expiry.yaml`, `action=reconcile`, chosen pool: replay
   finalized claims and root events in block/transaction/log order.
2. `action=announce`, `period=YYYY-MM`: pin and read back the credit manifest,
   send the alert, and persist its availability time. A failed commit starts
   no executable notice; retry requires a fresh read-back and alert.
3. At least 24h later, `action=cut`: rebuild on the latest adopted root,
   preserve announced caps, check coverage and pin the exact cut proofs.
4. Guard `monthly-expiry.yaml`, `action=submit`: validate, reserve the exact
   intent through GitHub Contents compare-and-swap, then submit through Guard.
   Dry-run `mode=test` before any separately approved `execute` dispatch.
5. Reconcile finalized submission. `action=advance` only accepts or cancels
   a journaled voters pending; it never creates a cut. Extra activates directly.
6. Reconcile finalized activation. The regular generator/publisher produces
   and funds fresh gains, adds the realized Treasury reserve once, and is
   adopted after activation. Nobody must wait for our Treasury collector for
   safety: any caller can claim a valid Treasury leaf immediately.

Plan the voters cut approximately six hours before ordinary submission; if
there is insufficient time, postpone expiry. The 30-minute reconciliation
schedule and 20-minute adoption delay are operational budgets, not finality
proofs. Only the RPC finalized checkpoint authorizes adoption. Extra normally
settles at its next six-hour publication.

## Cancellation and ambiguous outcomes

Persist `action=cancel` in bounties first. The manual Maestro cancel pipeline
then reconciles submission, revokes the **exact** voters pending through Guard,
and reconciles again. A pending that disappeared may have been accepted:
require canonical `PendingRootRevoked` or `RootSet`, never infer cancellation
from zero. A late cancel leaves `cancelRequested` set even after activation.

After review, bounties `action=resume` clears the halt. A finalized revocation
retains its candidate and funding receipt; resubmit that exact root through the
monthly Guard job, **without another withdrawal**. The normal funded publisher
rejects a journal with retained submission. An activated cut retains its reserve
for settlement. An unsubmitted cancelled notice is discarded on resume.

An `execution` intent without a canonical outcome blocks retries and resume.
Inspect the signer nonce, receipt/revert and possible replacement transaction;
wait for finality. Reconcile mined successful events. If no event can resolve
the intent, a reviewed journal repair with transaction evidence is required.
Never clear it just because the workflow failed or a timeout elapsed. Extra has
no on-chain pending cancellation window at timelock zero.

Git CAS failures and non-fast-forward pushes stop publication. Do not rebase
generated journals or force-push them. Retry from the newest canonical state.
Recovery can temporarily block distribution; paying twice is not a fallback.

## Reproducible checks and scope

From bounties-report:

```sh
pnpm test
PATH="$HOME/.foundry/bin:$PATH" EXPIRY_RPC=https://eth.drpc.org pnpm exec vitest run script/test/integration/twoPhaseExpiry.fork.test.ts --maxWorkers=1 --disableConsoleIntercept
```

From automation-guard:

```sh
uv run pytest -q
uv run ruff check
uv run guard-jobs validate monthly-expiry hook-incentive-set-root vlcvx-voters-set-root merkle-accept-roots
uv run guard-jobs gen workflow --check
RUN_FORK_E2E=1 FORK_RPC_1=https://eth.drpc.org uv run pytest -q tests/jobs/monthly_expiry/test_fork.py -s
```

From merkl-toolkit: `pnpm exec tsx src/tests/monthly_expiry.ts` and
`pnpm exec tsx src/tests/recovery_baseline.ts`. From orchestrator:
`uv run --with pyyaml==6.0.3 python -m unittest discover -s scripts/tests -v`.

Forks use deployed URD, Guard, AllMight and USDC at block 26428567, synthetic
credits/funding and impersonated accounts **only on Anvil**. TypeScript tests
exercise canonical replay, late claims, both revocations and late acceptance;
Python tests exercise actual job entrypoints and calldata with local Git CAS
and notifications. Python tests supply the reconciler's state between phases;
these are complementary integration tests, not one live multi-repository run.
No KMS signature, production funds, IPFS announcement or Maestro dispatch is
needed. Live seed/reserve correctness, consumer proof serving and the whole
workflow chain remain separate cutover checks. Treasury collection is outside
this release: it creates claimable rights, not an automatic transfer job.
