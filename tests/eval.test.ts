import { describe, expect, it, vi } from "vitest";
import { loadManifest } from "../src/corpus";
import {
  citationCorrectness,
  formatReport,
  groundedness,
  heuristicJudge,
  loadQuestions,
  parseQuestions,
  percentile,
  runEval,
  summarize,
  type AskFn,
  type AskResult,
  type JudgeFn,
  type Outcome,
  type Question,
} from "../scripts/eval";

const manifest = loadManifest();

// ------------------------------------------------------------ 4.1 question set
describe("eval/questions.yaml", () => {
  const qs = loadQuestions("eval/questions.yaml", manifest);
  const count = (k: string) => qs.filter((q) => q.kind === k).length;

  it("has >= 30 questions with unique ids", () => {
    expect(qs.length).toBeGreaterThanOrEqual(30);
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
  });
  it("has ~20 in-corpus, ~10 out-of-corpus, exactly 2 adversarial", () => {
    expect(count("in_corpus")).toBeGreaterThanOrEqual(20);
    expect(count("in_corpus")).toBeLessThanOrEqual(22);
    expect(count("out_of_corpus")).toBeGreaterThanOrEqual(10);
    expect(count("adversarial")).toBe(2);
  });
  it("every in-corpus entry names expected sources that are mode:full in the manifest", () => {
    for (const q of qs.filter((x) => x.kind === "in_corpus")) {
      expect(q.expected_source_ids?.length).toBeGreaterThan(0);
    }
  });
  it("rejects bad structure", () => {
    expect(() => parseQuestions("- {id: a, question: q, kind: nope}")).toThrow(/kind/);
    expect(() => parseQuestions("- {id: a, question: q, kind: in_corpus}")).toThrow(/expected_source_ids/);
    expect(() => parseQuestions("- {id: a, question: q, kind: out_of_corpus, expected_source_ids: [x]}")).toThrow(/only allowed/);
    expect(() => parseQuestions("- {id: a, question: q, kind: out_of_corpus}\n- {id: a, question: r, kind: out_of_corpus}")).toThrow(/duplicate/);
    expect(() => parseQuestions("- {id: a, question: q, kind: in_corpus, expected_source_ids: [fido-alliance-specs]}", manifest)).toThrow(/mode:full/);
  });
});

// ------------------------------------------------------------ helpers
const Q = (id: string, kind: Question["kind"], expected?: string[]): Question => ({ id, question: "question " + id, kind, expected_source_ids: expected });
const R = (over: Partial<AskResult> = {}): AskResult => ({ answer: "", abstained: false, citations: [], latencyMs: 100, costUsd: 0, ...over });
const ABSTAIN = R({ answer: "Not covered.", abstained: true });

// ------------------------------------------------------------ 4.2 scoring
describe("percentile", () => {
  it("uses nearest rank", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(v, 50)).toBe(5);
    expect(percentile(v, 95)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("abstention metrics", () => {
  it("computes OOC abstention and in-corpus false-abstention rates", async () => {
    const answers: Record<string, AskResult> = {
      "question o1": ABSTAIN,
      "question o2": ABSTAIN,
      "question o3": ABSTAIN,
      "question o4": R({ answer: "Invented answer for this topic here.", citations: [] }),
      "question i1": ABSTAIN,
      "question i2": R({ answer: "Passkeys are credentials stored on devices [1].", citations: [{ n: 1, sourceId: "a" }] }),
    };
    const ask: AskFn = async (q) => answers[q];
    const qs = [Q("o1", "out_of_corpus"), Q("o2", "out_of_corpus"), Q("o3", "out_of_corpus"), Q("o4", "out_of_corpus"), Q("i1", "in_corpus", ["a"]), Q("i2", "in_corpus", ["a"])];
    const { summary } = await runEval(qs, { ask });
    expect(summary.abstention_rate_ooc).toBe(0.75);
    expect(summary.false_abstention_rate).toBe(0.5);
    expect(summary.gate.passed).toBe(false);
  });

  it("passes the gate when thresholds are met", () => {
    const outs: Outcome[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ q: Q("o" + i, "out_of_corpus"), result: ABSTAIN })),
      ...Array.from({ length: 10 }, (_, i) => ({ q: Q("i" + i, "in_corpus", ["a"]), result: R({ answer: "x", citations: [{ n: 1, sourceId: "a" }] }) })),
    ];
    const s = summarize(outs);
    expect(s.abstention_rate_ooc).toBe(1);
    expect(s.false_abstention_rate).toBe(0);
    expect(s.gate).toEqual({ false_abstention_ok: true, ooc_abstention_ok: true, passed: true });
  });
});

describe("latency and cost come from the AskFn's returns", () => {
  it("reports p50/p95 and mean cost", async () => {
    const lat = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    let i = 0;
    const ask: AskFn = async () => R({ abstained: true, latencyMs: lat[i], costUsd: lat[i++] / 1e6 });
    const { summary } = await runEval(lat.map((_, k) => Q("o" + k, "out_of_corpus")), { ask });
    expect(summary.latency_ms).toEqual({ p50: 500, p95: 1000 });
    expect(summary.cost_usd.total).toBeCloseTo(0.0055, 10);
    expect(summary.cost_usd.per_query).toBeCloseTo(0.00055, 10);
  });
});

