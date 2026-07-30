import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildScriptCommands,
  sanitizeGateDiagnostic,
} from "../../verify/verificationScripts";

const TIMESTAMP = 1785369600;

describe("distribution verification orchestration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["voters", "delegators", "both"] as const)(
    "forwards the %s target only to the vlCVX invariant gate",
    (target) => {
      const commands = buildScriptCommands(TIMESTAMP, "vlCVX", target);
      const [invariant, ...otherCommands] = commands;

      expect(invariant).toMatchObject({
        path: "script/verify/invariantsVerify.ts",
        args: [
          "--timestamp",
          String(TIMESTAMP),
          "--target",
          target,
        ],
        gate: true,
      });
      for (const command of otherCommands) {
        expect(command.args).not.toContain("--target");
      }
    }
  );

  it("defaults the vlCVX invariant target to both", () => {
    const [invariant] = buildScriptCommands(TIMESTAMP, "vlCVX");

    expect(invariant.args).toContain("both");
  });

  it("redacts raw and URL-encoded secrets from failed-gate diagnostics", () => {
    const secret = "route mesh/secret value";
    vi.stubEnv("ROUTEMESH_API_KEY", secret);

    const sanitized = sanitizeGateDiagnostic(
      `raw=${secret} encoded=${encodeURIComponent(secret)}`
    );

    expect(sanitized).toContain("raw=[REDACTED]");
    expect(sanitized).toContain("encoded=[REDACTED]");
    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toContain(encodeURIComponent(secret));
  });
});
