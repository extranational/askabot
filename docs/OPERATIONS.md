# Operations

## Cost

Verified against Cloudflare's published pricing at build time (2026-10). Re-check before
relying on it.

- AI Search free tier: **1,000 semantic + 1,000 full-text queries/month**, 5M ingestion tokens,
  10 GB storage.
- Workers AI free tier: **10,000 neurons/day**, reset 00:00 UTC.
- Beyond that, AI Search and Workers AI bill per unit; the practical floor is the Workers Paid
  base plan.
- AI Gateway itself is not the cost driver; the generation tokens are.

Askabot enforces two independent brakes: a per-IP hourly limit and a hard monthly query
ceiling. Both are in `config/askabot.yaml` and both fail closed. A public demo at hundreds to a
few thousand queries a month typically runs at $0.

Budget the corpus, not the queries: ingestion tokens and storage matter when you ingest large
PDFs, and re-ingesting the whole corpus to fix one source is the usual waste.

## Rate limits and ceilings

| Key | Source | Failure |
|---|---|---|
| Per-IP hourly | truncated SHA-256 of `cf-connecting-ip`, TTL ~2h | `429` with `retry-after` |
| Monthly total | counter with no address information | `503` with a clear message |

Neither counter is a question history. Do not turn them into one.

## Monitoring

Minimum:

- `GET /healthz` from an external monitor.
- A synthetic question daily (`npm run smoke`), which catches a broken index, a dead model or a
  CORS regression.
- Cloudflare analytics for Worker errors and AI Search query volume.
- The AI Gateway log for latency and provider failures.

Alert on sustained 5xx, not on a single abstention. Abstention is a feature.

## Privacy and retention

What the application keeps:

- no question or session history;
- a rate-limit key: truncated SHA-256 of the IP, short TTL;
- a monthly total: no address information.

What the platform keeps:

- **AI Gateway retains request and response bodies** in a rolling log (reference deployment:
  100,000 entries, oldest discarded). Abstentions and pre-generation failures never reach the
  gateway.
- Cloudflare's own request logs and analytics under its terms.

If you publish a notice, describe both layers. The failure mode to avoid is claiming "we store
nothing" because the application is stateless, while the gateway retains the prompt and the
answer. `content/notices.yaml` is written with this distinction — keep it if it is still true,
change it if your configuration differs.

## Changing the model

Generation is swappable without a reindex:

1. Set `generation.model` (and `provider` if switching to an external provider).
2. For `external`, put the gateway token in `CF_AIG_TOKEN` (`wrangler secret put`) and set
   `CF_ACCOUNT_ID`.
3. Redeploy.
4. Re-run the evaluation set. A model change can move both groundedness and abstention
   behaviour; the threshold may need re-tuning.

Changing the **embedding model** is not a config change: it requires a new AI Search instance
and a full re-ingest.

## Re-ingesting and index hygiene

- Ingestion is idempotent per source id, but re-uploading a changed source can leave stale
  chunks. Delete the source's items before re-uploading if the document changed substantially.
- Keep `source_id` stable. Renaming it orphans chunks that will still be retrievable but can no
  longer be attributed correctly.
- After any corpus change, redeploy (the manifest is bundled) and re-run the eval set.

## Key rotation

- `CF_API_TOKEN` (ingestion) lives only in the operator environment, never in the Worker.
- `CF_AIG_TOKEN` (external generation) is a Wrangler secret. Rotate it in the gateway and with
  `wrangler secret put`, then redeploy.
- The Worker's KV and AI Search bindings need no secrets.

## Incident playbook

**Bad answer reported**

1. Reproduce the exact question with `npm run smoke -- --question "..."` (or curl the SSE
   endpoint).
2. Inspect the returned citations. If the answer has no citations, that is a defect, not a
   quality opinion.
3. If the cited chunk does not support the claim, the prompt contract failed: check the model
   and the chunk text. If the chunk itself is wrong, fix the corpus.
4. If retrieval returned the wrong source, the corpus or threshold is wrong.

**Endpoint down**

1. `/healthz` — is it the Worker or the route?
2. Check the deploy version and the custom-domain certificate.
3. Check AI Search instance status and the AI Gateway.
4. If the monthly ceiling tripped, that is working as designed; raise it deliberately.

**Source removal request**

Follow `docs/CORPUS-GUIDE.md#removal`. Remove from the manifest, delete indexed items, redeploy,
record the commit. Do not leave the chunks in place while removing the attribution.

## What not to do

- Do not gate the Worker itself with Cloudflare Access while a browser page calls it
  cross-origin: the Access cookie and audience will not match, and the fetch fails.
- Do not put a wildcard in `allowed_origins`. The rate limit is per-IP, so any site could spend
  your budget from its visitors' browsers.
- Do not raise the monthly ceiling to "fix" a 503 without looking at who is calling and why.
- Do not treat a passing smoke test as evidence of quality. It checks plumbing.
