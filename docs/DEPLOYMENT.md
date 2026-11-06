# Deployment

Everything here happens in **your** Cloudflare account and creates billable-capable resources.
The repository does not automate it. Work through the steps in order; each one produces a value
the next step needs.

## Prerequisites

- A Cloudflare account with a zone (domain) you control.
- Node.js 20+ and npm.
- Wrangler authenticated: `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the environment).
- Optional but recommended: Workers Paid, so a free-tier cliff cannot take the endpoint down.

## 1. Create the AI Search instance

In the Cloudflare dashboard: **AI → AI Search → Create**.

- Choose **built-in storage** (no R2 bucket needed).
- **The embedding model is fixed at creation.** Pick deliberately; changing it later means a
  new instance and a full re-ingest. The reference deployment used
  `@cf/qwen/qwen3-embedding-0.6b` (1,024 dims) with `@cf/baai/bge-reranker-base` for reranking.
- Enable reranking if you want the reranker threshold to drive abstention.
- Note the **instance name** and the **namespace** (normally `default`).

The instance must exist before the first ingest and before `wrangler deploy`.

## 2. Create the KV namespace

```bash
npx wrangler kv namespace create RATE_LIMIT
```

Copy the `id` into `[[kv_namespaces]]` in `wrangler.toml`.

## 3. Create the AI Gateway

Dashboard: **AI → AI Gateway → Create**. Note the gateway id (not the account id) and put it in
`[vars] AI_GATEWAY_ID`.

If you plan to use an external generation provider, enable the provider in the gateway (BYOK)
and create an authenticated-gateway token. That token becomes the `CF_AIG_TOKEN` secret in step 7.

## 4. Configure the bot

Edit `config/askabot.yaml`:

- `assistant.subject` — what the corpus is about (one clause).
- `abstain.message` — what a user sees when the corpus does not cover the question.
- `serving.allowed_origins` — the exact browser origins that will call the API.
- `generation.provider` / `model` — `workers-ai` needs no credentials; `external` needs the
  gateway token.
- Leave `retrieval.match_threshold` and `reranking.match_threshold` at the defaults until you
  have tuned them against your own corpus (`docs/EVALUATION.md`).

Edit `config/corpus.yaml` — or replace it with your sources. `config/corpus.example.yaml`
shows the minimum shape. The end-to-end procedure is `docs/BUILD-YOUR-INSTANCE.md`; the rules
are in `docs/CORPUS-GUIDE.md`.

Edit `content/notices.yaml` — it is a **template** with `[BRACKETED]` placeholders. Replace
them and review the claims against your deployment before publishing.

## 5. Ingest the corpus

Create an API token with **AI Search: Edit** for the account, then:

```bash
cp .env.example .env
# set CF_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ASKABOT_AI_SEARCH_INSTANCE
npm run ingest -- --dry-run     # per-source report: would fetch / skipped and why
npm run ingest                  # fetch, run the opt-out gate, upload with provenance
```

The dry run makes **no** uploads. Review every skip: the gate fails closed, so a blocked source
is reported rather than silently dropped.

Indexing is asynchronous. A freshly ingested source may not be retrievable for a few minutes;
do not tune thresholds against a partially indexed instance.

## 6. Fill in `wrangler.toml`

Replace every `REPLACE_*` value and the example route:

```toml
name = "askabot"
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "<from step 2>"
[[ai_search]]
binding = "AI_SEARCH"
instance_name = "<from step 1>"
[vars]
AI_GATEWAY_ID = "<from step 3>"
[[routes]]
pattern = "askabot-api.<your-domain>"
custom_domain = true
```

`custom_domain = true` makes Cloudflare create the DNS record and certificate. The hostname must
also appear in the consuming page's endpoint and in its CSP `connect-src`.

## 7. Deploy

```bash
npx wrangler deploy
# only for generation.provider = "external":
npx wrangler secret put CF_AIG_TOKEN
```

`src/worker.ts` bundles `config/*.yaml` and `content/notices.yaml` as text modules, so the
deployed Worker runs the repo's configuration exactly. A config change is a redeploy.

## 8. Verify

```bash
npm run smoke -- --endpoint https://askabot-api.<your-domain> \
  --question "a question your corpus answers" \
  --off-corpus "a question it does not"
```

The smoke test checks `/healthz`, `/notices`, a cited answer and an abstention. It is not a
quality measure — that is `npm run eval` (`docs/EVALUATION.md`).

Then check from outside your network: open the page, ask a question, follow a citation link.
Confirm the monthly ceiling trips as configured (set it low once, deliberately).

## 9. Wire the page

`ui/CorpusChat.tsx` takes an `endpoint`, a `placeholder`, a `noticeUrl` and optional
suggestions. The host page must:

- call the Worker's full URL (cross-origin is fine, given CORS);
- list that origin in `serving.allowed_origins`;
- allow the Worker host in the page's CSP `connect-src`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `500 misconfigured` on every route | `getRuntime` threw — bad YAML, missing notices, unknown config key | Run `npm run lint` and `npm test`; the parsers name the offending key. |
| Browser gets no `Access-Control-Allow-Origin` | Origin not an exact entry in `allowed_origins` (scheme/host/port must match; `www` differs from apex) | Add the exact origin. Never use `*`. |
| `403 origin_not_allowed` on preflight | Same as above; preflight is answered before any other work | Same. |
| Answers abstain on questions the corpus covers | Threshold too high, or indexing not finished, or the source was gated out | Check the ingest report, wait for indexing, then tune (`docs/EVALUATION.md`). |
| Answers ignore reranking changes | Reranking sent under `retrieval` instead of top-level `ai_search_options.reranking`; the API ignores it silently | Keep it in `config/askabot.yaml#reranking`; the parser rejects the nested form. |
| `429` from the Worker | Per-IP hourly limit | Expected. Raise `serving.rate_limit_per_ip_per_hour` only with a cost review. |
| `503` from the Worker | Monthly ceiling reached | Expected fail-closed behaviour. Raise the ceiling deliberately. |
| Custom domain stuck pending | DNS/zone mismatch | The zone must be active in the same account; check the Workers route and certificate status. |
