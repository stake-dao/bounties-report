// Pins one pipeline's verification artifacts to IPFS (Pinata), one pin per file,
// so a verifier can read them while raw.githubusercontent.com is down and the URD
// `ipfsHash` slot can later carry each tree's CID. CIDv0 keeps bytes32 <-> CID a
// bijection: ipfsHash = the sha256 digest = the CID minus its 0x1220 prefix.
// Lookup without GitHub: Pinata keyvalues {repo, pipeline, period, path, sha256};
// the same map is committed to bounties-reports/<period>/ipfs/<pipeline>.json,
// one file per pipeline so concurrent pipelines never edit the same file.
//
// `--index` (one writer: .github/workflows/ipfs-index.yaml, on push of those
// maps) pins the browsable index folder (index.json + index.html over every
// map) and writes its CID and EIP-1577 contenthash to data/ipfs-index.json;
// then dispatches automation-jobs' ens_publish to point rewards.stakedao.eth at it.
// With PINNING_SERVICE_URL/TOKEN set, every CID is also replicated on a second
// provider through the IPFS Pinning Service API.
//
// Invariant on main: every pin-map entry equals the committed bytes of its path. A map is written
// from the working tree at pin time, so a stale checkout or a later rewrite of a pinned file breaks
// the link silently (2026-09-10: the 1788393600 sdtokens map carried pre-freeze bytes). `--check`
// reports such entries, `--heal` re-pins them from the checkout and rewrites the maps; the index
// workflow runs both on every push that touches a map or a pinned file, and `--pipeline` refuses a
// checkout that is behind origin/main.
//
// Usage: pnpm tsx script/helpers/pinToIpfs.ts --pipeline <name> --period <timestamp> <file...>
//        pnpm tsx script/helpers/pinToIpfs.ts --check | --heal | --index
// Env: PINATA_JWT (required; the step is skipped when unset), PINATA_GATEWAY (read-back, optional),
//      PINNING_SERVICE_URL + PINNING_SERVICE_TOKEN (second pinner, optional),
//      PIN_ALLOW_STALE=1 (pin from a checkout behind origin/main anyway).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";
import { utils } from "ethers";

dotenv.config();

export const PIPELINES = ["sdtokens", "vlcvx-voters", "vlcvx-delegators", "sdfxs", "spectra"] as const;
export type Pipeline = (typeof PIPELINES)[number];
export const INDEX_POINTER = "data/ipfs-index.json";
const PINATA_API = "https://api.pinata.cloud";
const DEFAULT_GATEWAY = "https://gateway.pinata.cloud";

export interface PinnedFile {
  cid: string;
  ipfsHash: `0x${string}`;
  sha256: string;
  size: number;
}

/** Repo-relative path -> pin; one file per pipeline and period. */
export type PinMap = Record<string, PinnedFile>;
export type PeriodPins = Partial<Record<Pipeline, PinMap>>;

export interface EvidenceIndex {
  periods: Record<string, PeriodPins>;
  latest: Partial<Record<Pipeline, { period: number; files: PinMap }>>;
}

type Fetch = typeof fetch;

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Normalises repo-relative paths; anything that is not an existing file is reported as missing. */
export function collectFiles(paths: string[], root = process.cwd()): { files: string[]; missing: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  for (const raw of paths) {
    const rel = path.posix.normalize(raw);
    const abs = path.join(root, rel);
    if (existsSync(abs) && statSync(abs).isFile()) files.add(rel);
    else missing.push(rel);
  }
  return { files: [...files].sort(), missing };
}

/** The bytes32 a URD `ipfsHash` slot carries for a CIDv0: its sha256 digest. */
export function cidToBytes32(cid: string): `0x${string}` {
  let bytes: Uint8Array;
  try {
    bytes = utils.base58.decode(cid);
  } catch {
    throw new Error(`not a base58 CID: ${cid}`);
  }
  if (bytes.length !== 34 || bytes[0] !== 0x12 || bytes[1] !== 0x20) throw new Error(`not a sha256 CIDv0: ${cid}`);
  return `0x${Buffer.from(bytes.subarray(2)).toString("hex")}`;
}

