import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker smoke", () => {
  it("GET /healthz returns 200 and {status:'ok'} (no bindings or config needed)", async () => {
    const res = await worker.fetch(new Request("https://example.test/healthz"), {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /api/chat is 405 on the default export even with no config or bindings", async () => {
    const res = await worker.fetch(new Request("https://example.test/api/chat"), {} as never);
    expect(res.status).toBe(405);
  });

  it("POST /api/chat on the default export without config is a generic 500", async () => {
    const res = await worker.fetch(new Request("https://example.test/api/chat", { method: "POST", body: "{}" }), {} as never);
    expect(res.status).toBe(500);
  });

  it("unknown routes return 404", async () => {
    const res = await worker.fetch(new Request("https://example.test/anything"), {} as never);
    expect(res.status).toBe(404);
  });
});
