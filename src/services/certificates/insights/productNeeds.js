import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import { TEMPLATE_TOKEN_RE, productJsonColumns } from "../templates/sourceCatalogue.js";
import { parse, format, canonicalFull, normKey, resolveSegments, toLabel, isForbiddenKey } from "../paths/sourcePath.js";
import { getDictionary, pathSynonymMap } from "../dictionary/dataDictionary.js";
import { scheduleDictionaryRebuild } from "../dictionary/rebuildScheduler.js";
import { resolveField } from "../generation/valueResolver.js";

// What the company's ACTIVE templates need from its products (plan.md §9, A4):
//   - completeness: "these 14 products are missing specifications.pH, which 3
//     active templates need" — before an invoice ever arrives;
//   - structured product data entry: fixed inputs for exactly those values
//     (a pH spec, an assay spec, the constituents as a list of name + amount)
//     instead of free JSON. Saving writes ONLY the paths the templates need,
//     keeps every other key, and never touches a product of another company.
// Derived from template field sources (plain fields, combinations, and
// repeating groups reading a product list). Relations (category, brand) are
// not product data entry.

const JSON_COLUMNS = new Set(productJsonColumns());
// identity columns are edited at the top of the product form, never as "certificate data"
const SKIP_COLUMNS = new Set(["id", "companyId", "categoryId", "brandId", "createdAt", "updatedAt", "name", "productCode"]);
const TEXT_COLUMNS = new Set(
  Prisma.dmmf.datamodel.models
    .find((m) => m.name === "Product")
    .fields.filter((f) => f.kind === "scalar" && f.type === "String" && !f.isList && !SKIP_COLUMNS.has(f.name))
    .map((f) => f.name)
);
const MAX_LISTED = 100;
const MAX_VALUE = 1000;

/** Active template versions of the company → [{ templateId, name, versionId }] */
async function activeVersions(companyId) {
  const t = await prisma.certificateTemplate.findMany({ where: { companyId, archivedAt: null, activeVersionId: { not: null }, certificateType: { isActive: true } }, select: { id: true, name: true, activeVersionId: true } });
  return t.map((x) => ({ templateId: x.id, name: x.name, versionId: x.activeVersionId }));
}

/**
 * Splits a full product path into what an input edits.
 * → { kind: "text", column, rel } | { kind: "list", column, collection, child, filter?, index? } | null (not product data)
 */
export function classifyPath(full) {
  const p = parse(full);
  if (!p.ok || p.root !== "product" || p.segments[0]?.t !== "key") return null;
  const column = p.segments[0].k;
  if (!TEXT_COLUMNS.has(column) && !JSON_COLUMNS.has(column)) return null;
  const at = p.segments.findIndex((s) => s.t !== "key");
  if (at < 0) return JSON_COLUMNS.has(column) && p.segments.length === 1 ? null : { kind: "text", column, rel: format(p.segments) }; // a whole JSON column is not one text
  if (!JSON_COLUMNS.has(column)) return null;
  const rest = p.segments.slice(at + 1);
  if (!rest.length || rest.some((s) => s.t !== "key")) return null;
  const el = p.segments[at];
  return { kind: "list", column, collection: format(p.segments.slice(0, at)), child: format(rest), ...(el.t === "filter" ? { filter: { key: el.k, value: el.v } } : { index: el.i }) };
}

/**
 * → { texts: Map(rel → need), lists: Map(collection → need), versions }
 *   need: { label, templates: Set(name), required }
 *   list need: + children: Set(child key), expected: Set(filter values), keyField
 */
