import { describe, expect, it, vi } from "vitest";
import { loadManifest } from "../src/corpus";
import { htmlToMarkdown } from "../src/ingest/convert";
import type { FetchedResponse, Fetcher } from "../src/ingest/optout";
import { formatReport, parseArgs, runIngest, type UploadItem, type Uploader } from "../scripts/ingest";

const manifest = loadManifest("config/corpus.yaml");
const POINTER_IDS = ["fido-alliance-specs", "mslearn-passkeys", "apple-passkeys", "yubico-docs", "1password-blog", "okta-blog"];
const pointerHosts = manifest.filter((e) => e.mode === "pointer").map((e) => new URL(e.url).host);

function res(status: number, body = "", headers: Record<string, string> = {}): FetchedResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

function bigPdf(bytes: number, headers: Record<string, string> = {}): FetchedResponse {
  const buf = new Uint8Array(bytes);
  return {
    status: 200,
    headers: { get: (n: string) => ({ "content-type": "application/pdf", ...headers })[n.toLowerCase()] ?? null },
    text: async () => {
      throw new Error("PDF body must not be read as text");
    },
    arrayBuffer: async () => buf.buffer as ArrayBuffer,
  };
}

interface FixtureOpts {
  robots?: (origin: string) => FetchedResponse | Error;
  page?: (url: string, method: string) => FetchedResponse | Error | undefined;
}

/** Offline fixture fetcher that records every URL requested. */
function fixtureFetcher(opts: FixtureOpts = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(url);
    const method = init?.method ?? "GET";
    let r: FetchedResponse | Error | undefined;
    if (url.endsWith("/robots.txt")) {
      r = opts.robots?.(new URL(url).origin) ?? res(200, "User-agent: *\nAllow: /\n");
    } else if (url.endsWith("/.well-known/tdmrep.json") || url.endsWith("/tdm.txt")) {
      r = res(404);
    } else {
      r = opts.page?.(url, method);
      r ??= url.endsWith(".pdf")
        ? res(200, "%PDF-1.7", { "content-type": "application/pdf" })
        : res(200, `<html><body><h1>Title for ${url}</h1><p>Body text.</p></body></html>`, { "content-type": "text/html; charset=utf-8" });
    }
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetcher, calls };
}

function spyUploader() {
  const upload = vi.fn(async (_items: UploadItem[]) => {});
  const uploader: Uploader = { upload };
  return { uploader, upload };
}

const NOW = () => new Date("2026-10-13T12:00:00Z");

