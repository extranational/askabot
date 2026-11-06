import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { LICENCES, isKnownLicence, type LicenceId } from "./licences";

export type Mode = "full" | "pointer";

export interface CorpusEntry {
  source_id: string;
  title: string;
  url: string;
  licence: LicenceId;
  mode: Mode;
  attribution: string;
}

const KEYS = ["source_id", "title", "url", "licence", "mode", "attribution"];

export function parseManifest(text: string): CorpusEntry[] {
  const raw = parse(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("corpus manifest: document must be a list");
  const seen = new Set<string>();

  return raw.map((item, i) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`corpus manifest[${i}]: must be a mapping`);
    }
    const o = item as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!KEYS.includes(k)) throw new Error(`corpus manifest[${i}]: unknown key "${k}"`);
    }
    const s = (k: string): string => {
      const v = o[k];
      if (typeof v !== "string" || v.trim() === "") {
        throw new Error(`corpus manifest[${i}]: "${k}" is required and must be a non-empty string`);
      }
      return v;
    };

    const source_id = s("source_id");
    const where = `corpus manifest[${source_id}]`;
    if (seen.has(source_id)) throw new Error(`${where}: duplicate source_id`);
    seen.add(source_id);

    const url = s("url");
    if (!/^https:\/\//.test(url)) throw new Error(`${where}: url must be https`);

    const licence = s("licence");
    if (!isKnownLicence(licence)) throw new Error(`${where}: unknown licence id ${JSON.stringify(licence)}`);

    const mode = s("mode");
    if (mode !== "full" && mode !== "pointer") {
      throw new Error(`${where}: mode must be "full" or "pointer", got ${JSON.stringify(mode)}`);
    }

    const lic = LICENCES[licence];
    if (mode === "full" && (!lic.ingestable || !lic.quote_permitted)) {
      throw new Error(`${where}: mode full is not allowed with licence ${licence} (CITE-ONLY is pointer-only)`);
    }
    if (mode === "pointer" && lic.ingestable) {
      throw new Error(`${where}: mode pointer requires a cite-only licence, got ${licence}`);
    }

    return { source_id, title: s("title"), url, licence, mode, attribution: s("attribution") };
  });
}

export function loadManifest(path = "config/corpus.yaml"): CorpusEntry[] {
  return parseManifest(readFileSync(path, "utf8"));
}
