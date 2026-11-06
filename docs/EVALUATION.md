# Evaluation and tuning

A corpus bot that answers confidently and wrongly is worse than no bot. The evaluation harness
exists to make that failure measurable, and to choose thresholds and models on evidence.

## Question set

How to derive a set from your own topic — composition, intent mapping, refusal questions and
quality rules — is in
[`BUILD-YOUR-INSTANCE.md#5-write-the-question-set`](BUILD-YOUR-INSTANCE.md#5-write-the-question-set).
This section covers the format and what the harness expects.

`eval/questions.yaml` is a list of questions with an expected behaviour:

```yaml
- id: ic-01
  kind: in_corpus
  question: "..."
  expected_source_ids: [source-a, source-b]   # ANY-OF
- id: ooc-01
  kind: out_of_corpus
  question: "..."
- id: adv-01
  kind: adversarial
  question: "..."
```

- `in_corpus` — must be answered with citations including at least one expected source.
- `out_of_corpus` — adjacent topic the corpus does not cover; **must abstain**.
- `adversarial` — tries to elicit an unsupported claim; must abstain or answer only what cited
  chunks support.

Every `expected_source_id` must be a `mode: full` entry in the manifest. Start from the
shipped set and replace it with questions that matter for your subject — roughly 20 in-corpus,
10 out-of-corpus, 2 adversarial. Out-of-corpus questions should be *plausible* neighbours, not
obvious nonsense: they are what proves the abstention gate works.

## Harness

```bash
npm run eval -- --impl path/to/impl.ts [--questions eval/questions.yaml]
```

`impl.ts` exports:

- `ask: AskFn` — sends the question to the deployed endpoint, times it, and returns the answer
  plus citations. Credentials live here, not in the harness.
- `judge?: JudgeFn` — optional LLM judge for groundedness and citation correctness. Without it,
  the harness uses heuristics.

Reported metrics:

- **groundedness** — claims traceable to a cited chunk;
- **citation-correctness** — the cited chunk actually supports the claim;
- **abstention rate on out-of-corpus** — should be high;
- **false-abstention rate on in-corpus** — should be low;
- **p50 / p95 latency**;
- **cost per query**;
- **expected-source hit rate**;
- **adversarial pass count**;
- **gate** — `false-abstention < 15%` and `abstention-on-OOC ≥ 90%`.

Do not deploy a new corpus or model without the gate passing.

## Tuning protocol

1. Ingest fully and **wait for indexing**. A partially indexed instance produces false
   abstentions that look like a threshold problem.
2. Sweep `reranking.match_threshold` (when reranking is on) from 0.30 to 0.55 in small steps.
   The gate compares `chunks[].score`, which is the rerank score when reranking ran.
3. Plot false-abstention against abstention-on-OOC. Choose the point that clears the gate with
   the largest margin — not the single best-looking number.
4. Repeat for `retrieval.match_threshold` only if you run with reranking disabled.
5. A/B the generation model with the same question set. Change `generation.model`, redeploy,
   re-run. Record the winner and the numbers in the repo.
6. Re-run the set after any corpus change: adding sources changes the score distribution.

## Pitfalls that produced wrong conclusions before

- **Counting HTTP errors as answers.** A 429 or 5xx parsed as an empty answer looks like a
  failed citation, and a rate-limit-heavy run looks like bad grounding. Check the status code
  and content type before parsing. `scripts/smoke.ts` shows the expected shape.
- **Thresholds filtering different distributions.** With reranking on, `chunks[].score` is the
  rerank score. A `retrieval.match_threshold` that looked right was filtering vector similarity,
  not the score the gate sees. `gateThreshold()` in `src/retrieve.ts` picks the matching one.
- **Mis-placed reranking config.** `ai_search_options.reranking` is top-level. Nested under
  `retrieval`, it is silently ignored — no error, no effect. The config parser rejects the
  nested form for this reason.
- **Judging during ingestion.** Early results are not signal. Wait for the instance to report
  the source as indexed.
- **Cache.** AI Search caches similar queries for a short period. When probing a single
  question repeatedly, disable the cache per request rather than concluding the index changed.

## What "good" looks like

- In-corpus answers cite the source you expected, not merely some source.
- Out-of-corpus questions abstain with the configured message and **no** citations.
- No answer contains a citation number that does not map to a chunk.
- Quote warnings are zero; if a source is repeatedly quoted at the cap, the prompt or the
  corpus is wrong, not the model.
- Latency is dominated by generation, not retrieval. A retrieval p95 above ~1s usually means
  the instance is undersized or the query is pathological.
