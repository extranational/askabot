import { describe, expect, it } from "vitest";
import {
  checkOptOut,
  evaluateResponseSignals,
  evaluateRobots,
  type Fetcher,
  type FetchedResponse,
} from "../src/ingest/optout";

const URL_ = "https://example.test/docs/page";

function res(status: number, body = "", headers: Record<string, string> = {}): FetchedResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

interface Tdm {
  json?: FetchedResponse | Error;
  txt?: FetchedResponse | Error;
}

/**
 * Fixture fetcher: robots.txt and the TDM files only; no network.
 *
 * The page itself must NEVER be requested by the gate. That is the regression: a HEAD here
 * false-blocked hosts that do not implement HEAD. The `page` parameter is kept for
 * call-site compatibility and must go unused.
 */
function fx(robots: FetchedResponse | Error, _page: FetchedResponse | Error = res(200), tdm: Tdm = {}): Fetcher {
  return async (url, init) => {
    let r: FetchedResponse | Error;
    if (url.endsWith("/robots.txt")) r = robots;
    else if (url.endsWith("/.well-known/tdmrep.json")) r = tdm.json ?? res(404);
    else if (url.endsWith("/tdm.txt")) r = tdm.txt ?? res(404);
    else throw new Error(`the opt-out gate must not request the page: ${url} (${init?.method})`);
    if (r instanceof Error) throw r;
    return r;
  };
}

describe("evaluateRobots", () => {
  it("blocks Disallow: / for User-agent: *", () => {
    expect(evaluateRobots("User-agent: *\nDisallow: /\n", "/docs/page").allowed).toBe(false);
  });

  it.each(["GPTBot", "CCBot", "ClaudeBot", "Google-Extended"])("blocks named AI agent %s", (agent) => {
    const r = evaluateRobots(`User-agent: ${agent}\nDisallow: /\n\nUser-agent: *\nAllow: /\n`, "/docs/page");
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toContain(agent);
  });

  it("matches agent names case-insensitively and across stacked User-agent lines", () => {
    const r = evaluateRobots("User-agent: foo\nuser-agent: gptbot\nDisallow: /\n", "/x");
    expect(r.allowed).toBe(false);
  });

  it("blocks Content-Signal: ai-train=no, search=no", () => {
    const r = evaluateRobots("User-agent: *\nAllow: /\nContent-Signal: ai-train=no, search=no\n", "/docs/page");
    expect(r.allowed).toBe(false);
  });

  it("blocks when any content signal is no, even if others are yes", () => {
    expect(evaluateRobots("Content-Signal: search=yes, ai-input=no, ai-train=yes\n", "/").allowed).toBe(false);
  });

  it("blocks a malformed Content-Signal (ambiguous => closed)", () => {
    expect(evaluateRobots("Content-Signal: ai-train=maybe\n", "/").allowed).toBe(false);
    expect(evaluateRobots("Content-Signal: garbage\n", "/").allowed).toBe(false);
  });

  it("allows when all content signals are yes", () => {
    expect(evaluateRobots("User-agent: *\nAllow: /\nContent-Signal: ai-train=yes, search=yes, ai-input=yes\n", "/").allowed).toBe(true);
  });

  it("allows when there are no signals", () => {
    expect(evaluateRobots("User-agent: *\nDisallow: /private/\n", "/docs/page").allowed).toBe(true);
    expect(evaluateRobots("", "/docs/page").allowed).toBe(true);
    expect(evaluateRobots("User-agent: *\nDisallow:\n", "/docs/page").allowed).toBe(true);
  });

  it("applies path rules: longest match wins, Allow wins ties, wildcards and $ work", () => {
    const body = "User-agent: *\nDisallow: /docs/\nAllow: /docs/page\n";
    expect(evaluateRobots(body, "/docs/page").allowed).toBe(true);
    expect(evaluateRobots(body, "/docs/other").allowed).toBe(false);
    expect(evaluateRobots("User-agent: *\nDisallow: /*.pdf$\n", "/a/b.pdf").allowed).toBe(false);
    expect(evaluateRobots("User-agent: *\nDisallow: /*.pdf$\n", "/a/b.pdf?x=1").allowed).toBe(true);
  });

  it("ignores comments", () => {
    expect(evaluateRobots("# Disallow: /\nUser-agent: * # all\nDisallow: /nothing # none\n", "/x").allowed).toBe(true);
  });
});

