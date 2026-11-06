import { describe, it, expect, vi } from "vitest";
import {
  createAiSearchUploader,
  uploaderFromEnv,
  MissingCredentialsError,
} from "../scripts/ai-search-uploader";
import type { UploadItem } from "../scripts/ingest";

const item: UploadItem = {
  key: "w3c-webauthn-3.md",
  content: "# WebAuthn Level 3\n",
  content_type: "text/markdown",
  metadata: {
    source_id: "w3c-webauthn-3",
    source_url: "https://www.w3.org/TR/webauthn-3/",
    licence: "W3C-DOC",
    attribution: "W3C",
    retrieval_date: "2026-10-13",
  },
};

function stubFetch(ok = true, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response(ok ? "{}" : "nope", { status });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

describe("AI Search uploader wire format", () => {
  it("posts to the instance items endpoint as multipart", async () => {
    const { calls, impl } = stubFetch();
    await createAiSearchUploader({ accountId: "acct", token: "tok", fetchImpl: impl }).upload([item]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai-search/namespaces/default/instances/askabot/items",
    );
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("does NOT set content-type itself, so FormData's boundary survives", async () => {
    const { calls, impl } = stubFetch();
    await createAiSearchUploader({ accountId: "a", token: "t", fetchImpl: impl }).upload([item]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
  });

  // Trap 1: the API reference shows the document inside a JSON-valued form field. Doing
  // that fails with file_field_is_required -- a real multipart file part is mandatory.
  it("sends the key as the FILENAME of a real file part, because the key is not settable", async () => {
    const { calls, impl } = stubFetch();
    await createAiSearchUploader({ accountId: "a", token: "t", fetchImpl: impl }).upload([item]);
    const form = calls[0].init.body as FormData;
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("w3c-webauthn-3.md");
    expect(await (file as File).text()).toBe("# WebAuthn Level 3\n");
  });

  it("sends provenance as a JSON string in the metadata part", async () => {
    const { calls, impl } = stubFetch();
    await createAiSearchUploader({ accountId: "a", token: "t", fetchImpl: impl }).upload([item]);
    const form = calls[0].init.body as FormData;
    expect(form.get("metadata")).toBe(JSON.stringify(item.metadata));
  });

  it("uploads every item, one request each", async () => {
    const { calls, impl } = stubFetch();
    const second: UploadItem = { ...item, key: "owasp-mfa-cheatsheet.md" };
    await createAiSearchUploader({ accountId: "a", token: "t", fetchImpl: impl }).upload([item, second]);
    expect(calls).toHaveLength(2);
    expect((calls[1].init.body as FormData).get("file")).toBeInstanceOf(Blob);
  });

  it("names the failing item when a response is not ok, and does not swallow it", async () => {
    const { impl } = stubFetch(false, 429);
    await expect(
      createAiSearchUploader({ accountId: "a", token: "t", fetchImpl: impl }).upload([item]),
    ).rejects.toThrow(/w3c-webauthn-3\.md.*429/);
  });
});

describe("uploaderFromEnv", () => {
  // The whole point of the placeholder uploader was that no test can reach the live index.
  // This stays true: without credentials in the environment it refuses to build.
  it("refuses when credentials are absent, naming what is missing", () => {
    expect(() => uploaderFromEnv({} as NodeJS.ProcessEnv)).toThrow(MissingCredentialsError);
    expect(() => uploaderFromEnv({} as NodeJS.ProcessEnv)).toThrow(/CF_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
  });

  it("builds when both are present", () => {
    const up = uploaderFromEnv({
      CF_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
    } as unknown as NodeJS.ProcessEnv);
    expect(typeof up.upload).toBe("function");
  });
});