/** EIP-1577 contenthash for a CIDv0: ipfs-ns, cid v1, dag-pb, then the sha256 multihash. */
export function contenthashForCid(cid: string): `0x${string}` {
  return `0xe30101701220${cidToBytes32(cid).slice(2)}`;
}

async function pinataPin(
  fetchImpl: Fetch,
  jwt: string,
  form: FormData,
  label: string,
): Promise<{ cid: string; duplicate: boolean }> {
  const response = await fetchImpl(`${PINATA_API}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Pinata pinFileToIPFS ${response.status} for ${label}: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { IpfsHash?: unknown; isDuplicate?: unknown };
  if (typeof body.IpfsHash !== "string" || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(body.IpfsHash)) {
    throw new Error(`Pinata returned no CIDv0 for ${label}`);
  }
  return { cid: body.IpfsHash, duplicate: body.isDuplicate === true };
}

export async function pinFile(
  fetchImpl: Fetch,
  jwt: string,
  file: string,
  bytes: Uint8Array,
  metadata: { name: string; keyvalues: Record<string, string> },
): Promise<{ cid: string; duplicate: boolean }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), path.posix.basename(file));
  form.append("pinataMetadata", JSON.stringify(metadata));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));
  return pinataPin(fetchImpl, jwt, form, file);
}

/** Pins every entry under one folder; the CID addresses the folder, entries keep their names. */
export async function pinFolder(
  fetchImpl: Fetch,
  jwt: string,
  folder: string,
  entries: Map<string, Uint8Array>,
  metadata: { name: string; keyvalues: Record<string, string> },
): Promise<{ cid: string; duplicate: boolean }> {
  const form = new FormData();
  for (const [file, bytes] of entries) form.append("file", new Blob([new Uint8Array(bytes)]), `${folder}/${file}`);
  form.append("pinataMetadata", JSON.stringify(metadata));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));
  return pinataPin(fetchImpl, jwt, form, folder);
}

/** Every committed pin map, keyed by period then pipeline. */
export function readPins(root = process.cwd()): Record<string, PeriodPins> {
  const periods: Record<string, PeriodPins> = {};
  for (const period of readdirSync(path.join(root, "bounties-reports"))) {
    const dir = path.join(root, "bounties-reports", period, "ipfs");
    if (!/^\d+$/.test(period) || !existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pipeline = name.replace(/\.json$/, "") as Pipeline;
      if (PIPELINES.includes(pipeline)) (periods[period] ??= {})[pipeline] = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    }
  }
  return periods;
}

/** Every period's pins plus, per pipeline, the newest period: one fetch tells a reader where the current trees are. */
export function buildIndex(periods: Record<string, PeriodPins>): EvidenceIndex {
  const latest: EvidenceIndex["latest"] = {};
  for (const period of Object.keys(periods).sort((a, b) => Number(a) - Number(b))) {
    for (const [pipeline, files] of Object.entries(periods[period])) {
      latest[pipeline as Pipeline] = { period: Number(period), files: files as PinMap };
    }
  }
  return { periods, latest };
}

export interface StaleEntry {
  period: string;
  pipeline: Pipeline;
  file: string;
  reason: "sha256" | "missing";
  actual?: { sha256: string; size: number };
}

/** Map entries whose recorded sha256 is not the sha256 of the file in the checkout, or whose file is gone. */
export function staleEntries(periods: Record<string, PeriodPins>, root = process.cwd()): StaleEntry[] {
  const stale: StaleEntry[] = [];
  for (const [period, pipelines] of Object.entries(periods)) {
    for (const [pipeline, map] of Object.entries(pipelines) as [Pipeline, PinMap][]) {
      for (const [file, entry] of Object.entries(map)) {
        const abs = path.join(root, file);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          stale.push({ period, pipeline, file, reason: "missing" });
          continue;
        }
        const bytes = readFileSync(abs);
        const digest = sha256(bytes);
        if (digest !== entry.sha256) stale.push({ period, pipeline, file, reason: "sha256", actual: { sha256: digest, size: bytes.length } });
      }
    }
  }
  return stale;
}

/** Commits on origin/main that this checkout lacks; null when git cannot tell (no remote ref). */
export function commitsBehindOriginMain(root = process.cwd()): number | null {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", "HEAD..origin/main"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim());
  } catch {
    return null;
  }
}

/** Human entry point on rewards.stakedao.eth: renders index.json as gateway links. */
export function indexHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Stake DAO reward distributions</title>
<style>body{font:14px/1.5 system-ui;margin:2rem;max-width:60rem}code{font-size:12px}</style>
<h1>Stake DAO reward distributions</h1>
<p>Evidence behind every Merkle root, pinned to IPFS by <a href="https://github.com/stake-dao/bounties-report">bounties-report</a>.
Verify a file with its sha256, and a tree by recomputing its root against the distributor.</p>
<div id="out">Loading index.json…</div>
<script>
fetch("index.json").then(r => r.json()).then(index => {
  const gw = "https://gateway.pinata.cloud/ipfs/";
  const out = document.getElementById("out");
  out.textContent = "";
  const el = (tag, text, parent) => { const n = document.createElement(tag); n.textContent = text; parent.appendChild(n); return n; };
  for (const period of Object.keys(index.periods).sort((a, b) => b - a)) {
    el("h2", "Period " + period + " (" + new Date(period * 1000).toISOString().slice(0, 10) + ")", out);
    for (const [pipeline, files] of Object.entries(index.periods[period])) {
      el("h3", pipeline, out);
      const list = el("ul", "", out);
      for (const [file, entry] of Object.entries(files)) {
        const item = el("li", "", list);
        el("a", file, item).href = gw + entry.cid;
        el("code", " " + entry.cid + " · sha256 " + entry.sha256, item);
      }
    }
  }
});
</script>
`;
}

/** Second provider through the IPFS Pinning Service API: pin by CID unless it already is. */
export async function replicatePin(
  fetchImpl: Fetch,
  serviceUrl: string,
  token: string,
  cid: string,
  name: string,
): Promise<"already-pinned" | "queued"> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const listed = await fetchImpl(`${serviceUrl}/pins?cid=${cid}&status=queued,pinning,pinned`, { headers });
  if (!listed.ok) throw new Error(`pinning service GET /pins ${listed.status} for ${cid}`);
  if (Number(((await listed.json()) as { count?: unknown }).count ?? 0) > 0) return "already-pinned";
  const added = await fetchImpl(`${serviceUrl}/pins`, { method: "POST", headers, body: JSON.stringify({ cid, name }) });
  if (!added.ok) throw new Error(`pinning service POST /pins ${added.status} for ${cid}: ${(await added.text()).slice(0, 300)}`);
  return "queued";
}

