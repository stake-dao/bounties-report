# sdToken report gate

Run before publishing reports and again before freezing the distribution:

```sh
pnpm tsx script/sdTkns/verify/reportGate.ts --period 1789603200
```

Use `--protocol curve` or `--protocol fxn` to inspect one protocol. FXN report publication also requires its verified `--completion <file>` proof. `--notify-only` sends the results to Telegram without blocking; the normal command exits nonzero on a failed check.

| Check | Blocking condition |
| --- | --- |
| R1 Source completeness | Current claim files differ from on-chain VoteMarket v1/v2 claim events, including duplicates, amounts, chains, gauges and canonical tokens. RPC errors fail the check. |
| R2 Claim amounts | Report quantities do not reconcile with claims across sd/raw/delegation lanes, or a claim is silently dropped. Curve additionally verifies that reported quantities were funded and consumed in the attributed atomic conversions. FXN's separate funding/swap/conversion flow is validated by its completion proof before publication. |
| R3 Proceeds conservation | CSV totals or attribution differ from actual sdToken receipts beyond six-decimal CSV rounding and bounded JSON float dust. Each attributed conversion/cleanup must match an actual receipt. |
| R4 Allocation weights | Conversion proceeds, per-token budgets, gauge allocations or printed percentages disagree. WETH conversions must follow their input weights. With an FXN completion proof, token budgets must follow confirmed swap proceeds and native funding. Gauge allocations follow each token's raw claim weights. |
| R5 WETH ledger | Declared WETH totals differ from the transaction ledger, or the signed residual is worth at least $50. Cleanup settlement uses actual WETH transfers, not legacy native-token basis labels. |

Historical volume is compared separately per chain/token against its four-week median. Changes outside ±50% and missing history produce warnings, not completeness failures. Source completeness is established by events rather than volume heuristics.

Allocation checks use actual converted proceeds. A favorable conversion therefore increases the budget rather than failing a comparison with a later pool quote. No current pool-rate tolerance or volume acknowledgment is needed.

Curve input verification assumes the existing atomic conversion lane; FXN uses the separately verified Guard lane. Unwrapped rewards on other chains are outside the Ethereum sd report and are listed explicitly as warnings. This gate does not validate their separate distributions.

The FXN weekly Actions job needs `GIT_ACCESS_TOKEN` with Contents read and Actions read access to the private `stake-dao/automation-guard` repository, plus the Guard Redis connection and an ACL that permits its FXN reconciliation lease and journal checks. A manual Guard check does not trigger the Maestro report step: dispatch `reports.yaml` with `protocol=fxn`, `type=weekly` and its successful `check_run_id`. Completion failures are recorded in both the job log and `job-result` artifact.
