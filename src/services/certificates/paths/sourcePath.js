// The source path language (plan.md §3.1). One small grammar addresses every
// value a certificate field can read, including values INSIDE product JSON:
//
//   path    := root ("." key | "[" index "]" | "[" filter "]" | "[" quoted "]")*
//   root    := product | item | invoice | company | brand
//   key     := identifier                     specifications
//   quoted  := "\"" text "\""                 values["Assay %"]
//   index   := integer                        activeIngredients[1]
//   filter  := key "=" quoted                 activeIngredients[name="Vitamin E"]
//
// Parsed by this file only — nothing is ever evaluated. Reads own data
// properties only (no prototype, no functions). resolve() never throws.
//
// Stored sources keep their V2 shape { kind, path }: `kind` is the root and
// `path` is the rest of the grammar (read-time adapter, no data migration).

export const ROOTS = ["product", "item", "invoice", "company", "brand"];
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
/** Keys no path may name — nor may the dictionary list them. */
export const isForbiddenKey = (k) => FORBIDDEN.has(k);
const MAX_SEGMENTS = 12;
const MAX_LENGTH = 300;

// a JS-ish identifier, unicode letters allowed: ws_period, Größe
const IDENT_RE = /^[\p{L}_$][\p{L}\p{N}_$]*/u;
export const isIdentifier = (s) => typeof s === "string" && new RegExp(`${IDENT_RE.source}$`, "u").test(s);

/** Case- and space-insensitive comparison key (filters, key variants). */
export const normKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, "");

class PathError extends Error {}

function readQuoted(src, i) {
  // src[i] === '"'; → [text, nextIndex]. Inside quotes: \" and \\ are escapes.
  let out = "";
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\" && (src[j + 1] === '"' || src[j + 1] === "\\")) {
      out += src[j + 1];
      j += 2;
      continue;
    }
    if (c === '"') return [out, j + 1];
    out += c;
    j++;
  }
  throw new PathError("unterminated quoted key");
}

/**
 * Relative path (no root) → segments, or throws PathError.
 * Segment: { t: "key", k } | { t: "index", i } | { t: "filter", k, v }
 */
function parseSegments(src) {
  const segs = [];
  let i = 0;
  let expectKey = true; // at the start, or right after "."
  while (i < src.length) {
    const c = src[i];
    if (expectKey) {
      const m = src.slice(i).match(IDENT_RE);
      if (!m) throw new PathError(`expected a key at position ${i}`);
      segs.push({ t: "key", k: m[0] });
      i += m[0].length;
      expectKey = false;
      continue;
    }
    if (c === ".") {
      i++;
      expectKey = true;
      if (i >= src.length) throw new PathError("path ends with '.'");
      continue;
    }
    if (c === "[") {
      i++;
      if (src[i] === '"') {
        const [text, next] = readQuoted(src, i);
        if (!text.length) throw new PathError("empty quoted key");
        if (src[next] !== "]") throw new PathError("expected ']' after quoted key");
        segs.push({ t: "key", k: text });
        i = next + 1;
      } else if (/\d/.test(src[i] || "")) {
        const m = src.slice(i).match(/^\d{1,4}/);
        if (src[i + m[0].length] !== "]") throw new PathError("expected ']' after index");
        segs.push({ t: "index", i: Number(m[0]) });
        i += m[0].length + 1;
      } else {
        const m = src.slice(i).match(IDENT_RE);
        if (!m || src[i + m[0].length] !== "=" || src[i + m[0].length + 1] !== '"') throw new PathError("expected [index], [\"key\"] or [key=\"value\"]");
        const [text, next] = readQuoted(src, i + m[0].length + 1);
        if (src[next] !== "]") throw new PathError("expected ']' after filter");
        segs.push({ t: "filter", k: m[0], v: text });
        i = next + 1;
      }
      continue;
    }
    throw new PathError(`unexpected '${c}' at position ${i}`);
  }
  if (expectKey) throw new PathError("empty path");
  if (segs.length > MAX_SEGMENTS) throw new PathError("path is too deep");
  for (const s of segs) if ((s.t === "key" || s.t === "filter") && FORBIDDEN.has(s.k)) throw new PathError(`"${s.k}" is not allowed`);
  return segs;
}

