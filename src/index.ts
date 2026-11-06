import { answerQuestion } from "./answer";
import { assembleCitations } from "./citations";
import { parseConfig, type AskabotConfig } from "./config";
import { parseManifest, type CorpusEntry } from "./corpus";
import { generate, type GenEnv } from "./generate";
import { checkLimits, type KvLike } from "./limits";
import { renderNoticesPage, type NoticesDoc } from "./notices";
import { retrieve, type AiSearchInstance } from "./retrieve";

/** Bindings (wrangler.toml). The operator wires the real ones; tests inject mocks. */
export interface Env extends GenEnv {
  /** AI Search instance binding; only search() is used. */
  AI_SEARCH: AiSearchInstance;
  /** KV namespace for rate-limit and monthly counters. */
  RATE_LIMIT: KvLike;
  /** Optional: raw YAML text, used only by the default export (see src/worker.ts for the bundled entry). */
  ASKABOT_CONFIG_YAML?: string;
  ASKABOT_MANIFEST_YAML?: string;
}

export interface Runtime {
  config: AskabotConfig;
  manifest: CorpusEntry[];
  /** Approved notice copy (content/notices.yaml); required for GET /notices. */
  notices?: NoticesDoc;
  now?: () => number;
  /** Injected fetch for the external-provider path. */
  fetch?: typeof fetch;
}

export const MAX_QUESTION_CHARS = 500;
const MAX_BODY_CHARS = 8_000;

const enc = new TextEncoder();
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const errorJson = (status: number, code: string, message: string, headers: Record<string, string> = {}): Response =>
  json(status, { error: { code, message } }, headers);

async function readQuestion(request: Request): Promise<string | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > MAX_BODY_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const q = (body as { question?: unknown }).question;
  if (typeof q !== "string") return null;
  const trimmed = q.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_QUESTION_CHARS ? trimmed : null;
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
const event = (obj: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

const CORS_METHODS = "POST, OPTIONS";
const CORS_HEADERS = "content-type";
const CORS_MAX_AGE = "86400";

export function createWorker(getRuntime: (env: Env) => Runtime) {
  /** CORS wrapper for /api/chat only: exact-match allowlist from config, no wildcard, Vary: Origin always. */
  async function withCors(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    let allowlist: string[] = [];
    try {
      allowlist = getRuntime(env).config.serving.allowed_origins;
    } catch {
      /* handle() reports misconfiguration; with no allowlist no CORS header is sent */
    }
    const allowed = origin !== null && allowlist.includes(origin);

    let res: Response;
    if (request.method === "OPTIONS" && origin !== null) {
      // Preflight: answered here, before any KV / AI Search / generation access.
      res = allowed
        ? new Response(null, {
            status: 204,
            headers: {
              "access-control-allow-methods": CORS_METHODS,
              "access-control-allow-headers": CORS_HEADERS,
              "access-control-max-age": CORS_MAX_AGE,
              "cache-control": "no-store",
            },
          })
        : errorJson(403, "origin_not_allowed", "Origin not allowed.");
    } else {
      res = await handle(request, env);
    }
    if (allowed) res.headers.set("access-control-allow-origin", origin);
    res.headers.append("vary", "Origin");
    return res;
  }

  async function handle(request: Request, env: Env): Promise<Response> {
    {
      const url = new URL(request.url);

      if (url.pathname === "/healthz" && request.method === "GET") {
        return Response.json({ status: "ok" });
      }
      if (url.pathname === "/notices") {
        if (request.method !== "GET") return errorJson(405, "method_not_allowed", "Use GET.", { allow: "GET" });
        try {
          const rt = getRuntime(env);
          if (!rt.notices) throw new Error("notices not provided");
          return new Response(renderNoticesPage(rt.notices, rt.manifest), {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=300",
              "x-content-type-options": "nosniff",
            },
          });
        } catch {
          return errorJson(500, "misconfigured", "The service is not configured correctly.");
        }
      }
      if (url.pathname !== "/api/chat") return errorJson(404, "not_found", "Not found.");
      if (request.method !== "POST") return errorJson(405, "method_not_allowed", "Use POST.", { allow: "POST" });

      let rt: Runtime;
      try {
        rt = getRuntime(env);
      } catch {
        return errorJson(500, "misconfigured", "The service is not configured correctly.");
      }
      const { config, manifest } = rt;

      const question = await readQuestion(request);
      if (question === null) {
        return errorJson(400, "invalid_request", `Send JSON {"question": "..."} with 1-${MAX_QUESTION_CHARS} characters.`);
      }

      const limit = await checkLimits(env.RATE_LIMIT, request.headers.get("cf-connecting-ip"), config.serving, (rt.now ?? Date.now)());
      if (!limit.ok) {
        return errorJson(limit.status, limit.code, limit.message, limit.retryAfterSeconds ? { "retry-after": String(limit.retryAfterSeconds) } : {});
      }

      const allowed = new Set(manifest.filter((e) => e.mode === "full").map((e) => e.source_id));
      const outcome = await answerQuestion(
        {
          config,
          retrieve: (q) => retrieve(env.AI_SEARCH, q, { ...config.retrieval, reranking: config.reranking }, allowed),
          generate: (messages) => generate(messages, config.generation, env, rt.fetch),
        },
        question,
      );

      if (outcome.kind === "error") return errorJson(outcome.status, outcome.error.code, outcome.error.message);

      if (outcome.kind === "abstain") {
        return sseResponse(
          new ReadableStream({
            start(c) {
              c.enqueue(event({ token: outcome.message }));
              c.enqueue(event({ citations: [], notices: [], grounded: false, abstained: true }));
              c.close();
            },
          }),
        );
      }

      const { tokens, chunks } = outcome;
      let cancelled = false;
      return sseResponse(
        new ReadableStream({
          async start(c) {
            let answer = "";
            try {
              for await (const t of tokens) {
                if (cancelled) return;
                answer += t;
                c.enqueue(event({ token: t }));
              }
              const r = assembleCitations(answer, chunks);
              c.enqueue(
                event({
                  citations: r.citations,
                  notices: r.notices,
                  grounded: r.grounded,
                  abstained: false,
                  diagnostics: { invalid_refs: r.invalidRefs, quote_warnings: r.quoteWarnings },
                }),
              );
            } catch {
              // Whatever was streamed is incomplete: signal failure and send NO citations.
              if (!cancelled) c.enqueue(event({ error: { code: "generation_interrupted", message: "The answer was interrupted. Please try again." } }));
            }
            if (!cancelled) c.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    }
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      if (new URL(request.url).pathname === "/api/chat") return withCors(request, env);
      return handle(request, env);
    },
  };
}

/** Default export: config comes from env text vars. The bundled production entry is src/worker.ts. */
export default createWorker((env) => {
  if (!env.ASKABOT_CONFIG_YAML || !env.ASKABOT_MANIFEST_YAML) throw new Error("config not provided");
  return { config: parseConfig(env.ASKABOT_CONFIG_YAML), manifest: parseManifest(env.ASKABOT_MANIFEST_YAML) };
});
