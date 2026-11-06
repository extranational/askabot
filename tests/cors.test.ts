import { describe, expect, it, vi } from "vitest";
import { createWorker, type Env, type Runtime } from "../src/index";
import { loadConfig, parseConfig } from "../src/config";
import { loadManifest } from "../src/corpus";

const config = loadConfig("config/askabot.yaml");
const manifest = loadManifest("config/corpus.yaml");
const rt: Runtime = { config, manifest, now: () => Date.UTC(2026, 9, 13, 12, 0, 0) };
const worker = createWorker(() => rt);

const OK_ORIGIN = "https://www.example.com";
const URL_CHAT = "https://askabot-api.example.com/api/chat";

function makeEnv(store = new Map<string, string>()) {
  const kv = { get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)) };
  const search = vi.fn(async () => ({ chunks: [] })); // no chunks => abstain, no generation
  const run = vi.fn();
  const env = { AI_SEARCH: { search }, AI: { run }, RATE_LIMIT: kv, AI_GATEWAY_ID: "gw" } as unknown as Env;
  return { env, kv, search, run };
}

const post = (origin?: string) =>
  new Request(URL_CHAT, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9", ...(origin ? { origin } : {}) },
    body: JSON.stringify({ question: "What is a passkey?" }),
  });
const options = (origin?: string, path = "/api/chat") =>
  new Request("https://askabot-api.example.com" + path, {
    method: "OPTIONS",
    headers: { ...(origin ? { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } : {}) },
  });

describe("shipped allowlist", () => {
  it("contains exactly the page origins plus localhost, and no wildcard", () => {
    expect(config.serving.allowed_origins).toEqual([
      "https://www.example.com",
      "https://example.com",
      "http://localhost:3000",
    ]);
    expect(config.serving.allowed_origins).not.toContain("*");
  });
});

