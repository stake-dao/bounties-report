# Verification Pipeline

This directory contains automated verification for weekly distributions and bounty reports. Verification scripts produce deterministic local checks; `aiVerify.ts` can then send those outputs to the configured LLM provider for triage and Telegram reporting.

## Files

| File | Role |
|---|---|
| `distributionVerify.ts` | Script registry, subprocess runner, LLM prompt builder, and consensus helpers |
| `aiVerify.ts` | Main CLI for consensus verification and Telegram reporting |
| `compareModels.ts` | Runs scripts once and compares multiple model verdicts |
| `verifyBountiesReport.ts` | Verifies report CSVs, attribution files, claimed bounties, and BotMarket allowlist |
| `telegramReport.ts` | Formats and sends Telegram reports |
| `../utils/llmClient.ts` | Provider-agnostic LLM interface |
| `../utils/openCodeZen.ts` | Opencode ZEN-backed client |

## Supported Protocols

`distributionVerify.ts` currently accepts:

```typescript
export type Protocol = "vlCVX" | "bounties" | "all";
```

Registered scripts:

- vlCVX distribution, reward flow, claims completeness, parquet delegators, and RPC delegators.
- bounty report verification through `verifyBountiesReport.ts`.

## Usage

```bash
# Consensus verification for the current week
pnpm tsx script/verify/aiVerify.ts

# Specific week/protocol
pnpm tsx script/verify/aiVerify.ts --timestamp 1771459200 --protocol vlCVX
pnpm tsx script/verify/aiVerify.ts --timestamp 1771459200 --protocol bounties

# Override models
pnpm tsx script/verify/aiVerify.ts --model claude-haiku-4-5
pnpm tsx script/verify/aiVerify.ts --models claude-haiku-4-5,gpt-5.4-mini,minimax-m2.5-free

# Model comparison without consensus reporting
pnpm tsx script/verify/compareModels.ts --timestamp 1771459200 --protocol vlCVX
```

Required for LLM triage:

```text
OPENCODE_ZEN_API_KEY
```

Optional Telegram variables:

```text
TEST_TELEGRAM_API_KEY
TEST_TELEGRAM_CHAT_ID
```

The underlying verification scripts can also be run directly and do not require an LLM key.

## Verdicts

| Verdict | Meaning |
|---|---|
| `pass` | Required scripts passed and no material issue was found |
| `warning` | Known non-critical issue or expected missing optional data |
| `fail` | Missing required files, invalid merkle/root data, undistributed funds, or failed critical consistency checks |

`aiVerify.ts` exits `1` if any selected protocol returns `fail`; otherwise it exits `0`.

## Adding a Verification Script

1. Create a script that prints useful human-readable output and exits non-zero on failure.
2. Add it to the `SCRIPTS` registry in `distributionVerify.ts`.
3. Include the applicable protocol list.
4. Add protocol-specific triage notes to `PROTOCOL_CONTEXT` only when generic verdict rules are insufficient.

Example registry entry:

```typescript
{
  label: "vlSDT Distribution Verification",
  path: "script/vlSDT/verify/distribution.ts",
  args: (ts) => ["--timestamp", String(ts)],
  protocols: ["vlSDT", "all"],
}
```

If a new protocol is added, also extend the `Protocol` union type and any workflow or Telegram formatting that should expose it.