export async function neededProductPaths(companyId) {
  const versions = await activeVersions(companyId);
  const nameOf = new Map(versions.map((v) => [v.versionId, v.name]));
  const ids = versions.map((v) => v.versionId);
  const [fields, groups] = await Promise.all([
    prisma.templateField.findMany({ where: { versionId: { in: ids } }, select: { versionId: true, label: true, source: true, required: true, groupKey: true } }),
    prisma.templateGroup.findMany({ where: { versionId: { in: ids } }, select: { versionId: true, key: true, label: true, source: true, required: true } }),
  ]);
  const texts = new Map();
  const lists = new Map();
  const listNeed = (collection, column, label) => {
    if (!lists.has(collection)) lists.set(collection, { collection, column, label: label || toLabel(`product.${collection}`), templates: new Set(), required: false, children: new Set(), expected: new Set(), positions: new Set() });
    return lists.get(collection);
  };
  const add = (full, label, template, required) => {
    const c = classifyPath(canonicalFull(full) || full);
    if (!c) return;
    if (c.kind === "text") {
      if (!texts.has(c.rel)) texts.set(c.rel, { path: c.rel, column: c.column, label, templates: new Set(), required: false });
      const n = texts.get(c.rel);
      n.templates.add(template);
      n.required ||= required;
    } else {
      const n = listNeed(c.collection, c.column);
      n.templates.add(template);
      n.required ||= required;
      n.children.add(c.child);
      if (c.filter) {
        n.keyField = n.keyField || c.filter.key;
        n.expected.add(c.filter.value);
      } else n.positions.add(c.index);
    }
  };
  for (const f of fields.filter((x) => !x.groupKey)) {
    const s = f.source || {};
    const template = nameOf.get(f.versionId);
    if (s.kind === "product" && s.path) add(`product.${s.path}`, f.label, template, f.required);
    if (s.kind === "template") for (const m of String(s.template || "").matchAll(TEMPLATE_TOKEN_RE)) if (m[1] === "product" && m[2]) add(`product.${m[2]}`, f.label, template, f.required);
  }
  for (const g of groups) {
    if (g.source?.kind !== "product_list" || !g.source.path) continue;
    const p = parse(`product.${g.source.path}`);
    if (!p.ok || p.segments.some((s) => s.t !== "key") || !JSON_COLUMNS.has(p.segments[0].k)) continue;
    const n = listNeed(format(p.segments), p.segments[0].k, g.label);
    n.templates.add(nameOf.get(g.versionId));
    n.required ||= g.required;
    for (const cell of fields.filter((x) => x.versionId === g.versionId && x.groupKey === g.key)) if (cell.source?.kind === "row" && cell.source.path) n.children.add(cell.source.path);
  }
  return { texts, lists, versions };
}

// ── reading values ───────────────────────────────────────────────────────────
const relSegments = (rel) => parse(`product.${rel}`).segments;
const listAt = (product, collection) => {
  const r = resolveSegments(product, relSegments(collection));
  return Array.isArray(r.value) ? r.value : [];
};
const ownKey = (obj, k) => (obj && typeof obj === "object" ? Object.keys(obj).find((x) => normKey(x) === normKey(k)) : undefined);
const childValue = (el, child) => {
  const r = resolveSegments(el, relSegments(child));
  return r.found && ["string", "number"].includes(typeof r.value) ? String(r.value) : "";
};
const textValue = (product, rel, pathSynonyms) => resolveField({ source: { kind: "product", path: rel } }, { product, pathSynonyms }).resolved;

/** The missing parts of one list need on a product → [label] */
function listGaps(product, need) {
  const list = listAt(product, need.collection);
  const gaps = [];
  if (!list.length) return [need.label];
  for (const v of need.expected) {
    const el = list.find((x) => ownKey(x, need.keyField) !== undefined && normKey(x[ownKey(x, need.keyField)]) === normKey(v));
    for (const child of need.children) if (child !== need.keyField && (!el || !childValue(el, child))) gaps.push(`${need.label} › [${v}] › ${child}`);
  }
  for (const i of need.positions) for (const child of need.children) if (!list[i] || !childValue(list[i], child)) gaps.push(`${need.label} › #${i + 1} › ${child}`);
  return gaps;
}

// ── completeness (plan.md §9 "template-driven product completeness") ─────────
/**
 * GET /certificate-product-completeness
 * → { totals: { products, complete, incomplete, needs }, needs: [{ path, label, kind, templates[], required, missingCount, missing: [{ id, name }] }],
 *     products: [{ id, name, missing: [label] }] }
 */
