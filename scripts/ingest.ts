/**
 * Ingestion CLI: manifest -> opt-out gate -> fetch -> markdown -> upload items with provenance.
 *
 *   npm run ingest -- --dry-run [--only id,id] [--offline]
 *
 * `mode: pointer` entries are never fetched and never produce an item.
 * Live upload is performed by the operator, who holds the Cloudflare credentials.
 */
import { pathToFileURL } from "node:url";
import { loadManifest, type CorpusEntry } from "../src/corpus";
import { toMarkdown } from "../src/ingest/convert";
import { checkOptOut, evaluateResponseSignals, type Fetcher } from "../src/ingest/optout";
import { uploaderFromEnv } from "./ai-search-uploader";

/** AI Search file-size limits: 4 MiB for non-OCR formats, 10 MiB when OCR applies. */
export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_BYTES_OCR = 10 * 1024 * 1024;
// Only MAX_BYTES is enforced: whether OCR will apply to a given PDF is unknowable here, and
// image formats (the OCR case) are not accepted by this CLI. Fail closed on the lower limit.
const sizeReason = (n: number): string =>
  `file size ${n} bytes exceeds AI Search limit of 4 MiB (${MAX_BYTES} bytes) (fail closed)`;

export interface UploadItem {
  key: string;
  /** Markdown text (converted from HTML) or the untouched bytes of a PDF. */
  content: string | Uint8Array;
  content_type: string;
  metadata: {
    source_id: string;
    source_url: string;
    licence: string;
    attribution: string;
    retrieval_date: string;
  };
}
export interface Uploader {
  upload(items: UploadItem[]): Promise<void>;
}
export interface Deps {
  manifest: CorpusEntry[];
  fetcher: Fetcher;
  uploader: Uploader;
  now: () => Date;
}
export interface Options {
  dryRun: boolean;
  only?: string[];
}
export interface ReportRow {
  source_id: string;
  url: string;
  licence: string;
  mode: string;
  status: "indexed" | "skipped";
  reason?: string;
}
export interface IngestResult {
  report: ReportRow[];
  items: UploadItem[];
  uploaded: boolean;
  uploadError?: string;
}

