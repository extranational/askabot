import { describe, expect, it, vi } from "vitest";
import { createWorker, type Env, type Runtime } from "../src/index";
import { loadConfig } from "../src/config";
import { gateThreshold } from "../src/retrieve";
import { loadManifest } from "../src/corpus";
import type { KvLike } from "../src/limits";

const config = loadConfig("config/askabot.yaml");
const manifest = loadManifest("config/corpus.yaml");
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const rt: Runtime = { config, manifest, now: () => NOW };
const worker = createWorker(() => rt);

const meta = (id: string, licence: string, over: Record<string, unknown> = {}) => ({
  source_id: id,
  source_url: `https://example.test/${id}`,
  licence,
  attribution: `Attribution for ${id}`,
  retrieval_date: "2026-10-13",
  ...over,
});
const rawChunk = (id: string, licence: string, score: number, text = `Text from ${id}.`) => ({
  id: `chunk-${id}`,
  text,
  score,
  item: { key: `${id}.md`, metadata: meta(id, licence), timestamp: 1 },
});

// source ids that exist in the manifest (retrieval filters on them)
const W3C = "w3c-webauthn-3";
const NIST = "nist-sp800-63b-4";
const WIKI = "wikipedia-passkey";

const sse = (...events: object[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`));
      c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      c.close();
    },
  });

function fakeKv(): KvLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return { store, get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) };
}

function makeEnv(opts: { chunks?: unknown[]; tokens?: string[]; search?: () => Promise<unknown>; run?: () => Promise<unknown>; kv?: KvLike } = {}) {
  const search = vi.fn(opts.search ?? (async () => ({ chunks: opts.chunks ?? [] })));
  const run = vi.fn(opts.run ?? (async () => sse(...(opts.tokens ?? ["ok"]).map((t) => ({ response: t })))));
  const kv = opts.kv ?? fakeKv();
  const env = { AI_SEARCH: { search }, AI: { run }, RATE_LIMIT: kv, AI_GATEWAY_ID: "gw" } as unknown as Env;
  return { env, search, run, kv };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://askabot.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function events(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)));
}

describe("routes", () => {
  it("GET /healthz still returns 200 {status:'ok'}", async () => {
    const res = await worker.fetch(new Request("https://askabot.test/healthz"), makeEnv().env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/chat is 405 with Allow: POST", async () => {
    const res = await worker.fetch(new Request("https://askabot.test/api/chat"), makeEnv().env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("other methods on /api/chat are 405", async () => {
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(new Request("https://askabot.test/api/chat", { method }), makeEnv().env);
      expect(res.status).toBe(405);
    }
  });

  it("unknown routes are 404", async () => {
    expect((await worker.fetch(new Request("https://askabot.test/nope"), makeEnv().env)).status).toBe(404);
  });

  it("a misconfigured runtime is a generic 500 and /healthz still works", async () => {
    const broken = createWorker(() => {
      throw new Error("secret parse detail");
    });
    const res = await broken.fetch(post({ question: "q" }), makeEnv().env);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret parse detail");
    expect((await broken.fetch(new Request("https://askabot.test/healthz"), makeEnv().env)).status).toBe(200);
  });
});

describe("POST /api/chat validation", () => {
  it.each([
    ["missing question", {}],
    ["null question", { question: null }],
    ["numeric question", { question: 5 }],
    ["empty question", { question: "" }],
    ["whitespace question", { question: "   " }],
    ["array body", ["q"]],
    ["non-JSON body", "not json"],
    ["overlong question", { question: "x".repeat(501) }],
  ])("400 on %s, with no search, no generation and no quota consumed", async (_n, body) => {
    const { env, search, run, kv } = makeEnv();
    const res = await worker.fetch(post(body as never), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    expect(search).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect((kv as ReturnType<typeof fakeKv>).store.size).toBe(0);
  });
});

describe("POST /api/chat answers", () => {
  it("streams {token} events then a final {citations} event with ONLY the referenced chunks", async () => {
    const chunks = [rawChunk(W3C, "W3C-SDL-2023", 0.9), rawChunk(NIST, "US-GOV-PD", 0.8), rawChunk(WIKI, "CC-BY-SA-4.0", 0.7)];
    const { env, run } = makeEnv({ chunks, tokens: ["Passkeys ", "are ", "bound to origins [2]."] });
    const res = await worker.fetch(post({ question: "What is a passkey?" }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const ev = await events(res);

    const tokens = ev.filter((e) => "token" in e).map((e) => e.token);
    expect(tokens).toEqual(["Passkeys ", "are ", "bound to origins [2]."]);
    const last = ev[ev.length - 1] as { citations: { n: number; sourceId: string; url: string; attribution: string }[]; notices: string[]; grounded: boolean; abstained: boolean };
    expect(ev.slice(0, -1).every((e) => "token" in e)).toBe(true);
    expect(last.citations.map((c) => c.sourceId)).toEqual([NIST]); // chunk [2] after score ordering
    expect(last.citations[0].url).toBe(`https://example.test/${NIST}`);
    expect(last.citations[0].attribution).toBe(`Attribution for ${NIST}`);
    expect(last.notices).toEqual([]);
    expect(last.grounded).toBe(true);
    expect(last.abstained).toBe(false);
    expect(JSON.stringify(last)).not.toContain(W3C);
    expect(JSON.stringify(last)).not.toContain(WIKI);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("surfaces the CC BY-SA 4.0 adaptations notice when a share-alike source is cited", async () => {
    const { env } = makeEnv({ chunks: [rawChunk(WIKI, "CC-BY-SA-4.0", 0.9)], tokens: ["Yes [1]."] });
    const ev = await events(await worker.fetch(post({ question: "q" }), env));
    const last = ev[ev.length - 1] as { notices: string[] };
    expect(last.notices).toHaveLength(1);
    expect(last.notices[0]).toMatch(/CC BY-SA 4\.0/);
  });

  it("drops chunks from sources that are not full-mode manifest entries (pointers, unknown ids)", async () => {
    const chunks = [rawChunk("okta-blog", "CC-BY-4.0", 0.99), rawChunk("not-in-manifest", "CC-BY-4.0", 0.98), rawChunk(W3C, "W3C-SDL-2023", 0.5)];
    const { env, run } = makeEnv({ chunks, tokens: ["Fine [1]."] });
    const ev = await events(await worker.fetch(post({ question: "q" }), env));
    const last = ev[ev.length - 1] as { citations: { sourceId: string }[] };
    expect(last.citations.map((c) => c.sourceId)).toEqual([W3C]);
    expect(JSON.stringify((run.mock.calls[0] as unknown[])[1])).not.toContain("okta-blog");
  });

  it("an answer that cites nothing is flagged grounded:false", async () => {
    const { env } = makeEnv({ chunks: [rawChunk(W3C, "W3C-SDL-2023", 0.9)], tokens: ["No citations here."] });
    const ev = await events(await worker.fetch(post({ question: "q" }), env));
    const last = ev[ev.length - 1] as { grounded: boolean; citations: unknown[] };
    expect(last.grounded).toBe(false);
    expect(last.citations).toEqual([]);
  });
});