export async function completeness(companyId) {
  const { texts, lists } = await neededProductPaths(companyId);
  const dict = await getDictionary(companyId);
  const pathSynonyms = pathSynonymMap(dict.entries);
  const products = await prisma.product.findMany({ where: { companyId }, orderBy: { name: "asc" } });
  const needs = [];
  const byProduct = new Map(products.map((p) => [p.id, []]));
  for (const n of texts.values()) {
    const missing = products.filter((p) => !textValue(p, n.path, pathSynonyms));
    for (const p of missing) byProduct.get(p.id).push(n.label);
    needs.push({ path: `product.${n.path}`, label: n.label, kind: "text", templates: [...n.templates], required: n.required, missingCount: missing.length, missing: missing.slice(0, MAX_LISTED).map((p) => ({ id: p.id, name: p.name })) });
  }
  for (const n of lists.values()) {
    const missing = [];
    for (const p of products) {
      const gaps = listGaps(p, n);
      if (gaps.length) {
        missing.push(p);
        byProduct.get(p.id).push(...gaps);
      }
    }
    needs.push({ path: `product.${n.collection}`, label: n.label, kind: "list", children: [...n.children], expected: [...n.expected], templates: [...n.templates], required: n.required, missingCount: missing.length, missing: missing.slice(0, MAX_LISTED).map((p) => ({ id: p.id, name: p.name })) });
  }
  needs.sort((a, b) => b.missingCount - a.missingCount);
  const incomplete = products.filter((p) => byProduct.get(p.id).length).map((p) => ({ id: p.id, name: p.name, missing: byProduct.get(p.id) })).sort((a, b) => b.missing.length - a.missing.length);
  return { totals: { products: products.length, complete: products.length - incomplete.length, incomplete: incomplete.length, needs: needs.length }, needs, products: incomplete.slice(0, 500) };
}

// ── structured product data entry (plan.md §9) ───────────────────────────────
/**
 * The fixed inputs for the product form → { fields: [{ path, label, column, templates, required }],
 * lists: [{ path, label, keyField, children[], expected[], templates, required }] }
 */
export async function structuredDefinition(companyId) {
  const { texts, lists } = await neededProductPaths(companyId);
  const dict = await getDictionary(companyId);
  return {
    fields: [...texts.values()].map((n) => ({ path: n.path, label: n.label, column: n.column, templates: [...n.templates], required: n.required })),
    lists: [...lists.values()].map((n) => {
      const entry = dict.entries.find((e) => e.path === `product.${n.collection}[]`);
      const keyField = n.keyField || entry?.keyField || "name";
      const children = [...new Set([keyField, ...n.children])];
      return { path: n.collection, label: n.label, keyField, children, expected: [...n.expected], templates: [...n.templates], required: n.required };
    }),
  };
}

async function loadProduct(companyId, productId) {
  const p = await prisma.product.findFirst({ where: { id: productId, ...(companyId ? { companyId } : {}) } });
  if (!p) throw notFound("Product");
  return p;
}

/** GET /certificate-products/:id/data → { definition, values: { [path]: text }, lists: { [path]: [{ child: text }] }, missing: [label] } */
export async function productData(productId, companyScope) {
  const product = await loadProduct(companyScope, productId);
  const def = await structuredDefinition(product.companyId);
  const values = Object.fromEntries(def.fields.map((f) => [f.path, (() => {
    const r = resolveSegments(product, relSegments(f.path));
    return r.found && ["string", "number"].includes(typeof r.value) ? String(r.value) : "";
  })()]));
  const lists = Object.fromEntries(def.lists.map((l) => [l.path, listAt(product, l.path).filter((el) => el && typeof el === "object").map((el) => Object.fromEntries(l.children.map((c) => [c, childValue(el, c)])))]));
  const { texts, lists: listNeeds } = await neededProductPaths(product.companyId);
  const dict = await getDictionary(product.companyId);
  const pathSynonyms = pathSynonymMap(dict.entries);
  const missing = [...[...texts.values()].filter((n) => !textValue(product, n.path, pathSynonyms)).map((n) => n.label), ...[...listNeeds.values()].flatMap((n) => listGaps(product, n))];
  return { productId: product.id, name: product.name, definition: def, values, lists, missing };
}

