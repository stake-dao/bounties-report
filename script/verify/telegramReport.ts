/**
 * Format and send an AI verification report to Telegram.
 *
 * Uses TEST_TELEGRAM_API_KEY / TEST_TELEGRAM_CHAT_ID from .env.
 * Falls back to a console warning if the keys are missing.
 */

import * as dotenv from "dotenv";
import { sendTelegramMessageWithCreds } from "../utils/telegramUtils";
import type { VerificationResult, Protocol } from "./distributionVerify";

dotenv.config();

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
 * "vlAURA Reward Flow Verification" → "Reward Flow"
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
  if (/^vlAURA/i.test(label)) return "vlAURA";
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
  // Build from the groups actually present in this run
  return [...groupScripts(scripts).keys()].join(" · ");
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

// ── Sender ────────────────────────────────────────────────────────────────────

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
