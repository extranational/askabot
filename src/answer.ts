import { abstainResponse, decideAbstain, type AbstainReason } from "./abstain";
import type { AskabotConfig } from "./config";
import type { GenerateResult } from "./generate";
import { buildMessages, type ChatMessage } from "./prompt";
import { gateThreshold, type Chunk } from "./retrieve";

export interface AnswerDeps {
  config: AskabotConfig;
  retrieve(question: string): Promise<Chunk[]>;
  generate(messages: ChatMessage[]): Promise<GenerateResult>;
}

export type AnswerOutcome =
  | { kind: "abstain"; message: string; reason: AbstainReason }
  | { kind: "error"; status: number; error: { code: string; message: string } }
  | { kind: "answer"; tokens: AsyncIterable<string>; /** numbered [1..n] in the prompt: [n] maps to chunks[n-1] */ chunks: Chunk[] };

/**
 * retrieve -> ABSTENTION GATE -> prompt -> generate.
 * `deps.generate` is only reachable on the `abstain: false` branch of decideAbstain; every other
 * path (empty, below threshold, bad scores, retrieval failure) returns before it.
 */
export async function answerQuestion(deps: AnswerDeps, question: string): Promise<AnswerOutcome> {
  let chunks: Chunk[];
  try {
    chunks = await deps.retrieve(question);
  } catch {
    return { kind: "error", status: 502, error: { code: "retrieval_failed", message: "Search is temporarily unavailable. Please try again." } };
  }

  // Gate on the threshold that matches the score that came back: rerank scores when reranking
  // ran, vector similarity when it did not. See gateThreshold().
  const decision = decideAbstain(chunks, gateThreshold(deps.config));
  if (decision.abstain) {
    const r = abstainResponse(deps.config.abstain.message, decision.reason);
    return { kind: "abstain", message: r.message, reason: r.reason };
  }

  const gen = await deps.generate(buildMessages(question, decision.usable, deps.config.assistant.subject));
  if (!gen.ok) return { kind: "error", status: 502, error: gen.error };
  return { kind: "answer", tokens: gen.tokens, chunks: decision.usable };
}
