import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildIndex,
  cidToBytes32,
  collectFiles,
  contenthashForCid,
  pinFile,
  pinFolder,
  readBack,
  readPins,
  replicatePin,
  sha256,
} from "../../helpers/pinToIpfs";

// CIDv0 of the digest 0x11 * 32 (0x1220 prefix, base58btc).
const CID = "QmPVGjYFugq4XUyBfoTHG6c3qxfBS26jEdaFM1gdAVuMZ2";
const DIGEST = `0x${"11".repeat(32)}` as const;
const ok = (body: unknown) =>
  new Response(
    typeof body === "string" ? body : body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body),
    { status: 200 },
  );
const entry = { cid: CID, ipfsHash: DIGEST, sha256: "aa", size: 1 };

describe("collectFiles", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pin-to-ipfs-"));
    mkdirSync(path.join(root, "dir"));
    writeFileSync(path.join(root, "dir", "b.json"), "{}");
    writeFileSync(path.join(root, "top.json"), "1");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("normalises, sorts, dedupes and reports directories and missing paths", () => {
    expect(collectFiles(["./top.json", "dir/b.json", "dir//b.json", "dir", "missing.json"], root)).toEqual({
      files: ["dir/b.json", "top.json"],
      missing: ["dir", "missing.json"],
    });
  });
});

describe("CID encodings", () => {
  it("strips the 0x1220 prefix of a CIDv0", () => {
    expect(cidToBytes32(CID)).toBe(DIGEST);
  });

  it("wraps a CIDv0 into an EIP-1577 ipfs contenthash", () => {
    expect(contenthashForCid("QmbYM7TwnSDqmUQ8P6jegjwjiGnuzDr6jAP2ZwsPgczs28")).toBe(
      "0xe30101701220c42700a16396d964f902f40348a1243fb902c45b1947e8c82ea5f0ea54738941",
    );
  });

  it("rejects anything that is not a sha256 CIDv0", () => {
    expect(() => cidToBytes32("bafybeihp3fbrb6cgbrglcowsumy4p3kbv7ucaljazxgbha5msbgpxrte4y")).toThrow("not a");
    expect(() => cidToBytes32("Qm0")).toThrow("base58");
    expect(() => cidToBytes32(CID.slice(0, -1))).toThrow("CIDv0");
    expect(() => cidToBytes32(`1${CID}`)).toThrow("CIDv0");
  });
});

describe("pinFile", () => {
  it("uploads the file under its basename with metadata and asks for a v0 CID", async () => {
    let captured: Request | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = new Request(url, init);
      return ok({ IpfsHash: CID, isDuplicate: true });
    }) as typeof fetch;

    const pin = await pinFile(fetchImpl, "jwt", "bounties-reports/1/merkle.json", Buffer.from("{}"), {
      name: "sdtokens-1-merkle.json",
      keyvalues: { path: "bounties-reports/1/merkle.json" },
    });

    expect(pin).toEqual({ cid: CID, duplicate: true });
    expect(captured!.url).toBe("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect(captured!.method).toBe("POST");
    expect(captured!.headers.get("authorization")).toBe("Bearer jwt");
    const form = await captured!.formData();
    const file = form.get("file") as File;
    expect(file.name).toBe("merkle.json");
    expect(await file.text()).toBe("{}");
    expect(JSON.parse(form.get("pinataMetadata") as string)).toEqual({
      name: "sdtokens-1-merkle.json",
      keyvalues: { path: "bounties-reports/1/merkle.json" },
    });
    expect(JSON.parse(form.get("pinataOptions") as string)).toEqual({ cidVersion: 0 });
  });

  it("rejects a failed upload and a CID that is not v0", async () => {
    const metadata = { name: "n", keyvalues: {} };
    const failing = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    await expect(pinFile(failing, "jwt", "a.json", Buffer.from("a"), metadata)).rejects.toThrow(
      "Pinata pinFileToIPFS 401 for a.json: nope",
    );
    const v1 = (async () => ok({ IpfsHash: "bafybeihp3fbrb6cgbrglcowsumy4p3kbv7ucaljazxgbha5msbgpxrte4y" })) as typeof fetch;
    await expect(pinFile(v1, "jwt", "a.json", Buffer.from("a"), metadata)).rejects.toThrow("no CIDv0");
  });
});

