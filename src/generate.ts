import type { AskabotConfig } from "./config";
import type { ChatMessage } from "./prompt";

/** Bindings/vars the generation path needs. The operator wires these in wrangler.toml and secrets. */
export interface GenEnv {
  /** Workers AI binding (provider: workers-ai). */
  AI?: { run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };
  /** AI Gateway id; every generation call is routed through it. */
  AI_GATEWAY_ID?: string;
  /** provider: external only: the gateway lives under this account, and BYOK keys are stored in the gateway. */
  CF_ACCOUNT_ID?: string;
  CF_AIG_TOKEN?: string;
}

export type GenerateResult =
  | { ok: true; tokens: AsyncIterable<string> }
  | { ok: false; error: { code: string; message: string } };

const fail = (code: string, message: string): GenerateResult => ({ ok: false, error: { code, message } });

/** Parse an SSE byte stream (Workers AI `{response}` or OpenAI-style `choices[].delta.content`) into tokens. */
async function* tokensFrom(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let count = 0;

  const parse = (line: string): string | null | "DONE" => {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5).trim();
    if (payload === "") return null;
    if (payload === "[DONE]") return "DONE";
    const j = JSON.parse(payload) as { response?: unknown; choices?: { delta?: { content?: unknown } }[] };
    const t = typeof j.response === "string" ? j.response : j.choices?.[0]?.delta?.content;
    return typeof t === "string" && t !== "" ? t : null;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += decoder.decode(value, { stream: !done });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        const t = parse(line);
        if (t === "DONE") {
          if (count === 0) throw new Error("empty generation");
          return;
        }
        if (t !== null) {
          count++;
          yield t;
        }
      }
      if (done) break;
    }
    if (buf.trim() !== "") {
      const t = parse(buf.replace(/\r$/, ""));
      if (t !== null && t !== "DONE") {
        count++;
        yield t;
      }
    }
    if (count === 0) throw new Error("empty generation");
  } finally {
    reader.releaseLock();
  }
}

async function* single(text: string): AsyncGenerator<string> {
  yield text;
}

/**
 * Generate through AI Gateway. Provider, model and sampling parameters all come from `gen`
 * (config/askabot.yaml). Any failure returns a structured error; there is no code path that
 * produces answer text except the model's own stream.
 */
export async function generate(
  messages: ChatMessage[],
  gen: AskabotConfig["generation"],
  env: GenEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerateResult> {
  const gateway = env.AI_GATEWAY_ID;
  if (!gateway) return fail("generation_unconfigured", "Answer generation is not configured.");

  try {
    if (gen.provider === "workers-ai") {
      if (!env.AI) return fail("generation_unconfigured", "Answer generation is not configured.");
      const out = await env.AI.run(
        gen.model,
        { messages, max_tokens: gen.max_tokens, temperature: gen.temperature, stream: true },
        { gateway: { id: gateway } },
      );
      if (out instanceof ReadableStream) return { ok: true, tokens: tokensFrom(out as ReadableStream<Uint8Array>) };
      const whole = (out as { response?: unknown } | null)?.response;
      if (typeof whole === "string" && whole.trim() !== "") return { ok: true, tokens: single(whole) };
      return fail("generation_failed", "The answer service returned no answer.");
    }

    if (!env.CF_ACCOUNT_ID) return fail("generation_unconfigured", "Answer generation is not configured.");
    const res = await fetchImpl(`https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gateway}/compat/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.CF_AIG_TOKEN ? { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        model: gen.model,
        messages,
        max_tokens: gen.max_tokens,
        temperature: gen.temperature,
        stream: true,
      }),
    });
    if (!res.ok) return fail("generation_failed", `The answer service failed (HTTP ${res.status}).`);
    if (!res.body) return fail("generation_failed", "The answer service returned no answer.");
    return { ok: true, tokens: tokensFrom(res.body) };
  } catch {
    // Upstream error text is deliberately not forwarded to the client.
    return fail("generation_failed", "The answer service failed.");
  }
}
