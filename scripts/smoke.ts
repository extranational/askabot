/**
 * Live smoke test for a deployed Askabot.
 *
 *   npm run smoke -- --endpoint https://askabot-api.example.com \
 *                    [--question "What is a passkey?"] \
 *                    [--off-corpus "What is the capital of France?"]
 *
 * Checks, in order:
 *   1. GET  /healthz  -> 200 {"status":"ok"}
 *   2. GET  /notices  -> 200 HTML
 *   3. POST /api/chat -> streamed answer with at least one citation
 *   4. POST /api/chat -> abstention with no citations for an out-of-corpus question
 *
 * Exit code 0 only if every check passes. This is the check to run after a deploy; it is not
 * a substitute for the evaluation harness (npm run eval), which measures quality.
 */

export interface ChatResult {
  answer: string;
  citations: unknown[];
  abstained: boolean;
  grounded: boolean;
  error?: string;
}

/** Parse the Worker's SSE stream into the final answer + terminal event. */
export async function readChat(res: Response): Promise<ChatResult> {
  const out: ChatResult = { answer: "", citations: [], abstained: false, grounded: true };
  if (!res.body) return { ...out, error: "no response body" };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof ev.token === "string") out.answer += ev.token;
      if (ev.error && typeof ev.error === "object") {
        out.error = (ev.error as { message?: string }).message ?? "stream error";
      }
      if (Array.isArray(ev.citations)) {
        out.citations = ev.citations;
        out.abstained = ev.abstained === true;
        out.grounded = ev.grounded !== false;
      }
    }
  }
  return out;
}

async function ask(endpoint: string, question: string): Promise<ChatResult> {
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return { answer: "", citations: [], abstained: false, grounded: false, error: `HTTP ${res.status}` };
  return readChat(res);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const endpoint = arg(argv, "--endpoint");
  if (!endpoint) {
    console.error("usage: npm run smoke -- --endpoint https://your-worker.example.com [--question ...] [--off-corpus ...]");
    return 2;
  }
  const question = arg(argv, "--question") ?? "What is a passkey?";
  const offCorpus = arg(argv, "--off-corpus") ?? "What is the capital of France?";
  const base = endpoint.replace(/\/$/, "");
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  try {
    const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(15_000) });
    const body = (await health.json().catch(() => ({}))) as { status?: string };
    check("healthz", health.status === 200 && body.status === "ok", `HTTP ${health.status}`);
  } catch (e) {
    check("healthz", false, (e as Error).message);
  }

  try {
    const notices = await fetch(`${base}/notices`, { signal: AbortSignal.timeout(15_000) });
    const html = await notices.text();
    check("notices", notices.status === 200 && /<html/i.test(html), `HTTP ${notices.status}, ${html.length} bytes`);
  } catch (e) {
    check("notices", false, (e as Error).message);
  }

  try {
    const r = await ask(base, question);
    check(
      "in-corpus answer",
      !r.error && r.answer.trim().length > 0 && r.citations.length > 0 && !r.abstained,
      r.error ?? `${r.answer.length} chars, ${r.citations.length} citation(s)`,
    );
  } catch (e) {
    check("in-corpus answer", false, (e as Error).message);
  }

  try {
    const r = await ask(base, offCorpus);
    check(
      "out-of-corpus abstention",
      !r.error && r.abstained && r.citations.length === 0,
      r.error ?? (r.abstained ? "abstained" : "answered instead of abstaining"),
    );
  } catch (e) {
    check("out-of-corpus abstention", false, (e as Error).message);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