describe("evaluateResponseSignals", () => {
  it("blocks tdm-reservation: 1 header", () => {
    expect(evaluateResponseSignals({ get: (n) => (n === "tdm-reservation" ? "1" : null) }).allowed).toBe(false);
  });
  it("allows tdm-reservation: 0", () => {
    expect(evaluateResponseSignals({ get: (n) => (n === "tdm-reservation" ? "0" : null) }).allowed).toBe(true);
  });
  it("blocks an unparseable tdm-reservation value", () => {
    expect(evaluateResponseSignals({ get: (n) => (n === "tdm-reservation" ? "yes?" : null) }).allowed).toBe(false);
  });
  it("blocks any tdm-policy header (cannot evaluate policy => closed)", () => {
    expect(evaluateResponseSignals({ get: (n) => (n === "tdm-policy" ? "https://x.test/p.json" : null) }).allowed).toBe(false);
  });
  it("blocks a Content-Signal header with a no", () => {
    expect(evaluateResponseSignals({ get: (n) => (n === "content-signal" ? "ai-train=no" : null) }).allowed).toBe(false);
  });
  it("blocks tdm-reservation / tdm-policy / content-signal meta tags in the body", () => {
    const none = { get: () => null };
    expect(evaluateResponseSignals(none, '<meta name="tdm-reservation" content="1">').allowed).toBe(false);
    expect(evaluateResponseSignals(none, "<meta content='1' name='tdm-reservation'>").allowed).toBe(false);
    expect(evaluateResponseSignals(none, '<meta name="tdm-policy" content="https://x.test/p">').allowed).toBe(false);
    expect(evaluateResponseSignals(none, '<meta name="content-signal" content="ai-input=no">').allowed).toBe(false);
  });
  it("allows when there are no signals", () => {
    expect(evaluateResponseSignals({ get: () => null }, "<html></html>").allowed).toBe(true);
  });
});

