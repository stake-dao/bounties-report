/**
 * Format and send an AI verification report to Telegram.
 *
 * Uses TEST_TELEGRAM_API_KEY / TEST_TELEGRAM_CHAT_ID from .env.
 * Falls back to a console warning if the keys are missing.
 */

import * as dotenv from "dotenv";
import { sendTelegramMessageWithCreds } from "../utils/telegramUtils";
import type { VerificationResult, ConsensusResult, Protocol, VerifyMetadata, SnapshotProposal } from "./distributionVerify";

dotenv.config();

const SNAPSHOT_BASE_URL = "https://snapshot.box/#/s:";

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const HEADER_ICON: Record<string, string> = {
  pass: "✅",
  warning: "⚠️",
  fail: "🚨",
};

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━";

// ── Script label / grouping helpers ───────────────────────────────────────────

/**
 * Strip the protocol prefix and "Verification" suffix from script labels.
 * "vlCVX Distribution Verification" → "Distribution"
 */
function shortLabel(label: string): string {
  return label
    .replace(/^vl\w+\s+/i, "")
    .replace(/\s*Verification$/i, "")
    .trim();
}

/** Infer protocol group from script label prefix. */
function inferGroup(label: string): string {
  if (/^vlCVX/i.test(label)) return "vlCVX";
  if (/bounties/i.test(label)) return "Bounties";
  return "Other";
}

