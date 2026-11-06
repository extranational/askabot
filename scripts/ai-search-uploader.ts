/**
 * Live AI Search uploader: the operator half of ingestion.
 *
 * scripts/ingest.ts deliberately ships an unimplemented uploader so that no test, and no
 * harness run, can ever put bytes into the live index. This module supplies the real one,
 * and is only constructed when the CLI is run without --dry-run AND credentials are present.
 *
 * Wire format, established empirically against the live API rather than from the docs alone:
 *
 *   POST /accounts/{acct}/ai-search/namespaces/{ns}/instances/{id}/items   (multipart)
 *     file      the document. Its FILENAME becomes the item key, and the key is not
 *               otherwise settable -- so the filename must be `{source_id}.md` / `.pdf`,
 *               which is the convention src/retrieve.ts documents.
 *     metadata  a JSON string of the provenance fields. These are retained only because
 *               the instance declares them in `custom_metadata`; an undeclared field is
 *               dropped with a `custom_metadata_field_not_filterable` warning.
 *
 * TWO TRAPS, both of which cost real time to find:
 *
 *  1. `metadata` reads back as null at upload time and for some seconds after. It appears
 *     once indexing starts. A null metadata immediately after upload is NOT a failure --
 *     do not "fix" it by changing the request.
 *  2. Passing the document as a JSON-valued form field (`-F file='{"file":...}'`, which is
 *     what the API reference's example shows) fails with `file_field_is_required`. A real
 *     multipart file part is mandatory.
 */
import type { UploadItem, Uploader } from "./ingest";

export interface AiSearchUploaderConfig {
  accountId: string;
  token: string;
  instance?: string;
  namespace?: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Override with ASKABOT_AI_SEARCH_INSTANCE; must match wrangler.toml's instance_name. */
export const DEFAULT_INSTANCE = "askabot";
export const DEFAULT_NAMESPACE = "default";

export class MissingCredentialsError extends Error {}

/** Build from the environment, or explain precisely what is missing. */
export function uploaderFromEnv(env: NodeJS.ProcessEnv = process.env): Uploader {
  const token = env.CF_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const missing = [
    !token && "CF_API_TOKEN",
    !accountId && "CLOUDFLARE_ACCOUNT_ID",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new MissingCredentialsError(
      `live upload needs ${missing.join(" and ")} in the environment; ` +
        `use --dry-run to exercise everything except the upload`,
    );
  }
  return createAiSearchUploader({
    accountId: accountId as string,
    token: token as string,
    instance: env.ASKABOT_AI_SEARCH_INSTANCE,
    namespace: env.ASKABOT_AI_SEARCH_NAMESPACE,
  });
}

export function createAiSearchUploader(cfg: AiSearchUploaderConfig): Uploader {
  const namespace = cfg.namespace || DEFAULT_NAMESPACE;
  const instance = cfg.instance || DEFAULT_INSTANCE;
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}` +
    `/ai-search/namespaces/${namespace}/instances/${instance}/items`;
  const doFetch = cfg.fetchImpl ?? fetch;

  return {
    async upload(items: UploadItem[]): Promise<void> {
      for (const it of items) {
        const body = new FormData();
        // A Blob, not a string: the multipart file part is required, and its filename is
        // what becomes the item key.
        const blob = new Blob([it.content as BlobPart], { type: it.content_type });
        body.append("file", blob, it.key);
        body.append("metadata", JSON.stringify(it.metadata));

        const res = await doFetch(url, {
          method: "POST",
          // No content-type header: FormData sets its own boundary.
          headers: { authorization: `Bearer ${cfg.token}` },
          body,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(
            `AI Search upload failed for ${it.key}: HTTP ${res.status} ${detail.slice(0, 300)}`,
          );
        }
      }
    },
  };
}
