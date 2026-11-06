import { LICENCES, type LicenceId } from "./licences";
import { MAX_QUOTES_PER_SOURCE, MAX_QUOTE_WORDS } from "./prompt";
import type { Chunk } from "./retrieve";

export interface Citation {
  /** The [n] used in the answer text; maps to the n-th chunk given to the model. */
  n: number;
  chunkId: string;
  sourceId: string;
  url: string;
  licence: LicenceId;
  /** Display name from the licence registry. */
  licenceName: string;
  /** The per-source attribution string from the corpus manifest (what the licence prescribes). */
  attribution: string;
  shareAlike: boolean;
  linkRequired: boolean;
}

export interface QuoteWarning {
  kind: "too-long" | "too-many-quotes";
  sourceId?: string;
  detail: string;
}

export interface CitationResult {
  citations: Citation[];
  notices: string[];
  /** false when the answer cites no valid chunk: the client must not present it as sourced. */
  grounded: boolean;
  invalidRefs: number[];
  quoteWarnings: QuoteWarning[];
}

/** Default CC BY-SA 4.0 adaptations notice. Wording is provisional pending the operator's published notice text (plan 5.3b). */
export const SHARE_ALIKE_NOTICE = (urls: string[]): string =>
  `This answer adapts material from sources licensed under CC BY-SA 4.0 (${[...new Set(urls)].join(", ")}). ` +
  `It is paraphrased and may differ from the originals; any adaptation is shared under CC BY-SA 4.0 ` +
  `(https://creativecommons.org/licenses/by-sa/4.0/).`;

const REF = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

function quoteWarnings(answer: string, chunks: readonly Chunk[]): QuoteWarning[] {
  const out: QuoteWarning[] = [];
  const perSource = new Map<string, number>();
  const texts = chunks.map((c) => ({ id: c.sourceId, text: norm(c.text) }));

  for (const m of answer.matchAll(/"([^"]+)"|“([^”]+)”/g)) {
    const span = m[1] ?? m[2];
    const n = words(span);
    if (n < 4) continue; // scare quotes and short terms
    if (n > MAX_QUOTE_WORDS) out.push({ kind: "too-long", detail: `quoted span of ${n} words exceeds ${MAX_QUOTE_WORDS}` });
    const needle = norm(span);
    const hit = texts.find((t) => t.text.includes(needle));
    if (hit) perSource.set(hit.id, (perSource.get(hit.id) ?? 0) + 1);
  }
  for (const [sourceId, count] of perSource) {
    if (count > MAX_QUOTES_PER_SOURCE) {
      out.push({ kind: "too-many-quotes", sourceId, detail: `${count} verbatim quotes from ${sourceId} (cap ${MAX_QUOTES_PER_SOURCE})` });
    }
  }
  return out;
}

/**
 * Build citations[] from the finished answer. A chunk is cited only if its number appears as
 * [n] in the text; chunks that were retrieved but not referenced are never emitted.
 * `chunks` must be the exact list, in order, that was numbered in the prompt.
 */
export function assembleCitations(answer: string, chunks: readonly Chunk[]): CitationResult {
  const used = new Set<number>();
  const invalid = new Set<number>();
  for (const m of answer.matchAll(REF)) {
    for (const part of m[1].split(",")) {
      const n = Number(part.trim());
      if (Number.isInteger(n) && n >= 1 && n <= chunks.length) used.add(n);
      else invalid.add(n);
    }
  }

  const citations: Citation[] = [...used]
    .sort((a, b) => a - b)
    .map((n) => {
      const c = chunks[n - 1];
      const lic = LICENCES[c.licence];
      return {
        n,
        chunkId: c.id,
        sourceId: c.sourceId,
        url: c.sourceUrl,
        licence: c.licence,
        licenceName: lic.display_name,
        attribution: c.attribution,
        shareAlike: lic.share_alike === true,
        linkRequired: lic.link_required,
      };
    });

  const sa = citations.filter((c) => c.shareAlike).map((c) => c.url);
  return {
    citations,
    notices: sa.length > 0 ? [SHARE_ALIKE_NOTICE(sa)] : [],
    grounded: citations.length > 0,
    invalidRefs: [...invalid].sort((a, b) => a - b),
    quoteWarnings: quoteWarnings(answer, chunks),
  };
}
