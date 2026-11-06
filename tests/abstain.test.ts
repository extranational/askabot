import { describe, expect, it, vi } from "vitest";
import { abstainResponse, decideAbstain } from "../src/abstain";
import { answerQuestion } from "../src/answer";
import type { Chunk } from "../src/retrieve";
import { gateThreshold } from "../src/retrieve";
import { loadConfig } from "../src/config";

const config = loadConfig("config/askabot.yaml");
const T = gateThreshold(config); // 0.4 — the rerank threshold, since reranking is on

const chunk = (score: number, over: Partial<Chunk> = {}): Chunk => ({
  id: `c-${score}`,
  text: `text ${score}`,
  score,
  sourceId: "wikipedia-passkey",
  sourceUrl: "https://en.wikipedia.org/wiki/Passkey_(authentication)",
  licence: "CC-BY-SA-4.0",
  attribution: "Source: Wikipedia",
  ...over,
});

describe("decideAbstain", () => {
  it("abstains when the top score is below the threshold", () => {
    const d = decideAbstain([chunk(0.39), chunk(0.1)], T);
    expect(d.abstain).toBe(true);
    if (d.abstain) expect(d.reason).toBe("below-threshold");
  });

  it("abstains on an empty chunk list", () => {
    const d = decideAbstain([], T);
    expect(d).toEqual({ abstain: true, reason: "no-chunks" });
  });

  it("does not abstain at or above the threshold (boundary inclusive)", () => {
    expect(decideAbstain([chunk(T)], T).abstain).toBe(false);
    expect(decideAbstain([chunk(0.9)], T).abstain).toBe(false);
  });

  it("uses the maximum score, regardless of input order", () => {
    const d = decideAbstain([chunk(0.1), chunk(0.7), chunk(0.2)], T);
    expect(d.abstain).toBe(false);
    if (!d.abstain) expect(d.topScore).toBe(0.7);
  });

  it("only passes chunks at/above the threshold on to generation", () => {
    const d = decideAbstain([chunk(0.9), chunk(0.5), chunk(0.2)], T);
    if (d.abstain) throw new Error("should not abstain");
    expect(d.usable.map((c) => c.score)).toEqual([0.9, 0.5]);
  });

  it("FAILS CLOSED on non-finite scores or an invalid threshold", () => {
    expect(decideAbstain([chunk(Number.NaN)], T).abstain).toBe(true);
    expect(decideAbstain([chunk(Infinity)], T).abstain).toBe(true);
    expect(decideAbstain([chunk(0.9)], Number.NaN).abstain).toBe(true);
    expect(decideAbstain([chunk(0.9)], undefined as never).abstain).toBe(true);
  });
});

describe("abstainResponse", () => {
  it("is the configured message and carries no citations", () => {
    const r = abstainResponse(config.abstain.message, "below-threshold");
    expect(r.message).toBe(config.abstain.message);
    expect(r.citations).toEqual([]);
    expect(r.abstained).toBe(true);
  });
});

describe("INVARIANT #2: the LLM is never called when the gate trips", () => {
  const run = async (chunks: Chunk[] | Error) => {
    const generate = vi.fn(async () => ({ ok: true as const, tokens: (async function* () { yield "should never be produced"; })() }));
    const retrieve = vi.fn(async () => {
      if (chunks instanceof Error) throw chunks;
      return chunks;
    });
    const outcome = await answerQuestion({ config, retrieve, generate }, "anything");
    return { outcome, generate, retrieve };
  };

  it("below threshold: generation spy has ZERO calls", async () => {
    const { outcome, generate, retrieve } = await run([chunk(0.39), chunk(0.2)]);
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(0);
    expect(generate).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("abstain");
    if (outcome.kind === "abstain") {
      expect(outcome.message).toBe(config.abstain.message);
    }
  });

  it("empty retrieval: generation spy has ZERO calls", async () => {
    const { outcome, generate } = await run([]);
    expect(generate).toHaveBeenCalledTimes(0);
    expect(outcome.kind).toBe("abstain");
  });

  it("garbage scores: generation spy has ZERO calls", async () => {
    const { outcome, generate } = await run([chunk(Number.NaN)]);
    expect(generate).toHaveBeenCalledTimes(0);
    expect(outcome.kind).toBe("abstain");
  });

  it("retrieval failure: ZERO generation calls and a structured error, not an answer", async () => {
    const { outcome, generate } = await run(new Error("search down"));
    expect(generate).toHaveBeenCalledTimes(0);
    expect(outcome.kind).toBe("error");
  });

  it("control: at/above threshold, generation IS called exactly once, with only the usable chunks in the prompt", async () => {
    const { outcome, generate } = await run([chunk(0.9, { text: "GOOD CHUNK" }), chunk(0.1, { text: "WEAK CHUNK" })]);
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify((generate.mock.calls[0] as unknown[])[0]);
    expect(prompt).toContain("GOOD CHUNK");
    expect(prompt).not.toContain("WEAK CHUNK");
    expect(outcome.kind).toBe("answer");
  });
});