describe("INVARIANT #2 end to end: abstention never reaches the model", () => {
  it("below-threshold retrieval: canned message, zero AI.run calls, zero fetch calls, no citations", async () => {
    const fetchSpy = vi.fn();
    const w = createWorker(() => ({ ...rt, fetch: fetchSpy as never }));
    const { env, run } = makeEnv({ chunks: [rawChunk(W3C, "W3C-SDL-2023", gateThreshold(config) - 0.01)] });
    const res = await w.fetch(post({ question: "What is the best pizza?" }), env);
    expect(res.status).toBe(200);
    const ev = await events(res);
    expect(run).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(ev[0]).toEqual({ token: config.abstain.message });
    expect(ev[ev.length - 1]).toMatchObject({ abstained: true, citations: [], grounded: false });
  });

  it("empty retrieval: abstains with zero generation calls", async () => {
    const { env, run } = makeEnv({ chunks: [] });
    const ev = await events(await worker.fetch(post({ question: "q" }), env));
    expect(run).not.toHaveBeenCalled();
    expect(ev[ev.length - 1]).toMatchObject({ abstained: true, citations: [] });
  });

  it("external provider: abstention makes zero gateway fetches too", async () => {
    const fetchSpy = vi.fn();
    const w = createWorker(() => ({ ...rt, config: { ...config, generation: { ...config.generation, provider: "external" } }, fetch: fetchSpy as never }));
    const { env } = makeEnv({ chunks: [] });
    await w.fetch(post({ question: "q" }), { ...env, CF_ACCOUNT_ID: "a" } as Env);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("limits at the route", () => {
  it("the 21st request in an hour is 429 with Retry-After, and no search is made for it", async () => {
    const { env, search } = makeEnv({ chunks: [] });
    for (let i = 0; i < 20; i++) expect((await worker.fetch(post({ question: "q" }), env)).status).toBe(200);
    expect(search).toHaveBeenCalledTimes(20);
    const res = await worker.fetch(post({ question: "q" }), env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(search).toHaveBeenCalledTimes(20);
  });

  it("monthly ceiling reached: 503 with a clear message, no search, no generation", async () => {
    const kv = fakeKv();
    kv.store.set("mc:2026-10", String(config.serving.monthly_query_ceiling));
    const { env, search, run } = makeEnv({ kv });
    const res = await worker.fetch(post({ question: "q" }), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/monthly/i);
    expect(search).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("failures are structured and never fabricate an answer", () => {
  it("retrieval failure: 502 JSON error, generation never called", async () => {
    const { env, run } = makeEnv({ search: async () => { throw new Error("search exploded"); } });
    const res = await worker.fetch(post({ question: "q" }), env);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("retrieval_failed");
    expect(body).not.toContain("search exploded");
    expect(run).not.toHaveBeenCalled();
  });

  it("generation failure before any output: 502 JSON error, no answer text", async () => {
    const { env } = makeEnv({ chunks: [rawChunk(W3C, "W3C-SDL-2023", 0.9)], run: async () => { throw new Error("model down"); } });
    const res = await worker.fetch(post({ question: "q" }), env);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { error: { code: string }; token?: unknown };
    expect(body.error.code).toBe("generation_failed");
    expect(body).not.toHaveProperty("token");
  });

  it("generation failing mid-stream: an error event, and NO citations event", async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ response: "Partial [1]" })}\n\n`));
        c.enqueue(new TextEncoder().encode("data: {broken\n\n"));
        c.close();
      },
    });
    const { env } = makeEnv({ chunks: [rawChunk(W3C, "W3C-SDL-2023", 0.9)], run: async () => broken });
    const res = await worker.fetch(post({ question: "q" }), env);
    const ev = await events(res);
    expect(ev.some((e) => "error" in e)).toBe(true);
    expect(ev.some((e) => "citations" in e)).toBe(false);
  });
});