/** Proves a pin is retrievable: the gateway must serve bytes with the recorded sha256. */
export async function readBack(
  fetchImpl: Fetch,
  gateway: string,
  ipfsPath: string,
  digest: string,
  attempts = 6,
  delayMs = 5000,
): Promise<void> {
  const url = `${gateway}/ipfs/${ipfsPath}`;
  let last = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!response.ok) {
      last = `HTTP ${response.status}`;
      continue;
    }
    if (sha256(new Uint8Array(await response.arrayBuffer())) === digest) return;
    throw new Error(`${url} serves other bytes than pinned`);
  }
  throw new Error(`${url} unavailable after ${attempts} attempts (${last})`);
}

interface Env {
  jwt: string;
  gateway: string;
  service?: { url: string; token: string };
}

async function replicateAll(env: Env, pins: Iterable<[string, string]>): Promise<void> {
  if (!env.service) {
    console.log("::warning::PINNING_SERVICE_URL/TOKEN not set; CIDs live on Pinata only");
    return;
  }
  for (const [name, cid] of pins) {
    console.log(`second pinner ${cid}: ${await replicatePin(fetch, env.service.url, env.service.token, cid, name)}`);
  }
}

async function pinPipeline(env: Env, pipeline: Pipeline, period: number, paths: string[]): Promise<void> {
  const { files, missing } = collectFiles(paths);
  for (const file of missing) console.log(`::warning::pinToIpfs: ${file} is not a file, skipped`);
  if (files.length === 0) throw new Error("nothing to pin");

  const pinned: PinMap = {};
  for (const file of files) {
    const bytes = readFileSync(file);
    const digest = sha256(bytes);
    // Pinata truncates a name at its first "/", hence the basename.
    const pin = await pinFile(fetch, env.jwt, file, bytes, {
      name: `${pipeline}-${period}-${path.posix.basename(file)}`,
      keyvalues: { repo: "bounties-report", pipeline, period: String(period), path: file, sha256: digest },
    });
    pinned[file] = { cid: pin.cid, ipfsHash: cidToBytes32(pin.cid), sha256: digest, size: bytes.length };
    console.log(`${file} -> ${pin.cid}${pin.duplicate ? " (already pinned)" : ""}`);
  }
  for (const file of Object.values(pinned)) await readBack(fetch, env.gateway, file.cid, file.sha256);

  const map = path.join("bounties-reports", String(period), "ipfs", `${pipeline}.json`);
  mkdirSync(path.dirname(map), { recursive: true });
  writeFileSync(map, JSON.stringify(pinned, null, 2) + "\n");
  console.log(`::notice::${pipeline} ${period}: ${files.length} files pinned and read back, map in ${map}`);
  await replicateAll(env, Object.entries(pinned).map(([file, pin]) => [`${pipeline}-${period}-${path.posix.basename(file)}`, pin.cid]));
}

