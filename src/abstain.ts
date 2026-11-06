import type { Chunk } from "./retrieve";

export type AbstainReason = "no-chunks" | "below-threshold" | "invalid-score";

export type AbstainDecision =
  | { abstain: true; reason: AbstainReason }
  | { abstain: false; topScore: number; /** chunks at/above the threshold, best first: the only text generation may see */ usable: Chunk[] };

/**
 * THE ABSTENTION GATE. Pure and synchronous: it takes no generation function, so it cannot
 * call one. The orchestrator (answer.ts) only reaches the model after this returns
 * `abstain: false`.
 *
 * Fails closed: an empty list, a non-finite threshold, or no finite score all abstain.
 * Scores are compared as opaque numbers on the same scale as `retrieval.match_threshold`;
 * what a given value means is a Phase 4 tuning question, not something assumed here.
 */
export function decideAbstain(chunks: readonly Chunk[], threshold: number): AbstainDecision {
  if (!Array.isArray(chunks) || chunks.length === 0) return { abstain: true, reason: "no-chunks" };
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) return { abstain: true, reason: "invalid-score" };

  const scored = chunks.filter((c) => typeof c.score === "number" && Number.isFinite(c.score));
  if (scored.length === 0) return { abstain: true, reason: "invalid-score" };

  const topScore = Math.max(...scored.map((c) => c.score));
  if (topScore < threshold) return { abstain: true, reason: "below-threshold" };

  const usable = scored.filter((c) => c.score >= threshold).sort((a, b) => b.score - a.score);
  return { abstain: false, topScore, usable };
}

export interface AbstainResponse {
  abstained: true;
  message: string;
  citations: [];
  reason: AbstainReason;
}

export function abstainResponse(message: string, reason: AbstainReason): AbstainResponse {
  return { abstained: true, message, citations: [], reason };
}
