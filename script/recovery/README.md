# Safe-approved recovery preparation

Preparation **only refreshes** the reviewed October 29, 2026 recovery round.
A separate, manually dispatched adoption job proposes canonical proof updates
after a finalized Safe execution. Neither job signs, submits, accepts roots,
merges PRs, or changes distributor permissions.
The recipient is DAO Safe `0x5DA07af8913A4EAf09E5F569c20138b658906c17`;
the distributor owner / signing Safe remains Boss
`0xB0552b6860CE5C0202976Db056b5e3Cc4f9CC765`.

## Flow

1. Let the ordinary distribution finish, including its existing root delay and
   acceptance. The Maestro voter pipeline invokes preparation after publication;
   the extra-rewards pipeline invokes it after its existing `setRoot` job.
2. Read root history, claim counters and balances at one fresh block. Later
   ordinary distributions may add rewards, but every intervening root must have
   a verified artifact with no reduced leaf. A pending root, missing history,
   reduction or reorg prevents a Safe batch. Each subsequent claim reduces its
   old-reward allowance first. New rewards never enlarge approved allowances.
3. Upload a report, reduced Merkle tree and exact per-wallet reductions. Telegram
   includes status, cutoff, snapshot, roots, recipient, token amounts, funding
   deficits and the workflow link. Missing/failed Telegram delivery fails a
   notification-enabled run. Notifications are opt-in for local runs.
4. **Only after a reviewed checker deployment is configured**, a funded proposal
   also includes `safe-batch.json` for Safe Transaction Builder. Sign and execute
   its two CALLs as **one atomic MultiSend**, never separately. The checker
   rejects changed claims, changed roots, pending roots and redirected DAO
   payments at execution, not merely at preparation. Any competing claim means
   recompute the files and collect new Safe signatures.
5. After finality, dispatch `rewards-recovery-adopt.yaml` with the pool,
   preparation run ID and on-chain Safe execution hash. It replays preparation
   at its original block and checks publication, finality and all affected claim
   events before execution. It rejects wrong roots, stale proposals and pending
   replacements. Claims after recovery publication are allowed.
6. Review and merge the adoption PR(s). Voters update both their numeric-period
   and latest proofs; extra rewards update toolkit's latest tree and a recovery
   parent mapping, never historical distribution files. Both original and reduced
   roots, receipt and gross/offset/net accounting are archived in bounties-report.
   A committed adoption makes further refreshes of that round a no-op.

## Existing funding deficits

A deficit is measured per token as the sum of positive unclaimed entitlements
minus the distributor's token balance, at the same block as the claims snapshot.
It is absorbed only from that token's **newly recovered DAO credit**. The gross
expired reduction stays unchanged; DAO receives gross minus deficit. Existing
DAO entitlements and non-expired rewards are not reduced. No cross-token offset,
external transfer, or additional expiry is allowed. If any deficit exceeds its
token's new recovery, preparation remains blocked, including when none remains.

`report.json` records gross, funding offset and net amounts, and Telegram shows
the same breakdown. The tree's total falls by the offset: it removes unbacked
entitlements rather than pretending missing tokens were transferred. Record
this write-down separately from the net DAO recovery when adopting the reduced
baseline; do not use the old gross-conservation accounting unchanged. A fresh
claim can make the offset unaffordable, so reruns must recalculate both amounts.

## Timelock and deployment decision

No Safe module or privileged automation is installed. `ClaimSnapshotCheck.sol`
is a stateless assertion contract: it has no storage, custody, root setter or
permissions. It still needs contract review and deployment on each target chain.
Compile with Solidity 0.8.30, optimizer 200, via-IR and EVM Paris; record the
reviewed deployed runtime's keccak256 hash and address in `config.json`.
All checker entries deliberately remain **null**: no executable batch is emitted.

**This design preserves the ordinary distribution timelock, but does bypass a
separate recovery-root timelock using the owner's existing `setRoot` authority.**
Safe signers must explicitly approve that decision. It is not a timelocked
recovery disguised as an acceptance operation: `acceptRoot()` accepts the exact
queued hash and cannot recompute it. Queueing a reduced tree and only checking
claims in a bot would be unsafe because anyone can accept that queued root.
Do not enable this path if a recovery-root delay must also be enforced.

## Running and reviewing

`pnpm tsx script/recovery/run.ts all /tmp/rewards-recovery` prepares locally
without sending Telegram. Scopes are `all`, `voters`, or `extra`. Add `--notify`
only when delivery is authorized; it uses `TELEGRAM_VERIF_API_KEY` and
`TELEGRAM_VERIF_CHAT_ID`. The dispatch-only `rewards-recovery.yaml` workflow
performs the same computation, with read-only repository permissions and no
signing secrets. Land that workflow before enabling the Maestro hooks.

Extra preparation needs a `merkl-toolkit` checkout with current distribution
archives; each published artifact is checked against its root. The review
references an immutable archive, not `last_merkle.json`. Review files contain the original maximum
reductions and historical claim counters from the linked provenance bundle.
They are not a general rolling expiry policy. After this round completes, or
after a reduction/unresolved publication, reconcile and review a new input;
do not relabel a root or advance the checkpoint to get past a rejection.

Before execution, simulate the **full Safe MultiSend** against the actual Safe,
review funding and gas, and **pause and drain all competing root generators,
setters and acceptors**, including already-running jobs and signed/queued batches.
Keep them stopped through adoption. A prepared-but-unpublished ordinary root
could otherwise restore old entitlements after recovery; a bot preflight is not
an execution-time lock. Recheck the active root before merging adoption PRs.
Do not resume until the canonical reduced proofs are merged and served to claim
clients. For extra rewards both the toolkit baseline PR and bounties audit PR
must land; the toolkit implementation PR must already be installed. No workflow
automatically pauses/unpauses publishers or merges these PRs.

The adoption workflow uses `GIT_ACCESS_TOKEN` to create PRs in bounties-report
and (for extra) merkl-toolkit. It never pushes canonical data straight to main.
Locally, `pnpm tsx script/recovery/adopt.ts <pool> <prepared-pool-directory>
<on-chain-tx-hash>` verifies and lists planned files without writes; `--write`
creates the changes for review. The post-execution audit cannot undo an unsafe
execution; it does not replace the atomic on-chain checker.

The batch reallocates entitlements; it does **not** transfer tokens. Once its
root is confirmed, DAO claims use the emitted proofs and pay the DAO Safe.
Keep the executed batch, receipt, original review, refreshed reductions, and
published tree together as the round's audit record.