describe("checkOptOut (fixtures, fails closed)", () => {
  it("allows when robots.txt is clean and the page carries no signals", async () => {
    const r = await checkOptOut(URL_, fx(res(200, "User-agent: *\nAllow: /\n")));
    expect(r.allowed).toBe(true);
  });

  it("blocks on robots Disallow", async () => {
    expect((await checkOptOut(URL_, fx(res(200, "User-agent: *\nDisallow: /\n")))).allowed).toBe(false);
  });

  // The page's OWN reservation headers are evaluated by the CALLER on the real content
  // response, not here -- see tests/ingest.test.ts ("skips when the content response carries
  // a tdm-reservation header"). This gate must not request the page at all, because a HEAD's
  // status does not mean what a GET's status means.
  it("does not evaluate page headers itself: that is the caller's job on the real GET", async () => {
    expect((await checkOptOut(URL_, fx(res(200, "")))).allowed).toBe(true);
  });

  it("FAILS CLOSED: robots.txt fetch throws => blocked", async () => {
    const r = await checkOptOut(URL_, fx(new Error("network down")));
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/robots\.txt.*fail/i);
  });

  it("requests only robots.txt and the TDM files -- never the page", async () => {
    const seen: string[] = [];
    const f: Fetcher = async (url) => {
      seen.push(url);
      return res(404);
    };
    expect((await checkOptOut(URL_, f)).allowed).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.every(
        (u) =>
          u.endsWith("/robots.txt") || u.endsWith("/.well-known/tdmrep.json") || u.endsWith("/tdm.txt"),
      ),
    ).toBe(true);
  });

  it("FAILS CLOSED: reading the robots body throws => blocked", async () => {
    const broken: FetchedResponse = { ...res(200), text: async () => { throw new Error("reset"); } };
    expect((await checkOptOut(URL_, fx(broken))).allowed).toBe(false);
  });

  // RFC 9309 §2.3.1.3: 4xx (except 429) = "Unavailable" => no robots policy => access allowed.
  it.each([400, 401, 403, 404, 410, 451])("robots.txt HTTP %i is Unavailable => allowed (RFC 9309)", async (status) => {
    expect((await checkOptOut(URL_, fx(res(status)))).allowed).toBe(true);
  });

  it.each([429, 500, 502, 503, 504])("FAILS CLOSED: robots.txt HTTP %i => blocked", async (status) => {
    const r = await checkOptOut(URL_, fx(res(status)));
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(new RegExp(`HTTP ${status}.*fail closed`));
  });

  it("FAILS CLOSED: unparseable robots.txt (HTML soft-error page, or no directives) => blocked", async () => {
    expect((await checkOptOut(URL_, fx(res(200, "<!doctype html><html><body>Oops</body></html>")))).allowed).toBe(false);
    expect((await checkOptOut(URL_, fx(res(200, "this is not a robots file\nat all")))).allowed).toBe(false);
  });

  it("an explicit Disallow still blocks and the page is never touched", async () => {
    const seen: string[] = [];
    const inner = fx(res(200, "User-agent: *\nDisallow: /docs/\n"));
    const r = await checkOptOut(URL_, async (u, i) => (seen.push(u), inner(u, i)));
    expect(r.allowed).toBe(false);
    expect(seen).toEqual(["https://example.test/robots.txt"]);
  });

  it("an unreadable robots.txt (5xx) means the page and TDM files are never requested", async () => {
    const seen: string[] = [];
    const inner = fx(res(503));
    await checkOptOut(URL_, async (u, i) => (seen.push(u), inner(u, i)));
    expect(seen).toEqual(["https://example.test/robots.txt"]);
  });

  // Was: "robots.txt 404 still checks the page headers". It no longer does, and that is the
  // point -- the HEAD it used to issue false-blocked hosts that do not implement HEAD.
  it("robots.txt 404 (Unavailable) proceeds to the TDM files without touching the page", async () => {
    const got = await checkOptOut(URL_, fx(res(404)));
    expect(got.allowed).toBe(true);
    expect(got.reasons).toEqual([]);
  });

  describe("TDM reservation files", () => {
    const ok = res(200, "User-agent: *\nAllow: /\n");

    it("absence of any TDM file (404/403/410) does NOT block", async () => {
      expect((await checkOptOut(URL_, fx(ok))).allowed).toBe(true);
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: res(403), txt: res(410) }))).allowed).toBe(true);
    });

    it("a soft-404 HTML page at a TDM path is not a reservation file", async () => {
      const html = res(200, "<html><body>Not found</body></html>");
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: html, txt: html }))).allowed).toBe(true);
    });

    it("tdmrep.json reserving the path blocks", async () => {
      const json = res(200, JSON.stringify([{ location: "/docs/*", "tdm-reservation": 1 }]));
      const r = await checkOptOut(URL_, fx(ok, res(200), { json }));
      expect(r.allowed).toBe(false);
      expect(r.reasons.join(" ")).toMatch(/tdmrep\.json/);
    });

    it("tdmrep.json reserving only another path, or with reservation 0, does not block", async () => {
      const other = res(200, JSON.stringify([{ location: "/private/*", "tdm-reservation": 1 }]));
      const zero = res(200, JSON.stringify([{ location: "/*", "tdm-reservation": 0 }]));
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: other }))).allowed).toBe(true);
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: zero }))).allowed).toBe(true);
    });

    it("tdmrep.json with a tdm-policy for the path blocks (policy cannot be evaluated)", async () => {
      const json = res(200, JSON.stringify([{ location: "/*", "tdm-reservation": 0, "tdm-policy": "https://x.test/p.json" }]));
      expect((await checkOptOut(URL_, fx(ok, res(200), { json }))).allowed).toBe(false);
    });

    it("FAILS CLOSED: present but unreadable tdmrep.json, or a malformed rule, blocks", async () => {
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: res(200, "{not json") }))).allowed).toBe(false);
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: res(200, '{"a":1}') }))).allowed).toBe(false);
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: res(200, '[{"location":"/*"}]') }))).allowed).toBe(false);
    });

    it("FAILS CLOSED: a TDM file fetch error, 5xx or 429 is not 'absence' => blocks", async () => {
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: new Error("dns") }))).allowed).toBe(false);
      expect((await checkOptOut(URL_, fx(ok, res(200), { txt: res(503) }))).allowed).toBe(false);
      expect((await checkOptOut(URL_, fx(ok, res(200), { json: res(429) }))).allowed).toBe(false);
    });

    it("tdm.txt expressing a reservation blocks; reservation 0 does not", async () => {
      expect((await checkOptOut(URL_, fx(ok, res(200), { txt: res(200, "tdm-reservation: 1\n") }))).allowed).toBe(false);
      expect((await checkOptOut(URL_, fx(ok, res(200), { txt: res(200, "tdm-reservation: 0\n") }))).allowed).toBe(true);
    });

    it("tdm.txt that is present but says nothing recognisable blocks (ambiguous)", async () => {
      expect((await checkOptOut(URL_, fx(ok, res(200), { txt: res(200, "hello") }))).allowed).toBe(false);
    });
  });

  // REGRESSION: nvlpubs.nist.gov answers HEAD with 404 while serving the same URL as 200 on
  // GET (verified live, with curl's default user-agent -- it is not UA blocking). The gate
  // used to HEAD the page and fail closed, so NIST SP 800-63B-4 was reported as
  // "page HEAD returned HTTP 404" and silently skipped. The gate must not touch the page;
  // the caller evaluates Content-Signal / tdm-reservation on the real GET.
  it("does not request the page, so a host that 404s on HEAD is not false-blocked", async () => {
    const got = await checkOptOut(URL_, fx(res(200, "")));
    expect(got.allowed).toBe(true);
    expect(got.reasons).toEqual([]);
  });

  it("FAILS CLOSED: unparseable URL => blocked", async () => {
    expect((await checkOptOut("not a url", fx(res(200, "")))).allowed).toBe(false);
  });

  it("always reports at least one reason when blocked", async () => {
    const r = await checkOptOut(URL_, fx(new Error("x")));
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
