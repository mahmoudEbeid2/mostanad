import { TEMPLATE_TOKEN_RE } from "../templates/sourceCatalogue.js";
import { resolveRelative, fromSource, parse, canonicalFull } from "../paths/sourcePath.js";

// Pure value resolution (CERTIFICATES_V2_PLAN.md §10.3, §10.4, D7). No I/O,
// no model inference, no fallbacks: a value comes from its declared source or
// it is empty — and the caller's fill() flags an empty required field
// `missing`. A `template` source is plain placeholder substitution; nothing in
// it is ever evaluated.
//
// ctx: { item: { …item.data }, invoice: { …header }, product: { …, category, brand }, company, brand, today: Date,
//        pathSynonyms?: { [canonical full path]: [alternative full paths] } }
// pathSynonyms (plan.md §6.1 "near-miss learning", A2): alternatives a person
// accepted company-wide ("PH value" for "pH"). Tried only when the declared
// path is empty; the value still comes from the product, never from a model.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Reads a relative source path (plan.md §3.1 grammar: `a.b[0].c`,
 *  `values["Assay %"]`, `list[name="Vitamin E"].x`) — own data properties
 *  only (no prototype, no `constructor`, no functions). Never evaluates
 *  anything; undefined when absent or invalid. */
export function readPath(obj, path) {
  if (obj === null || obj === undefined || !path) return undefined;
  return resolveRelative(obj, path).value;
}

/** A source value as text, or "" when absent / not representable. */
function asText(v) {
  if (v === null || v === undefined || typeof v === "function") return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.every((x) => ["string", "number"].includes(typeof x)) ? v.map(String).filter(Boolean).join(", ") : "";
  if (typeof v === "object") {
    // invoice values keep { raw, iso } when extraction normalised a date (§9.1)
    if ("iso" in v || "raw" in v) return asText(v.iso ?? v.raw);
    return "";
  }
  return String(v).trim();
}

function contextFor(kind, ctx) {
  switch (kind) {
    case "item":
      return ctx.item;
    case "invoice":
      return ctx.invoice;
    case "product":
      return ctx.product;
    case "company":
      return ctx.company;
    case "brand":
      return ctx.brand ?? ctx.product?.brand;
    default:
      return undefined;
  }
}

// review #13: "today" is the calendar date where the certificates are issued
// (CERT_TZ, default Africa/Cairo), not UTC — 00:30 in Cairo is still the
// previous day in UTC. en-CA formats as YYYY-MM-DD.
export const CERT_TZ = process.env.CERT_TZ || "Africa/Cairo";
const todayIso = (ctx) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone || CERT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ctx.today instanceof Date ? ctx.today : new Date());

/** One path's text, trying accepted synonyms when it is empty → { text, via? } */
function readText(kind, path, ctx) {
  const text = asText(readPath(contextFor(kind, ctx), path));
  if (text || !ctx.pathSynonyms) return { text };
  const full = canonicalFull(fromSource({ kind, path }));
  for (const alt of (full && ctx.pathSynonyms[full]) || []) {
    const p = parse(alt);
    if (!p.ok || p.root !== kind) continue;
    const t = asText(readPath(contextFor(kind, ctx), alt.slice(kind.length + 1)));
    if (t) return { text: t, via: alt };
  }
  return { text: "" };
}

function rawValue(source, ctx, hit = {}) {
  switch (source.kind) {
    case "static":
      return source.text ?? "";
    case "manual":
      return "";
    case "today":
      return todayIso(ctx);
    case "template": {
      let missing = false;
      const out = String(source.template).replace(TEMPLATE_TOKEN_RE, (_m, kind, path) => {
        if (kind === "today") return todayIso(ctx);
        const r = readText(kind, path, ctx);
        if (r.via) hit.via = r.via;
        if (!r.text) missing = true;
        return r.text;
      });
      // a half-filled combination ("COA" without the batch) would be silently
      // wrong — D7: the whole value is empty and gets flagged instead
      // leftover braces = a "placeholder" that isn't one (validation rejects it
      // on save); refuse it here too rather than print template syntax
      return missing || /\{\{|\}\}/.test(out) ? "" : out;
    }
    default: {
      const r = readText(source.kind, source.path, ctx);
      if (r.via) hit.via = r.via;
      return r.text;
    }
  }
}

// ── formats ──────────────────────────────────────────────────────────────────
/** Parses YYYY-MM-DD / YYYY-MM / full ISO → { y, m, d|null } or null. */
export function parseIsoDate(s) {
  const m = String(s).trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : null;
  if (mo < 1 || mo > 12 || (d !== null && (d < 1 || d > 31))) return null;
  return { y, m: mo, d };
}