function mapPath(period: string, pipeline: Pipeline): string {
  return path.join("bounties-reports", period, "ipfs", `${pipeline}.json`);
}

/** Exit 1 when a map entry no longer matches the checkout; needs no credentials. */
function checkPins(): StaleEntry[] {
  const stale = staleEntries(readPins());
  for (const s of stale) {
    console.log(
      s.reason === "missing"
        ? `::error::${s.pipeline} ${s.period}: ${s.file} is pinned but no longer in the tree`
        : `::error::${s.pipeline} ${s.period}: ${s.file} committed sha256 ${s.actual!.sha256} != pinned`,
    );
  }
  if (stale.length === 0) console.log("::notice::every pin map matches the committed tree");
  return stale;
}

/** Re-pin every stale entry from the checkout and rewrite its map; a missing file keeps its (still pinned) entry. */
async function healPins(env: Env): Promise<void> {
  const periods = readPins();
  const stale = staleEntries(periods);
  const touched = new Set<string>();
  for (const s of stale) {
    if (s.reason === "missing") {
      console.log(`::warning::${s.pipeline} ${s.period}: ${s.file} is pinned but no longer in the tree; entry kept`);
      continue;
    }
    const bytes = readFileSync(s.file);
    const digest = sha256(bytes);
    const name = `${s.pipeline}-${s.period}-${path.posix.basename(s.file)}`;
    const pin = await pinFile(fetch, env.jwt, s.file, bytes, {
      name,
      keyvalues: { repo: "bounties-report", pipeline: s.pipeline, period: s.period, path: s.file, sha256: digest },
    });
    await readBack(fetch, env.gateway, pin.cid, digest);
    const previous = periods[s.period][s.pipeline]![s.file];
    periods[s.period][s.pipeline]![s.file] = { cid: pin.cid, ipfsHash: cidToBytes32(pin.cid), sha256: digest, size: bytes.length };
    touched.add(`${s.period}/${s.pipeline}`);
    console.log(`::warning::${s.pipeline} ${s.period}: ${s.file} re-pinned ${previous.cid} -> ${pin.cid} (committed bytes differed from the pin)`);
    await replicateAll(env, [[name, pin.cid]]);
  }
  for (const key of touched) {
    const [period, pipeline] = key.split("/") as [string, Pipeline];
    writeFileSync(mapPath(period, pipeline), JSON.stringify(periods[period][pipeline], null, 2) + "\n");
  }
  console.log(`::notice::heal: ${stale.length} stale entries, ${touched.size} maps rewritten`);
}

