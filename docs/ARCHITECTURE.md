# Architecture

## Pipeline

```
[Browser]
  chat component (ui/CorpusChat.tsx)
      │ POST /api/chat {question}          streamed SSE
      ▼
[Cloudflare Worker]
  1. CORS allowlist + request validation
  2. rate limit (KV, per hashed IP) + monthly ceiling (KV)
  3. retrieve → AI Search instance (hybrid, optional rerank)
  4. ABSTENTION GATE — best score < threshold → canned answer, NO model call
  5. build prompt: numbered chunks [1..n], fixed grounding rules
  6. generate → AI Gateway → Workers AI (or external provider via BYOK)
  7. stream tokens, then citations[] derived from the chunks actually referenced
      ▼
[Browser]
  answer + numbered citations per source + licence/attribution lines
```

## Components

| Module | Responsibility |
|---|---|
| `src/worker.ts` | Production entry. Bundles `config/*.yaml` and `content/notices.yaml` as text modules, so the deployed Worker runs exactly what is in the repo. |
| `src/index.ts` | Routing, CORS, request validation, limit checks, SSE orchestration, `/healthz`, `/notices`. |
| `src/retrieve.ts` | AI Search call, response mapping to `Chunk[]`, provenance fields, threshold selection (`gateThreshold`). |
| `src/abstain.ts` | The gate. Pure and synchronous — takes no generation function, so it cannot call one. Fails closed. |
| `src/prompt.ts` | Fixed grounding contract with a configurable subject line. Fences chunk text so it cannot impersonate instructions. |
| `src/generate.ts` | Workers AI or any AI-Gateway chat-completions provider. Model and params come from config. |
| `src/citations.ts` | Maps `[n]` back to chunks, de-duplicates by source, renders attribution and ShareAlike notice, reports invalid refs and quote-cap warnings. |
| `src/limits.ts` | Per-IP hourly limit (truncated SHA-256 key, short TTL) and monthly query counter. |
| `src/licences.ts` | Licence registry as data: display name, attribution template, `share_alike`, `quote_permitted`, `link_required`. |
| `src/corpus.ts` | Manifest loader and validation. |
| `src/notices.ts` | Renders `content/notices.yaml` and the generated per-source attribution list. |
| `src/ingest/` | Opt-out gate (`robots.txt`, Content-Signal, TDM) and binary/document collection. |
| `scripts/ingest.ts` | CLI: manifest → gate → fetch → upload to AI Search with provenance metadata. |
| `scripts/eval.ts` | Scoring harness. Measures; never calls a model itself (the caller injects `ask`). |
| `ui/CorpusChat.tsx` | React component. SSE parsing, citation grouping, error/abstain states. |

## Invariants

These are load-bearing and covered by tests. Do not relax them when adapting the project.

1. **No model call on abstention.** `answerQuestion` reaches `generate` only on the
   `abstain: false` branch. A test injects a spy and asserts zero calls.
2. **No answer without citations.** Every substantive claim must carry `[n]`; the citation
   assembler drops numbers that do not map to a chunk and reports them as invalid refs.
3. **`pointer` sources produce zero upload items.** The ingestion CLI and its tests enforce it.
4. **Unknown config keys are rejected.** A typo cannot silently disable a limit.
5. **CORS is an exact allowlist.** Never `*`: the rate limit is per-IP, so a wildcard would let
   any site spend your monthly budget from visitors' browsers.

## Retrieval and thresholds

Cloudflare AI Search does ingest → markdown → chunk → embed → index → hybrid retrieve. Askabot
owns the answer pipeline on top: gating, grounding, citations, limits and evaluation.

Two thresholds exist and they filter different score distributions:

- `retrieval.match_threshold` filters **vector similarity**.
- `reranking.match_threshold` filters the **rerank score**.

When reranking is on, `chunks[].score` **is** the reranking score, so the abstention gate uses
the reranking threshold. `src/retrieve.ts#gateThreshold` picks the matching one from config.
The reranking block must be sent per request as top-level `ai_search_options.reranking`; a
field nested inside `retrieval` is **silently ignored** by AI Search. The config parser
therefore rejects `retrieval.rerank`.

Both values are corpus-specific. Do not assume the shipped 0.4 is right for your corpus — tune
it with the evaluation harness (`docs/EVALUATION.md`).

## Generation

`generation.provider` selects the path:

- `workers-ai` — the `AI` binding, parameters from config.
- `external` — an AI Gateway chat-completions call with `CF_ACCOUNT_ID` and `CF_AIG_TOKEN`
  (a Wrangler secret). Any provider behind the gateway works, so the model is swappable without
  a reindex.

The **embedding model is fixed at AI Search instance creation**. That is the one real lock-in:
changing it means a new instance and a full re-ingest. Generation is not locked in.

## Privacy and retention

The application keeps no question history. It keeps two counters: a per-IP rate-limit key
(a truncated SHA-256 hash, short TTL) and a monthly total. However, Cloudflare AI Gateway
retains request and response bodies in a rolling log; abstentions and pre-generation failures
never reach it. If you publish a privacy notice, disclose the gateway log — do not claim
"we store nothing" because the application does not. `content/notices.yaml` is written with
that distinction; review it against your own configuration.

## Design decisions

- **Managed retrieval over a self-hosted vector DB.** AI Search removes chunk/embed/index work
  and keeps the corpus in one place. The cost is embedding lock-in and less control over
  chunking — accepted, because the differentiator here is the answer contract, not the index.
- **Abstention before generation.** Saves cost and makes "no unsupported answer" structural
  rather than a prompt hope.
- **Attribution generated from the manifest.** The notice page cannot drift from the corpus
  because the source list is rendered from `config/corpus.yaml` at request time.
- **Config bundled at build time.** The deployed Worker cannot disagree with the repo.