describe("pinFolder", () => {
  it("uploads every entry under one wrapper folder", async () => {
    let captured: Request | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = new Request(url, init);
      return ok({ IpfsHash: CID, isDuplicate: false });
    }) as typeof fetch;
    const entries = new Map<string, Uint8Array>([
      ["index.json", Buffer.from("{}")],
      ["index.html", Buffer.from("<p>")],
    ]);

    await expect(pinFolder(fetchImpl, "jwt", "rewards-index", entries, { name: "n", keyvalues: {} })).resolves.toEqual({
      cid: CID,
      duplicate: false,
    });
    const form = await captured!.formData();
    expect(form.getAll("file").map((file) => (file as File).name)).toEqual([
      "rewards-index/index.json",
      "rewards-index/index.html",
    ]);
    expect(JSON.parse(form.get("pinataOptions") as string)).toEqual({ cidVersion: 0 });
  });
});

describe("evidence index", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "pin-index-"));
    for (const period of ["1788393600", "1787788800", "latest"]) mkdirSync(path.join(root, "bounties-reports", period, "ipfs"), { recursive: true });
    writeFileSync(path.join(root, "bounties-reports", "1787788800", "ipfs", "sdtokens.json"), JSON.stringify({ "a.json": entry }));
    writeFileSync(path.join(root, "bounties-reports", "1788393600", "ipfs", "vlcvx-voters.json"), JSON.stringify({ "v.json": entry }));
    writeFileSync(path.join(root, "bounties-reports", "1788393600", "ipfs", "notes.json"), "{}");
    writeFileSync(path.join(root, "bounties-reports", "latest", "ipfs", "sdtokens.json"), "{}");
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads every numeric period's pipeline maps and derives the newest period per pipeline", () => {
    const periods = readPins(root);
    expect(periods).toEqual({
      "1787788800": { sdtokens: { "a.json": entry } },
      "1788393600": { "vlcvx-voters": { "v.json": entry } },
    });
    expect(buildIndex(periods).latest).toEqual({
      sdtokens: { period: 1787788800, files: { "a.json": entry } },
      "vlcvx-voters": { period: 1788393600, files: { "v.json": entry } },
    });
  });
});

describe("replicatePin", () => {
  it("skips a CID the service already holds and queues a new one", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "POST") return new Response(JSON.stringify({ requestid: "r1", status: "queued" }), { status: 202 });
      return ok({ count: calls.length === 1 ? 1 : 0, results: [] });
    }) as typeof fetch;

    await expect(replicatePin(fetchImpl, "https://api.filebase.io/v1/ipfs", "t", CID, "n")).resolves.toBe("already-pinned");
    await expect(replicatePin(fetchImpl, "https://api.filebase.io/v1/ipfs", "t", CID, "n")).resolves.toBe("queued");
    expect(calls).toEqual([
      `GET https://api.filebase.io/v1/ipfs/pins?cid=${CID}&status=queued,pinning,pinned`,
      `GET https://api.filebase.io/v1/ipfs/pins?cid=${CID}&status=queued,pinning,pinned`,
      "POST https://api.filebase.io/v1/ipfs/pins",
    ]);
  });
});

describe("readBack", () => {
  const bytes = Buffer.from("pinned");
  const digest = sha256(bytes);
  const gateway = "https://gateway.example";

  it("retries until the gateway serves the pinned bytes", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (urls.length === 1) throw new Error("ECONNRESET");
      if (urls.length === 2) return new Response("", { status: 504 });
      return ok(bytes);
    }) as typeof fetch;

    await expect(readBack(fetchImpl, gateway, `${CID}/index.json`, digest, 3, 0)).resolves.toBeUndefined();
    expect(urls).toEqual(Array(3).fill(`${gateway}/ipfs/${CID}/index.json`));
  });

  it("fails immediately on other bytes and after exhausted attempts", async () => {
    const other = (async () => ok(Buffer.from("tampered"))) as typeof fetch;
    await expect(readBack(other, gateway, CID, digest, 3, 0)).rejects.toThrow("serves other bytes");
    const down = (async () => new Response("", { status: 404 })) as typeof fetch;
    await expect(readBack(down, gateway, CID, digest, 2, 0)).rejects.toThrow("unavailable after 2 attempts (HTTP 404)");
  });
});
