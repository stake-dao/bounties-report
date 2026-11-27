import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export type Identity = {
  version: 1;
  kind: string;
  epoch: number;
  revision?: string;
  digest: string;
  claimsDigest?: string;
  roots: Record<string, string>;
};
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function capture(kind: string, epoch: number, read: (path: string) => Buffer = path => readFileSync(path)): Identity {
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || epoch % 604800 !== 0) throw new Error("Invalid epoch");
  const base = `bounties-reports/${epoch}`;
  const delegators = kind === "vlcvx-delegators";
  if (!delegators && !["sdtokens-check", "sdtokens-submit"].includes(kind)) throw new Error("Invalid identity kind");
  const bytes = read(`${base}/${delegators ? "vlCVX/merkle_data_delegators.json" : "sdtokens-distribution.json"}`) as Buffer;
  const data = JSON.parse(bytes.toString());
  const roots: Record<string, string> = {};
  let claimsDigest: string | undefined;
  if (delegators) {
    roots.delegators = data.merkleRoot.toLowerCase();
  } else {
    if (data.period !== epoch) throw new Error("Distribution epoch mismatch");
    if (kind === "sdtokens-submit" && (data.verified !== true || data.postFreeze !== true)) throw new Error("Distribution not verified post-freeze");
    for (const token of data.tokens) {
      const address = token.address.toLowerCase();
      if (roots[address]) throw new Error("Duplicate token");
      roots[address] = token.root.toLowerCase();
    }
    claimsDigest = sha256(read(`${base}/merkle.json`) as Buffer);
  }
  if (!Object.keys(roots).length || Object.values(roots).some(root => !/^0x[\da-f]{64}$/.test(root) || /^0x0+$/.test(root))) throw new Error("Invalid roots");
  return { version: 1, kind, epoch, digest: sha256(bytes), ...(claimsDigest ? { claimsDigest } : {}), roots };
}

export function exportIdentity(snapshot: Identity, revision: string, read: (path: string) => Buffer = path => readFileSync(path)): Identity {
  if (!/^[\da-f]{40}$/.test(revision)) throw new Error("Expected immutable git revision");
  const current = capture(snapshot.kind, snapshot.epoch, read);
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new Error("Distribution changed after verification");
  return { ...current, revision };
}

if (require.main === module) {
  const [command, snapshotPath] = process.argv.slice(2);
  if (!snapshotPath) throw new Error("Snapshot path required outside the repository");
  if (command === "snapshot") {
    const epoch = Number(process.env.EPOCH);
    if (epoch !== Math.floor(Date.now() / 1000 / 604800) * 604800) throw new Error("Epoch rollover; restart preparation");
    writeFileSync(snapshotPath, JSON.stringify(capture(process.env.IDENTITY_KIND!, epoch)));
  } else if (command === "export") {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    exportIdentity(snapshot, revision);
    // Read committed bytes, not a mutable working copy after a rebase/push.
    const identity = exportIdentity(snapshot, revision, path => execFileSync("git", ["show", `${revision}:${path}`], { maxBuffer: 64 * 1024 * 1024 }));
    writeFileSync(process.env.JOB_RESULT_PATH || "/tmp/job_result.json", JSON.stringify({ status: "executed", outputs: { identity: JSON.stringify(identity) } }));
  } else if (command === "verify") {
    const identity: Identity = JSON.parse(process.env.DISTRIBUTION_IDENTITY!);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (identity.revision !== revision || identity.kind !== "vlcvx-delegators" || identity.epoch !== Number(process.env.EPOCH)) throw new Error("Verification identity mismatch");
    const { revision: _, ...snapshot } = identity;
    exportIdentity(snapshot, revision);
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
  } else throw new Error("Unknown identity command");
}
