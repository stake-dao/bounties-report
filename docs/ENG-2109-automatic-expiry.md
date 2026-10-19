# Automatic reward expiry

The initial Safe setup enables the reviewed RewardsExpiry module. Governance also installs Guard rules for its exact `prepare(Batch)` and `activate(Batch)` selectors. The module pins the existing AllMight V2 as its immutable `PREPARER`; deployment metadata must record that address and the reviewed deployed code hash. Policy, treasury and notice gates remain required.

All callers allowed by AllMight, including legacy callers, inherit that prepare authority. Ages and notices depend on the pinned off-chain authoring inputs. Revoking Guard rules stops future job transactions but cannot cancel an already prepared public activation; the Safe's `disableModule` is the final stop for root-changing recovery.

For each batch, the job plans locally, durably publishes the immutable input and parent, then prepares through Guard → AllMight. A later dispatch activates after the longer of the module delay and current distributor timelock. A batch handles one token and at most 64 accounts. Each next batch and round follows the same automatic path without another Safe signature.

Retries preserve an existing proposal and its original timer, including across epoch rollover and competing claims. An ordinary distribution can invalidate a proposal's parent; only a known, canonically reproduced, published proposal with an obsolete parent may be replaced, starting a fresh delay. Unknown proposals stop execution for review.

The reviewed code revision also pins the initial bootstrap ledger. Cached states are display outputs: execution replays canonical events and recreates pending inputs at their original block and claims. Test mode simulates without publishing; plan mode emits local artifacts without sending transactions.

The intended initial Ethereum cleanup starts on 29 October. Allow roughly two weeks for the initial backlog under the per-batch delay; 29 October is the start date, not a promise that the backlog finishes that day. Production deployment and activation are separate from these code changes.
