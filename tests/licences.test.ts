import { describe, expect, it } from "vitest";
import { LICENCES, getLicence, isKnownLicence, renderAttribution } from "../src/licences";

describe("licence registry", () => {
  it("contains exactly the contract's licence ids", () => {
    expect(Object.keys(LICENCES).sort()).toEqual(
      ["CC-BY-4.0", "CC-BY-SA-4.0", "CITE-ONLY", "IETF-TLP", "US-GOV-PD", "W3C-SDL-2023"].sort(),
    );
  });

  it("CC-BY-SA-4.0 is share-alike; US-GOV-PD is not", () => {
    expect(LICENCES["CC-BY-SA-4.0"].share_alike).toBe(true);
    expect(LICENCES["US-GOV-PD"].share_alike).toBe(false);
  });

  it("only CC-BY-SA-4.0 is share-alike among ingestable licences", () => {
    const sa = Object.entries(LICENCES).filter(([, l]) => l.share_alike === true).map(([id]) => id);
    expect(sa).toEqual(["CC-BY-SA-4.0"]);
  });

  it("matches the contract's quote_permitted / link_required table", () => {
    expect(LICENCES["CITE-ONLY"].quote_permitted).toBe(false);
    expect(LICENCES["CITE-ONLY"].share_alike).toBeNull();
    expect(LICENCES["CITE-ONLY"].ingestable).toBe(false);
    expect(LICENCES["US-GOV-PD"].link_required).toBe(false);
    for (const id of ["W3C-SDL-2023", "IETF-TLP", "CC-BY-4.0", "CC-BY-SA-4.0", "CITE-ONLY"]) {
      expect(LICENCES[id as keyof typeof LICENCES].link_required).toBe(true);
    }
    for (const id of ["W3C-SDL-2023", "IETF-TLP", "US-GOV-PD", "CC-BY-4.0", "CC-BY-SA-4.0"]) {
      expect(LICENCES[id as keyof typeof LICENCES].quote_permitted).toBe(true);
      expect(LICENCES[id as keyof typeof LICENCES].ingestable).toBe(true);
    }
  });

  it("every licence has a display name and attribution template", () => {
    for (const l of Object.values(LICENCES)) {
      expect(l.display_name.length).toBeGreaterThan(0);
      expect(l.attribution_template.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown licence ids", () => {
    expect(isKnownLicence("MIT")).toBe(false);
    expect(() => getLicence("MIT")).toThrow(/unknown licence/i);
    expect(isKnownLicence("CC-BY-SA-4.0")).toBe(true);
  });

  it("renders a template with title and url", () => {
    const s = renderAttribution("CC-BY-SA-4.0", { title: "Authentication Cheat Sheet", url: "https://x.test/a" });
    expect(s).toContain("Authentication Cheat Sheet");
    expect(s).toContain("https://x.test/a");
    expect(s).toContain("CC BY-SA 4.0");
  });
});
