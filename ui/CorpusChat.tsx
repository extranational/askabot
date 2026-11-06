import { useRef, useState } from "react";

/** Mirrors the Citation object emitted by the Worker (src/citations.ts). Kept local so the component has no Worker imports. */
export interface ChatCitation {
  n: number;
  chunkId: string;
  sourceId: string;
  url: string;
  licence: string;
  licenceName: string;
  attribution: string;
  shareAlike: boolean;
  linkRequired: boolean;
}

/** One row of the Sources list: one SOURCE, with every [n] that points at it. */
export interface SourceRow {
  url: string;
  /** Every [n] in the answer text that refers to a chunk of this source, ascending. */
  ns: number[];
  attribution: string;
  licenceName: string;
}

/**
 * Collapse chunk-level citations into one row per source. Several chunks of the same document
 * are routinely cited (the same URL, different passages), which listed the same source over and
 * over; grouping keeps the [n] mapping intact while showing each source once.
 */
export function groupSources(citations: readonly ChatCitation[]): SourceRow[] {
  const rows = new Map<string, SourceRow>();
  for (const c of [...citations].sort((a, b) => a.n - b.n)) {
    const existing = rows.get(c.url);
    if (existing) {
      if (!existing.ns.includes(c.n)) existing.ns.push(c.n);
      continue;
    }
    rows.set(c.url, { url: c.url, ns: [c.n], attribution: c.attribution, licenceName: c.licenceName });
  }
  return [...rows.values()];
}

export interface CorpusChatProps {
  /** Full URL of the Worker's POST /api/chat route. */
  endpoint: string;
  placeholder?: string;
  /** Link to the public notices page (attribution, takedown contact). */
  noticeUrl?: string;
  /**
   * Example questions offered under the composer. A string is both the label and the
   * question sent; an object lets the label differ from the question. Clicking one asks it.
   */
  suggestions?: readonly (string | { label: string; question: string })[];
}

type Phase = "idle" | "loading" | "done" | "abstained" | "error";

const MAX_QUESTION_CHARS = 500; // matches the Worker's limit

/** Only http(s) URLs become links; anything else is shown as plain text. */
const safeHref = (u: string): string | null => (/^https?:\/\//i.test(u) ? u : null);

/** Incremental SSE parser: feed text chunks, get decoded `data:` JSON payloads per complete event. */
function createSseParser(onEvent: (data: unknown) => void) {
  let buf = "";
  return (text: string) => {
    buf += text;
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
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore malformed event */
      }
    }
  };
}

export function CorpusChat({
  endpoint,
  placeholder = "Ask a question about this corpus",
  noticeUrl,
  suggestions = [],
}: CorpusChatProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState<ChatCitation[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [grounded, setGrounded] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function send(raw: string) {
    const q = raw.trim();
    if (!q || q.length > MAX_QUESTION_CHARS || phase === "loading") return;
    setQuestion(q);

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAnswer("");
    setCitations([]);
    setNotices([]);
    setGrounded(true);
    setError("");
    setPhase("loading");

    let acc = "";
    let finished = false;
    const fail = (message: string) => {
      finished = true;
      // Never leave a partial, unsourced answer on screen after a failure.
      setAnswer("");
      setCitations([]);
      setNotices([]);
      setError(message);
      setPhase("error");
    };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        let message = "Request failed (" + res.status + ").";
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body.error?.message) message = body.error.message;
        } catch {
          /* keep default */
        }
        fail(message);
        return;
      }

      const parse = createSseParser((data) => {
        if (finished || typeof data !== "object" || data === null) return;
        const ev = data as Record<string, unknown>;
        if (typeof ev.token === "string") {
          acc += ev.token;
          setAnswer(acc);
        } else if (ev.error && typeof ev.error === "object") {
          fail((ev.error as { message?: string }).message ?? "Something went wrong. Please try again.");
        } else if (Array.isArray(ev.citations)) {
          finished = true;
          setCitations(ev.citations as ChatCitation[]);
          setNotices(Array.isArray(ev.notices) ? (ev.notices as string[]) : []);
          setGrounded(ev.grounded !== false);
          setPhase(ev.abstained === true ? "abstained" : "done");
        }
      });

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parse(dec.decode(value, { stream: true }));
      }
      parse(dec.decode() + "\n\n");
      if (!finished) fail("The answer was interrupted. Please try again.");
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      fail("Could not reach the service. Please try again.");
    }
  }

  const sources = groupSources(citations);

  return (
    <section className="corpus-chat">
      <form
        className="corpus-chat__composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(question);
        }}
      >
        <label htmlFor="corpus-chat-q" className="corpus-chat__label">
          Your question
        </label>
        <textarea
          id="corpus-chat-q"
          rows={1}
          value={question}
          maxLength={MAX_QUESTION_CHARS}
          placeholder={placeholder}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(question);
            }
          }}
        />
        <div className="corpus-chat__bar">
          <button
            type="submit"
            aria-label="Send question"
            disabled={phase === "loading" || question.trim() === ""}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M12 19V5M5 12l7-7 7 7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </form>

      {suggestions.length > 0 && (
        <ul className="corpus-chat__suggestions">
          {suggestions.map((s, i) => {
            const label = typeof s === "string" ? s : s.label;
            return (
              <li key={i}>
                <button type="button" disabled={phase === "loading"} onClick={() => void send(typeof s === "string" ? s : s.question)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path
                      d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 9 9 0 0 1-3.8-.8L3 20.5l1.6-4.9a8.1 8.1 0 0 1-1.1-4.1A8.4 8.4 0 0 1 12 3.2a8.4 8.4 0 0 1 9 8.3Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div aria-live="polite" className="corpus-chat__output">
        {phase === "loading" && answer === "" && <p role="status">Searching the sources…</p>}

        {phase === "error" && <p role="alert">{error}</p>}

        {answer !== "" && (
          <div className={phase === "abstained" ? "corpus-chat__abstain" : "corpus-chat__answer"} data-testid="answer">
            {answer}
          </div>
        )}

        {phase === "done" && !grounded && (
          <p role="note">This answer could not be tied to any source, so treat it as unverified.</p>
        )}

        {sources.length > 0 && (
          <div className="corpus-chat__sources">
            <h3>Sources</h3>
            <ul>
              {sources.map((s) => {
                const href = safeHref(s.url);
                return (
                  <li key={s.url} data-testid="citation">
                    {/* The number is rendered as text, not left to list styling: the host site's
                        CSS resets `list-style` on ol/ul, which silently removed the markers. */}
                    <span className="corpus-chat__ref" data-testid="citation-ref">
                      {s.ns.map((n) => `[${n}]`).join(" ")}
                    </span>{" "}
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {s.url}
                      </a>
                    ) : (
                      <span>{s.url}</span>
                    )}
                    <div className="corpus-chat__attribution">
                      {s.attribution} · {s.licenceName}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {notices.map((n, i) => (
          <p key={i} role="note" className="corpus-chat__notice" data-testid="notice">
            {n}
          </p>
        ))}
      </div>

      {noticeUrl && (
        <p className="corpus-chat__footer">
          <a href={noticeUrl}>Notices, licences and takedown contact</a>
        </p>
      )}
    </section>
  );
}

export default CorpusChat;
