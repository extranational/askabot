/**
 * Opt-out gate (docs/CORPUS-GUIDE.md). FAILS CLOSED: a failed fetch, a non-200
 * robots.txt, an unparseable signal, or any other ambiguity means `allowed: false`.
 * Blocking more can only narrow what is ingested, never widen it.
 */

export interface HeaderReader {
  get(name: string): string | null;
}
export interface FetchedResponse {
  status: number;
  headers: HeaderReader;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type Fetcher = (url: string, init?: { method?: string }) => Promise<FetchedResponse>;

export interface GateResult {
  allowed: boolean;
  reasons: string[];
}

/** Our own crawler token plus AI agents whose robots groups we honour. */
export const OUR_AGENT = "askabot";
export const AI_AGENTS = ["GPTBot", "CCBot", "ClaudeBot", "Google-Extended"];
const HONOURED = [OUR_AGENT, ...AI_AGENTS.map((a) => a.toLowerCase())];

interface Rule {
  allow: boolean;
  pattern: string;
}
interface Group {
  agents: string[];
  rules: Rule[];
}

function parseRobots(text: string): { groups: Group[]; contentSignals: string[] } {
  const groups: Group[] = [];
  const contentSignals: string[] = [];
  let current: Group | null = null;
  let collectingAgents = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();

    if (field === "user-agent") {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (field === "allow" || field === "disallow") {
      collectingAgents = false;
      if (current && value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "content-signal") {
      contentSignals.push(value);
    }
  }
  return { groups, contentSignals };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const src = body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + src + (anchored ? "$" : ""));
}

/** Longest matching pattern wins; Allow wins ties; no match => allowed. */
function pathAllowed(rules: Rule[], path: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const r of rules) {
    if (!patternToRegExp(r.pattern).test(path)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/** Returns a block reason, or null if the Content-Signal value permits use. */
function contentSignalBlock(value: string, where: string): string | null {
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return `${where}: empty Content-Signal (ambiguous)`;
  for (const p of parts) {
    const m = /^([a-z-]+)\s*=\s*(yes|no)$/i.exec(p);
    if (!m) return `${where}: unparseable Content-Signal "${p}" (ambiguous)`;
    if (m[2].toLowerCase() === "no") return `${where}: Content-Signal ${m[1].toLowerCase()}=no`;
  }
  return null;
}

/** Evaluate robots.txt text (robots rules for the path, plus any Content-Signal lines). */
export function evaluateRobots(text: string, path: string): GateResult {
  const reasons: string[] = [];
  const { groups, contentSignals } = parseRobots(text);

  for (const g of groups) {
    const hit = g.agents.filter((a) => a === "*" || HONOURED.includes(a));
    if (hit.length === 0) continue;
    if (!pathAllowed(g.rules, path)) {
      const lower = hit.find((a) => a !== "*");
      const named = lower ? (AI_AGENTS.find((a) => a.toLowerCase() === lower) ?? lower) : "*";
      reasons.push(`robots.txt disallows ${path} for User-agent: ${named}`);
    }
  }
  for (const cs of contentSignals) {
    const r = contentSignalBlock(cs, "robots.txt");
    if (r) reasons.push(r);
  }
  return { allowed: reasons.length === 0, reasons };
}

function tdmReservationBlock(v: string, where: string): string | null {
  const t = v.trim();
  if (t === "0") return null;
  if (t === "1") return `${where}: tdm-reservation: 1`;
  return `${where}: unparseable tdm-reservation "${t}" (ambiguous)`;
}

function metaTags(html: string): { name: string; content: string | null }[] {
  const out: { name: string; content: string | null }[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
    const name = attr("name");
    if (!name) continue;
    const content = attr("content");
    out.push({ name: (name[1] ?? name[2]).toLowerCase(), content: content ? (content[1] ?? content[2]) : null });
  }
  return out;
}

/** Evaluate a page response's headers (and, if supplied, its HTML meta tags). */
export function evaluateResponseSignals(headers: HeaderReader, html = ""): GateResult {
  const reasons: string[] = [];

  const tdmRes = headers.get("tdm-reservation");
  if (tdmRes !== null) {
    const r = tdmReservationBlock(tdmRes, "response header");
    if (r) reasons.push(r);
  }
  const tdmPol = headers.get("tdm-policy");
  if (tdmPol !== null && tdmPol.trim() !== "") {
    reasons.push("response header: tdm-policy present (policy cannot be evaluated)");
  }
  const cs = headers.get("content-signal");
  if (cs !== null) {
    const r = contentSignalBlock(cs, "response header");
    if (r) reasons.push(r);
  }

  for (const m of metaTags(html)) {
    if (m.name === "tdm-reservation") {
      const r = m.content === null ? "meta tdm-reservation without content (ambiguous)" : tdmReservationBlock(m.content, "meta tag");
      if (r) reasons.push(r);
    } else if (m.name === "tdm-policy") {
      reasons.push("meta tag: tdm-policy present (policy cannot be evaluated)");
    } else if (m.name === "content-signal") {
      const r = m.content === null ? "meta content-signal without content (ambiguous)" : contentSignalBlock(m.content, "meta tag");
      if (r) reasons.push(r);
    }
  }
  return { allowed: reasons.length === 0, reasons };
}

const looksLikeHtml = (t: string): boolean => /^\s*<(!doctype|html|\?xml)|<html[\s>]/i.test(t);

/** A non-empty robots.txt that is HTML, or has no `field: value` line at all, cannot be trusted. */
function robotsUnparseable(text: string): boolean {
  if (looksLikeHtml(text)) return true;
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  return lines.length > 0 && !lines.some((l) => /^[A-Za-z][A-Za-z-]*\s*:/.test(l));
}

/**
 * Fetch a published TDM reservation file. Absence (any 4xx except 429, or a soft-404 HTML
 * page) is NOT ambiguity and does not block; a fetch error, 429 or 5xx cannot be told apart
 * from a reservation we failed to read, so it blocks. Returns block reasons.
 */
async function checkTdmFile(
  origin: string,
  file: string,
  path: string,
  fetcher: Fetcher,
  evaluate: (body: string, path: string, where: string) => string[],
): Promise<string[]> {
  const where = file;
  try {
    const r = await fetcher(`${origin}${file}`);
    if (r.status >= 400 && r.status < 500 && r.status !== 429) return [];
    if (r.status < 200 || r.status >= 300) return [`${where} returned HTTP ${r.status} (fail closed)`];
    const body = await r.text();
    if (looksLikeHtml(body)) return [];
    return evaluate(body, path, where);
  } catch (e) {
    return [`${where} fetch failed: ${(e as Error).message} (fail closed)`];
  }
}

/** TDMRep /.well-known/tdmrep.json: [{location, "tdm-reservation": 0|1, "tdm-policy"?}, ...] */
function evaluateTdmrepJson(body: string, path: string, where: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [`${where} present but not valid JSON (fail closed)`];
  }
  if (!Array.isArray(doc)) return [`${where} present but not a rule list (fail closed)`];
  const reasons: string[] = [];
  for (const rule of doc) {
    const o = (typeof rule === "object" && rule !== null ? rule : {}) as Record<string, unknown>;
    const res = o["tdm-reservation"];
    if (typeof o.location !== "string" || (res !== 0 && res !== 1 && res !== "0" && res !== "1")) {
      reasons.push(`${where} contains a malformed rule (fail closed)`);
      continue;
    }
    if (!patternToRegExp(o.location).test(path)) continue;
    if (res === 1 || res === "1") reasons.push(`${where}: tdm-reservation 1 for ${o.location}`);
    if (o["tdm-policy"] !== undefined && o["tdm-policy"] !== "") {
      reasons.push(`${where}: tdm-policy for ${o.location} (policy cannot be evaluated)`);
    }
  }
  return reasons;
}

/** /tdm.txt: no normative format is known to us, so read `tdm-reservation:` / `tdm-policy:` lines. */
function evaluateTdmTxt(body: string, _path: string, where: string): string[] {
  const reasons: string[] = [];
  let recognised = false;
  for (const raw of body.split(/\r?\n/)) {
    const m = /^\s*(tdm-reservation|tdm-policy)\s*:\s*(.*?)\s*(#.*)?$/i.exec(raw);
    if (!m) continue;
    recognised = true;
    if (m[1].toLowerCase() === "tdm-policy") {
      if (m[2]) reasons.push(`${where}: tdm-policy present (policy cannot be evaluated)`);
    } else if (m[2] === "1") reasons.push(`${where}: tdm-reservation: 1`);
    else if (m[2] !== "0") reasons.push(`${where}: unparseable tdm-reservation "${m[2]}" (ambiguous)`);
  }
  if (!recognised && body.trim() !== "") reasons.push(`${where} present but expresses nothing recognisable (ambiguous)`);
  return reasons;
}

/**
 * Full gate for one URL, evaluated before its content is fetched:
 *  1. robots.txt per RFC 9309 §2.3.1: 2xx -> parse (unparseable => closed); 4xx except 429
 *     ("Unavailable") -> no policy, allowed; 429, 5xx, 3xx or a network error -> closed.
 *  2. TDM reservation files (absence allowed; present+reserving or unreadable => closed).
 *
 * The page's OWN response headers (Content-Signal / tdm-reservation) are deliberately NOT
 * fetched here. This gate used to issue a HEAD for them, and that caused a FALSE BLOCK on
 * any host that does not implement HEAD: nvlpubs.nist.gov answers HEAD with 404 while
 * serving the very same URL as 200 on GET, so NIST SP 800-63B-4 was skipped as though it
 * were missing. A HEAD's status cannot be trusted to mean what a GET's status means.
 *
 * The caller evaluates `evaluateResponseSignals` on the real content response instead --
 * where those headers are authoritative anyway -- so no coverage is lost, one request is
 * saved, and a server's HEAD support can no longer silence a legitimate source.
 *
 * A blocked/unreadable robots.txt stops here: no later request is made.
 * Never throws; every failure path returns `allowed: false` with a reason.
 */
export async function checkOptOut(url: string, fetcher: Fetcher): Promise<GateResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reasons: [`unparseable URL ${JSON.stringify(url)} (fail closed)`] };
  }