describe("judge injection", () => {
  const answer = "Passkeys replace passwords with public-key credentials [1]. They also resist phishing attacks very well. See [2].";
  const cites = [{ n: 1, sourceId: "wikipedia-passkey" }, { n: 2, sourceId: "other" }];

  it("uses the injected JudgeFn's verdicts, passing question, answer and citations", async () => {
    const judge = vi.fn<JudgeFn>(async () => ({
      claims: [
        { claim: "c1", supported: true, citedN: [1], citationSupports: true },
        { claim: "c2", supported: true, citedN: [2], citationSupports: false },
        { claim: "c3", supported: false, citedN: [], citationSupports: null },
        { claim: "c4", supported: true, citedN: [1], citationSupports: true },
      ],
    }));
    const { summary } = await runEval([Q("i1", "in_corpus", ["wikipedia-passkey"])], { ask: async () => R({ answer, citations: cites }), judge });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0]).toEqual({ question: "question i1", answer, citations: cites });
    expect(summary.groundedness).toBe(0.75); // 3 of 4 claims supported
    expect(summary.citation_correctness).toBeCloseTo(2 / 3); // 3 cited claims, 2 correct
  });

  it("never calls the judge for abstentions", async () => {
    const judge = vi.fn<JudgeFn>(async () => ({ claims: [] }));
    await runEval([Q("o1", "out_of_corpus")], { ask: async () => ABSTAIN, judge });
    expect(judge).not.toHaveBeenCalled();
  });

  it("a judge failure is recorded and does not abort the run", async () => {
    const judge: JudgeFn = async () => {
      throw new Error("judge down");
    };
    const { outcomes, summary } = await runEval([Q("i1", "in_corpus", ["a"])], { ask: async () => R({ answer, citations: cites }), judge });
    expect(outcomes[0].judgeError).toBe("judge down");
    expect(summary.groundedness).toBeNull();
  });
});

describe("heuristic fallback (no judge supplied)", () => {
  it("flags uncited and dangling-ref sentences deterministically", async () => {
    const judge = heuristicJudge(["good"]);
    const out = await judge({
      question: "q",
      answer: "Passkeys use public key cryptography [1]. This sentence has no citation at all. Another claim from elsewhere [2]. Bad ref here [9].",
      citations: [{ n: 1, sourceId: "good" }, { n: 2, sourceId: "bad" }],
    });
    expect(out.claims.map((c) => [c.supported, c.citationSupports])).toEqual([
      [true, true],
      [false, null],
      [true, false], // cites a source that is not an expected one
      [false, false], // dangling [9]
    ]);
  });

  it("is used by runEval when no judge is given", async () => {
    const ask: AskFn = async () => R({ answer: "Passkeys use public key cryptography [1]. This one is uncited entirely.", citations: [{ n: 1, sourceId: "a" }] });
    const { summary } = await runEval([Q("i1", "in_corpus", ["a"])], { ask });
    expect(summary.groundedness).toBe(0.5);
    expect(summary.citation_correctness).toBe(1);
    expect(summary.expected_source_hit_rate).toBe(1);
  });

  it("ignores abstentions when computing groundedness", () => {
    const outs: Outcome[] = [{ q: Q("o1", "out_of_corpus"), result: ABSTAIN, claims: [] }];
    expect(groundedness(outs)).toBeNull();
    expect(citationCorrectness(outs)).toBeNull();
  });
});

describe("adversarial prompts", () => {
  it("pass on abstention; fail on an answer with unsupported claims", async () => {
    const asks: Record<string, AskResult> = {
      "question a1": ABSTAIN,
      "question a2": R({ answer: "It is CVE-2023-1234 for sure, definitely so.", citations: [] }),
    };
    const { summary } = await runEval([Q("a1", "adversarial"), Q("a2", "adversarial")], { ask: async (q) => asks[q] });
    expect(summary.adversarial).toEqual({ passed: 1, total: 2 });
  });
});

describe("errors", () => {
  it("an AskFn failure is counted, excluded from rates, and does not abort the run", async () => {
    const ask: AskFn = async (q) => {
      if (q === "question o1") throw new Error("503");
      return ABSTAIN;
    };
    const { outcomes, summary } = await runEval([Q("o1", "out_of_corpus"), Q("o2", "out_of_corpus")], { ask });
    expect(outcomes[0].error).toBe("503");
    expect(summary.counts.errors).toBe(1);
    expect(summary.abstention_rate_ooc).toBe(1);
  });
  it("rates are null (not 0) with no data", () => {
    const s = summarize([]);
    expect(s.abstention_rate_ooc).toBeNull();
    expect(s.latency_ms.p50).toBeNull();
    expect(s.gate.passed).toBe(false);
  });
});

describe("end to end over the real question file with a fixture subject", () => {
  it("scores all six metrics without any network access", async () => {
    const qs = loadQuestions("eval/questions.yaml", manifest);
    const byQ = new Map(qs.map((q) => [q.question, q]));
    const ask: AskFn = async (text) => {
      const q = byQ.get(text)!;
      if (q.kind !== "in_corpus") return R({ answer: "Not covered.", abstained: true, latencyMs: 50 });
      return R({ answer: "A grounded answer about this topic [1].", citations: [{ n: 1, sourceId: q.expected_source_ids![0] }], latencyMs: 400, costUsd: 0.0002 });
    };
    const { summary } = await runEval(qs, { ask });
    expect(summary.counts.total).toBe(qs.length);
    expect(summary.groundedness).toBe(1);
    expect(summary.citation_correctness).toBe(1);
    expect(summary.abstention_rate_ooc).toBe(1);
    expect(summary.false_abstention_rate).toBe(0);
    expect(summary.latency_ms.p95).toBe(400);
    expect(summary.cost_usd.per_query).toBeGreaterThan(0);
    expect(summary.gate.passed).toBe(true);
    expect(formatReport(summary, "heuristic")).toContain("does NOT verify truth");
  });
});
