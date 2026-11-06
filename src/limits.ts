/** Minimal KV surface (Cloudflare KV namespace satisfies it). */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface LimitsConfig {
  rate_limit_per_ip_per_hour: number;
  monthly_query_ceiling: number;
}

export type LimitDecision =
  | { ok: true }
  | { ok: false; status: 429 | 503; code: string; message: string; retryAfterSeconds?: number };

const HOUR_S = 3600;
const UNAVAILABLE: LimitDecision = {
  ok: false,
  status: 503,
  code: "limits_unavailable",
  message: "The service is temporarily unavailable. Please try again later.",
};

class CorruptCounter extends Error {}

async function readCount(kv: KvLike, key: string): Promise<number> {
  const v = await kv.get(key);
  if (v === null) return 0;
  if (!/^\d+$/.test(v)) throw new CorruptCounter(key);
  return Number(v);
}

async function sha256Hex16(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-IP hourly rate limit, then a monthly query ceiling. Both counters live in KV.
 *
 * Order: monthly ceiling is read first (a paused service touches nothing else), then the
 * per-IP counter is checked and incremented, then the monthly counter is incremented. A
 * request refused with 429 does not consume monthly budget.
 *
 * FAILS CLOSED: a missing binding, a KV error, or a corrupt counter all return 503.
 * KV is eventually consistent and read-modify-write is not atomic, so under concurrent bursts
 * the ceiling can be overshot by a small margin; a Durable Object would make it strict.
 */
export async function checkLimits(
  kv: KvLike | undefined,
  ip: string | null,
  limits: LimitsConfig,
  nowMs: number,
): Promise<LimitDecision> {
  if (!kv) return UNAVAILABLE;
  try {
    const now = new Date(nowMs);
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const monthKey = `mc:${month}`;

    const monthly = await readCount(kv, monthKey);
    if (monthly >= limits.monthly_query_ceiling) {
      return {
        ok: false,
        status: 503,
        code: "monthly_ceiling_reached",
        message: "This demo has reached its monthly query limit and is paused until next month.",
      };
    }

    const hourBucket = Math.floor(nowMs / 1000 / HOUR_S);
    const ipKey = `rl:${await sha256Hex16(ip ?? "unknown")}:${hourBucket}`;
    const perIp = await readCount(kv, ipKey);
    if (perIp >= limits.rate_limit_per_ip_per_hour) {
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "Too many questions from your address this hour. Please try again later.",
        retryAfterSeconds: (hourBucket + 1) * HOUR_S - Math.floor(nowMs / 1000),
      };
    }

    await kv.put(ipKey, String(perIp + 1), { expirationTtl: 2 * HOUR_S });
    await kv.put(monthKey, String(monthly + 1), { expirationTtl: 40 * 24 * HOUR_S });
    return { ok: true };
  } catch {
    return UNAVAILABLE;
  }
}