  const reasons: string[] = [];
  const path = parsed.pathname + parsed.search;

  try {
    const robots = await fetcher(`${parsed.origin}/robots.txt`);
    const s = robots.status;
    if (s >= 200 && s < 300) {
      const text = await robots.text();
      if (robotsUnparseable(text)) reasons.push("robots.txt is not parseable (fail closed)");
      else reasons.push(...evaluateRobots(text, path).reasons);
    } else if (s >= 400 && s < 500 && s !== 429) {
      // RFC 9309 §2.3.1.3 "Unavailable": no robots policy exists; access is allowed.
    } else {
      reasons.push(`robots.txt returned HTTP ${s} (fail closed)`);
    }
  } catch (e) {
    reasons.push(`robots.txt fetch failed: ${(e as Error).message} (fail closed)`);
  }

  // A blocked or unreadable robots.txt ends the check: never touch the page itself.
  if (reasons.length > 0) return { allowed: false, reasons };

  reasons.push(
    ...(await checkTdmFile(parsed.origin, "/.well-known/tdmrep.json", path, fetcher, evaluateTdmrepJson)),
    ...(await checkTdmFile(parsed.origin, "/tdm.txt", path, fetcher, evaluateTdmTxt)),
  );
  if (reasons.length > 0) return { allowed: false, reasons };

  return { allowed: reasons.length === 0, reasons };
}