export async function runIngest(deps: Deps, opts: Options): Promise<IngestResult> {
  const { manifest, fetcher, uploader, now } = deps;
  if (opts.only) {
    const known = new Set(manifest.map((e) => e.source_id));
    for (const id of opts.only) if (!known.has(id)) throw new Error(`unknown source_id in --only: ${id}`);
  }
  const retrieval_date = now().toISOString().slice(0, 10);
  const report: ReportRow[] = [];
  const items: UploadItem[] = [];

  for (const e of manifest) {
    const row = (status: "indexed" | "skipped", reason?: string): void => {
      report.push({ source_id: e.source_id, url: e.url, licence: e.licence, mode: e.mode, status, reason });
    };

    // Pointer check comes first and short-circuits: nothing below may touch the network.
    if (e.mode !== "full") {
      row("skipped", "pointer: cite-only, never fetched or stored");
      continue;
    }
    if (opts.only && !opts.only.includes(e.source_id)) {
      row("skipped", "not selected (--only)");
      continue;
    }

    try {
      const gate = await checkOptOut(e.url, fetcher);
      if (!gate.allowed) {
        row("skipped", `opt-out gate: ${gate.reasons.join("; ")}`);
        continue;
      }

      const page = await fetcher(e.url);
      if (page.status !== 200) {
        row("skipped", `content fetch returned HTTP ${page.status} (fail closed)`);
        continue;
      }
      const contentType = (page.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const isPdf = contentType === "application/pdf";
      const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
      if (!isPdf && !isHtml && contentType !== "text/markdown" && contentType !== "text/plain") {
        row("skipped", `unsupported content-type ${JSON.stringify(contentType || "unknown")} (fail closed)`);
        continue;
      }

      // AI Search size limit, checked on the declared length before reading and again on the bytes.
      const declared = Number(page.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        row("skipped", sizeReason(declared));
        continue;
      }

      let content: string | Uint8Array;
      let storedType: string;
      let key: string;
      if (isPdf) {
        // Bytes are handed over untouched: AI Search converts PDF to markdown itself.
        const bytes = new Uint8Array(await page.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) {
          row("skipped", sizeReason(bytes.byteLength));
          continue;
        }
        const signals = evaluateResponseSignals(page.headers);
        if (!signals.allowed) {
          row("skipped", `opt-out gate (content response): ${signals.reasons.join("; ")}`);
          continue;
        }
        content = bytes;
        storedType = "application/pdf";
        key = `${e.source_id}.pdf`;
      } else {
        const body = await page.text();
        const size = new TextEncoder().encode(body).byteLength;
        if (size > MAX_BYTES) {
          row("skipped", sizeReason(size));
          continue;
        }
        const signals = evaluateResponseSignals(page.headers, isHtml ? body : "");
        if (!signals.allowed) {
          row("skipped", `opt-out gate (content response): ${signals.reasons.join("; ")}`);
          continue;
        }
        content = toMarkdown(body, contentType);
        storedType = "text/markdown";
        key = `${e.source_id}.md`;
      }
      if (content.length === 0) {
        row("skipped", "content is empty");
        continue;
      }
      items.push({
        key,
        content,
        content_type: storedType,
        metadata: {
          source_id: e.source_id,
          source_url: e.url,
          licence: e.licence,
          attribution: e.attribution,
          retrieval_date,
        },
      });
      row("indexed");
    } catch (err) {
      row("skipped", `${(err as Error).message}`.replace(/^/, "error: ") + " (fail closed)");
    }
  }

  const result: IngestResult = { report, items, uploaded: false };
  if (!opts.dryRun && items.length > 0) {
    try {
      await uploader.upload(items);
      result.uploaded = true;
    } catch (err) {
      result.uploadError = (err as Error).message;
      for (const r of report) {
        if (r.status === "indexed") {
          r.status = "skipped";
          r.reason = `upload failed: ${result.uploadError}`;
        }
      }
    }
  }
  return result;
}

export function formatReport(r: IngestResult, dryRun: boolean): string {
  const indexed = r.report.filter((x) => x.status === "indexed").length;
  const lines = [
    `Ingestion report${dryRun ? " (dry-run: nothing uploaded)" : ""}`,
    `${indexed} indexed, ${r.report.length - indexed} skipped, ${r.report.length} manifest entries`,
    "",
  ];
  for (const x of r.report) {
    const tag = x.status === "indexed" ? (dryRun ? "INDEXED (dry-run)" : "INDEXED") : "SKIPPED";
    lines.push(`${tag.padEnd(18)} ${x.source_id}  [${x.licence}, ${x.mode}]`);
    if (x.reason) lines.push(`${"".padEnd(18)} reason: ${x.reason}`);
  }
  if (r.uploadError) lines.push("", `UPLOAD ERROR: ${r.uploadError}`);
  return lines.join("\n");
}

export interface CliArgs {
  dryRun: boolean;
  offline: boolean;
  only?: string[];
  manifest: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { dryRun: false, offline: false, manifest: "config/corpus.yaml" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--offline") a.offline = true;
    else if (arg === "--only") a.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--manifest") a.manifest = argv[++i] ?? a.manifest;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (a.offline && !a.dryRun) throw new Error("--offline requires --dry-run");
  return a;
}

/**
 * Real fetcher for operator runs. The User-Agent identifies the crawler and should carry a
 * contact URL for the site you are ingesting from; set INGEST_UA_CONTACT to your own.
 */
export const liveFetcher: Fetcher = (url, init) =>
  fetch(url, {
    method: init?.method ?? "GET",
    redirect: "follow",
    headers: { "user-agent": `askabot-ingest/0.1 (+${process.env.INGEST_UA_CONTACT ?? "https://example.com"})` },
    signal: AbortSignal.timeout(20_000),
  });

/** --offline: no network at all; everything fails closed. */
const offlineFetcher: Fetcher = async () => {
  throw new Error("network disabled (--offline)");
};

/** Used ONLY for --dry-run. Live uploads build a real uploader from the environment. */
const unimplementedUploader: Uploader = {
  async upload() {
    throw new Error(
      "internal: the dry-run uploader must never be called (dry-run skips the upload entirely)",
    );
  },
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runIngest(
    {
      manifest: loadManifest(args.manifest),
      fetcher: args.offline ? offlineFetcher : liveFetcher,
      uploader: args.dryRun ? unimplementedUploader : uploaderFromEnv(),
      now: () => new Date(),
    },
    { dryRun: args.dryRun, only: args.only },
  );
  console.log(formatReport(result, args.dryRun));
  if (result.uploadError) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  });
}