// writing: only key segments, keeping an existing key's spelling ("PH" stays "PH")
function setIn(obj, segments, value) {
  const root = obj && typeof obj === "object" && !Array.isArray(obj) ? structuredClone(obj) : {};
  let cur = root;
  segments.forEach((s, i) => {
    if (s.t !== "key" || isForbiddenKey(s.k)) throw new CertError("INVALID_PATH", "Only plain keys can be written", 400);
    const k = ownKey(cur, s.k) ?? s.k;
    if (i === segments.length - 1) {
      if (value === null) delete cur[k];
      else cur[k] = value;
      return;
    }
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  });
  return root;
}

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, MAX_VALUE);
  return s || null;
};

/**
 * PATCH /certificate-products/:id/data — { values?: { [path]: text|null }, lists?: { [path]: [{ child: text }] } }
 * Only paths of the structured definition are written; other keys and other
 * elements' extra keys are kept. A list replaces the list's rows (matched to
 * the existing elements by its key field, whose other keys survive).
 */
export async function saveProductData(productId, companyScope, { values = {}, lists = {} }) {
  const product = await loadProduct(companyScope, productId);
  const def = await structuredDefinition(product.companyId);
  const fieldByPath = new Map(def.fields.map((f) => [f.path, f]));
  const listByPath = new Map(def.lists.map((l) => [l.path, l]));
  const data = {};
  const current = { ...product };
  const unknown = [...Object.keys(values).filter((p) => !fieldByPath.has(p)), ...Object.keys(lists).filter((p) => !listByPath.has(p))];
  if (unknown.length) throw new CertError("NOT_A_CERTIFICATE_FIELD", `Not a value your active templates need: ${unknown.join(", ")}`, 400, { paths: unknown });
  for (const [path, raw] of Object.entries(values)) {
    const f = fieldByPath.get(path);
    const segs = relSegments(path);
    const v = clean(raw);
    if (segs.length === 1) data[f.column] = v;
    else {
      current[f.column] = setIn(current[f.column], segs.slice(1), v);
      data[f.column] = current[f.column];
    }
  }
  for (const [path, rows] of Object.entries(lists)) {
    const l = listByPath.get(path);
    if (!Array.isArray(rows) || rows.length > 200) throw new CertError("INVALID_LIST", `${l.label} must be a list of at most 200 rows`, 400);
    const segs = relSegments(path);
    const existing = listAt(current, path).filter((el) => el && typeof el === "object");
    const next = [];
    for (const row of rows) {
      const cells = Object.fromEntries(l.children.map((c) => [c, clean(row?.[c])]));
      if (Object.values(cells).every((x) => x === null)) continue;
      const keyVal = cells[l.keyField];
      const prev = keyVal ? existing.find((el) => ownKey(el, l.keyField) !== undefined && normKey(el[ownKey(el, l.keyField)]) === normKey(keyVal)) : null;
      let el = prev ? structuredClone(prev) : {};
      for (const [c, v] of Object.entries(cells)) el = setIn(el, relSegments(c), v);
      next.push(el);
    }
    if (segs.length === 1) data[segs[0].k] = next;
    else {
      current[segs[0].k] = setIn(current[segs[0].k], segs.slice(1), next);
      data[segs[0].k] = current[segs[0].k];
    }
  }
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  if (Object.keys(data).length) {
    await prisma.product.update({ where: { id: product.id }, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON_COLUMNS.has(k) && v === null ? Prisma.DbNull : v])) });
    await scheduleDictionaryRebuild(product.companyId);
  }
  return productData(product.id, product.companyId);
}