async function pinIndex(env: Env): Promise<void> {
  const indexJson = Buffer.from(JSON.stringify(buildIndex(readPins()), null, 2) + "\n");
  const folder = await pinFolder(
    fetch,
    env.jwt,
    "rewards-index",
    new Map([["index.json", indexJson], ["index.html", Buffer.from(indexHtml())]]),
    { name: "bounties-report-index", keyvalues: { repo: "bounties-report", pipeline: "index" } },
  );
  await readBack(fetch, env.gateway, `${folder.cid}/index.json`, sha256(indexJson));
  const pointer = { cid: folder.cid, ipfsHash: cidToBytes32(folder.cid), contenthash: contenthashForCid(folder.cid) };
  writeFileSync(INDEX_POINTER, JSON.stringify(pointer, null, 2) + "\n");
  console.log(`::notice::evidence index ${folder.cid} read back, contenthash ${pointer.contenthash}, pointer in ${INDEX_POINTER}`);
  await replicateAll(env, [["bounties-report-index", folder.cid]]);
}

type Args = { mode: "index" | "check" | "heal" } | { mode: "pipeline"; pipeline: Pipeline; period: number; paths: string[] };

function parseArgs(argv: string[]): Args {
  if (argv.length === 1 && ["--index", "--check", "--heal"].includes(argv[0])) return { mode: argv[0].slice(2) as "index" | "check" | "heal" };
  const paths: string[] = [];
  let pipeline: string | undefined;
  let period = NaN;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pipeline") pipeline = argv[++i];
    else if (argv[i] === "--period") period = Number(argv[++i]);
    else paths.push(argv[i]);
  }
  if (!PIPELINES.includes(pipeline as Pipeline) || !Number.isInteger(period) || period <= 0 || paths.length === 0) {
    throw new Error(`Usage: pinToIpfs --pipeline <${PIPELINES.join("|")}> --period <timestamp> <file...> | pinToIpfs --check | --heal | --index`);
  }
  return { mode: "pipeline", pipeline: pipeline as Pipeline, period, paths };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "check") {
    process.exitCode = checkPins().length ? 1 : 0;
    return;
  }
  if (args.mode === "pipeline") {
    const behind = commitsBehindOriginMain();
    if (behind === null) console.log("::warning::origin/main unknown; cannot tell whether this checkout is stale");
    else if (behind > 0 && process.env.PIN_ALLOW_STALE !== "1") {
      throw new Error(`checkout is ${behind} commit(s) behind origin/main: pull first (PIN_ALLOW_STALE=1 to override)`);
    }
  }
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    console.log("::warning::PINATA_JWT is not set; IPFS pin skipped");
    return;
  }
  const serviceUrl = process.env.PINNING_SERVICE_URL?.replace(/\/$/, "");
  const serviceToken = process.env.PINNING_SERVICE_TOKEN;
  const env: Env = {
    jwt,
    gateway: (process.env.PINATA_GATEWAY || DEFAULT_GATEWAY).replace(/\/$/, ""),
    service: serviceUrl && serviceToken ? { url: serviceUrl, token: serviceToken } : undefined,
  };
  if (args.mode === "index") await pinIndex(env);
  else if (args.mode === "heal") await healPins(env);
  else if (args.mode === "pipeline") await pinPipeline(env, args.pipeline, args.period, args.paths);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