// V2 stored product paths with a free-text key after `specifications.values.`
// (sourceCatalogue's old SPEC_RE: spaces, %, parentheses…) → quoted form.
const LEGACY_SPEC_RE = /^specifications\.values\.([A-Za-z0-9 _\-().%/]{1,60})$/;

/** A relative path in canonical grammar form (legacy spellings adapted). */
export function canonicalRelative(path) {
  const p = String(path ?? "");
  const legacy = p.match(LEGACY_SPEC_RE);
  if (legacy && !isIdentifier(legacy[1])) return `specifications.values${quoteKey(legacy[1])}`;
  return p;
}

/** → { ok: true, segments } | { ok: false, error } for a path WITHOUT root. */
export function parseRelative(path) {
  const p = canonicalRelative(path);
  if (!p || p.length > MAX_LENGTH) return { ok: false, error: p ? "path is too long" : "path is empty" };
  try {
    return { ok: true, segments: parseSegments(p) };
  } catch (err) {
    if (err instanceof PathError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Full path "product.specifications.values[\"pH\"]" → { ok, root, segments } | { ok: false, error }. */
export function parse(fullPath) {
  const s = String(fullPath ?? "");
  const m = s.match(/^([a-z]+)(?:\.(.*))?$/s);
  if (!m || !ROOTS.includes(m[1])) return { ok: false, error: `a path starts with one of ${ROOTS.join(", ")}` };
  if (m[2] === undefined) return { ok: false, error: "a path needs at least one key after the root" };
  const rel = parseRelative(m[2]);
  return rel.ok ? { ok: true, root: m[1], segments: rel.segments } : rel;
}

export const quoteKey = (k) => `["${String(k).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

/** segments → relative path text (canonical: identifiers dotted, others quoted). */
export function format(segments) {
  let out = "";
  for (const s of segments) {
    if (s.t === "index") out += `[${s.i}]`;
    else if (s.t === "filter") out += `[${s.k}=${JSON.stringify(String(s.v))}]`;
    else if (isIdentifier(s.k)) out += out ? `.${s.k}` : s.k;
    else out += quoteKey(s.k);
  }
  return out;
}

const own = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

/** The own key of `obj` matching `k`: exact first, else the single case/space-insensitive match. */
function matchKey(obj, k) {
  if (own(obj, k)) return k;
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const want = normKey(k);
  const hits = Object.keys(obj).filter((x) => normKey(x) === want);
  return hits.length === 1 ? hits[0] : null;
}

const typeOf = (v) => (v === null || v === undefined ? "null" : Array.isArray(v) ? "array" : v instanceof Date ? "date" : typeof v);

/**
 * Walk `segments` from `obj`. → { found, value, type, path } — `path` is the
 * concrete relative path that was hit (the real key spelling, the matched
 * element's index). Never throws.
 */
export function resolveSegments(obj, segments) {
  let cur = obj;
  const hit = [];
  for (const s of segments) {
    if (cur === null || cur === undefined || typeof cur === "function") return { found: false, value: undefined, type: "null", path: format(hit) };
    if (s.t === "index") {
      if (!Array.isArray(cur) || !own(cur, String(s.i))) return { found: false, value: undefined, type: "null", path: format(hit) };
      cur = cur[s.i];
      hit.push(s);
    } else if (s.t === "filter") {
      if (!Array.isArray(cur)) return { found: false, value: undefined, type: "null", path: format(hit) };
      const want = normKey(s.v);
      const idx = cur.findIndex((el) => {
        const k = matchKey(el, s.k);
        return k !== null && ["string", "number"].includes(typeof el[k]) && normKey(el[k]) === want;
      });
      if (idx < 0) return { found: false, value: undefined, type: "null", path: format(hit) };
      cur = cur[idx];
      hit.push({ t: "index", i: idx });
    } else {
      if (cur instanceof Date) return { found: false, value: undefined, type: "null", path: format(hit) };
      const k = matchKey(cur, s.k);
      if (k === null || FORBIDDEN.has(k)) return { found: false, value: undefined, type: "null", path: format(hit) };
      cur = cur[k];
      hit.push({ t: "key", k });
    }
    if (typeof cur === "function") return { found: false, value: undefined, type: "null", path: format(hit) };
  }
  const empty = cur === null || cur === undefined || (typeof cur === "string" && !cur.trim());
  return { found: !empty, value: empty ? undefined : cur, type: typeOf(cur), path: format(hit) };
}

/** Relative path on one object (V2 `{ kind, path }` sources). Never throws. */
export function resolveRelative(obj, path) {
  const p = parseRelative(path);
  if (!p.ok) return { found: false, value: undefined, type: "null", path: "", error: p.error };
  return resolveSegments(obj, p.segments);
}

/**
 * Full path against a context { product, item, invoice, company, brand }.
 * → { found, value, type, path } with `path` the concrete full path. Never throws.
 */
export function resolve(ctx, fullPath) {
  const p = parse(fullPath);
  if (!p.ok) return { found: false, value: undefined, type: "null", path: "", error: p.error };
  const base = p.root === "brand" ? ctx?.brand ?? ctx?.product?.brand : ctx?.[p.root];
  const r = resolveSegments(base, p.segments);
  return { ...r, path: r.path ? `${p.root}.${r.path}` : p.root };
}

/** `{ kind, path }` → full path text, or null when the kind has no path. */
export function fromSource(source) {
  if (!source || !ROOTS.includes(source.kind) || !source.path) return null;
  return `${source.kind}.${canonicalRelative(source.path)}`;
}

const ROOT_LABELS = { product: "Product", item: "Invoice line", invoice: "Invoice", company: "Company", brand: "Brand" };
const humanize = (s) =>
  String(s)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

// Column names (activeIngredients → "Active ingredients") and plain
// lower-case keys (concentration, ws_period) are humanised; any other key is a
// spelling someone chose inside JSON ("pH", "Assay %") and is shown as written.
function keyLabel(k, isColumn) {
  if (!(isColumn ? isIdentifier(k) : /^[a-z][a-z0-9_]*$/.test(k))) return k;
  const h = humanize(k);
  return h.charAt(0) + h.slice(1).replace(/\b([A-Z])(?=[a-z])/g, (c) => c.toLowerCase());
}

/**
 * Human label: product.specifications.values["pH"] → "Product › Specifications › pH",
 * product.activeIngredients[name="Vitamin E"].concentration → "Product › Active ingredients › [Vitamin E] › Concentration".
 * `values` (the specifications wrapper) is not shown. Invalid paths come back as written.
 */
export function toLabel(fullPath) {
  const p = parse(fullPath);
  if (!p.ok) return String(fullPath ?? "");
  const parts = [ROOT_LABELS[p.root]];
  p.segments.forEach((s, i) => {
    if (s.t === "index") parts.push(`#${s.i + 1}`);
    else if (s.t === "filter") parts.push(`[${s.v}]`);
    else if (s.k === "values" && p.segments[i - 1]?.k === "specifications") return;
    else parts.push(keyLabel(s.k, i === 0));
  });
  return parts.join(" › ");
}

/** A full path in its one canonical spelling (identifiers dotted, others quoted), or null when invalid. */
export function canonicalFull(fullPath) {
  const p = parse(fullPath);
  return p.ok ? `${p.root}.${format(p.segments)}` : null;
}
