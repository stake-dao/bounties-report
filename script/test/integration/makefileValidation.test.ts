/**
 * Makefile and Workflow Validation Tests
 *
 * These tests verify that:
 * 1. The consolidated distribution.mk exists with correct targets
 * 2. Old Makefiles are deleted
 * 3. Consolidated workflows exist with correct structure
 * 4. Old workflows are deleted
 * 5. All workflow make references are valid
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(".");

describe("Consolidated Makefile: automation/distribution.mk", () => {
  const makefilePath = path.join(ROOT, "automation/distribution.mk");

  it("should exist", () => {
    expect(fs.existsSync(makefilePath)).toBe(true);
  });

  it("should support PROTOCOL parameter", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    expect(content).toContain("PROTOCOL");
  });

  it("should contain all required common targets", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    const targets = [
      "run-claims",
      "run-report",
      "run-repartition",
      "run-merkle",
      "run-merkles",
      "run-all",
      "clean",
      "setup",
      "install-deps",
    ];
    for (const target of targets) {
      const pattern = new RegExp(`^${target}[:\\s]`, "m");
      expect(
        pattern.test(content),
        `Missing target: ${target}`
      ).toBe(true);
    }
  });

  it("should contain vlCVX-specific targets", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    const targets = ["validate-reports", "verify-claims"];
    for (const target of targets) {
      const pattern = new RegExp(`^${target}[:\\s]`, "m");
      expect(
        pattern.test(content),
        `Missing vlCVX target: ${target}`
      ).toBe(true);
    }
  });

  it("should reference vlAURA scripts that exist on disk", () => {
    const vlAuraScripts = [
      "script/vlAURA/claims/generateVotemarketV2.ts",
      "script/vlAURA/1_report.ts",
      "script/vlAURA/2_repartition/index.ts",
      "script/vlAURA/3_merkles/createMerkle.ts",
    ];
    for (const scriptPath of vlAuraScripts) {
      expect(
        fs.existsSync(path.join(ROOT, scriptPath)),
        `Referenced vlAURA script not found: ${scriptPath}`
      ).toBe(true);
    }
  });

  it("should reference vlCVX scripts that exist on disk", () => {
    const vlCvxScripts = [
      "script/vlCVX/claims/generateConvexVotemarketV2.ts",
      "script/vlCVX/1_report.ts",
      "script/vlCVX/2_repartition/index.ts",
      "script/vlCVX/3_merkles/createCombinedMerkle.ts",
      "script/vlCVX/3_merkles/createDelegatorsMerkle.ts",
      "script/vlCVX/verify/claimsCompleteness.ts",
    ];
    for (const scriptPath of vlCvxScripts) {
      expect(
        fs.existsSync(path.join(ROOT, scriptPath)),
        `Referenced vlCVX script not found: ${scriptPath}`
      ).toBe(true);
    }
  });

  it("should contain vlAURA script paths in Makefile content", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    expect(content).toContain("script/vlAURA/claims/generateVotemarketV2.ts");
    expect(content).toContain("script/vlAURA/1_report.ts");
    expect(content).toContain("script/vlAURA/2_repartition/index.ts");
    expect(content).toContain("script/vlAURA/3_merkles/createMerkle.ts");
  });

  it("should contain vlCVX script paths in Makefile content", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    expect(content).toContain("script/vlCVX/claims/generateConvexVotemarketV2.ts");
    expect(content).toContain("script/vlCVX/1_report.ts");
    expect(content).toContain("script/vlCVX/2_repartition/index.ts");
    expect(content).toContain("script/vlCVX/3_merkles/createCombinedMerkle.ts");
    expect(content).toContain("script/vlCVX/3_merkles/createDelegatorsMerkle.ts");
  });

  it("should handle TYPE=delegators for vlCVX merkle", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    expect(content).toContain("TYPE");
    expect(content).toContain("delegators");
  });
});

describe("Old Makefiles should not exist", () => {
  const oldMakefiles = [
    "automation/vlAURA/repartition.mk",
    "automation/vlCVX/repartition.mk",
    "automation/vlCVX/merkles.mk",
  ];

  for (const makefile of oldMakefiles) {
    it(`${makefile} should be deleted`, () => {
      expect(fs.existsSync(path.join(ROOT, makefile))).toBe(false);
    });
  }
});

describe("Consolidated GitHub Actions workflows", () => {
  const workflowDir = path.join(ROOT, ".github/workflows");

  const consolidatedWorkflows = [
    "vlaura-distribution.yaml",
    "vlcvx-voters-distribution.yaml",
    "vlcvx-delegators-distribution.yaml",
    "vlaura-compute-apr.yaml",
    "vlcvx-compute-apr.yaml",
  ];

  for (const workflow of consolidatedWorkflows) {
    it(`${workflow} should exist`, () => {
      expect(fs.existsSync(path.join(workflowDir, workflow))).toBe(true);
    });
  }

  it("all consolidated workflows should be valid YAML (basic syntax check)", () => {
    for (const workflow of consolidatedWorkflows) {
      const fullPath = path.join(workflowDir, workflow);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, "utf-8");
      expect(content).toContain("name:");
      expect(content).toContain("on:");
      expect(content).toContain("jobs:");
    }
  });

  it("vlaura-distribution.yaml should have step selector with all options", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "vlaura-distribution.yaml"),
      "utf-8"
    );
    expect(content).toContain("step:");
    expect(content).toContain("- all");
    expect(content).toContain("- claims-report");
    expect(content).toContain("- repartition");
    expect(content).toContain("- merkle");
    expect(content).toContain("- publish");
  });

  it("vlcvx-voters-distribution.yaml should have step selector with all options", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "vlcvx-voters-distribution.yaml"),
      "utf-8"
    );
    expect(content).toContain("step:");
    expect(content).toContain("- all");
    expect(content).toContain("- claims-report");
    expect(content).toContain("- repartition");
    expect(content).toContain("- merkle");
    expect(content).toContain("- publish");
  });

  it("vlcvx-delegators-distribution.yaml should have step selector with merkle and publish", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "vlcvx-delegators-distribution.yaml"),
      "utf-8"
    );
    expect(content).toContain("step:");
    expect(content).toContain("- all");
    expect(content).toContain("- merkle");
    expect(content).toContain("- publish");
  });

  it("consolidated workflows should reference automation/distribution.mk", () => {
    const workflowsWithMake = [
      "vlaura-distribution.yaml",
      "vlcvx-voters-distribution.yaml",
      "vlcvx-delegators-distribution.yaml",
    ];
    for (const workflow of workflowsWithMake) {
      const content = fs.readFileSync(
        path.join(workflowDir, workflow),
        "utf-8"
      );
      expect(
        content.includes("automation/distribution.mk"),
        `${workflow} should reference automation/distribution.mk`
      ).toBe(true);
      expect(
        content.includes("automation/vlAURA/"),
        `${workflow} should not reference old automation/vlAURA/ path`
      ).toBe(false);
      expect(
        content.includes("automation/vlCVX/"),
        `${workflow} should not reference old automation/vlCVX/ path`
      ).toBe(false);
    }
  });

  it("consolidated workflows should reference valid make targets", () => {
    const makefilePath = path.join(ROOT, "automation/distribution.mk");
    if (!fs.existsSync(makefilePath)) return;
    const makefileContent = fs.readFileSync(makefilePath, "utf-8");

    const workflowsWithMake = [
      "vlaura-distribution.yaml",
      "vlcvx-voters-distribution.yaml",
      "vlcvx-delegators-distribution.yaml",
    ];

    for (const workflow of workflowsWithMake) {
      const fullPath = path.join(workflowDir, workflow);
      if (!fs.existsSync(fullPath)) continue;

      const content = fs.readFileSync(fullPath, "utf-8");

      const makePattern = /make\s+-f\s+automation\/distribution\.mk\s+(\S+)/g;
      let match;
      while ((match = makePattern.exec(content)) !== null) {
        const target = match[1];
        if (target.startsWith("PROTOCOL=") || target.startsWith("TYPE=")) continue;
        const targetPattern = new RegExp(`^${target}[:\\s]`, "m");
        expect(
          targetPattern.test(makefileContent),
          `Workflow ${workflow} references non-existent target "${target}" in distribution.mk`
        ).toBe(true);
      }
    }
  });
});

describe("Old workflows should not exist", () => {
  const workflowDir = path.join(ROOT, ".github/workflows");

  const oldWorkflows = [
    "vlaura-claims-report.yaml",
    "vlaura-repartition.yaml",
    "vlaura-create-merkle.yaml",
    "vlaura-publish.yaml",
    "vlcvx-claims-report.yaml",
    "vlcvx-repartition.yaml",
    "vlcvx-create-voters-merkle.yaml",
    "vlcvx-create-delegators-merkle.yaml",
    "vlcvx-publish-voters.yaml",
    "vlcvx-publish-delegators.yaml",
  ];

  for (const workflow of oldWorkflows) {
    it(`${workflow} should be deleted`, () => {
      expect(fs.existsSync(path.join(workflowDir, workflow))).toBe(false);
    });
  }
});
