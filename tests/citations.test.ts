import { describe, expect, it } from "vitest";
import { assembleCitations, SHARE_ALIKE_NOTICE } from "../src/citations";
import { LICENCES } from "../src/licences";
import type { Chunk } from "../src/retrieve";

const mk = (n: number, over: Partial<Chunk> = {}): Chunk => ({
  id: `chunk-${n}`,
  text: `Body of chunk ${n} about passkeys and credentials.`,
  score: 0.9,
  sourceId: `source-${n}`,
  sourceUrl: `https://example.test/source-${n}`,
  licence: "CC-BY-4.0",
  attribution: `Attribution string ${n}`,
  ...over,
});
const chunks = [mk(1), mk(2), mk(3, { licence: "US-GOV-PD" }), mk(4, { licence: "CC-BY-SA-4.0" })];

describe("assembleCitations", () => {
  it("INCLUDES ONLY chunks actually referenced by [n]; unreferenced chunks are excluded", () => {
    const r = assembleCitations("Passkeys use public-key cryptography [2]. They resist phishing [3].", chunks);
    expect(r.citations.map((c) => c.n)).toEqual([2, 3]);
    expect(r.citations.map((c) => c.sourceId)).toEqual(["source-2", "source-3"]);
    const json = JSON.stringify(r);
    expect(json).not.toContain("source-1");
    expect(json).not.toContain("source-4");
    expect(json).not.toContain("chunk-1");
  });

  it("a retrieved-but-uncited chunk never appears, however many are retrieved", () => {
    const many = Array.from({ length: 8 }, (_, i) => mk(i + 1));
    const r = assembleCitations("Only this one [5].", many);
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0].sourceId).toBe("source-5");
  });

  it("an answer with no citations yields no citations and is flagged ungrounded", () => {
    const r = assembleCitations("Passkeys are great.", chunks);
    expect(r.citations).toEqual([]);
    expect(r.grounded).toBe(false);
    expect(r.notices).toEqual([]);
  });

  it("handles adjacent, repeated and comma-separated refs; sorted, deduplicated", () => {
    const r = assembleCitations("A [3][1]. B [1, 2]. C [1,3].", chunks);
    expect(r.citations.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(r.grounded).toBe(true);
  });

  it("ignores out-of-range / zero refs and reports them instead of inventing a source", () => {
    const r = assembleCitations("X [0]. Y [9]. Z [2].", chunks);
    expect(r.citations.map((c) => c.n)).toEqual([2]);
    expect(r.invalidRefs).toEqual([0, 9]);
  });

  it("an answer citing only invalid refs is ungrounded", () => {
    const r = assembleCitations("X [9].", chunks);
    expect(r.citations).toEqual([]);
    expect(r.grounded).toBe(false);
  });

  it("does not treat markdown links or ordinary brackets as citations", () => {
    const r = assembleCitations("See [the spec](https://x.test) and [a] and [1a] and array[2x].", chunks);
    expect(r.citations).toEqual([]);
  });

  describe("attribution from the licence registry", () => {
    it("each citation carries its URL, attribution string and the registry's licence name", () => {
      const r = assembleCitations("a [1] b [3] c [4]", chunks);
      for (const c of r.citations) {
        const src = chunks[c.n - 1];
        expect(c.url).toBe(src.sourceUrl);
        expect(c.attribution).toBe(src.attribution);
        expect(c.licence).toBe(src.licence);
        expect(c.licenceName).toBe(LICENCES[src.licence].display_name);
        expect(c.shareAlike).toBe(LICENCES[src.licence].share_alike === true);
      }
    });
  });

  describe("ShareAlike adaptations notice", () => {
    it("is surfaced when a referenced source is share-alike (CC BY-SA 4.0)", () => {
      const r = assembleCitations("From wiki [4].", chunks);
      expect(r.notices).toEqual([SHARE_ALIKE_NOTICE(["https://example.test/source-4"])]);
      expect(r.notices[0]).toMatch(/CC BY-SA 4\.0/);
    });
    it("is NOT surfaced when only non-share-alike sources are cited", () => {
      expect(assembleCitations("a [1] b [3]", chunks).notices).toEqual([]);
    });
    it("is NOT surfaced when the share-alike chunk was retrieved but not cited", () => {
      expect(assembleCitations("a [1]", chunks).notices).toEqual([]);
    });
    it("appears once, naming every cited share-alike source", () => {
      const two = [mk(1, { licence: "CC-BY-SA-4.0" }), mk(2, { licence: "CC-BY-SA-4.0" })];
      const r = assembleCitations("a [1] b [2]", two);
      expect(r.notices).toHaveLength(1);
      expect(r.notices[0]).toContain("https://example.test/source-1");
      expect(r.notices[0]).toContain("https://example.test/source-2");
    });
  });

  describe("quote cap (CORPUS-GUIDE) reporting", () => {
    const long = Array.from({ length: 26 }, (_, i) => `w${i}`).join(" ");
    it("flags a quoted span over 25 words", () => {
      const c = [mk(1, { text: `intro ${long} outro` })];
      const r = assembleCitations(`It says "${long}" [1].`, c);
      expect(r.quoteWarnings.map((w) => w.kind)).toContain("too-long");
    });
    it("does not flag a quote of exactly 25 words", () => {
      const ok = long.split(" ").slice(0, 25).join(" ");
      const c = [mk(1, { text: `intro ${ok} outro` })];
      expect(assembleCitations(`It says "${ok}" [1].`, c).quoteWarnings).toEqual([]);
    });
    it("flags more than 2 verbatim quotes from one source", () => {
      const c = [mk(1, { text: "alpha bravo charlie delta. echo foxtrot golf hotel. india juliet kilo lima." })];
      const r = assembleCitations('"alpha bravo charlie delta" [1] "echo foxtrot golf hotel" [1] "india juliet kilo lima" [1]', c);
      expect(r.quoteWarnings.some((w) => w.kind === "too-many-quotes" && w.sourceId === "source-1")).toBe(true);
    });
    it("two quotes from a source is within the cap", () => {
      const c = [mk(1, { text: "alpha bravo charlie delta. echo foxtrot golf hotel." })];
      const r = assembleCitations('"alpha bravo charlie delta" [1] "echo foxtrot golf hotel" [1]', c);
      expect(r.quoteWarnings).toEqual([]);
    });
    it("ignores short scare-quotes", () => {
      expect(assembleCitations('The "passkey" [1] and "sync" [1] terms', [mk(1)]).quoteWarnings).toEqual([]);
    });
  });
});
