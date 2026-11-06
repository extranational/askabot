# Corpus guide

The corpus is the product. Askabot's answer quality is bounded by what you put in
`config/corpus.yaml`, and its legal posture is bounded by how you are allowed to use it.

## Two modes

- **`full`** — the text may be stored, embedded, retrieved, paraphrased and quoted (within the
  quote cap), with the entry's attribution string rendered on every answer that uses it.
- **`pointer`** — the source must **never** be fetched, crawled, stored or embedded. It exists
  only to be named and linked in prose. The ingestion CLI produces zero upload items for a
  `pointer` entry, and a test proves it.

Use `pointer` where the terms do not permit reproduction. Do not use it as a way to dodge a
licence question on text you intend to copy.

## Manifest fields

| Field | Required | Meaning |
|---|---|---|
| `source_id` | yes | Stable slug. Appears in citations, metadata and eval expectations. Changing it orphans indexed chunks. |
| `title` | yes | Human-readable name shown in the attribution list. |
| `url` | yes | Canonical URL; also the link rendered with a citation. |
| `licence` | yes | An id from `src/licences.ts`. Unknown ids are rejected. |
| `mode` | yes | `full` or `pointer`. |
| `attribution` | yes | Exact string rendered with any answer that uses the source. |

`mode: full` requires a licence with `quote_permitted: true`. `CITE-ONLY` is valid only with
`mode: pointer`. Both rules are tested.

## Licence registry

Encoded as data in `src/licences.ts`, not prose:

| id | display name | share_alike | quote_permitted | link_required |
|---|---|---|---|---|
| `W3C-SDL-2023` | W3C Software and Document License 2023 | false | true | true |
| `IETF-TLP` | IETF Trust Legal Provisions | false | true | true |
| `US-GOV-PD` | U.S. Government work — public domain | false | true | false |
| `CC-BY-4.0` | Creative Commons Attribution 4.0 | false | true | true |
| `CC-BY-SA-4.0` | Creative Commons Attribution-ShareAlike 4.0 | **true** | true | true |
| `CITE-ONLY` | Cite and link only — no ingestion | n/a | false | true |

Adding a licence means extending the registry and its tests. Do not reuse an id for different
terms.

**Citation is not a licence.** Attribution is displayed because the licence requires it, never
as a substitute for permission to ingest.

## Answer-layer rules

- Attribution for every source actually used, rendered from the registry.
- **Quote cap: ≤ 25 words per quote, ≤ 2 quotes per source per answer.** Never chain quotes
  that would reconstruct a source.
- **Paraphrase first.** Verbatim text is reserved for the quote cap.
- `share_alike: true` sources: if an answer is a close derivative, carry a CC BY-SA 4.0
  adaptations notice. The citation assembler emits the notice; the notice page explains it.
- **Abstention runs before generation.** If the best retrieval score is below the threshold,
  return the configured message and do not call the model.

## Ingestion gates

Implemented in `src/ingest/optout.ts` as code, not convention. The gate is **fail-closed on
genuine uncertainty, not on defined answers**.

Fetch and parse:

- `robots.txt`, including named AI agents (GPTBot, CCBot, ClaudeBot, Google-Extended, …);
- `Content-Signal`;
- TDM reservation signals: HTTP header, HTML `<meta>`, `/.well-known/tdmrep.json`, `/tdm.txt`.

**Block** on:

- an explicit reservation matching the crawler or the path;
- `robots.txt` 5xx, 429, a 3xx, or a network/timeout error;
- a present-but-unreadable reservation file;
- an unparseable signal.

**Do not block** on:

- `robots.txt` 4xx other than 429. Per RFC 9309 §2.3.1.3 ("Unavailable"), that means no policy
  exists and access is allowed;
- the *absence* of a TDM reservation file. No file means no reservation.

Treating a defined "no policy exists" answer as ambiguity is a bug, not caution: it silently
drops legitimate sources.

## Documents and size limits

Binary types are **collected, not converted**. Fetch the bytes and hand them to AI Search,
which converts PDFs (including OCR for scans) natively. Do not write your own extractor.

Enforce AI Search's limits and fail closed above them:

- 4 MiB for non-OCR formats;
- 10 MiB when OCR applies.

## Provenance

Every uploaded item carries:

```json
{
  "source_id": "...",
  "source_url": "...",
  "licence": "...",
  "attribution": "...",
  "retrieval_date": "YYYY-MM-DD"
}
```

This is what makes citations auditable and removals precise. The metadata fields must be
declared on the AI Search instance (custom metadata) before upload; an undeclared field is
rejected.

## Checklist for a new corpus

1. Write the manifest with one entry per source. Every entry gets a licence verdict before it
   gets a URL.
2. For anything not clearly licensed for reuse: `pointer`, or leave it out.
3. Run `npm run ingest -- --dry-run` and review every skip.
4. Ingest, wait for indexing, then run the evaluation harness with ~20 in-corpus, ~10
   out-of-corpus and 2 adversarial questions.
5. Tune both thresholds; record the chosen values and the measured metrics in the repo.
6. Update `assistant.subject`, `abstain.message`, and the notice copy.
7. Re-run `npm run smoke` after deploy.

## Removal

When a source owner asks for removal:

1. Remove the entry from `config/corpus.yaml` (or change `mode` to `pointer` if a link is still
   acceptable).
2. Delete its items from the AI Search instance.
3. Redeploy so the bundled manifest and attribution page change.
4. Record it in a commit. Visibility is part of the promise.
