import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { generate, type GenEnv, type GenerateResult } from "../src/generate";
import { loadConfig } from "../src/config";
import type { ChatMessage } from "../src/prompt";

const base = loadConfig("config/askabot.yaml").generation;
const messages: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];

const sse = (...events: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(e));
      c.close();
    },
  });
const workersAiStream = (...tokens: string[]) =>
  sse(...tokens.map((t) => `data: ${JSON.stringify({ response: t })}\n\n`), "data: [DONE]\n\n");
const openAiStream = (...tokens: string[]) =>
  sse(...tokens.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`), "data: [DONE]\n\n");

async function collect(r: GenerateResult): Promise<string> {
  if (!r.ok) throw new Error("expected ok result");
  let out = "";
  for await (const t of r.tokens) out += t;
  return out;
}

function env(over: Partial<GenEnv> = {}) {
  const run = vi.fn(async (..._a: unknown[]) => workersAiStream("Hel", "lo"));
  const e: GenEnv = { AI: { run } as never, AI_GATEWAY_ID: "gw-test", ...over };
  return { e, run };
}

describe("generate: workers-ai provider", () => {
  it("streams tokens, taking model and every param from config (never literals)", async () => {
    const { e, run } = env();
    const cfg = { provider: "workers-ai" as const, model: "@cf/test/some-other-model", max_tokens: 123, temperature: 0.7 };
    const r = await generate(messages, cfg, e);
    expect(await collect(r)).toBe("Hello");
    expect(run).toHaveBeenCalledTimes(1);
    const [model, inputs, options] = run.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(model).toBe("@cf/test/some-other-model");
    expect(inputs).toMatchObject({ messages, max_tokens: 123, temperature: 0.7, stream: true });
    expect(options).toEqual({ gateway: { id: "gw-test" } });
  });

  it("uses the shipped config values when given the shipped config", async () => {
    const { e, run } = env();
    await generate(messages, base, e);
    expect((run.mock.calls[0] as unknown[])[0]).toBe(base.model);
  });

  it("src/generate.ts contains no hard-coded model id or sampling literal", () => {
    const src = readFileSync("src/generate.ts", "utf8");
    expect(src).not.toMatch(/@cf\//);
    expect(src).not.toMatch(/llama|glm|claude|gpt-|qwen/i);
    expect(src).not.toMatch(/max_tokens\s*:\s*\d|temperature\s*:\s*[\d.]/);
  });

  it("falls back to a non-streamed {response} object", async () => {
    const { e } = env({ AI: { run: async () => ({ response: "whole answer" }) } as never });
    expect(await collect(await generate(messages, base, e))).toBe("whole answer");
  });
});

describe("generate: external provider via AI Gateway", () => {
  const ext = { provider: "external" as const, model: "anthropic/some-model", max_tokens: 321, temperature: 0.2 };
  const extEnv = { CF_ACCOUNT_ID: "acct", AI_GATEWAY_ID: "gw-test", CF_AIG_TOKEN: "tok" };

  it("swaps only the call target: fetch to the gateway, AI binding untouched", async () => {
    const { e, run } = env(extEnv);
    const f = vi.fn(async (..._a: unknown[]) => new Response(openAiStream("Hi", "!")));
    const r = await generate(messages, ext, e, f as never);
    expect(await collect(r)).toBe("Hi!");
    expect(run).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw-test/compat/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "anthropic/some-model",
      messages,
      max_tokens: 321,
      temperature: 0.2,
      stream: true,
    });
    expect(JSON.stringify(init.headers)).toContain("tok"); // gateway auth token is sent, and only as a header
  });

  it("the workers-ai path never calls fetch", async () => {
    const { e } = env();
    const f = vi.fn();
    await generate(messages, base, e, f as never);
    expect(f).not.toHaveBeenCalled();
  });

  it("missing account id => structured error", async () => {
    const { e } = env({ ...extEnv, CF_ACCOUNT_ID: undefined });
    const r = await generate(messages, ext, e, vi.fn() as never);
    expect(r.ok).toBe(false);
  });
});

describe("generate: errors are structured, never a fabricated answer", () => {
  const assertNoAnswer = (r: GenerateResult) => {
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r).not.toHaveProperty("tokens");
    expect(r.error.code).toBeTruthy();
    expect(r.error.message).toBeTruthy();
  };

  it("AI.run throwing", async () => {
    const { e } = env({ AI: { run: async () => { throw new Error("model overloaded SECRET-DETAIL"); } } as never });
    const r = await generate(messages, base, e);
    assertNoAnswer(r);
    if (!r.ok) expect(r.error.message).not.toContain("SECRET-DETAIL"); // upstream detail is not leaked to the client
  });

  it("missing AI binding or gateway id", async () => {
    assertNoAnswer(await generate(messages, base, { AI_GATEWAY_ID: "g" }));
    assertNoAnswer(await generate(messages, base, { AI: { run: async () => workersAiStream("x") } as never }));
  });

  it("external: fetch rejects, non-2xx, or no body", async () => {
    const ext = { provider: "external" as const, model: "m", max_tokens: 10, temperature: 0 };
    const e: GenEnv = { CF_ACCOUNT_ID: "a", AI_GATEWAY_ID: "g", CF_AIG_TOKEN: "t" };
    assertNoAnswer(await generate(messages, ext, e, (async () => { throw new Error("dns"); }) as never));
    const r500 = await generate(messages, ext, e, (async () => new Response("upstream says SECRET", { status: 500 })) as never);
    assertNoAnswer(r500);
    if (!r500.ok) expect(r500.error.message).not.toContain("SECRET");
    assertNoAnswer(await generate(messages, ext, e, (async () => new Response(null, { status: 200 })) as never));
  });

  it("a stream that errors mid-way rejects the iteration (the handler turns that into an error event)", async () => {
    const bad = sse(`data: ${JSON.stringify({ response: "ok" })}\n\n`, "data: {not json\n\n");
    const { e } = env({ AI: { run: async () => bad } as never });
    const r = await generate(messages, base, e);
    await expect(collect(r)).rejects.toThrow();
  });

  it("a stream with zero tokens rejects rather than yielding an empty answer", async () => {
    const { e } = env({ AI: { run: async () => sse("data: [DONE]\n\n") } as never });
    await expect(collect(await generate(messages, base, e))).rejects.toThrow(/empty/i);
  });

  it("handles SSE events split across chunk boundaries", async () => {
    const line = `data: ${JSON.stringify({ response: "split" })}\n\n`;
    const stream = sse(line.slice(0, 7), line.slice(7), "data: [DONE]\n\n");
    const { e } = env({ AI: { run: async () => stream } as never });
    expect(await collect(await generate(messages, base, e))).toBe("split");
  });
});
