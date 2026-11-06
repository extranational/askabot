import { describe, expect, it, vi } from "vitest";
import { retrieve, gateThreshold, type AiSearchInstance } from "../src/retrieve";

const RERANK = { enabled: true, model: "@cf/baai/bge-reranker-base", match_threshold: 0.4 };
const CFG = { max_num_results: 3, match_threshold: 0.4, reranking: RERANK };

const meta = (over: Record<string, unknown> = {}) => ({
  source_id: "wikipedia-passkey",
  source_url: "https://en.wikipedia.org/wiki/Passkey_(authentication)",
  licence: "CC-BY-SA-4.0",
  attribution: "Source: Wikipedia, 'Passkey (authentication)'",
  retrieval_date: "2026-10-13",
  ...over,
});
const raw = (text: string, score: number, metadata: Record<string, unknown> = meta(), extra: object = {}) => ({
  text,
  score,
  item: { key: "wikipedia-passkey.md", metadata, timestamp: 1 },
  ...extra,
});

function instance(chunks: unknown): AiSearchInstance & { search: ReturnType<typeof vi.fn> } {
  return { search: vi.fn(async () => ({ chunks })) } as never;
}

describe("retrieve", () => {
  it("maps an AI Search response to Chunk[] with provenance", async () => {
    const inst = instance([raw("Passkeys are…", 0.82, meta(), { id: "c1" })]);
    const out = await retrieve(inst, "what is a passkey?", CFG);
    expect(out).toEqual([
      {
        id: "c1",
        text: "Passkeys are…",
        score: 0.82,
        sourceId: "wikipedia-passkey",
        sourceUrl: "https://en.wikipedia.org/wiki/Passkey_(authentication)",
        licence: "CC-BY-SA-4.0",
        attribution: "Source: Wikipedia, 'Passkey (authentication)'",
        retrievalDate: "2026-10-13",
      },
    ]);
  });

  it("sends the question, the retrieval controls AND the top-level reranking block to search()", async () => {
    const inst = instance([]);
    await retrieve(inst, "q?", CFG);
    expect(inst.search).toHaveBeenCalledTimes(1);
    expect(inst.search.mock.calls[0][0]).toEqual({
      messages: [{ role: "user", content: "q?" }],
      ai_search_options: {
        retrieval: { match_threshold: 0.4, max_num_results: 3 },
        // Top level: inside `retrieval` AI Search would silently ignore it.
        reranking: { enabled: true, model: "@cf/baai/bge-reranker-base", match_threshold: 0.4 },
      },
    });
  });

  it("gateThreshold picks the threshold matching the score that comes back", () => {
    const retrieval = { max_num_results: 3, match_threshold: 0.4 };
    expect(gateThreshold({ retrieval, reranking: RERANK })).toBe(0.4); // reranking on: rerank score
    expect(gateThreshold({ retrieval, reranking: { ...RERANK, enabled: false } })).toBe(0.4); // vector
    // Different values prove which one is chosen, not just that both happen to be 0.4.
    const splitR = { ...retrieval, match_threshold: 0.2 };
    const splitK = { ...RERANK, match_threshold: 0.6 };
    expect(gateThreshold({ retrieval: splitR, reranking: splitK })).toBe(0.6);
    expect(gateThreshold({ retrieval: splitR, reranking: { ...splitK, enabled: false } })).toBe(0.2);
  });

  it("carries the vector and rerank scores off scoring_details", async () => {
    const inst = instance([
      raw("a", 0.42, meta(), { scoring_details: { vector_score: 0.62, reranking_score: 0.42 } }),
    ]);
    const [c] = await retrieve(inst, "q", CFG);
    expect(c.vectorScore).toBe(0.62);
    expect(c.rerankScore).toBe(0.42);
  });

  it("applies max_num_results to the response too, keeping the best-scored, sorted descending", async () => {
    const inst = instance([raw("a", 0.5), raw("b", 0.9), raw("c", 0.7), raw("d", 0.6), raw("e", 0.8)]);
    const out = await retrieve(inst, "q", CFG);
    expect(out.map((c) => c.text)).toEqual(["b", "e", "c"]);
  });

  it("empty or missing results return [] without throwing", async () => {
    expect(await retrieve(instance([]), "q", CFG)).toEqual([]);
    expect(await retrieve(instance(undefined), "q", CFG)).toEqual([]);
    expect(await retrieve(instance("garbage"), "q", CFG)).toEqual([]);
    expect(await retrieve({ search: async () => ({}) } as never, "q", CFG)).toEqual([]);
  });

  it("generates a stable id when the chunk has none", async () => {
    const out = await retrieve(instance([raw("a", 0.9)]), "q", CFG);
    expect(out[0].id).toBe("wikipedia-passkey.md#0");
  });

  describe("metadata filter (allowed source ids from the manifest)", () => {
    const allowed = new Set(["wikipedia-passkey"]);

    it("drops chunks whose source_id is not in the allowed set", async () => {
      const inst = instance([raw("ok", 0.9), raw("alien", 0.95, meta({ source_id: "not-in-manifest" }))]);
      const out = await retrieve(inst, "q", CFG, allowed);
      expect(out.map((c) => c.text)).toEqual(["ok"]);
    });

    it("never returns a pointer/CITE-ONLY chunk, even if one is in the index", async () => {
      const inst = instance([raw("x", 0.99, meta({ licence: "CITE-ONLY", source_id: "okta-blog" }))]);
      expect(await retrieve(inst, "q", CFG)).toEqual([]);
    });
  });

  describe("drops chunks that cannot be cited (fail closed)", () => {
    it.each([
      ["missing source_url", { source_url: undefined }],
      ["non-https source_url", { source_url: "javascript:alert(1)" }],
      ["missing attribution", { attribution: "" }],
      ["unknown licence", { licence: "MIT" }],
      ["missing licence", { licence: undefined }],
      ["missing source_id", { source_id: undefined }],
      ["non-string metadata", { source_url: 5 }],
    ])("%s", async (_n, over) => {
      expect(await retrieve(instance([raw("x", 0.9, meta(over))]), "q", CFG)).toEqual([]);
    });

    it("drops empty text and non-finite scores", async () => {
      const out = await retrieve(
        instance([raw("", 0.9), raw("nan", Number.NaN), raw("inf", Infinity), raw("str", "0.9" as never), raw("ok", 0.5)]),
        "q",
        CFG,
      );
      expect(out.map((c) => c.text)).toEqual(["ok"]);
    });

    it("drops chunks with no item/metadata at all", async () => {
      expect(await retrieve(instance([{ text: "x", score: 0.9 }]), "q", CFG)).toEqual([]);
    });
  });

  it("propagates a search() failure (the caller turns it into a structured error)", async () => {
    const inst = { search: async () => { throw new Error("upstream down"); } } as never;
    await expect(retrieve(inst, "q", CFG)).rejects.toThrow(/upstream down/);
  });
});
