/**
 * Evaluation harness (plan Task 4.2): scores a question set against an injected subject.
 *
 * This file MEASURES; it never contacts a model or the Worker itself. The operator supplies, at
 * run time (plan Task 4.3):
 *   - an `AskFn`   : question -> AskResult (calls the deployed /api/chat, times it, prices it)
 *   - a `JudgeFn`  : (optional) LLM judge for groundedness / citation-correctness
 *   - the endpoint and credentials, which live inside those two functions.
 *
 *   npm run eval -- --impl path/to/impl.ts [--questions eval/questions.yaml]
 *
 * where impl.ts exports `ask: AskFn` and optionally `judge: JudgeFn`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { CorpusEntry } from "../src/corpus";

// ---------------------------------------------------------------- questions

export type Kind = "in_corpus" | "out_of_corpus" | "adversarial";

export interface Question {
  id: string;
  question: string;
  kind: Kind;
  /** in_corpus only; ANY-OF: the answer should cite at least one of these. */
  expected_source_ids?: string[];
}

const KINDS: readonly Kind[] = ["in_corpus", "out_of_corpus", "adversarial"];

/** Parse and validate the question set. Throws on any structural problem. */
export function parseQuestions(text: string, manifest?: readonly CorpusEntry[]): Question[] {
  const raw = parseYaml(text) as unknown;
  if (!Array.isArray(raw)) throw new Error("questions: expected a list");
  const full = manifest ? new Set(manifest.filter((e) => e.mode === "full").map((e) => e.source_id)) : null;
  const ids = new Set<string>();
  return raw.map((r, i) => {
    const where = `questions[${i}]`;
    if (typeof r !== "object" || r === null) throw new Error(`${where}: not an object`);
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!["id", "question", "kind", "expected_source_ids"].includes(k)) throw new Error(`${where}: unknown key ${k}`);
    }
    if (typeof o.id !== "string" || !o.id) throw new Error(`${where}: id required`);
    if (ids.has(o.id)) throw new Error(`${where}: duplicate id ${o.id}`);
    ids.add(o.id);
    if (typeof o.question !== "string" || !o.question.trim()) throw new Error(`${where}: question required`);
    if (!KINDS.includes(o.kind as Kind)) throw new Error(`${where}: invalid kind ${String(o.kind)}`);
    const kind = o.kind as Kind;
    const q: Question = { id: o.id, question: o.question, kind };
    if (kind === "in_corpus") {
      const e = o.expected_source_ids;
      if (!Array.isArray(e) || e.length === 0 || e.some((x) => typeof x !== "string")) {
        throw new Error(`${where}: in_corpus needs non-empty expected_source_ids`);
      }
      if (full) for (const id of e as string[]) if (!full.has(id)) throw new Error(`${where}: ${id} is not a mode:full manifest source`);
      q.expected_source_ids = e as string[];
    } else if (o.expected_source_ids !== undefined) {
      throw new Error(`${where}: expected_source_ids only allowed for in_corpus`);
    }
    return q;
  });
}

export function loadQuestions(path = "eval/questions.yaml", manifest?: readonly CorpusEntry[]): Question[] {
  return parseQuestions(readFileSync(path, "utf8"), manifest);
}

// ---------------------------------------------------------------- injected subject

export interface EvalCitation {
  n: number;
  sourceId: string;
  url?: string;
  /** Text of the chunk behind this citation, if the AskFn can supply it (used by judges). */
  evidence?: string;
}

/** What the subject returned for one question. Latency and cost are measured by the AskFn. */
export interface AskResult {
  answer: string;
  abstained: boolean;
  citations: EvalCitation[];
  latencyMs: number;
  /** USD for this query (0 on free tier). */
  costUsd: number;
}

export type AskFn = (question: string) => Promise<AskResult>;

export interface JudgeInput {
  question: string;
  answer: string;
  citations: EvalCitation[];
}
export interface JudgedClaim {
  claim: string;
  /** The claim is supported by at least one of the cited chunks. */
  supported: boolean;
  /** [n] markers attached to the claim; empty when uncited. */
  citedN: number[];
  /** Every cited chunk actually supports the claim. null when the claim cites nothing. */
  citationSupports: boolean | null;
}
export interface JudgeOutput {
  claims: JudgedClaim[];
}
export type JudgeFn = (input: JudgeInput) => Promise<JudgeOutput>;

// ---------------------------------------------------------------- heuristic fallback

const REF = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g;
const refsIn = (s: string): number[] => [...s.matchAll(REF)].flatMap((m) => m[1].split(",").map((x) => Number(x.trim())));

