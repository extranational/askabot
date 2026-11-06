import { isKnownLicence, LICENCES, type LicenceId } from "./licences";

export interface Chunk {
  id: string;
  text: string;
  /** The chunk's returned match score. Its scale is NOT interpreted here; see abstain.ts. */
  score: number;
  sourceId: string;
  sourceUrl: string;
  licence: LicenceId;
  attribution: string;
  retrievalDate?: string;
  /** From scoring_details: the semantic similarity score — what retrieval.match_threshold filters. */
  vectorScore?: number;
  /** From scoring_details: the rerank score, present only when reranking ran. Equals `score`. */
  rerankScore?: number;
}

export interface SearchRequest {
  messages: { role: "user"; content: string }[];
  ai_search_options: {
    retrieval: { match_threshold: number; max_num_results: number };
    /**
     * TOP LEVEL — not inside `retrieval`. AI Search silently ignores a mis-placed reranking
     * field (no error, no effect), which is what made the instance setting look like the only
     * control. Sent on every request so this repo is the source of truth, not the instance.
     */
    reranking: { enabled: boolean; model: string; match_threshold: number };
  };
}
/** The slice of the AI Search binding we use. The operator wires the real one. */
export interface AiSearchInstance {
  search(req: SearchRequest): Promise<unknown>;
}
export interface RetrievalConfig {
  max_num_results: number;
  match_threshold: number;
  reranking: { enabled: boolean; model: string; match_threshold: number };
}

/**
 * The threshold the ABSTENTION GATE must compare against. chunks[].score is the reranking
 * score when reranking ran and the vector similarity when it did not, so gate and score must
 * be on the same scale: pick the threshold that matches the score that came back. Comparing
 * the wrong pair silently moves the gate, which is what happened before this existed.
 */
export function gateThreshold(cfg: {
  retrieval: { match_threshold: number };
  reranking: { enabled: boolean; match_threshold: number };
}): number {
  return cfg.reranking.enabled ? cfg.reranking.match_threshold : cfg.retrieval.match_threshold;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const numOrUndef = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * Map one raw chunk, or null if it cannot be cited.
 * Provenance comes from item.metadata (written by scripts/ingest.ts), not from item.key:
 * the ingest key is "{source_id}.md|pdf", and the URL lives in metadata.source_url.
 */
function mapChunk(raw: unknown, index: number, allowed?: ReadonlySet<string>): Chunk | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as {
    id?: unknown;
    text?: unknown;
    score?: unknown;
    scoring_details?: { vector_score?: unknown; reranking_score?: unknown };
    item?: { key?: unknown; metadata?: unknown };
  };

  const text = str(c.text);
  if (text === undefined || typeof c.score !== "number" || !Number.isFinite(c.score)) return null;

  const md = c.item?.metadata;
  if (typeof md !== "object" || md === null) return null;
  const m = md as Record<string, unknown>;
  const sourceId = str(m.source_id);
  const sourceUrl = str(m.source_url);
  const licence = str(m.licence);
  const attribution = str(m.attribution);
  if (!sourceId || !sourceUrl || !licence || !attribution) return null;
  if (!/^https:\/\//.test(sourceUrl)) return null;
  if (!isKnownLicence(licence) || !LICENCES[licence].ingestable) return null; // CITE-ONLY is never citable from the index
  if (allowed && !allowed.has(sourceId)) return null;

  const key = str(c.item?.key) ?? sourceId;
  return {
    id: str(c.id) ?? `${key}#${index}`,
    text,
    score: c.score,
    sourceId,
    sourceUrl,
    licence,
    attribution,
    retrievalDate: str(m.retrieval_date),
    vectorScore: numOrUndef(c.scoring_details?.vector_score),
    rerankScore: numOrUndef(c.scoring_details?.reranking_score),
  };
}

/**
 * Query AI Search and return citable chunks, best score first, at most max_num_results.
 * `allowedSourceIds` is the metadata filter: the full-mode source ids from the corpus manifest.
 * Anything without complete provenance is dropped, never passed on. A failing search() rejects.
 * The reranking block is sent explicitly on every request so the instance-level setting cannot
 * silently differ from this repo's config.
 */
export async function retrieve(
  instance: AiSearchInstance,
  question: string,
  cfg: RetrievalConfig,
  allowedSourceIds?: ReadonlySet<string>,
): Promise<Chunk[]> {
  const res = (await instance.search({
    messages: [{ role: "user", content: question }],
    ai_search_options: {
      retrieval: { match_threshold: cfg.match_threshold, max_num_results: cfg.max_num_results },
      reranking: {
        enabled: cfg.reranking.enabled,
        model: cfg.reranking.model,
        match_threshold: cfg.reranking.match_threshold,
      },
    },
  })) as { chunks?: unknown } | null | undefined;

  const rawChunks = Array.isArray(res?.chunks) ? (res!.chunks as unknown[]) : [];
  return rawChunks
    .map((r, i) => mapChunk(r, i, allowedSourceIds))
    .filter((c): c is Chunk => c !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, cfg.max_num_results);
}
