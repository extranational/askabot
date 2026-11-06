import { describe, expect, it } from "vitest";
import { parseConfig, loadConfig } from "../src/config";

const VALID = `
corpus_manifest: config/corpus.yaml
assistant:
  subject: "the test corpus"
retrieval:
  max_num_results: 8
  match_threshold: 0.4
reranking:
  enabled: true
  model: "@cf/baai/bge-reranker-base"
  match_threshold: 0.4
generation:
  provider: workers-ai
  model: "@cf/meta/llama-4-scout-17b-16e-instruct"
  max_tokens: 900
  temperature: 0.1
serving:
  rate_limit_per_ip_per_hour: 20
  monthly_query_ceiling: 3000
abstain:
  message: "Not covered."
`;

describe("config", () => {
  it("loads the shipped config/askabot.yaml", () => {
    const c = loadConfig("config/askabot.yaml");
    expect(c.retrieval.max_num_results).toBe(8);
    expect(c.reranking.enabled).toBe(true);
    expect(c.reranking.model).toBe("@cf/baai/bge-reranker-base");
    expect(c.reranking.match_threshold).toBe(0.4);
    expect(c.generation.model).toBe("@cf/meta/llama-4-scout-17b-16e-instruct");
    expect(c.serving.monthly_query_ceiling).toBe(3000);
    expect(c.assistant.subject).toMatch(/passkeys/);
    expect(c.abstain.message).toMatch(/isn't covered/);
  });

  it("parses a valid document", () => {
    expect(parseConfig(VALID).generation.provider).toBe("workers-ai");
  });

  it("rejects unknown top-level keys", () => {
    expect(() => parseConfig(VALID + "\nextra: 1\n")).toThrow(/unknown key.*extra/i);
  });

  it("rejects unknown nested keys", () => {
    expect(() => parseConfig(VALID.replace("max_num_results: 8", "max_num_results: 8\n  bogus: 1"))).toThrow(
      /unknown key.*retrieval\.bogus/i,
    );
  });

  it("rejects retrieval.rerank (reranking is not a retrieval-level key)", () => {
    // AI Search takes reranking at ai_search_options.reranking, not inside retrieval; a
    // mis-placed field is silently ignored by the API, so the parser refuses it here.
    expect(() => parseConfig(VALID.replace("  match_threshold: 0.4", "  match_threshold: 0.4\n  rerank: true"))).toThrow(
      /unknown key.*retrieval\.rerank/i,
    );
  });

  it("rejects missing keys", () => {
    expect(() => parseConfig(VALID.replace("  max_tokens: 900\n", ""))).toThrow(
      /generation\.max_tokens/,
    );
  });

  it("rejects wrong types", () => {
    expect(() => parseConfig(VALID.replace("max_num_results: 8", 'max_num_results: "8"'))).toThrow(
      /retrieval\.max_num_results/,
    );
  });

  it("rejects an invalid provider", () => {
    expect(() => parseConfig(VALID.replace("workers-ai", "bogus"))).toThrow(/generation\.provider/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseConfig(VALID.replace("match_threshold: 0.4", "match_threshold: 1.5"))).toThrow(
      /match_threshold/,
    );
  });

  it("requires the reranking block — the per-request control is not optional", () => {
    // Reranking is sent explicitly on every request, so its absence must fail loudly rather
    // than silently fall back to whatever the instance happens to be set to.
    expect(() => parseConfig(VALID.replace(/reranking:\n(.*\n){3}/, ""))).toThrow(/reranking/);
  });

  it("rejects a non-boolean reranking.enabled", () => {
    expect(() => parseConfig(VALID.replace("enabled: true", 'enabled: "yes"'))).toThrow(
      /reranking\.enabled/,
    );
  });

  it("rejects an out-of-range reranking.match_threshold", () => {
    expect(() =>
      parseConfig(
        VALID.replace(
          '  model: "@cf/baai/bge-reranker-base"\n  match_threshold: 0.4',
          '  model: "@cf/baai/bge-reranker-base"\n  match_threshold: 1.5',
        ),
      ),
    ).toThrow(/reranking\.match_threshold/);
  });
});
