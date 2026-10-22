import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { notFound } from "../errors.js";
import { getSourceCatalogue, productJsonColumns } from "../templates/sourceCatalogue.js";
import { normKey, toLabel, isIdentifier, quoteKey, isForbiddenKey } from "../paths/sourcePath.js";

// The company data dictionary (plan.md §3.2): every addressable source path
// and what it actually contains, built by code from the company's own
// products. It is what makes JSON product data (`specifications`,
// `activeIngredients`, …) pickable and explainable without anyone reading raw
// JSON — and the base both AI layers work on. Derived data only: building it
// never changes a product.
//
// Entry: { path, root, type, coverage, distinct, examples, labels, synonyms,
//          source: "schema" | "observed", label, collection? }

const MAX_EXAMPLES = 5;
const EXAMPLE_CHARS = 60;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 2000;
const MAX_KEYS_PER_OBJECT = 200;
// [key="value"] paths are listed for the most common element names of a
// collection, so "Active ingredients › [Vitamin E] › Concentration" is pickable
const MAX_FILTER_VALUES = 50;
// a collection's identifying child key: present on most elements, distinct per element
const KEY_FIELD_CANDIDATES = ["name", "title", "label", "key", "code", "ingredient"];

const clip = (s) => (s.length > EXAMPLE_CHARS ? `${s.slice(0, EXAMPLE_CHARS - 1)}…` : s);
const scalarType = (v) => (typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string");
const isEmpty = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

/** Accumulates observations for one (grouped) path. */
class Acc {
  constructor(segments, root) {
    this.segments = segments; // canonical segments (most common spelling decided at the end)
    this.root = root;
    this.products = new Set();
    this.values = new Map(); // example text → count
    this.types = new Map();
    this.spellings = new Map(); // last key spelling → count
    this.collection = false;
    this.list = false;
  }
}

/**
 * Walks one product's JSON columns, calling visit(segments, value, productIdx,
 * spelling) for every key path. Key variants of the same object level share
 * a group: their segment carries the normalised key, the real spelling is
 * passed alongside.
 */
function walk(value, segments, depth, visit) {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    const objects = value.filter(isPlainObject);
    if (objects.length) {
      visit([...segments, { t: "each" }], value, null, "collection");
      for (const el of objects) walkObject(el, [...segments, { t: "each" }], depth + 1, visit);
    } else if (value.some((x) => !isEmpty(x) && typeof x !== "object")) {
      visit(segments, value, null, "list");
    }
    return;
  }
  if (isPlainObject(value)) walkObject(value, segments, depth, visit);
  else if (!isEmpty(value)) visit(segments, value, null, "scalar");
}

function walkObject(obj, segments, depth, visit) {
  for (const k of Object.keys(obj).slice(0, MAX_KEYS_PER_OBJECT)) {
    if (isForbiddenKey(k)) continue; // unaddressable (plan.md §3.1) — never listed
    const v = obj[k];
    const seg = { t: "key", n: normKey(k) };
    visit([...segments, seg], v, k, "key");
    walk(v, [...segments, seg], depth + 1, visit);
  }
}

const groupId = (segments) => segments.map((s) => (s.t === "each" ? "[]" : `.${s.n}`)).join("");

/**
 * Pure builder: products (with their JSON columns) → observed entries.
 * Exported for unit tests; buildDictionary() persists the result.
 */
