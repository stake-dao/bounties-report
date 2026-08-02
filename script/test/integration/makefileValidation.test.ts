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
      "run-repartition",
      "run-merkle",
      "run-merkles",
      "run-all",
      "validate-reports",
      "verify-claims",
      "commit-and-push",
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

  it("should contain vlCVX script paths in Makefile content", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    expect(content).toContain("script/vlCVX/2_repartition/index.ts");
    expect(content).toContain("script/vlCVX/3_merkles/createCombinedMerkle.ts");
    expect(content).toContain("script/vlCVX/3_merkles/createDelegatorsMerkle.ts");
    expect(content).toContain("script/vlCVX/verify/claimsCompleteness.ts");
  });

  it("should handle TYPE=delegators for vlCVX merkle", () => {
    const content = fs.readFileSync(makefilePath, "utf-8");
    expect(content).toContain("TYPE");
    expect(content).toContain("delegators");
  });
});

describe("Old Makefiles should not exist", () => {
  const oldMakefiles = [
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
    "vlcvx-distribution.yaml",
    "compute-apr.yaml",
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

  it("vlcvx-distribution.yaml should have type and step selectors", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "vlcvx-distribution.yaml"),
      "utf-8"
    );
    expect(content).toContain("type:");
    expect(content).toContain("- voters");
    expect(content).toContain("- delegators");
    expect(content).toContain("step:");
    expect(content).toContain("- repartition");
    expect(content).toContain("- merkle");
    expect(content).toContain("- publish");
  });

  it("scopes voters merkle verification to voters invariants", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "vlcvx-distribution.yaml"),
      "utf-8"
    );
    const votersVerifyStep = content.match(
      /- name: AI verify distribution \(voters\)([\s\S]*?)(?=\n {6}- name:|\n {4}[A-Za-z]|\s*$)/
    )?.[0];

    expect(votersVerifyStep).toContain(
      "if: inputs.type == 'voters' && inputs.step == 'merkle'"
    );
    expect(votersVerifyStep).toContain(
      "--protocol vlCVX --target voters"
    );
  });

  it("resumes voters verification from a complete existing merkle", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "vlcvx-distribution.yaml"),
      "utf-8"
    );
    const findStep = (name: string) => {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return content.match(
        new RegExp(
          ` {6}- name: ${escapedName}[\\s\\S]*?(?=\\n {6}- name:|$)`
        )
      )?.[0];
    };

    const stateStep = findStep("Check voters merkle state");
    const createStep = findStep("Create merkle (voters)");
    const commitStep = findStep("Commit merkle voters");
    const verifyStep = findStep("AI verify distribution (voters)");

    expect(stateStep).toContain("id: voters_merkle_state");
    expect(stateStep).toContain(
      "curve/merkle_data_non_delegators.json"
    );
    expect(stateStep).toContain(
      "fxn/merkle_data_non_delegators.json"
    );
    expect(stateStep).toContain("vlcvx_merkle.json");
    expect(stateStep).toContain(
      'if [ "$EXISTING" -eq "${#MERKLE_FILES[@]}" ]'
    );
    expect(stateStep).toContain("skip=true");
    expect(stateStep).toContain(
      "FORCE_UPDATE: ${{ inputs.force_merkle && 'true' || 'false' }}"
    );
    expect(createStep).toContain(
      "steps.voters_merkle_state.outputs.skip != 'true'"
    );
    expect(commitStep).toContain(
      "steps.voters_merkle_state.outputs.skip != 'true'"
    );
    expect(verifyStep).not.toContain(
      "steps.voters_merkle_state.outputs.skip"
    );
  });

  it("keeps the post-delegators AI gate on the both-target default", () => {
    const content = fs.readFileSync(
      path.join(workflowDir, "ai-verify-vlcvx.yaml"),
      "utf-8"
    );

    expect(content).toContain("--protocol vlCVX --deep");
    expect(content).not.toContain("--target");
  });

  it("consolidated workflows should reference automation/distribution.mk", () => {
    const workflowsWithMake = [
      "vlcvx-distribution.yaml",
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
      "vlcvx-distribution.yaml",
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