describe("ingest: pointer entries", () => {
  it("produce zero upload items and are never fetched", async () => {
    const { fetcher, calls } = fixtureFetcher();
    const { uploader, upload } = spyUploader();
    const out = await runIngest({ manifest, fetcher, uploader, now: NOW }, { dryRun: false });

    const ids = out.items.map((i) => i.metadata.source_id);
    for (const p of POINTER_IDS) expect(ids).not.toContain(p);
    for (const item of upload.mock.calls.flatMap((c) => c[0])) {
      expect(POINTER_IDS).not.toContain(item.metadata.source_id);
    }
    // not one request (robots.txt, HEAD or GET) went to a pointer host
    for (const url of calls) expect(pointerHosts).not.toContain(new URL(url).host);

    for (const p of POINTER_IDS) {
      const row = out.report.find((r) => r.source_id === p)!;
      expect(row.status).toBe("skipped");
      expect(row.reason).toMatch(/pointer/i);
    }
  });

  it("stay un-ingested even if the pointer URL's robots would allow it", async () => {
    const only = manifest.filter((e) => e.mode === "pointer");
    const { fetcher, calls } = fixtureFetcher();
    const out = await runIngest({ manifest: only, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: false });
    expect(out.items).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("ingest: provenance", () => {
  it("every item carries source_url, licence, attribution, retrieval_date, source_id", async () => {
    const { fetcher } = fixtureFetcher();
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(out.items.length).toBeGreaterThan(0);
    for (const item of out.items) {
      const entry = manifest.find((e) => e.source_id === item.metadata.source_id)!;
      expect(entry.mode).toBe("full");
      expect(item.metadata).toEqual({
        source_id: entry.source_id,
        source_url: entry.url,
        licence: entry.licence,
        attribution: entry.attribution,
        retrieval_date: "2026-10-13",
      });
      expect(item.content.length).toBeGreaterThan(0);
      if (entry.url.endsWith(".pdf")) {
        expect(item.key).toBe(`${entry.source_id}.pdf`);
        expect(item.content_type).toBe("application/pdf");
        expect(item.content).toBeInstanceOf(Uint8Array);
      } else {
        expect(item.key).toBe(`${entry.source_id}.md`);
        expect(item.content_type).toBe("text/markdown");
        expect(typeof item.content).toBe("string");
      }
    }
  });
});

describe("ingest: opt-out gate integration", () => {
  it("skips and REPORTS a source that fails the gate (not silently dropped)", async () => {
    const blockedHost = "www.w3.org";
    const { fetcher, calls } = fixtureFetcher({
      robots: (origin) =>
        new URL(origin).host === blockedHost ? res(200, "User-agent: GPTBot\nDisallow: /\n") : res(200, "User-agent: *\nAllow: /\n"),
    });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    for (const id of ["w3c-webauthn-3", "w3c-webauthn-2"]) {
      const row = out.report.find((r) => r.source_id === id)!;
      expect(row.status).toBe("skipped");
      expect(row.reason).toMatch(/robots\.txt disallows.*GPTBot/);
      expect(out.items.map((i) => i.metadata.source_id)).not.toContain(id);
    }
    // the content of a blocked source was never requested (only robots.txt)
    expect(calls.filter((u) => u.includes("www.w3.org") && !u.endsWith("/robots.txt"))).toEqual([]);
  });

  it("FAILS CLOSED: every fetch failing yields zero items and every full entry skipped", async () => {
    const fetcher: Fetcher = async () => {
      throw new Error("network disabled");
    };
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(out.items).toEqual([]);
    expect(out.report.every((r) => r.status === "skipped")).toBe(true);
    expect(out.report.filter((r) => r.mode === "full").every((r) => /fail closed/i.test(r.reason!))).toBe(true);
  });

  it("skips when the content response carries a tdm-reservation header", async () => {
    const { fetcher } = fixtureFetcher({
      page: (url, method) =>
        url.includes("wikipedia.org") && method === "GET"
          ? res(200, "<p>x</p>", { "content-type": "text/html", "tdm-reservation": "1" })
          : undefined,
    });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    const row = out.report.find((r) => r.source_id === "wikipedia-webauthn")!;
    expect(row.status).toBe("skipped");
    expect(row.reason).toMatch(/tdm-reservation/);
  });
});

describe("ingest: conversion", () => {
  it("collects PDF bytes untouched (AI Search converts PDFs; we do no extraction)", async () => {
    const { fetcher } = fixtureFetcher();
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    for (const id of ["nist-sp800-63b-4", "cisa-phishing-resistant-mfa"]) {
      expect(out.report.find((r) => r.source_id === id)!.status).toBe("indexed");
      const item = out.items.find((i) => i.metadata.source_id === id)!;
      expect(item.content_type).toBe("application/pdf");
      expect(new TextDecoder().decode(item.content as Uint8Array)).toBe("%PDF-1.7");
    }
  });

  it("all 12 full sources are indexed and all 6 skipped are pointers when nothing is blocked", async () => {
    const { fetcher } = fixtureFetcher();
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(out.report.filter((r) => r.status === "indexed").length).toBe(12);
    expect(out.report.filter((r) => r.status === "skipped").map((r) => r.source_id).sort()).toEqual([...POINTER_IDS].sort());
  });

  it("still skips content types it cannot hand over (e.g. application/zip)", async () => {
    const { fetcher } = fixtureFetcher({ page: (u, m) => (u.includes("rfc-editor") && m === "GET" ? res(200, "PK", { "content-type": "application/zip" }) : undefined) });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(out.report.find((r) => r.source_id === "ietf-rfc8809")!.reason).toMatch(/unsupported content-type.*zip/);
  });

  it("nist-sp800-63b-4 end to end: robots.txt 404 (none published) + PDF => indexed", async () => {
    const { fetcher, calls } = fixtureFetcher({
      robots: (origin) => (new URL(origin).host === "nvlpubs.nist.gov" ? res(404) : res(200, "User-agent: *\nAllow: /\n")),
    });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true, only: ["nist-sp800-63b-4"] });
    const row = out.report.find((r) => r.source_id === "nist-sp800-63b-4")!;
    expect(row.status).toBe("indexed");
    expect(out.items).toHaveLength(1);
    expect(out.items[0].content_type).toBe("application/pdf");
    expect(calls).toContain("https://nvlpubs.nist.gov/robots.txt");
  });

  it("enforces AI Search's 4 MiB limit and fails closed above it, with a reason", async () => {
    const MiB = 1024 * 1024;
    for (const [bytes, headers] of [
      [4 * MiB + 1, {}],
      [10, { "content-length": String(5 * MiB) }], // declared size alone is enough
    ] as const) {
      const { fetcher } = fixtureFetcher({ page: (u, m) => (u.endsWith("NIST.SP.800-63b-4.pdf") && m === "GET" ? bigPdf(bytes, { ...headers }) : undefined) });
      const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true, only: ["nist-sp800-63b-4"] });
      const row = out.report.find((r) => r.source_id === "nist-sp800-63b-4")!;
      expect(row.status).toBe("skipped");
      expect(row.reason).toMatch(/exceeds.*4 MiB.*fail closed/i);
      expect(out.items).toEqual([]);
    }
  });

  it("accepts a PDF of exactly 4 MiB", async () => {
    const { fetcher } = fixtureFetcher({ page: (u, m) => (u.endsWith("NIST.SP.800-63b-4.pdf") && m === "GET" ? bigPdf(4 * 1024 * 1024) : undefined) });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true, only: ["nist-sp800-63b-4"] });
    expect(out.report.find((r) => r.source_id === "nist-sp800-63b-4")!.status).toBe("indexed");
  });

  it("a page whose HTML has a meta tdm-reservation: 1 is skipped (live path)", async () => {
    const { fetcher } = fixtureFetcher({
      page: (u, m) => (u.includes("wikipedia.org/wiki/WebAuthn") && m === "GET"
        ? res(200, '<html><head><meta name="tdm-reservation" content="1"></head><body>x</body></html>', { "content-type": "text/html" })
        : undefined),
    });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    const row = out.report.find((r) => r.source_id === "wikipedia-webauthn")!;
    expect(row.status).toBe("skipped");
    expect(row.reason).toMatch(/meta tag.*tdm-reservation/);
    expect(out.items.map((i) => i.metadata.source_id)).not.toContain("wikipedia-webauthn");
  });

  it("a page whose HTML has a meta content-signal with a no is skipped (live path)", async () => {
    const { fetcher } = fixtureFetcher({
      page: (u, m) => (u.includes("wikipedia.org/wiki/WebAuthn") && m === "GET"
        ? res(200, '<meta name="content-signal" content="ai-input=no, search=yes">', { "content-type": "text/html" })
        : undefined),
    });
    const out = await runIngest({ manifest, fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(out.report.find((r) => r.source_id === "wikipedia-webauthn")!.reason).toMatch(/meta tag.*ai-input=no/);
  });

  it("htmlToMarkdown keeps headings, links and list items; drops scripts", () => {
    const md = htmlToMarkdown(
      '<script>evil()</script><h2>Heading</h2><p>See <a href="https://x.test/a">link</a> &amp; more.</p><ul><li>one</li><li>two</li></ul>',
    );
    expect(md).toContain("## Heading");
    expect(md).toContain("[link](https://x.test/a) & more.");
    expect(md).toContain("- one");
    expect(md).toContain("- two");
    expect(md).not.toContain("evil");
  });
});

