import { describe, expect, it } from "vitest";
import { createWorker, type Env, type Runtime } from "../src/index";
import { loadConfig } from "../src/config";
import { loadManifest, type CorpusEntry } from "../src/corpus";
import { LICENCES } from "../src/licences";
import { SHARE_ALIKE_NOTICE } from "../src/citations";
import { esc, loadNotices, parseNotices, renderNoticesPage } from "../src/notices";

const doc = loadNotices();
const manifest = loadManifest();
const config = loadConfig("config/askabot.yaml");
const html = renderNoticesPage(doc, manifest);

const entry = (over: Partial<CorpusEntry> = {}): CorpusEntry => ({
  source_id: "x",
  title: "X Title",
  url: "https://example.test/x",
  licence: "US-GOV-PD",
  mode: "full",
  attribution: "Source: X.",
  ...over,
});

describe("approved prose is rendered verbatim", () => {
  it("every paragraph, list item, after-paragraph and heading appears exactly (escaped only)", () => {
    expect(doc.sections.length).toBeGreaterThan(0);
    for (const s of doc.sections) {
      for (const t of [s.heading, ...(s.paragraphs ?? []), ...(s.list ?? []), ...(s.after ?? [])]) {
        expect(html).toContain(esc(t));
      }
    }
    expect(html).toContain(`<h1>${esc(doc.title)}</h1>`);
    expect(html).toContain(esc(doc.updated));
  });

  it("is a complete document with charset and title", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain(`<title>${esc(doc.title)}</title>`);
  });

  it("renders ordered:true sections as <ol> and others as <ul>", () => {
    const ordered = doc.sections.find((s) => s.ordered)!;
    const plain = doc.sections.find((s) => s.list && !s.ordered)!;
    const sec = (h: string) => html.slice(html.indexOf(`<h2>${esc(h)}</h2>`)).split("</section>")[0];
    expect(sec(ordered.heading)).toContain("<ol>");
    expect(sec(ordered.heading)).not.toContain("<ul>");
    expect(sec(plain.heading)).toContain("<ul>");
    expect(sec(plain.heading)).not.toContain("<ol>");
  });

  it("keeps order: paragraphs, then list, then after", () => {
    const s = doc.sections.find((x) => x.list && x.after)!;
    const at = (t: string) => html.indexOf(esc(t));
    expect(at(s.paragraphs![0])).toBeLessThan(at(s.list![0]));
    expect(at(s.list![0])).toBeLessThan(at(s.after![0]));
  });
});

describe("generated attribution list", () => {
  it("is placed in the attribution_list section and only there", () => {
    const sec = doc.sections.find((s) => s.attribution_list)!;
    const start = html.indexOf(`<h2>${esc(sec.heading)}</h2>`);
    const end = html.indexOf("</section>", start);
    const idx = html.indexOf('<ul class="sources">');
    expect(idx).toBeGreaterThan(start);
    expect(idx).toBeLessThan(end);
    expect(html.split('<ul class="sources">')).toHaveLength(2);
  });

  it("lists every manifest source with linked title, licence name, attribution and status", () => {
    for (const e of manifest) {
      expect(html).toContain(esc(e.title));
      expect(html).toContain(esc(LICENCES[e.licence].display_name));
      expect(html).toContain(esc(e.attribution));
      expect(html).toContain(`href="${esc(e.url)}"`);
    }
    expect((html.match(/Status: Ingested/g) ?? []).length).toBe(manifest.filter((e) => e.mode === "full").length);
    expect((html.match(/Status: Cited only/g) ?? []).length).toBe(manifest.filter((e) => e.mode === "pointer").length);
  });

  it("is driven by the manifest: a removed source vanishes, an added one appears", () => {
    const a = entry({ source_id: "a", title: "Alpha Doc", url: "https://a.test/" });
    const b = entry({ source_id: "b", title: "Beta Doc", url: "https://b.test/" });
    const both = renderNoticesPage(doc, [a, b]);
    const one = renderNoticesPage(doc, [a]);
    expect(both).toContain("Beta Doc");
    expect(one).toContain("Alpha Doc");
    expect(one).not.toContain("Beta Doc");
    expect(one).not.toContain("b.test");
  });

  it("states pointer entries as cited only", () => {
    const p = entry({ title: "Vendor Docs", licence: "CITE-ONLY", mode: "pointer", attribution: "Name + link only." });
    expect(renderNoticesPage(doc, [p])).toContain("Status: Cited only");
    expect(renderNoticesPage(doc, [p])).not.toContain("Status: Ingested");
  });

  it("carries the CC BY-SA adaptations notice (from the citations helper) iff a share-alike source exists", () => {
    const sa = entry({ licence: "CC-BY-SA-4.0", url: "https://sa.test/page" });
    expect(renderNoticesPage(doc, [sa])).toContain(esc(SHARE_ALIKE_NOTICE([sa.url])));
    expect(renderNoticesPage(doc, [entry()])).not.toContain("CC BY-SA 4.0 (");
    // real manifest has OWASP/Wikipedia
    for (const e of manifest.filter((m) => LICENCES[m.licence].share_alike === true)) expect(html).toContain(esc(e.url));
    expect(html).toContain("This answer adapts material");
  });
});

