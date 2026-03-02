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

// ── Script label shortener ─────────────────────────────────────────────────────

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

  // Header — icon reflects severity
  lines.push(`${headerIcon} <b>[AI Verify] ${protocol} — ${date}</b>`);
  lines.push("");

  // Verdict + summary on adjacent lines
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

  // Compact scripts line
  lines.push("");
  lines.push(DIVIDER);
  const scriptParts = result.scripts.map((s) => {
    const icon = s.exitCode === 0 ? "✅" : "❌";
    return `${icon} ${escapeHtml(shortLabel(s.label))}`;
  });
  lines.push(scriptParts.join("  ·  "));

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