describe("ingest: dry-run, upload and idempotence", () => {
  it("--dry-run never calls the uploader", async () => {
    const { fetcher } = fixtureFetcher();
    const { uploader, upload } = spyUploader();
    const out = await runIngest({ manifest, fetcher, uploader, now: NOW }, { dryRun: true });
    expect(out.items.length).toBeGreaterThan(0);
    expect(upload).not.toHaveBeenCalled();
    expect(out.uploaded).toBe(false);
  });

  it("a live run uploads exactly the collected items, once", async () => {
    const { fetcher } = fixtureFetcher();
    const { uploader, upload } = spyUploader();
    const out = await runIngest({ manifest, fetcher, uploader, now: NOW }, { dryRun: false });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][0]).toEqual(out.items);
    expect(out.uploaded).toBe(true);
  });

  it("an upload failure is reported, not swallowed", async () => {
    const { fetcher } = fixtureFetcher();
    const uploader: Uploader = { upload: async () => { throw new Error("boom"); } };
    const out = await runIngest({ manifest, fetcher, uploader, now: NOW }, { dryRun: false });
    expect(out.uploaded).toBe(false);
    expect(out.uploadError).toMatch(/boom/);
    expect(out.report.filter((r) => r.status === "indexed")).toEqual([]);
    expect(out.report.some((r) => /upload failed/.test(r.reason ?? ""))).toBe(true);
  });

  it("re-running is idempotent (same keys, same content, same metadata)", async () => {
    const a = await runIngest({ manifest, fetcher: fixtureFetcher().fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    const b = await runIngest({ manifest, fetcher: fixtureFetcher().fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(b.items).toEqual(a.items);
    expect(new Set(a.items.map((i) => i.key)).size).toBe(a.items.length);
  });

  it("--only restricts to a subset: 2 sources indexed, all others reported as not selected", async () => {
    const { fetcher } = fixtureFetcher();
    const out = await runIngest(
      { manifest, fetcher, uploader: spyUploader().uploader, now: NOW },
      { dryRun: true, only: ["wikipedia-passkey", "ietf-rfc8809"] },
    );
    expect(out.report.filter((r) => r.status === "indexed").map((r) => r.source_id).sort()).toEqual(["ietf-rfc8809", "wikipedia-passkey"]);
    expect(out.items.length).toBe(2);
    expect(out.report.length).toBe(manifest.length);
    expect(out.report.find((r) => r.source_id === "owasp-mfa-cheatsheet")!.reason).toMatch(/not selected/);
  });

  it("rejects an unknown --only id", async () => {
    await expect(
      runIngest({ manifest, fetcher: fixtureFetcher().fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true, only: ["nope"] }),
    ).rejects.toThrow(/unknown source_id/);
  });

  it("report lists every manifest entry exactly once, as indexed or skipped-with-reason", async () => {
    const out = await runIngest({ manifest, fetcher: fixtureFetcher().fetcher, uploader: spyUploader().uploader, now: NOW }, { dryRun: true });
    expect(out.report.map((r) => r.source_id)).toEqual(manifest.map((e) => e.source_id));
    for (const r of out.report) {
      expect(["indexed", "skipped"]).toContain(r.status);
      if (r.status === "skipped") expect(r.reason).toBeTruthy();
    }
    const text = formatReport(out, true);
    for (const e of manifest) expect(text).toContain(e.source_id);
    expect(text).toMatch(/dry-run/i);
  });
});

describe("ingest: args", () => {
  it("parses flags", () => {
    expect(parseArgs(["--dry-run"])).toMatchObject({ dryRun: true, offline: false });
    expect(parseArgs(["--dry-run", "--offline", "--only", "a,b"])).toMatchObject({ dryRun: true, offline: true, only: ["a", "b"] });
    expect(parseArgs([])).toMatchObject({ dryRun: false });
  });
  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/unknown/i);
  });
  it("refuses --offline without --dry-run", () => {
    expect(() => parseArgs(["--offline"])).toThrow(/dry-run/);
  });
});
