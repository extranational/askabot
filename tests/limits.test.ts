import { describe, expect, it } from "vitest";
import { checkLimits, type KvLike } from "../src/limits";

const LIMITS = { rate_limit_per_ip_per_hour: 20, monthly_query_ceiling: 3000 };
const T0 = Date.UTC(2026, 9, 13, 12, 30, 0); // 2026-10-13 12:30 UTC

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const kv: KvLike & { store: Map<string, string>; ttls: Map<string, number | undefined> } = {
    store,
    ttls: new Map(),
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v, opts) {
      store.set(k, v);
      kv.ttls.set(k, opts?.expirationTtl);
    },
  };
  return kv;
}

describe("per-IP hourly rate limit", () => {
  it("allows 20 requests in an hour and answers the 21st with 429", async () => {
    const kv = fakeKv();
    for (let i = 1; i <= 20; i++) {
      expect((await checkLimits(kv, "1.2.3.4", LIMITS, T0 + i)).ok).toBe(true);
    }
    const d = await checkLimits(kv, "1.2.3.4", LIMITS, T0 + 21);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(429);
      expect(d.code).toBe("rate_limited");
      expect(d.retryAfterSeconds).toBeGreaterThan(0);
      expect(d.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("is per IP: another address is unaffected", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) await checkLimits(kv, "1.2.3.4", LIMITS, T0);
    expect((await checkLimits(kv, "1.2.3.4", LIMITS, T0)).ok).toBe(false);
    expect((await checkLimits(kv, "5.6.7.8", LIMITS, T0)).ok).toBe(true);
  });

  it("resets in the next hour", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 21; i++) await checkLimits(kv, "1.2.3.4", LIMITS, T0);
    expect((await checkLimits(kv, "1.2.3.4", LIMITS, T0 + 3600_000)).ok).toBe(true);
  });

  it("takes the limit from config, not a literal", async () => {
    const kv = fakeKv();
    const small = { ...LIMITS, rate_limit_per_ip_per_hour: 2 };
    expect((await checkLimits(kv, "ip", small, T0)).ok).toBe(true);
    expect((await checkLimits(kv, "ip", small, T0)).ok).toBe(true);
    const d = await checkLimits(kv, "ip", small, T0);
    expect(d.ok).toBe(false);
  });

  it("does not store the raw IP in KV keys, and counters expire", async () => {
    const kv = fakeKv();
    await checkLimits(kv, "203.0.113.77", LIMITS, T0);
    for (const k of kv.store.keys()) expect(k).not.toContain("203.0.113.77");
    for (const [k, ttl] of kv.ttls) expect(ttl, k).toBeGreaterThan(0);
  });

  it("a missing IP is rate limited as one shared 'unknown' client rather than skipped", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 20; i++) await checkLimits(kv, null, LIMITS, T0);
    const d = await checkLimits(kv, null, LIMITS, T0);
    expect(d.ok).toBe(false);
  });
});

describe("monthly ceiling (fails closed)", () => {
  it("at the ceiling returns 503 with a clear message", async () => {
    const kv = fakeKv({ "mc:2026-10": "3000" });
    const d = await checkLimits(kv, "1.2.3.4", LIMITS, T0);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(503);
      expect(d.code).toBe("monthly_ceiling_reached");
      expect(d.message).toMatch(/monthly/i);
    }
  });

  it("counts admitted requests: the 3000th passes, the 3001st is refused", async () => {
    const kv = fakeKv({ "mc:2026-10": "2999" });
    expect((await checkLimits(kv, "a", LIMITS, T0)).ok).toBe(true);
    const d = await checkLimits(kv, "b", LIMITS, T0);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(503);
  });

  it("takes the ceiling from config", async () => {
    const kv = fakeKv({ "mc:2026-10": "5" });
    expect((await checkLimits(kv, "a", { ...LIMITS, monthly_query_ceiling: 5 }, T0)).ok).toBe(false);
    expect((await checkLimits(kv, "a", { ...LIMITS, monthly_query_ceiling: 6 }, T0)).ok).toBe(true);
  });

  it("a new calendar month starts a new counter", async () => {
    const kv = fakeKv({ "mc:2026-10": "3000" });
    const nov = Date.UTC(2026, 10, 1, 0, 0, 1);
    expect((await checkLimits(kv, "a", LIMITS, nov)).ok).toBe(true);
    expect(kv.store.get("mc:2026-11")).toBe("1");
  });

  it("rate-limited (429) requests do not consume the monthly budget", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 25; i++) await checkLimits(kv, "1.2.3.4", LIMITS, T0);
    expect(kv.store.get("mc:2026-10")).toBe("20");
  });

  it("monthly 503 takes precedence over per-IP accounting (no IP counter created)", async () => {
    const kv = fakeKv({ "mc:2026-10": "3000" });
    await checkLimits(kv, "1.2.3.4", LIMITS, T0);
    expect([...kv.store.keys()].filter((k) => k.startsWith("rl:"))).toEqual([]);
  });
});

describe("FAILS CLOSED when the counter store misbehaves", () => {
  it("KV read error => 503", async () => {
    const kv = fakeKv();
    kv.get = async () => {
      throw new Error("kv down");
    };
    const d = await checkLimits(kv, "a", LIMITS, T0);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(503);
  });

  it("KV write error => 503", async () => {
    const kv = fakeKv();
    kv.put = async () => {
      throw new Error("kv down");
    };
    const d = await checkLimits(kv, "a", LIMITS, T0);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(503);
  });

  it.each(["abc", "-1", "NaN", "1.5", ""])("corrupt monthly counter %j => 503", async (bad) => {
    const kv = fakeKv({ "mc:2026-10": bad });
    const d = await checkLimits(kv, "a", LIMITS, T0);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(503);
  });

  it("a missing KV binding => 503", async () => {
    const d = await checkLimits(undefined, "a", LIMITS, T0);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(503);
  });
});
