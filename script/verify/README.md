# AI Verification Pipeline

Automated end-to-end verification of weekly bounty distributions, with LLM-powered triage and Telegram reporting.

---

## How it works

```
┌──────────────────────────────────────────────────────┐
│  aiVerify.ts  (CLI entry point)                      │
│  compareModels.ts  (multi-model comparison)          │
└─────────────────────┬────────────────────────────────┘
                      │  calls
                      ▼
┌──────────────────────────────────────────────────────┐
│  distributionVerify.ts  (orchestrator)               │
│                                                      │
│  1. runScripts()  — spawns verification scripts      │
│       filters SCRIPTS[] by protocol                  │
│       collects stdout + exit code per script         │
│                                                      │
│  2. buildPrompt() — assembles LLM prompt             │
│       generic verdict rules                          │
│       + PROTOCOL_CONTEXT[protocol] if present        │
│                                                      │
│  3. analyze()     — calls LLMClient.analyzeJson()    │
│       parses { verdict, summary, issues }            │
│       falls back to exit-code heuristic on error     │
└─────────────────────┬────────────────────────────────┘
                      │  results flow to
                      ▼
┌──────────────────────────────────────────────────────┐
│  telegramReport.ts                                   │
│  formatVerificationReport() → sendVerificationReport()│
└──────────────────────────────────────────────────────┘
```

Scripts run **synchronously** (one at a time, blocking). The LLM call is the only async step.

---

## File map

| File | Role |
|------|------|
| `distributionVerify.ts` | Core orchestrator — `SCRIPTS` registry, `PROTOCOL_CONTEXT`, `runScripts`, `analyze`, `verify` |
| `aiVerify.ts` | CLI entry point — single model, sends Telegram report |
| `compareModels.ts` | Run scripts once, query N models in parallel, print comparison table |
| `telegramReport.ts` | Format + send HTML Telegram message |
| `../utils/llmClient.ts` | Provider-agnostic interface (`LLMClient`) |
| `../utils/openCodeZen.ts` | Concrete `LLMClient` backed by Opencode ZEN proxy (Anthropic + OpenAI wire formats) |

---

## Usage

```bash
# Single model, current week, all protocols
pnpm tsx script/verify/aiVerify.ts

# Specific week + protocol
pnpm tsx script/verify/aiVerify.ts --timestamp 1771459200 --protocol vlCVX

# Different model
pnpm tsx script/verify/aiVerify.ts --model kimi-k2.5-free

# Compare multiple models on the same script outputs
pnpm tsx script/verify/compareModels.ts --timestamp 1771459200 --protocol vlCVX
pnpm tsx script/verify/compareModels.ts --models claude-sonnet-4-6,kimi-k2.5-free,claude-haiku-4-5
```

**Required env var:** `OPENCODE_ZEN_API_KEY`
**Optional env vars:** `TEST_TELEGRAM_API_KEY`, `TEST_TELEGRAM_CHAT_ID` (Telegram notifications)

---

## Verdict semantics

| Verdict | Meaning |
|---------|---------|
| `pass` | All scripts exited 0, no issues |
| `warning` | Non-critical: optional file absent, week-over-week spike >20%, CSV diff where token IS in merkle (reporting gap, funds distributed correctly) |
| `fail` | Critical: missing required files, invalid merkle root, delegation address in merkle, BigInt mismatch, undistributed funds (CSV diff + token NOT in merkle) |

Exit code: `0` for pass/warning, `1` for fail.

---

## Extension points

### The `SCRIPTS` registry (`distributionVerify.ts`)

Every verification script is declared once here. Adding a script = adding one entry.

```typescript
interface VerifyScript {
  label: string;           // shown in Telegram + console
  path: string;            // relative to project root, run via `pnpm tsx`
  args: (ts: number) => string[];  // CLI args given the week timestamp
  protocols: Protocol[];   // which protocols this script applies to
  note?: string;           // optional warning shown in console
}
```

### The `PROTOCOL_CONTEXT` map (`distributionVerify.ts`)

Domain-specific triage rules injected at the end of the LLM prompt, keyed by protocol. Keeps protocol quirks out of the generic prompt template.

```typescript
const PROTOCOL_CONTEXT: Partial<Record<Protocol, string>> = {
  vlCVX: "...",
  vlAURA: "...",
  // new protocols go here
};
```

Leave the key absent if the protocol has no special triage rules — the generic verdict rules apply.

### The `Protocol` type (`distributionVerify.ts`)

```typescript
export type Protocol = "vlCVX" | "vlAURA" | "all";
```

---

## Adding a new protocol (e.g. vlSDT)

**1. Create the verification scripts**

```
script/vlSDT/verify/distribution.ts   # check repartition files, merkle roots
script/vlSDT/verify/rewardFlow.ts     # check CSV totals vs merkle totals
script/vlSDT/verify/delegators-rpc.ts # optional: check delegators on-chain
```

Each script must: print human-readable output to stdout, exit `0` on pass, exit non-zero on failure. The LLM reads the stdout.

**2. Extend the `Protocol` type**

```typescript
// distributionVerify.ts
export type Protocol = "vlCVX" | "vlAURA" | "vlSDT" | "all";
```

**3. Register scripts in `SCRIPTS`**

```typescript
// distributionVerify.ts — SCRIPTS array
{
  label: "vlSDT Distribution Verification",
  path: "script/vlSDT/verify/distribution.ts",
  args: (ts) => ["--timestamp", String(ts)],
  protocols: ["vlSDT", "all"],
},
{
  label: "vlSDT Reward Flow Verification",
  path: "script/vlSDT/verify/rewardFlow.ts",
  args: (ts) => ["--timestamp", String(ts)],
  protocols: ["vlSDT", "all"],
},
```

**4. Add triage context if needed**

```typescript
// distributionVerify.ts — PROTOCOL_CONTEXT
vlSDT: `Any vlSDT-specific triage rules the LLM should know about.`,
```

**5. That's it.** Zero changes to `aiVerify.ts`, `compareModels.ts`, or `telegramReport.ts`.

---

## Adding a new LLM provider

Implement the `LLMClient` interface from `script/utils/llmClient.ts`:

```typescript
export interface LLMClient {
  readonly model: string;
  readonly provider: string;
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<string>;
  ask(prompt: string, options?: LLMOptions): Promise<string>;
  analyzeJson<T>(prompt: string, fallback: T, options?: LLMOptions): Promise<LLMJsonResult<T>>;
}
```

`analyzeJson` must never throw — return `{ result: fallback, rawText, error }` on failure. The orchestrator displays the error as a warning and continues with the fallback verdict.

Pass your client to `verify(client, timestamp, protocol)` or `analyze(client, ...)` — no other changes needed.