/** → { text } or { error } when the value can't be formatted without inventing data. */
export function formatDate(value, pattern) {
  const p = parseIsoDate(value);
  if (!p) return { error: true };
  if (/DD/.test(pattern) && p.d === null) return { error: true }; // never invent a day
  const pad = (n) => String(n).padStart(2, "0");
  const text = pattern.replace(/YYYY|MMM|DD|MM|YY/g, (t) =>
    t === "YYYY" ? String(p.y) : t === "YY" ? String(p.y).slice(-2) : t === "MMM" ? MONTHS[p.m - 1] : t === "MM" ? pad(p.m) : pad(p.d)
  );
  return { text };
}

function formatNumber(value, { decimals, thousands } = {}) {
  const n = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || String(value).trim() === "") return { error: true };
  let text = decimals !== undefined ? n.toFixed(decimals) : String(n);
  if (thousands) {
    const [int, frac] = text.split(".");
    text = int.replace(/\B(?=(\d{3})+(?!\d))/g, thousands) + (frac !== undefined ? `.${frac}` : "");
  }
  return { text };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/])(\p{L})/gu, (_m, sep, c) => sep + c.toUpperCase());

/** → { value, flags } after applying `format` to a resolved, non-empty value. */
export function applyFormat(value, format) {
  if (!format || value === "") return { value, flags: [] };
  const flags = [];
  let v = value;
  if (format.date) {
    const r = formatDate(v, format.date);
    if (r.error) flags.push("format"); // raw value kept (§10.3)
    else v = r.text;
  }
  if (format.number) {
    const r = formatNumber(v, format.number);
    if (r.error) flags.push("format");
    else v = r.text;
  }
  if (format.case === "upper") v = v.toUpperCase();
  else if (format.case === "lower") v = v.toLowerCase();
  else if (format.case === "title") v = titleCase(v);
  if (format.prefix) v = format.prefix + v;
  if (format.suffix) v = v + format.suffix;
  return { value: v, flags };
}

/**
 * field: { key, source, format } → { value, resolved, flags, via? }
 * `resolved` is the source value before formatting ("" when absent); `via` the
 * accepted synonym path that supplied it, when one did.
 */
export function resolveField(field, ctx = {}) {
  const hit = {};
  const resolved = rawValue(field.source || { kind: "manual" }, ctx, hit);
  const { value, flags } = applyFormat(resolved, field.format);
  return { value, resolved, flags, ...(hit.via ? { via: hit.via } : {}) };
}

/** All plain fields (group cells excluded) → { [key]: { value, resolved, flags } }. */
export function resolveAll(fields, ctx = {}) {
  return Object.fromEntries(fields.filter((f) => !f.groupKey).map((f) => [f.key, resolveField(f, ctx)]));
}

export const MAX_RESOLVED_ROWS = 200;

/** The list a group's rows come from (§7.8, §10.3). Manual → []. */
function groupList(group, ctx) {
  const src = group.source || {};
  if (src.kind === "product_list") {
    const list = readPath(ctx.product, src.path);
    return Array.isArray(list) ? list : [];
  }
  if (src.kind === "invoice_lines") return Array.isArray(ctx.lines) ? ctx.lines : [];
  return [];
}

/**
 * One group → { rows: [{ cellKey: value }], resolvedRows, flags }. Each cell
 * reads its own row ({ kind: "row", path }), a fixed text, or stays empty
 * (manual). Values only ever come from the declared list (D7).
 */
export function resolveGroup(group, cells, ctx = {}) {
  const list = groupList(group, ctx).slice(0, MAX_RESOLVED_ROWS);
  const flags = new Set();
  const rows = [];
  const resolvedRows = [];
  for (const item of list) {
    const row = {};
    const raw = {};
    for (const c of cells) {
      const s = c.source || { kind: "manual" };
      const resolved = s.kind === "row" ? asText(readPath(item, s.path)) : s.kind === "static" ? s.text ?? "" : "";
      const { value, flags: f } = applyFormat(resolved, c.format);
      f.forEach((x) => flags.add(x));
      row[c.key] = value;
      raw[c.key] = resolved;
    }
    rows.push(row);
    resolvedRows.push(raw);
  }
  return { rows, resolvedRows, flags: [...flags] };
}

/** All groups → { [groupKey]: { rows, resolvedRows, flags } }. */
export function resolveGroups(groups, fields, ctx = {}) {
  return Object.fromEntries((groups || []).map((g) => [g.key, resolveGroup(g, fields.filter((f) => f.groupKey === g.key).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), ctx)]));
}
