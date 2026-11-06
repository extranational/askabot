import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { SHARE_ALIKE_NOTICE } from "./citations";
import type { CorpusEntry } from "./corpus";
import { LICENCES } from "./licences";

/** Shape of content/notices.yaml. The prose is approved copy: this module renders it, never rewrites it. */
export interface NoticeSection {
  heading: string;
  paragraphs?: string[];
  list?: string[];
  ordered?: boolean;
  after?: string[];
  attribution_list?: boolean;
}
export interface NoticesDoc {
  title: string;
  updated: string;
  contact_email: string;
  sections: NoticeSection[];
}

const SECTION_KEYS = ["heading", "paragraphs", "list", "ordered", "after", "attribution_list"];

function strings(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`notices: ${where} must be a list of strings`);
  return v as string[];
}

export function parseNotices(text: string): NoticesDoc {
  const raw = parse(text) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("notices: document must be a mapping");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!["title", "updated", "contact_email", "sections"].includes(k)) throw new Error(`notices: unknown key "${k}"`);
  }
  for (const k of ["title", "updated", "contact_email"]) {
    if (typeof o[k] !== "string" || !o[k]) throw new Error(`notices: ${k} must be a non-empty string`);
  }
  if (!Array.isArray(o.sections) || o.sections.length === 0) throw new Error("notices: sections must be a non-empty list");
  const sections = o.sections.map((s, i): NoticeSection => {
    const where = `sections[${i}]`;
    if (typeof s !== "object" || s === null || Array.isArray(s)) throw new Error(`notices: ${where} must be a mapping`);
    const r = s as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!SECTION_KEYS.includes(k)) throw new Error(`notices: ${where} unknown key "${k}"`);
    if (typeof r.heading !== "string" || !r.heading) throw new Error(`notices: ${where}.heading required`);
    for (const k of ["ordered", "attribution_list"]) {
      if (r[k] !== undefined && typeof r[k] !== "boolean") throw new Error(`notices: ${where}.${k} must be a boolean`);
    }
    return {
      heading: r.heading,
      paragraphs: strings(r.paragraphs, `${where}.paragraphs`),
      list: strings(r.list, `${where}.list`),
      ordered: r.ordered as boolean | undefined,
      after: strings(r.after, `${where}.after`),
      attribution_list: r.attribution_list as boolean | undefined,
    };
  });
  return { title: o.title as string, updated: o.updated as string, contact_email: o.contact_email as string, sections };
}

export function loadNotices(path = "content/notices.yaml"): NoticesDoc {
  return parseNotices(readFileSync(path, "utf8"));
}

/** Escape text for use in element content or a double-quoted attribute value. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Only http(s) URLs become hrefs; anything else is shown as escaped text. */
const isHttp = (u: string): boolean => /^https?:\/\//i.test(u);

function renderAttributionList(manifest: readonly CorpusEntry[]): string {
  if (manifest.length === 0) return "";
  const items = manifest.map((e) => {
    const title = isHttp(e.url) ? `<a href="${esc(e.url)}" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title);
    const status = e.mode === "full" ? "Ingested" : "Cited only (linked, not copied or stored)";
    return (
      `<li>${title}` +
      `<br>Licence: ${esc(LICENCES[e.licence].display_name)}` +
      `<br>${esc(e.attribution)}` +
      `<br>Status: ${status}</li>`
    );
  });
  const sa = manifest.filter((e) => LICENCES[e.licence].share_alike === true).map((e) => e.url);
  const saNote = sa.length > 0 ? `<p>${esc(SHARE_ALIKE_NOTICE(sa))}</p>` : "";
  return `<ul class="sources">${items.join("")}</ul>${saNote}`;
}

function renderSection(s: NoticeSection, manifest: readonly CorpusEntry[]): string {
  const p = (t: string) => `<p>${esc(t)}</p>`;
  const tag = s.ordered ? "ol" : "ul";
  return (
    `<section><h2>${esc(s.heading)}</h2>` +
    (s.paragraphs ?? []).map(p).join("") +
    (s.list ? `<${tag}>${s.list.map((t) => `<li>${esc(t)}</li>`).join("")}</${tag}>` : "") +
    (s.after ?? []).map(p).join("") +
    (s.attribution_list ? renderAttributionList(manifest) : "") +
    `</section>`
  );
}

/** Full HTML document for GET /notices. Everything from config is escaped on output. */
export function renderNoticesPage(doc: NoticesDoc, manifest: readonly CorpusEntry[]): string {
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(doc.title)}</title></head><body><main>` +
    `<h1>${esc(doc.title)}</h1>` +
    `<p>Last updated: <time datetime="${esc(doc.updated)}">${esc(doc.updated)}</time></p>` +
    doc.sections.map((s) => renderSection(s, manifest)).join("") +
    `</main></body></html>\n`
  );
}