export function observeProducts(products, jsonColumns = [...productJsonColumns()]) {
  const accs = new Map();
  const total = products.length;
  const acc = (segments) => {
    const id = groupId(segments);
    if (!accs.has(id)) accs.set(id, new Acc(segments, "product"));
    return accs.get(id);
  };

  products.forEach((p, idx) => {
    for (const col of jsonColumns) {
      const value = p[col];
      if (isEmpty(value)) continue;
      const head = [{ t: "key", n: normKey(col) }];
      const visit = (segments, v, spelling, what) => {
        const a = acc(segments);
        if (spelling !== null) a.spellings.set(spelling, (a.spellings.get(spelling) || 0) + 1);
        if (what === "collection") {
          a.collection = true;
          a.products.add(idx);
          return;
        }
        if (what === "list") {
          a.list = true;
          a.products.add(idx);
          a.types.set("list", (a.types.get("list") || 0) + 1);
          const text = v.filter((x) => !isEmpty(x) && typeof x !== "object").map(String).join(", ");
          a.values.set(text, (a.values.get(text) || 0) + 1);
          return;
        }
        if (what === "scalar") {
          a.products.add(idx);
          a.types.set(scalarType(v), (a.types.get(scalarType(v)) || 0) + 1);
          const text = String(v).trim();
          a.values.set(text, (a.values.get(text) || 0) + 1);
        }
      };
      walk(value, head, 1, visit);
    }
  });

  // turn accumulators into entries; group segments resolved to the most common spelling
  const spellingOf = new Map(); // groupId → chosen spelling
  for (const [id, a] of accs) {
    const best = [...a.spellings.entries()].sort((x, y) => y[1] - x[1])[0]; // stable: a tie keeps the first spelling seen
    if (best) spellingOf.set(id, best[0]);
  }
  // the column head keeps its real (case-sensitive) name; deeper keys their most common spelling
  const columns = new Map(jsonColumns.map((c) => [normKey(c), c]));
  const relPath = (segments) => {
    let out = "";
    segments.forEach((s, i) => {
      if (s.t === "each") {
        out += "[]"; // a collection path, not a grammar path
        return;
      }
      const k = i === 0 ? columns.get(s.n) : spellingOf.get(groupId(segments.slice(0, i + 1))) ?? s.n;
      out += isIdentifier(k) ? (out ? `.${k}` : k) : quoteKey(k);
    });
    return out;
  };

  const entries = [];
  const collections = [];
  for (const [id, a] of accs) {
    if (a.segments.length < 2 && !a.collection) continue; // a bare JSON column (an object) is not a value
    const path = `product.${relPath(a.segments)}`;
    const coverage = total ? round(a.products.size / total) : 0;
    const labels = [...a.spellings.keys()];
    if (a.collection) {
      collections.push({ id, a, path });
      entries.push({ path, root: "product", type: "collection", coverage, distinct: 0, examples: [], labels, synonyms: [], source: "observed", label: toLabel(path.replace(/\[\]/g, "")) });
      continue;
    }
    if (!a.values.size) continue; // only objects below: their leaves are entries of their own
    const type = [...a.types.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || "string";
    const examples = [...a.values.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_EXAMPLES).map(([v]) => clip(v));
    entries.push({ path, root: "product", type, coverage, distinct: a.values.size, examples, labels, synonyms: [], source: "observed", label: toLabel(path.replace(/\[\]/g, "")) });
  }

  // [key="value"] paths for each collection: product.activeIngredients[name="Vitamin E"].concentration
  for (const { a, path } of collections) {
    const children = entries.filter((e) => e.path.startsWith(`${path}.`) && !e.path.slice(path.length + 1).includes("[]"));
    const keyChild = pickKeyField(children, path);
    if (!keyChild) continue;
    const keyName = keyChild.path.slice(path.length + 1);
    const counts = new Map(); // normalised value → { value, products:Set }
    products.forEach((p, idx) => {
      const list = elementsAt(p, a.segments);
      for (const el of list) {
        const k = Object.keys(el).find((x) => normKey(x) === normKey(keyName));
        const v = k !== undefined ? el[k] : undefined;
        if (isEmpty(v) || typeof v === "object") continue;
        const n = normKey(v);
        if (!counts.has(n)) counts.set(n, { value: String(v).trim(), products: new Set(), byChild: new Map() });
        const c = counts.get(n);
        c.products.add(idx);
        for (const child of children) {
          if (child === keyChild) continue;
          const ck = Object.keys(el).find((x) => normKey(x) === normKey(child.path.slice(path.length + 1)));
          const cv = ck !== undefined ? el[ck] : undefined;
          if (isEmpty(cv) || typeof cv === "object") continue;
          const slot = c.byChild.get(child.path) || new Map();
          slot.set(String(cv).trim(), (slot.get(String(cv).trim()) || 0) + 1);
          c.byChild.set(child.path, slot);
        }
      }
    });
    const parent = entries.find((e) => e.path === path);
    parent.keyField = keyName;
    parent.keyValues = [...counts.values()].sort((x, y) => y.products.size - x.products.size).slice(0, MAX_FILTER_VALUES).map((c) => c.value);
    for (const c of [...counts.values()].sort((x, y) => y.products.size - x.products.size).slice(0, MAX_FILTER_VALUES)) {
      for (const child of children) {
        if (child === keyChild) continue;
        const values = c.byChild.get(child.path);
        if (!values) continue;
        const childKey = child.path.slice(path.length + 1);
        const fp = `${path.slice(0, -2)}[${keyName}=${JSON.stringify(c.value)}].${childKey}`;
        entries.push({
          path: fp,
          root: "product",
          type: child.type,
          coverage: total ? round(c.products.size / total) : 0,
          distinct: values.size,
          examples: [...values.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_EXAMPLES).map(([v]) => clip(v)),
          labels: child.labels,
          synonyms: [],
          source: "observed",
          label: toLabel(fp),
          collection: path,
        });
      }
    }
  }
  // `[]` paths describe a collection (repeating groups); everything else is a single value a field can read
  for (const e of entries) e.pickable = !e.path.includes("[]");
  return entries.sort((x, y) => y.coverage - x.coverage || x.path.localeCompare(y.path)).slice(0, MAX_ENTRIES);
}

function pickKeyField(children, path) {
  const named = (name) => children.find((c) => normKey(c.path.slice(path.length + 1)) === name && c.type === "string");
  for (const k of KEY_FIELD_CANDIDATES) {
    const hit = named(k);
    if (hit) return hit;
  }
  return null;
}

/** The array elements (objects) a collection group points at on one product. */
function elementsAt(product, segments) {
  let cur = [product];
  for (const s of segments) {
    const next = [];
    for (const v of cur) {
      if (s.t === "each") {
        if (Array.isArray(v)) next.push(...v.filter(isPlainObject));
      } else if (isPlainObject(v)) {
        const k = Object.keys(v).find((x) => normKey(x) === s.n);
        if (k !== undefined) next.push(v[k]);
      }
    }
    cur = next;
  }
  return cur.filter(isPlainObject);
}

const round = (x) => Math.round(x * 1000) / 1000;

/** Schema entries (plan.md §3.2 "static schema"): product columns + relations, invoice line/header, company, brand. */
export function schemaEntries(products) {
  const total = products.length;
  const catalogue = getSourceCatalogue();
  const out = [];
  for (const kind of catalogue.kinds.filter((k) => k.paths)) {
    for (const p of kind.paths) {
      if (kind.kind === "product" && /\[\d+\]/.test(p.path)) continue; // positional slots: superseded by [name="…"] paths
      if (kind.kind === "product" && productJsonColumns().has(p.path.split(".")[0])) continue; // JSON: observed entries describe it
      const path = `${kind.kind}.${p.path}`;
      const entry = { path, root: kind.kind, type: p.type, labels: [p.label], synonyms: [], source: "schema", label: `${kind.label} › ${p.label}`, pickable: true };
      if (kind.kind === "product") {
        const seen = new Map();
        let has = 0;
        for (const prod of products) {
          const v = p.path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), prod);
          if (isEmpty(v)) continue;
          has++;
          const text = Array.isArray(v) ? v.join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
          seen.set(text, (seen.get(text) || 0) + 1);
        }
        Object.assign(entry, {
          coverage: total ? round(has / total) : 0,
          distinct: seen.size,
          examples: [...seen.entries()].sort((x, y) => y[1] - x[1]).slice(0, MAX_EXAMPLES).map(([v]) => clip(v)),
        });
      } else Object.assign(entry, { coverage: null, distinct: null, examples: [] });
      out.push(entry);
    }
  }
  return out;
}