/** Group scripts preserving insertion order. */
function groupScripts(scripts: VerificationResult["scripts"]): Map<string, VerificationResult["scripts"]> {
  const groups = new Map<string, VerificationResult["scripts"]>();
  for (const s of scripts) {
    const g = inferGroup(s.label);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  return groups;
}

/** Human-readable protocol name for the message header. */
function protocolDisplayName(protocol: Protocol, scripts: VerificationResult["scripts"]): string {
  if (protocol !== "all") return protocol;
  return [...groupScripts(scripts).keys()].join(" · ");
}

function snapshotLinks(metadata?: VerifyMetadata): string[] {
  if (!metadata?.snapshotProposals || metadata.snapshotProposals.length === 0) return [];
  return metadata.snapshotProposals.map((p) => {
    const shortId = p.proposalId.slice(0, 10) + "…";
    const url = `${SNAPSHOT_BASE_URL}${p.space}/proposal/${p.proposalId}`;
    return `🗳 <a href="${url}">${escapeHtml(p.label)} (${shortId})</a>`;
  });
}

// ── Formatter ─────────────────────────────────────────────────────────────────

export function formatVerificationReport(
  result: VerificationResult,
  timestamp: number,
  protocol: Protocol
): string {
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const headerIcon = HEADER_ICON[result.verdict] ?? "❓";
  const verdict = result.verdict.toUpperCase();
  const verdictIcon = result.verdict === "pass" ? "✅" : result.verdict === "warning" ? "⚠️" : "❌";

  const lines: string[] = [];

  // Header
  const displayName = protocolDisplayName(protocol, result.scripts);
  lines.push(`${headerIcon} <b>[AI Verify] ${escapeHtml(displayName)} — ${date}</b>`);
  lines.push("");

  // Verdict + summary
  lines.push(`${verdictIcon} <b>${verdict}</b>`);
  lines.push(`<i>${escapeHtml(result.summary)}</i>`);

  // Issues — only when present
  if (result.issues.length > 0) {
    lines.push("");
    lines.push(DIVIDER);
    for (const issue of result.issues) {
      lines.push(`• ${escapeHtml(issue)}`);
    }
  }

  // Scripts — grouped when multiple protocols, flat when single
  lines.push("");
  lines.push(DIVIDER);

  const groups = groupScripts(result.scripts);
  const multiGroup = groups.size > 1;

  for (const [group, scripts] of groups) {
    if (multiGroup) {
      const passCount = scripts.filter((s) => s.exitCode === 0).length;
      const groupIcon = passCount === scripts.length ? "✅" : "❌";
      lines.push(`\n<b>${escapeHtml(group)}</b>  ${passCount}/${scripts.length} ${groupIcon}`);
    }
    for (const s of scripts) {
      const icon = s.exitCode === 0 ? "✅" : "❌";
      const label = escapeHtml(shortLabel(s.label));
      const note = result.scriptNotes?.[s.label];
      lines.push(note ? `${icon} ${label} — <i>${escapeHtml(note)}</i>` : `${icon} ${label}`);
    }
  }

  const message = lines.join("\n");

  // Telegram cap: 4096 chars
  if (message.length > 4000) {
    return message.slice(0, 3950) + "\n\n<i>… (truncated)</i>";
  }

  return message;
}

// ── Consensus formatter ───────────────────────────────────────────────────────

const MODEL_VERDICT_ICON: Record<string, string> = { pass: "✅", warning: "⚠️", fail: "❌" };

export function formatConsensusReport(
  result: ConsensusResult,
  timestamp: number,
  protocol: Protocol,
  metadata?: VerifyMetadata
): string {
  const date = new Date(timestamp * 1000).toISOString().split("T")[0];
  const headerIcon = HEADER_ICON[result.verdict] ?? "❓";
  const verdictIcon = result.verdict === "pass" ? "✅" : result.verdict === "warning" ? "⚠️" : "❌";

  const lines: string[] = [];

  const displayName = protocolDisplayName(protocol, result.scripts);
  const weekTag = result.weekContext && result.weekContext !== "unknown" ? `, Week ${result.weekContext}` : "";
  lines.push(`${headerIcon} <b>[AI Verify] ${escapeHtml(displayName)} — ${date}</b>`);
  lines.push(`<code>${timestamp}</code>${weekTag}`);
  lines.push("");

  lines.push(`${verdictIcon} <b>${result.verdict.toUpperCase()}</b>`);
  lines.push(`<i>${escapeHtml(result.summary)}</i>`);

  if (result.issues.length > 0) {
    lines.push("");
    lines.push(DIVIDER);
    for (const issue of result.issues) {
      lines.push(`• ${escapeHtml(issue)}`);
    }
  }

  lines.push("");
  lines.push(DIVIDER);

  const responded = result.modelVerdicts.filter((m) => m.verdict !== null);
  const failed = result.modelVerdicts.filter((m) => m.verdict === null);

  if (result.consensusMethod === "script-only") {
    const failedNames = failed.map((m) => escapeHtml(m.model)).join(", ");
    lines.push(`🤖 No model response — verdict from scripts only`);
    lines.push(`<i>Failed: ${failedNames}</i>`);
  } else {
    const modelLine = result.modelVerdicts.map((m) => {
      if (m.verdict === null) return `${escapeHtml(m.model)}: 💀`;
      const conf = m.confidence != null ? ` (${(m.confidence * 100).toFixed(0)}%)` : "";
      return `${escapeHtml(m.model)}: ${MODEL_VERDICT_ICON[m.verdict] ?? "❓"}${conf}`;
    }).join("  ");
    lines.push(`🤖 ${modelLine}`);
    lines.push(`<i>Consensus: ${result.consensusMethod} (${responded.length}/${result.modelVerdicts.length})</i>`);

    const dissenters = responded.filter((m) => m.verdict !== result.verdict);
    if (dissenters.length > 0) {
      for (const d of dissenters) {
        const icon = MODEL_VERDICT_ICON[d.verdict!] ?? "❓";
        const conf = d.confidence != null ? ` ${(d.confidence * 100).toFixed(0)}%` : "";
        lines.push(`${icon} <i>${escapeHtml(d.model)}${conf}</i>`);
        if (d.summary) lines.push(`  <i>"${escapeHtml(d.summary)}"</i>`);
        if (d.issues && d.issues.length > 0) {
          for (const issue of d.issues.slice(0, 3)) {
            lines.push(`  • <i>${escapeHtml(issue)}</i>`);
          }
          if (d.issues.length > 3) lines.push(`  <i>… +${d.issues.length - 3} more</i>`);
        }
      }
    }
  }

  if (result.chainStatus && Object.keys(result.chainStatus).length > 0) {
    const chainLine = Object.entries(result.chainStatus)
      .map(([chain, v]) => `${chain}: ${MODEL_VERDICT_ICON[v] ?? "❓"}`)
      .join("  ");
    lines.push(`⛓ ${chainLine}`);
  }

  lines.push("");
  lines.push(DIVIDER);

  const groups = groupScripts(result.scripts);
  const multiGroup = groups.size > 1;

  for (const [group, scripts] of groups) {
    if (multiGroup) {
      const passCount = scripts.filter((s) => s.exitCode === 0).length;
      const groupIcon = passCount === scripts.length ? "✅" : "❌";
      lines.push(`\n<b>${escapeHtml(group)}</b>  ${passCount}/${scripts.length} ${groupIcon}`);
    }
    for (const s of scripts) {
      const icon = s.exitCode === 0 ? "✅" : "❌";
      const label = escapeHtml(shortLabel(s.label));
      const note = result.scriptNotes?.[s.label];
      lines.push(note ? `${icon} ${label} — <i>${escapeHtml(note)}</i>` : `${icon} ${label}`);
    }
  }

  const snapLinks = snapshotLinks(metadata);
  if (snapLinks.length > 0 || metadata?.commitSha) {
    lines.push("");
    lines.push(DIVIDER);
    for (const link of snapLinks) lines.push(link);
    if (metadata?.commitSha) lines.push(`📎 <code>${escapeHtml(metadata.commitSha)}</code>`);
  }

  const message = lines.join("\n");
  if (message.length > 4000) {
    return message.slice(0, 3950) + "\n\n<i>… (truncated)</i>";
  }
  return message;
}

// ── Senders ───────────────────────────────────────────────────────────────────

export async function sendVerificationReport(
  result: VerificationResult,
  timestamp: number,
  protocol: Protocol
): Promise<void> {
  const apiKey = process.env.TEST_TELEGRAM_API_KEY;
  const chatId = process.env.TEST_TELEGRAM_CHAT_ID;

  if (!apiKey || !chatId) {
    console.warn("  ⚠️  TEST_TELEGRAM_API_KEY or TEST_TELEGRAM_CHAT_ID not set — skipping Telegram notification");
    return;
  }

  const message = formatVerificationReport(result, timestamp, protocol);

  try {
    await sendTelegramMessageWithCreds(message, apiKey, chatId, "HTML");
    console.log("  → Telegram report sent");
  } catch (err) {
    console.warn(`  ⚠️  Telegram send failed: ${err}`);
  }
}

export async function sendConsensusReport(
  result: ConsensusResult,
  timestamp: number,
  protocol: Protocol,
  metadata?: VerifyMetadata
): Promise<void> {
  const apiKey = process.env.TEST_TELEGRAM_API_KEY;
  const chatId = process.env.TEST_TELEGRAM_CHAT_ID;

  if (!apiKey || !chatId) {
    console.warn("  ⚠️  TEST_TELEGRAM_API_KEY or TEST_TELEGRAM_CHAT_ID not set — skipping Telegram notification");
    return;
  }

  const message = formatConsensusReport(result, timestamp, protocol, metadata);

  try {
    await sendTelegramMessageWithCreds(message, apiKey, chatId, "HTML");
    console.log("  → Telegram report sent");
  } catch (err) {
    console.warn(`  ⚠️  Telegram send failed: ${err}`);
  }
}