describe("responses to /api/chat", () => {
  it("echoes an allowlisted origin on the successful SSE response, with Vary: Origin", async () => {
    const res = await worker.fetch(post(OK_ORIGIN), makeEnv().env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe(OK_ORIGIN);
    expect(res.headers.get("vary")).toContain("Origin");
    expect(await res.text()).toContain("abstained"); // body still streams intact
  });

  it("echoes each allowlisted origin, including localhost", async () => {
    for (const o of config.serving.allowed_origins) {
      expect((await worker.fetch(post(o), makeEnv().env)).headers.get("access-control-allow-origin")).toBe(o);
    }
  });

  it.each([
    ["a disallowed origin", "https://evil.example"],
    ["a look-alike suffix", "https://www.example.com.evil.example"],
    ["the same host on http", "http://www.example.com"],
    ["the literal null origin", "null"],
  ])("gives %s no Access-Control-Allow-Origin (but still Vary)", async (_n, origin) => {
    const res = await worker.fetch(post(origin), makeEnv().env);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("gives a request with no Origin no Access-Control-Allow-Origin", async () => {
    const res = await worker.fetch(post(), makeEnv().env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("never emits a wildcard", async () => {
    for (const o of [OK_ORIGIN, "https://evil.example", undefined]) {
      expect((await worker.fetch(post(o), makeEnv().env)).headers.get("access-control-allow-origin")).not.toBe("*");
    }
  });

  it("error responses still carry allow-origin: 400, monthly-ceiling 503, 429", async () => {
    const bad = new Request(URL_CHAT, { method: "POST", headers: { origin: OK_ORIGIN }, body: "not json" });
    const r400 = await worker.fetch(bad, makeEnv().env);
    expect(r400.status).toBe(400);
    expect(r400.headers.get("access-control-allow-origin")).toBe(OK_ORIGIN);

    const full = new Map([["mc:2026-10", String(config.serving.monthly_query_ceiling)]]);
    const r503 = await worker.fetch(post(OK_ORIGIN), makeEnv(full).env);
    expect(r503.status).toBe(503);
    expect(r503.headers.get("access-control-allow-origin")).toBe(OK_ORIGIN);
    expect(((await r503.json()) as { error: { message: string } }).error.message).toMatch(/monthly/i);

    const { env } = makeEnv();
    for (let i = 0; i < config.serving.rate_limit_per_ip_per_hour; i++) await worker.fetch(post(OK_ORIGIN), env);
    const r429 = await worker.fetch(post(OK_ORIGIN), env);
    expect(r429.status).toBe(429);
    expect(r429.headers.get("access-control-allow-origin")).toBe(OK_ORIGIN);
  });

  it("the existing 405 for non-POST keeps working and is CORS-readable for an allowed origin", async () => {
    const res = await worker.fetch(new Request(URL_CHAT, { method: "GET", headers: { origin: OK_ORIGIN } }), makeEnv().env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("access-control-allow-origin")).toBe(OK_ORIGIN);
  });
});

describe("preflight", () => {
  it("allowlisted origin: 204 with exactly the four CORS headers, and no binding is touched", async () => {
    const { env, kv, search, run } = makeEnv();
    const res = await worker.fetch(options(OK_ORIGIN), env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(OK_ORIGIN);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(await res.text()).toBe("");
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("disallowed origin: 403, no allow-origin, bindings untouched", async () => {
    const { env, kv, search } = makeEnv();
    const res = await worker.fetch(options("https://evil.example"), env);
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(kv.get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("OPTIONS with no Origin keeps the previous 405", async () => {
    const res = await worker.fetch(options(), makeEnv().env);
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("with an empty allowlist nothing is allowed (fail closed)", async () => {
    const closed = createWorker(() => ({ ...rt, config: { ...config, serving: { ...config.serving, allowed_origins: [] } } }));
    expect((await closed.fetch(options(OK_ORIGIN), makeEnv().env)).status).toBe(403);
    expect((await closed.fetch(post(OK_ORIGIN), makeEnv().env)).headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("unchanged behaviour elsewhere", () => {
  it("OPTIONS on an unknown path is still 404, with no CORS headers", async () => {
    const res = await worker.fetch(options(OK_ORIGIN, "/nope"), makeEnv().env);
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("/healthz is unchanged", async () => {
    const res = await worker.fetch(new Request("https://x.test/healthz", { headers: { origin: OK_ORIGIN } }), makeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("a runtime that fails to load still returns 500 and /healthz still works", async () => {
    const broken = createWorker(() => {
      throw new Error("boom");
    });
    expect((await broken.fetch(post(OK_ORIGIN), makeEnv().env)).status).toBe(500);
    expect((await broken.fetch(new Request("https://x.test/healthz"), makeEnv().env)).status).toBe(200);
  });
});

describe("allowed_origins config validation", () => {
  const base = `
corpus_manifest: config/corpus.yaml
assistant: {subject: x}
retrieval: {max_num_results: 8, match_threshold: 0.4}
reranking: {enabled: true, model: m, match_threshold: 0.4}
generation: {provider: workers-ai, model: m, max_tokens: 9, temperature: 0.1}
serving:
  rate_limit_per_ip_per_hour: 20
  monthly_query_ceiling: 3000
`;
  const withOrigins = (list: string) => parseConfig(base + list + "abstain: {message: x}\n");
  it("defaults to no origins when omitted", () => {
    expect(withOrigins("").serving.allowed_origins).toEqual([]);
  });
  it.each(["'*'", "https://a.test/", "https://a.test/path", "a.test", "ftp://a.test", "'null'"])("rejects %s", (bad) => {
    expect(() => withOrigins(`  allowed_origins: [${bad}]\n`)).toThrow(/allowed_origins/);
  });
  it("accepts exact origins with ports", () => {
    expect(withOrigins("  allowed_origins: ['http://localhost:3000', 'https://a.test']\n").serving.allowed_origins).toHaveLength(2);
  });
});