/** Synonyms survive a rebuild (they were added by a user or accepted from the AI). */
function carrySynonyms(entries, previous) {
  const byPath = new Map((previous || []).filter((e) => e.synonyms?.length).map((e) => [e.path, e.synonyms]));
  for (const e of entries) if (byPath.has(e.path)) e.synonyms = byPath.get(e.path);
  return entries;
}

const PRODUCT_SELECT = (() => {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "Product");
  const sel = Object.fromEntries(model.fields.filter((f) => f.kind === "scalar").map((f) => [f.name, true]));
  return { ...sel, category: { select: { name: true } }, brand: { select: { name: true } } };
})();

/** Builds and stores the company's dictionary. → the DataDictionary row. */
export async function buildDictionary(companyId) {
  const products = await prisma.product.findMany({ where: { companyId }, select: PRODUCT_SELECT });
  const previous = await prisma.dataDictionary.findUnique({ where: { companyId } });
  const entries = carrySynonyms([...schemaEntries(products), ...observeProducts(products)], previous?.entries);
  const data = { entries, productCount: products.length, builtAt: new Date() };
  return prisma.dataDictionary.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: { ...data, version: { increment: 1 } },
  });
}

/** The stored dictionary, built on first use (plan.md §3.2 "lazily"). */
export async function getDictionary(companyId) {
  return (await prisma.dataDictionary.findUnique({ where: { companyId } })) || buildDictionary(companyId);
}

/**
 * The source catalogue for one company (GET /certificate-field-sources?companyId=):
 * the static catalogue, with the product kind extended by every pickable
 * path its dictionary observed inside JSON ("Product › Specifications › pH",
 * "… › Active ingredients › [Vitamin E] › Concentration"), each with its
 * coverage and examples. Every added path passes validateSource (grammar).
 */
export async function companySourceCatalogue(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) throw notFound("Company");
  const row = await getDictionary(companyId);
  const base = getSourceCatalogue();
  const observed = row.entries
    .filter((e) => e.source === "observed" && e.pickable && e.root === "product")
    .map((e) => ({
      path: e.path.slice("product.".length),
      label: e.label.replace(/^Product › /, ""),
      type: e.type === "number" ? "number" : "string",
      coverage: e.coverage,
      examples: e.examples,
      fromDictionary: true,
    }));
  const known = new Set(base.kinds.find((k) => k.kind === "product").paths.map((p) => p.path));
  const coverage = new Map(row.entries.filter((e) => e.root === "product" && e.source === "schema").map((e) => [e.path.slice("product.".length), e]));
  return {
    ...base,
    kinds: base.kinds.map((k) =>
      k.kind !== "product"
        ? k
        : {
            ...k,
            paths: [
              ...k.paths.map((p) => (coverage.has(p.path) ? { ...p, coverage: coverage.get(p.path).coverage, examples: coverage.get(p.path).examples } : p)),
              ...observed.filter((p) => !known.has(p.path)),
            ],
          }
    ),
    dictionary: { version: row.version, builtAt: row.builtAt, productCount: row.productCount },
  };
}

/** Exposed for the source picker: only what the UI needs. */
export const dictionaryView = (row) => ({ version: row.version, builtAt: row.builtAt, productCount: row.productCount, entries: row.entries });

