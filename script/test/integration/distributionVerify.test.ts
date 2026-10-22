import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWithConsensus } from "../../verify/distributionVerify";
import { createZenClient } from "../../utils/openCodeZen";

const TIMESTAMP = 1785369600;
const MODELS = ["claude-sonnet-5-5", "gpt-6.1-sol", "minimax-m3"];

describe("distribution verifier with subprocesses and OpenCode HTTP", () => {
  let server: Server;
  let directory: string;
  let proxy: string;
  let failures: Map<string, string>;
  let requests: string[];
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "verifier-e2e-"));
    writeFileSync(join(directory, "pnpm"), '#!/bin/sh\necho "fixture checks passed"\nexit "$VERIFIER_SCRIPT_EXIT"\n', { mode: 0o755 });
    server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { model } = JSON.parse(raw);
      requests.push(new URL(req.url!).pathname);
      const mode = failures.get(model);
      if (mode === "disconnect") {
        res.destroy();
        return;
      }
      if (mode && /^\d+$/.test(mode)) {
        res.writeHead(Number(mode)).end('{"error":"fixture API failure"}');
        return;
      }
      const text = mode === "malformed" ? "not JSON" : JSON.stringify({
        verdict: mode === "invalid" ? "unknown" : mode ?? "pass",
        summary: "fixture checks passed",
        issues: [],
      });
      const body = model.startsWith("claude-")
        ? { content: [{ type: "text", text }] }
        : model.startsWith("gpt-")
          ? { output: [{ content: [{ type: "output_text", text }] }] }
          : { choices: [{ message: { content: text } }] };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    proxy = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(() => {
    failures = new Map();
    requests = [];
    vi.stubEnv("PATH", `${directory}:${originalPath}`);
    vi.stubEnv("VERIFIER_SCRIPT_EXIT", "0");
    vi.stubEnv("https_proxy", proxy);
    vi.stubEnv("HTTPS_PROXY", proxy);
    vi.stubEnv("no_proxy", "");
    vi.stubEnv("NO_PROXY", "");
  });

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(["vlCVX", "bounties", "spectra", "frax"] as const)(
    "%s accepts three valid responses through all transports",
    async (protocol) => {
      const clients = MODELS.map((model) => createZenClient(model, "fixture-key"));
      const result = await verifyWithConsensus(clients, TIMESTAMP, protocol);
      expect(result.verdict).toBe("pass");
      expect(result.consensusMethod).toBe("unanimous");
      expect(result.modelVerdicts.every((m) => m.verdict === "pass")).toBe(true);
      expect(new Set(requests)).toEqual(new Set([
        "/zen/v1/messages", "/zen/v1/responses", "/zen/v1/chat/completions",
      ]));
    }
  );

  it.each<[string, string[]]>([
    ...MODELS.map((model) => ["401", [model]] as [string, string[]]),
    ["401", MODELS.slice(0, 2)],
    ["401", MODELS],
    ...["403", "429", "500", "malformed", "invalid", "disconnect"].map(
      (mode) => [mode, [MODELS[2]]] as [string, string[]]
    ),
  ])("%s from %j blocks verification despite passing scripts", async (mode, models) => {
    failures = new Map(models.map((model) => [model, mode]));
    const clients = MODELS.map((model) => createZenClient(model, "fixture-key"));
    const result = await verifyWithConsensus(clients, TIMESTAMP, "vlCVX");
    expect(result.scripts.every((script) => script.exitCode === 0)).toBe(true);
    expect(result.verdict).toBe("fail");
    expect(result.consensusMethod).toBe("insufficient-models");
    expect(result.summary).toContain(`${3 - models.length}/3 models responded`);
    expect(result.issues).toHaveLength(models.length);
    expect(result.modelVerdicts.filter((m) => m.verdict === null)).toHaveLength(models.length);
  });

  it.each(["warning", "fail"])("keeps existing consensus for three valid %s verdicts", async (verdict) => {
    failures = new Map(MODELS.map((model) => [model, verdict]));
    const clients = MODELS.map((model) => createZenClient(model, "fixture-key"));
    const result = await verifyWithConsensus(clients, TIMESTAMP, "frax");
    expect(result.verdict).toBe("warning");
    expect(result.consensusMethod).toBe("unanimous");
    expect(result.modelVerdicts.every((m) => m.verdict === verdict)).toBe(true);
  });

  it("keeps majority voting when all three models respond", async () => {
    failures.set(MODELS[2], "fail");
    const clients = MODELS.map((model) => createZenClient(model, "fixture-key"));
    const result = await verifyWithConsensus(clients, TIMESTAMP, "frax");
    expect(result.verdict).toBe("pass");
    expect(result.consensusMethod).toBe("majority");
    expect(result.modelVerdicts.filter((m) => m.verdict !== null)).toHaveLength(3);
  });

  it("rejects an empty model configuration", async () => {
    const result = await verifyWithConsensus([], TIMESTAMP, "frax");
    expect(result.verdict).toBe("fail");
    expect(result.consensusMethod).toBe("insufficient-models");
    expect(requests).toHaveLength(0);
  });

  it("keeps deterministic gate failures ahead of model requests", async () => {
    vi.stubEnv("VERIFIER_SCRIPT_EXIT", "1");
    const clients = MODELS.map((model) => createZenClient(model, "fixture-key"));
    const result = await verifyWithConsensus(clients, TIMESTAMP, "vlCVX");
    expect(result.verdict).toBe("fail");
    expect(result.consensusMethod).toBe("script-only");
    expect(requests).toHaveLength(0);
  });
});