describe("escaping", () => {
  it("escapes hostile titles, urls, attributions and licence-independent text", () => {
    const evil = entry({
      title: '<script>alert(1)</script>',
      url: 'https://e.test/"><img src=x onerror=alert(2)>',
      attribution: "<b>bold</b> & \"quotes\" 'single'",
    });
    const out = renderNoticesPage(doc, [evil]);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot; &#39;single&#39;");
  });

  it("does not link non-http(s) URLs", () => {
    const out = renderNoticesPage(doc, [entry({ url: "javascript:alert(1)" })]);
    expect(out).not.toContain("href=\"javascript");
    expect(out).toContain("X Title");
  });

  it("escapes notice-document text too", () => {
    const d = parseNotices('title: "<i>T</i>"\nupdated: "2026"\ncontact_email: "a@b.c"\nsections:\n  - heading: "<h>"\n    paragraphs: ["<p>x</p>"]\n');
    const out = renderNoticesPage(d, []);
    expect(out).toContain("&lt;i&gt;T&lt;/i&gt;");
    expect(out).toContain("&lt;p&gt;x&lt;/p&gt;");
    expect(out).not.toContain("<i>");
  });
});

describe("parseNotices", () => {
  it("rejects malformed documents", () => {
    expect(() => parseNotices("- a")).toThrow(/mapping/);
    expect(() => parseNotices('title: t\nupdated: u\ncontact_email: c\nsections: []')).toThrow(/sections/);
    expect(() => parseNotices('title: t\nupdated: u\ncontact_email: c\nsections:\n  - {heading: h, bogus: 1}')).toThrow(/unknown key/);
    expect(() => parseNotices('title: t\nupdated: u\ncontact_email: c\nsections:\n  - {heading: h, list: [1]}')).toThrow(/strings/);
  });
});

describe("GET /notices route", () => {
  const rt: Runtime = { config, manifest, notices: doc };
  const worker = createWorker(() => rt);
  const env = {} as Env;
  const call = (method: string, path = "/notices", w = worker) => w.fetch(new Request("https://w.test" + path, { method }), env);

  it("GET returns the HTML page", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(html);
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])("%s returns 405 with Allow: GET", async (m) => {
    const res = await call(m);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("unknown paths and /healthz keep their behaviour", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("GET", "/notices/x")).status).toBe(404);
    expect((await call("GET", "/healthz")).status).toBe(200);
    expect((await call("GET", "/api/chat")).status).toBe(405);
  });

  it("returns 500 rather than a partial page when notices are not configured", async () => {
    const bare = createWorker(() => ({ config, manifest }));
    expect((await call("GET", "/notices", bare)).status).toBe(500);
  });
});
