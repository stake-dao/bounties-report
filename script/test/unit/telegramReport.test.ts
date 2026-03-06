/**
 * Unit tests for formatVerificationReport.
 *
 * Tests formatting logic in isolation — no LLM, no Telegram API calls.
 */
import { describe, it, expect } from "vitest";
import { formatVerificationReport } from "../../verify/telegramReport";
import type { VerificationResult } from "../../verify/distributionVerify";

const WEEK_TS = 1772668800; // 2026-03-05

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeScripts(labels: string[], exitCode = 0): VerificationResult["scripts"] {
  return labels.map((label) => ({ label, output: "ok", exitCode }));
}

const VLCVX_SCRIPTS = [
  "vlCVX Distribution Verification",
  "vlCVX Reward Flow Verification",
  "vlCVX parquet delegators",
  "vlCVX RPC delegators",
];

const VLAURA_SCRIPTS = [
  "vlAURA Distribution Verification",
  "vlAURA Reward Flow Verification",
  "vlAURA RPC delegators",
  "vlAURA delegation timing",
];

const BOUNTIES_SCRIPTS = ["Bounties Report Verification"];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("formatVerificationReport", () => {
  describe("header", () => {
    it("shows protocol name for single protocol", () => {
      const result: VerificationResult = {
        verdict: "pass",
        summary: "All good.",
        issues: [],
        scripts: makeScripts(VLCVX_SCRIPTS),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toContain("[AI Verify] vlCVX — 2026-03-05");
    });

    it("expands 'all' to actual group names from scripts", () => {
      const result: VerificationResult = {
        verdict: "pass",
        summary: "All good.",
        issues: [],
        scripts: makeScripts([...VLCVX_SCRIPTS, ...BOUNTIES_SCRIPTS, ...VLAURA_SCRIPTS]),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "all");
      expect(msg).toContain("vlCVX · Bounties · vlAURA");
    });
  });

  describe("verdict icons", () => {
    it("uses ✅ header icon for pass", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toMatch(/^✅/);
      expect(msg).toContain("✅ <b>PASS</b>");
    });

    it("uses 🚨 header icon for fail", () => {
      const result: VerificationResult = {
        verdict: "fail", summary: "Broken.", issues: ["Something failed"], scripts: makeScripts(VLCVX_SCRIPTS, 1),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toMatch(/^🚨/);
    });

    it("uses ⚠️ for warning", () => {
      const result: VerificationResult = {
        verdict: "warning", summary: "Minor issue.", issues: ["CSV mismatch"], scripts: makeScripts(VLCVX_SCRIPTS),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toMatch(/^⚠️/);
    });
  });

  describe("issues", () => {
    it("renders issues as bullet points with HTML escaping", () => {
      const result: VerificationResult = {
        verdict: "warning",
        summary: "Minor issue.",
        issues: ["CSV mismatch for 2 tokens", "Week-over-week >20%"],
        scripts: makeScripts(VLCVX_SCRIPTS),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toContain("• CSV mismatch for 2 tokens");
      expect(msg).toContain("• Week-over-week &gt;20%");
    });

    it("omits issues section when empty", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
      };
      expect(formatVerificationReport(result, WEEK_TS, "vlCVX")).not.toContain("•");
    });
  });

  describe("script grouping", () => {
    it("shows no group headers for single-protocol run", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).not.toMatch(/<b>vlCVX<\/b>/);
    });

    it("shows group headers with pass counts for multi-protocol run", () => {
      const result: VerificationResult = {
        verdict: "pass",
        summary: "All good.",
        issues: [],
        scripts: makeScripts([...VLCVX_SCRIPTS, ...VLAURA_SCRIPTS]),
      };
      const msg = formatVerificationReport(result, WEEK_TS, "all");
      expect(msg).toContain("<b>vlCVX</b>  4/4 ✅");
      expect(msg).toContain("<b>vlAURA</b>  4/4 ✅");
    });

    it("shows ❌ in group header when any script in that group fails", () => {
      const scripts = [
        ...makeScripts(VLCVX_SCRIPTS.slice(0, 3)),
        { label: VLCVX_SCRIPTS[3], output: "err", exitCode: 1 },
        ...makeScripts(VLAURA_SCRIPTS),
      ];
      const result: VerificationResult = {
        verdict: "fail", summary: "RPC check failed.", issues: ["RPC mismatch"], scripts,
      };
      const msg = formatVerificationReport(result, WEEK_TS, "all");
      expect(msg).toContain("<b>vlCVX</b>  3/4 ❌");
      expect(msg).toContain("<b>vlAURA</b>  4/4 ✅");
    });
  });

  describe("script notes", () => {
    it("renders note inline after label with em-dash", () => {
      const result: VerificationResult = {
        verdict: "pass",
        summary: "Fine.",
        issues: [],
        scripts: makeScripts(VLCVX_SCRIPTS),
        scriptNotes: {
          "vlCVX Distribution Verification": "812 claims, 28 tokens",
          "vlCVX RPC delegators": "358 active, 86 zero-VP",
        },
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toContain("Distribution — <i>812 claims, 28 tokens</i>");
      expect(msg).toContain("RPC delegators — <i>358 active, 86 zero-VP</i>");
    });

    it("renders script without note when key is absent", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
        scriptNotes: {},
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toContain("✅ Distribution\n");
    });

    it("gracefully handles absent scriptNotes", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
      };
      expect(() => formatVerificationReport(result, WEEK_TS, "vlCVX")).not.toThrow();
    });

    it("HTML-escapes note content", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
        scriptNotes: { "vlCVX Distribution Verification": "diff=0 & ok <good>" },
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg).toContain("diff=0 &amp; ok &lt;good&gt;");
    });
  });

  describe("truncation", () => {
    it("truncates and appends truncation marker when over 4000 chars", () => {
      const result: VerificationResult = {
        verdict: "pass", summary: "Fine.", issues: [], scripts: makeScripts(VLCVX_SCRIPTS),
        scriptNotes: { "vlCVX Distribution Verification": "x".repeat(4000) },
      };
      const msg = formatVerificationReport(result, WEEK_TS, "vlCVX");
      expect(msg.length).toBeLessThanOrEqual(4000);
      expect(msg).toContain("(truncated)");
    });
  });
});