/** Substantive sentences = at least 4 words once [n] markers are removed. */
function sentences(answer: string): string[] {
  return answer
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.replace(REF, "").trim().split(/\s+/).filter(Boolean).length >= 4);
}

/**
 * Deterministic stand-in for a judge. It checks structure only, NOT truth:
 * a claim is "supported" when its sentence carries a [n] that exists in citations[];
 * a citation "supports" when n resolves to a citation whose sourceId is expected (if known).
 * It cannot tell whether a cited chunk really says what the sentence says; use a real JudgeFn for that.
 */
export function heuristicJudge(expected?: readonly string[]): JudgeFn {
  return async ({ answer, citations }) => {
    const byN = new Map(citations.map((c) => [c.n, c]));
    return {
      claims: sentences(answer).map((s) => {
        const ns = refsIn(s);
        const valid = ns.filter((n) => byN.has(n));
        return {
          claim: s,
          supported: valid.length > 0,
          citedN: ns,
          citationSupports:
            ns.length === 0
              ? null
              : valid.length === ns.length && (!expected || valid.every((n) => expected.includes(byN.get(n)!.sourceId))),
        };
      }),
    };
  };
}

// ---------------------------------------------------------------- scoring (pure)

export interface Outcome {
  q: Question;
  result?: AskResult;
  /** Set when AskFn threw; the question is excluded from rates and counted in `errors`. */
  error?: string;
  /** Judged claims for answered, non-error responses. */
  claims?: JudgedClaim[];
  judgeError?: string;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

/** Nearest-rank percentile (p in 0..100). null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(rank, s.length) - 1];
}

/** Share of judged claims supported by a cited chunk, over answered responses (abstentions excluded). */
export function groundedness(outcomes: readonly Outcome[]): number | null {
  const claims = outcomes.filter((o) => o.result && !o.result.abstained).flatMap((o) => o.claims ?? []);
  return ratio(claims.filter((c) => c.supported).length, claims.length);
}

/** Of claims that carry a citation, the share where the cited chunk really supports the claim. */
export function citationCorrectness(outcomes: readonly Outcome[]): number | null {
  const cited = outcomes.filter((o) => o.result && !o.result.abstained).flatMap((o) => o.claims ?? []).filter((c) => c.citationSupports !== null);
  return ratio(cited.filter((c) => c.citationSupports).length, cited.length);
}

/** In-corpus answers whose citations include at least one expected source. Needs no judge. */
export function expectedSourceHitRate(outcomes: readonly Outcome[]): number | null {
  const answered = outcomes.filter((o) => o.q.kind === "in_corpus" && o.result && !o.result.abstained);
  const hits = answered.filter((o) => o.result!.citations.some((c) => o.q.expected_source_ids!.includes(c.sourceId)));
  return ratio(hits.length, answered.length);
}

/**
 * Adversarial prompt passes when the subject abstained, or answered with every judged claim
 * supported (and at least one claim). The heuristic judge can only vouch structurally.
 */
export function adversarialPassed(o: Outcome): boolean {
  if (!o.result) return false;
  if (o.result.abstained) return true;
  const claims = o.claims ?? [];
  return claims.length > 0 && claims.every((c) => c.supported);
}

export interface Summary {
  counts: { total: number; in_corpus: number; out_of_corpus: number; adversarial: number; errors: number };
  groundedness: number | null;
  citation_correctness: number | null;
  /** Extra, judge-free signal: in-corpus answers citing an expected source. */
  expected_source_hit_rate: number | null;
  abstention_rate_ooc: number | null;
  false_abstention_rate: number | null;
  adversarial: { passed: number; total: number };
  latency_ms: { p50: number | null; p95: number | null };
  cost_usd: { per_query: number | null; total: number };
  /** Plan Phase 4 gate: false-abstention < 15% and OOC abstention >= 90%. */
  gate: { false_abstention_ok: boolean; ooc_abstention_ok: boolean; passed: boolean };
}

export function summarize(outcomes: readonly Outcome[]): Summary {
  const ok = outcomes.filter((o) => o.result);
  const of = (k: Kind) => ok.filter((o) => o.q.kind === k);
  const ooc = of("out_of_corpus");
  const inc = of("in_corpus");
  const adv = of("adversarial");
  const lat = ok.map((o) => o.result!.latencyMs);
  const total = ok.reduce((a, o) => a + o.result!.costUsd, 0);
  const abst = ratio(ooc.filter((o) => o.result!.abstained).length, ooc.length);
  const falseAbst = ratio(inc.filter((o) => o.result!.abstained).length, inc.length);
  const fa = falseAbst !== null && falseAbst < 0.15;
  const oa = abst !== null && abst >= 0.9;
  return {
    counts: {
      total: outcomes.length,
      in_corpus: outcomes.filter((o) => o.q.kind === "in_corpus").length,
      out_of_corpus: outcomes.filter((o) => o.q.kind === "out_of_corpus").length,
      adversarial: outcomes.filter((o) => o.q.kind === "adversarial").length,
      errors: outcomes.length - ok.length,
    },
    groundedness: groundedness(ok),
    citation_correctness: citationCorrectness(ok),
    expected_source_hit_rate: expectedSourceHitRate(ok),
    abstention_rate_ooc: abst,
    false_abstention_rate: falseAbst,
    adversarial: { passed: adv.filter(adversarialPassed).length, total: adv.length },
    latency_ms: { p50: percentile(lat, 50), p95: percentile(lat, 95) },
    cost_usd: { per_query: ratio(total, ok.length), total },
    gate: { false_abstention_ok: fa, ooc_abstention_ok: oa, passed: fa && oa },
  };
}

// ---------------------------------------------------------------- runner

export interface RunDeps {
  ask: AskFn;
  /** Omit to use the structural heuristic (see heuristicJudge). */
  judge?: JudgeFn;
}

export async function runEval(questions: readonly Question[], deps: RunDeps): Promise<{ outcomes: Outcome[]; summary: Summary }> {
  const outcomes: Outcome[] = [];
  for (const q of questions) {
    const o: Outcome = { q };
    try {
      o.result = await deps.ask(q.question);
    } catch (e) {
      o.error = e instanceof Error ? e.message : String(e);
      outcomes.push(o);
      continue;
    }
    if (!o.result.abstained) {
      try {
        const judge = deps.judge ?? heuristicJudge(q.expected_source_ids);
        o.claims = (await judge({ question: q.question, answer: o.result.answer, citations: o.result.citations })).claims;
      } catch (e) {
        o.judgeError = e instanceof Error ? e.message : String(e);
        o.claims = [];
      }
    }
    outcomes.push(o);
  }
  return { outcomes, summary: summarize(outcomes) };
}

const pct = (x: number | null): string => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");
const ms = (x: number | null): string => (x === null ? "n/a" : Math.round(x) + " ms");

export function formatReport(s: Summary, judged: "custom" | "heuristic"): string {
  return [
    "questions: " + s.counts.total + " (in-corpus " + s.counts.in_corpus + ", out-of-corpus " + s.counts.out_of_corpus + ", adversarial " + s.counts.adversarial + "), errors: " + s.counts.errors,
    "judge: " + judged + (judged === "heuristic" ? " (structural only: does NOT verify truth)" : ""),
    "groundedness:                 " + pct(s.groundedness),
    "citation-correctness:         " + pct(s.citation_correctness),
    "abstention rate (OOC):        " + pct(s.abstention_rate_ooc),
    "false-abstention (in-corpus): " + pct(s.false_abstention_rate),
    "latency p50 / p95:            " + ms(s.latency_ms.p50) + " / " + ms(s.latency_ms.p95),
    "cost per query (USD):         " + (s.cost_usd.per_query === null ? "n/a" : s.cost_usd.per_query.toFixed(6)),
    "expected-source hit rate:     " + pct(s.expected_source_hit_rate),
    "adversarial passed:           " + s.adversarial.passed + "/" + s.adversarial.total,
    "gate (FA<15%, OOC>=90%):      " + (s.gate.passed ? "PASS" : "FAIL"),
  ].join("\n");
}

// ---------------------------------------------------------------- CLI

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const impl = arg(argv, "--impl");
  if (!impl) {
    console.error("usage: npm run eval -- --impl <module exporting ask: AskFn and optional judge: JudgeFn> [--questions path]");
    return 2;
  }
  const mod = (await import(pathToFileURL(resolve(impl)).href)) as { ask?: AskFn; judge?: JudgeFn };
  if (typeof mod.ask !== "function") {
    console.error("impl module must export `ask`");
    return 2;
  }
  const { loadManifest } = await import("../src/corpus");
  const questions = loadQuestions(arg(argv, "--questions") ?? "eval/questions.yaml", loadManifest());
  const { summary } = await runEval(questions, { ask: mod.ask, judge: mod.judge });
  console.log(formatReport(summary, mod.judge ? "custom" : "heuristic"));
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
