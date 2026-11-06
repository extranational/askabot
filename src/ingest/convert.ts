const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Minimal, dependency-free HTML → markdown: headings, links, list items, paragraphs. */
export function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|nav|header|footer)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_m, a: string, b: string, t: string) => `[${t}](${a ?? b})`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|ul|ol|table|section|article|pre|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = s.replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class UnsupportedContentError extends Error {}

/** Convert a fetched body to markdown, or throw UnsupportedContentError. */
export function toMarkdown(body: string, contentType: string | null): string {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (ct === "text/html" || ct === "application/xhtml+xml") return htmlToMarkdown(body);
  if (ct === "text/markdown" || ct === "text/plain") return body.trim();
  throw new UnsupportedContentError(`unsupported content-type ${JSON.stringify(ct || "unknown")} (no converter)`);
}
