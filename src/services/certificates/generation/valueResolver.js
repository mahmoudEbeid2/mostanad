import { TEMPLATE_TOKEN_RE } from "../templates/sourceCatalogue.js";

// Pure value resolution (CERTIFICATES_V2_PLAN.md §10.3, §10.4, D7). No I/O,
// no model inference, no fallbacks: a value comes from its declared source or
// it is empty — and the caller's fill() flags an empty required field
// `missing`. A `template` source is plain placeholder substitution; nothing in
// it is ever evaluated.
//
// ctx: { item: { …item.data }, invoice: { …header }, product: { …, category, brand }, company, brand, today: Date }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const own = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

/** Reads `a.b[0].c` from an object — own data properties only (no prototype,
 *  no `constructor`, no functions). Never evaluates anything. */
export function readPath(obj, path) {
  if (obj === null || obj === undefined || !path) return undefined;
  let cur = obj;
  for (const part of String(path).split(".")) {
    const m = part.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    cur = own(cur, m[1]) ? cur[m[1]] : undefined;
    for (const idx of m[2].match(/\d+/g) || []) cur = Array.isArray(cur) && own(cur, idx) ? cur[Number(idx)] : undefined;
    if (cur === null || cur === undefined) return undefined;
  }
  return cur;
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

const todayIso = (ctx) => (ctx.today instanceof Date ? ctx.today : new Date()).toISOString().slice(0, 10);

function rawValue(source, ctx) {
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
        const v = kind === "today" ? todayIso(ctx) : asText(readPath(contextFor(kind, ctx), path));
        if (!v) missing = true;
        return v;
      });
      // a half-filled combination ("COA" without the batch) would be silently
      // wrong — D7: the whole value is empty and gets flagged instead
      // leftover braces = a "placeholder" that isn't one (validation rejects it
      // on save); refuse it here too rather than print template syntax
      return missing || /\{\{|\}\}/.test(out) ? "" : out;
    }
    default:
      return asText(readPath(contextFor(source.kind, ctx), source.path));
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
 * field: { key, source, format } → { value, resolved, flags }
 * `resolved` is the source value before formatting ("" when absent).
 */
export function resolveField(field, ctx = {}) {
  const resolved = rawValue(field.source || { kind: "manual" }, ctx);
  const { value, flags } = applyFormat(resolved, field.format);
  return { value, resolved, flags };
}

/** All fields → { [key]: { value, resolved, flags } }. */
export function resolveAll(fields, ctx = {}) {
  return Object.fromEntries(fields.map((f) => [f.key, resolveField(f, ctx)]));
}
