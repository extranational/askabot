/** Licence obligations encoded as data (docs/CORPUS-GUIDE.md). */
export type LicenceId =
  | "W3C-SDL-2023"
  | "IETF-TLP"
  | "US-GOV-PD"
  | "CC-BY-4.0"
  | "CC-BY-SA-4.0"
  | "CITE-ONLY";

export interface Licence {
  display_name: string;
  /** Placeholders: {title}, {url}. Per-source wording in the manifest takes precedence where the licence prescribes it. */
  attribution_template: string;
  /** null = not applicable (CITE-ONLY: nothing is ingested, so nothing is derived). */
  share_alike: boolean | null;
  quote_permitted: boolean;
  link_required: boolean;
  /** false => no text may be fetched, stored or embedded; valid only for mode: pointer. */
  ingestable: boolean;
}

export const LICENCES: Readonly<Record<LicenceId, Licence>> = {
  "W3C-SDL-2023": {
    display_name: "W3C Software and Document License 2023",
    attribution_template:
      "Based on '{title}' ({url}), © W3C, used under the W3C Software and Document License. This answer is a modification, not W3C text.",
    share_alike: false,
    quote_permitted: true,
    link_required: true,
    ingestable: true,
  },
  "IETF-TLP": {
    display_name: "IETF Trust Legal Provisions",
    attribution_template:
      "Extracted from {title} ({url}), © IETF Trust and the persons identified as the document authors. Subject to BCP 78 and the IETF Trust's Legal Provisions.",
    share_alike: false,
    quote_permitted: true,
    link_required: true,
    ingestable: true,
  },
  "US-GOV-PD": {
    display_name: "U.S. Government work — public domain (17 U.S.C. §105)",
    attribution_template: "Source: {title}.",
    share_alike: false,
    quote_permitted: true,
    link_required: false,
    ingestable: true,
  },
  "CC-BY-4.0": {
    display_name: "Creative Commons Attribution 4.0",
    attribution_template:
      "Portions of '{title}' ({url}) are reproduced from work created and shared by its authors and used according to terms described in the Creative Commons 4.0 Attribution License.",
    share_alike: false,
    quote_permitted: true,
    link_required: true,
    ingestable: true,
  },
  "CC-BY-SA-4.0": {
    display_name: "Creative Commons Attribution-ShareAlike 4.0",
    attribution_template:
      "Adapted/Quoted from '{title}', {url} — licensed CC BY-SA 4.0.",
    share_alike: true,
    quote_permitted: true,
    link_required: true,
    ingestable: true,
  },
  "CITE-ONLY": {
    display_name: "Cite and link only — no ingestion permitted",
    attribution_template: "{title} ({url})",
    share_alike: null,
    quote_permitted: false,
    link_required: true,
    ingestable: false,
  },
};

export function isKnownLicence(id: string): id is LicenceId {
  return Object.prototype.hasOwnProperty.call(LICENCES, id);
}

export function getLicence(id: string): Licence {
  if (!isKnownLicence(id)) throw new Error(`unknown licence id: ${JSON.stringify(id)}`);
  return LICENCES[id];
}

export function renderAttribution(id: string, vars: { title: string; url: string }): string {
  return getLicence(id)
    .attribution_template.replaceAll("{title}", vars.title)
    .replaceAll("{url}", vars.url);
}
