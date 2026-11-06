import { describe, expect, it } from "vitest";
import { loadManifest, parseManifest } from "../src/corpus";
import { LICENCES } from "../src/licences";

const FROZEN_IDS = [
  "w3c-webauthn-3",
  "w3c-webauthn-2",
  "ietf-rfc8809",
  "nist-sp800-63b-4",
  "nist-sp800-63b-3",
  "cisa-phishing-resistant-mfa",
  "cisa-more-than-a-password",
  "owasp-authentication-cheatsheet",
  "owasp-mfa-cheatsheet",
  "google-identity-passkeys",
  "wikipedia-passkey",
  "wikipedia-webauthn",
  "fido-alliance-specs",
  "mslearn-passkeys",
  "apple-passkeys",
  "yubico-docs",
  "1password-blog",
  "okta-blog",
];
const POINTER_IDS = ["fido-alliance-specs", "mslearn-passkeys", "apple-passkeys", "yubico-docs", "1password-blog", "okta-blog"];

describe("corpus manifest (config/corpus.yaml)", () => {
  const m = loadManifest("config/corpus.yaml");

  it("contains exactly the frozen contract §2 source ids", () => {
    expect(m.map((e) => e.source_id).sort()).toEqual([...FROZEN_IDS].sort());
  });

  it("every entry has source_id, url, licence, mode, attribution", () => {
    for (const e of m) {
      expect(e.source_id).toBeTruthy();
      expect(e.url).toMatch(/^https:\/\//);
      expect(e.licence).toBeTruthy();
      expect(["full", "pointer"]).toContain(e.mode);
      expect(e.attribution.trim().length).toBeGreaterThan(0);
    }
  });

  it("every licence is in the registry", () => {
    for (const e of m) expect(Object.keys(LICENCES)).toContain(e.licence);
  });

  it("has at least 8 full entries (non-degenerate)", () => {
    expect(m.filter((e) => e.mode === "full").length).toBeGreaterThanOrEqual(8);
  });

  it("no full entry carries a licence with quote_permitted:false or ingestable:false", () => {
    for (const e of m.filter((x) => x.mode === "full")) {
      expect(LICENCES[e.licence].quote_permitted).toBe(true);
      expect(LICENCES[e.licence].ingestable).toBe(true);
    }
  });

  it("the six vendor sources are pointer + CITE-ONLY, and nothing else is", () => {
    const pointers = m.filter((e) => e.mode === "pointer");
    expect(pointers.map((e) => e.source_id).sort()).toEqual([...POINTER_IDS].sort());
    for (const e of pointers) expect(e.licence).toBe("CITE-ONLY");
    for (const e of m.filter((x) => x.mode === "full")) expect(e.licence).not.toBe("CITE-ONLY");
  });

  it("source_ids are unique", () => {
    expect(new Set(m.map((e) => e.source_id)).size).toBe(m.length);
  });
});

describe("manifest loader validation", () => {
  const base = (over: string) => `
- source_id: a
  title: A
  url: https://example.test/a
  licence: CC-BY-4.0
  mode: full
  attribution: "x"
${over}`;

  it("accepts a valid entry", () => {
    expect(parseManifest(base("")).length).toBe(1);
  });

  it("rejects an unknown licence id", () => {
    expect(() => parseManifest(base("").replace("CC-BY-4.0", "MIT"))).toThrow(/unknown licence/i);
  });

  it("rejects a bad mode", () => {
    expect(() => parseManifest(base("").replace("mode: full", "mode: crawl"))).toThrow(/mode/);
  });

  it("rejects CITE-ONLY on a full entry", () => {
    expect(() => parseManifest(base("").replace("CC-BY-4.0", "CITE-ONLY"))).toThrow(/CITE-ONLY|full/);
  });

  it("rejects a pointer entry with an ingestable licence", () => {
    expect(() => parseManifest(base("").replace("mode: full", "mode: pointer"))).toThrow(/pointer/);
  });

  it("rejects missing attribution and unknown keys", () => {
    expect(() => parseManifest(base("").replace('  attribution: "x"\n', ""))).toThrow(/attribution/);
    expect(() => parseManifest(base("  extra: 1"))).toThrow(/unknown key/i);
  });

  it("rejects duplicate source_ids", () => {
    const one = base("");
    expect(() => parseManifest(one + one)).toThrow(/duplicate/i);
  });
});
