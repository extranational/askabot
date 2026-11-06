# Askabot

A corpus-grounded question-and-answer bot you can point at any body of knowledge.

Askabot is a small Cloudflare Worker plus the tooling around it: a declarative corpus manifest,
a licence-aware ingestion CLI, a retrieval → abstention → generation pipeline, citation
assembly, a framework-agnostic chat component, and an evaluation harness. The corpus is
configuration, not code — swapping subjects means replacing `config/corpus.yaml` and re-ingesting.

The shipped example corpus is passkeys / WebAuthn, because it is a good stress test: the
sources are authoritative, the licences differ, and a wrong answer is obviously wrong.

**Start here:** [`docs/BUILD-YOUR-INSTANCE.md`](docs/BUILD-YOUR-INSTANCE.md) walks from a
topic to a deployed bot — choosing sources, writing the manifest, ingesting, and authoring your
own question set. The rest of this README is the orientation.

## What is in the repo, and what is not

Included: the Worker and its tooling, the corpus **definition** (`config/corpus.yaml` — source
URLs, licences, attribution), a starter question set, and the documentation.

Not included: any source document, chunk, embedding or index. The example deployment's corpus
lives in its own Cloudflare AI Search instance. "Ingesting" means the CLI fetches the URLs in
your manifest and uploads them to **your** instance; the repository never stores the text. That
is also why a corpus change is reproducible from the manifest rather than from a binary snapshot.

## What it guarantees

1. **Grounded or silent.** Answers are generated only from retrieved chunks. If the best chunk
   scores below the configured threshold, the Worker returns a canned abstention and **never
   calls the model**.
2. **Every claim cited.** The prompt requires `[n]` citations; the Worker maps them back to the
   chunks actually used and returns structured `citations[]` with URL, licence and attribution.
3. **Licences enforced as data.** Each source carries a licence id; the registry decides whether
   text may be stored or quoted, and whether a ShareAlike notice is required. `pointer` sources
   are never fetched.
4. **Config, not code.** Corpus, thresholds, model, rate limits and the abstention message live
   in YAML. The grounding rules do not — a corpus swap cannot weaken them.

## Quick start

```bash
npm install
npm test                 # 300+ unit tests, no network
npm run lint             # tsc --noEmit
```

Then read [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) to stand up the Cloudflare resources. The
short version:

```bash
cp .env.example .env                  # fill in account id + API token
# create the AI Search instance, KV namespace and AI Gateway (docs/DEPLOYMENT.md)
# edit config/askabot.yaml and wrangler.toml
npm run ingest -- --dry-run           # per-source report, no upload
npm run ingest                        # fetch, gate, convert, upload
npx wrangler deploy
npm run smoke -- --endpoint https://askabot-api.example.com
```

## Pointing it at your corpus

The full procedure is [`docs/BUILD-YOUR-INSTANCE.md`](docs/BUILD-YOUR-INSTANCE.md). In short:

1. Replace `config/corpus.yaml` with your sources. `config/corpus.example.yaml` shows the shape.
2. Set `assistant.subject` and `abstain.message` in `config/askabot.yaml`.
3. Re-ingest into a **new** AI Search instance (the embedding model is fixed at instance
   creation), update `wrangler.toml`, deploy.
4. Write your own `eval/questions.yaml` and tune the thresholds — see
   [`docs/EVALUATION.md`](docs/EVALUATION.md).

[`docs/CORPUS-GUIDE.md`](docs/CORPUS-GUIDE.md) is the reference for licensing, the opt-out
gate, provenance and the quote cap.

## Documentation

- [`docs/BUILD-YOUR-INSTANCE.md`](docs/BUILD-YOUR-INSTANCE.md) — topic → corpus → questions → deploy.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the pipeline works and what is invariant.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Cloudflare resources, configuration, verification.
- [`docs/CORPUS-GUIDE.md`](docs/CORPUS-GUIDE.md) — source selection, licences, ingestion gates.
- [`docs/EVALUATION.md`](docs/EVALUATION.md) — metrics, question-set design, threshold tuning.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — cost, limits, privacy, incidents.

## Repository layout

```
config/askabot.yaml        runtime config: thresholds, model, limits, CORS, abstention copy
config/corpus.yaml         the corpus manifest (sources, licences, modes, attribution)
config/corpus.example.yaml minimal manifest template
content/notices.yaml       public notice copy rendered at GET /notices (template — review it)
src/                       Worker: retrieval, abstention, prompt, generation, citations, limits
src/ingest/                opt-out gate and document conversion
scripts/ingest.ts          corpus → AI Search ingestion CLI
scripts/eval.ts            evaluation harness (groundedness, citation correctness, abstention)
scripts/smoke.ts           post-deploy live checks
ui/CorpusChat.tsx          framework-agnostic chat component (React)
eval/questions.yaml        example question set
docs/                      architecture, build guide, deployment, corpus, evaluation, operations
```

## API

`POST /api/chat` with `{"question": "..."}` returns `text/event-stream`:

```
data: {"token":"A passkey is "}
...
data: {"citations":[{n,chunkId,sourceId,url,licence,licenceName,attribution,shareAlike,linkRequired}],
       "notices":[],"grounded":true,"abstained":false}
```

`GET /healthz` → `{"status":"ok"}`. `GET /notices` → the rendered notice and per-source
attribution list.

## Cost

At demo volume the stack runs on free tiers: AI Search includes 1,000 semantic + 1,000
full-text queries/month, 5M ingestion tokens and 10 GB storage; Workers AI includes 10,000
neurons/day. The Worker also enforces a per-IP hourly limit and a hard monthly query ceiling,
so a public endpoint cannot run away. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Status

Reference implementation, extracted from a working deployment. The code is complete and tested;
the deployment steps are documented but deliberately not automated, because they create billable
resources in your account. `content/notices.yaml` is a template, not legal advice — review it
against what your deployment actually does before publishing.

## Licence

No open-source licence is included. Add one before publishing if you intend others to reuse the
code.
