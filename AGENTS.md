# Agents Collaboration Guide

This repository defines how Codex (terminal coding agent) and Claude Code (CLI) collaborate on tasks. The goal is a simple, reliable workflow that both agents follow every time.

## Scope

These instructions apply to the entire repository. When there is a conflict:
- Direct instructions from Jesse override this document.
- Codex CLI developer/system instructions override this document for Codex.
- Claude must also follow `CLAUDE.md`.

## Roles

- Codex: makes precise file edits, runs local commands, maintains plans, and validates changes.
- Claude: assists with ideation, code generation, reviews, and explanations via the `claude` CLI.
- Jesse: final decision-maker. Ask questions when choices matter or rules would be broken.

## Source of Truth

- Claude must follow `CLAUDE.md`.
- Codex should reference `CLAUDE.md` for naming/commenting expectations that affect code it writes.

## Default Workflow

1) Understand the task
- Read the prompt, skim repo, and note constraints.
- For ambiguous requirements, ask Jesse before proceeding.

2) Create a plan
- Codex uses the plan tool to outline short, verifiable steps.
- Keep plans minimal and update status as work progresses.

3) TDD-first changes
- Prefer writing or updating tests before code when feasible.
- Make the smallest change to pass tests; keep scope tight (YAGNI).

4) Validate
- Run targeted checks for the changed area; then broader tests if available.
- Address failures before moving on.

5) Review and handoff
- Summarize changes (what/where/why) and note follow-ups.
- Ask Jesse to confirm when multiple valid options exist.

## Collaboration Patterns

- Use Claude for:
  - Brainstorming designs and naming.
  - Proposing simple implementations or refactors.
  - Drafting tests or migration checklists.
- Use Codex for:
  - Surgical file edits via patches.
  - Repository-aware changes respecting local constraints.
  - Running local validations and keeping plans in sync.

## Claude CLI Usage

- Interactive session: `claude`
- One-off prompt: `claude -p "<prompt>" --output-format text`
- Choose model: `--model sonnet` (or `opus`, or full model name)
- Resume last session: `claude --continue`
- Health/update: `claude doctor`, `claude update`
- Restrict tools (optional): `--allowedTools Edit Write` or `--disallowedTools Bash(git*)`

Guidelines:
- Keep prompts concrete and scoped to the current step.
- Save longer explorations to a gist/doc if they influence code.
- When Claude suggests multiple approaches, pause and confirm with Jesse if the choice matters.

## Codex CLI Behavior

- Use `apply_patch` for edits and keep changes minimal.
- Use `update_plan` for multi-step work; keep exactly one step in progress.
- Prefer `rg` for search; read files in small chunks.
- Avoid unrelated refactors; call them out instead.

## Coding Standards

- Simplicity over cleverness; prefer readable maintainable code.
- Match surrounding style; minimize churn.
- Names describe domain purpose, not implementation details.
- Comments explain what/why (not history). Preserve accurate comments.
- ABOUTME header: for any new code files, start with two lines:
  - `ABOUTME: <one-line file purpose>`
  - `ABOUTME: <one-line key behavior or scope>`
  Do not add headers retroactively to existing files unless Jesse requests it.

## Tests and Validation

- Favor small, focused tests near the changed code.
- Keep test output clean; assert on expected warnings/errors where relevant.
- Never delete failing tests; raise concerns to Jesse if a test is invalid.

## Version Control

- In this environment, Codex does not commit unless Jesse asks to.
- Outside this harness, commit early/often and use branches for WIP.
- Never bypass pre-commit hooks in normal development.

## Asking Jesse

- Stop and ask when:
  - Multiple valid approaches exist and the choice impacts design.
  - An action would delete or significantly restructure code.
  - A rule in `CLAUDE.md` or this file would be broken.
  - Requirements are unclear or conflict.

## Quick Runbook

1) Start Claude for ideation: `claude -p "Summarize X; propose 2 simple approaches" --model sonnet`
2) Draft minimal plan (Codex): outline steps with `update_plan`.
3) Write failing test (if feasible), then minimal change to pass.
4) Validate locally; iterate until green.
5) Summarize changes and any open decisions for Jesse.

