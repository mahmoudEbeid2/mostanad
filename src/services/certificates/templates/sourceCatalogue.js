import { Prisma } from "@prisma/client";
import { INVOICE_HEADER_FIELDS, INVOICE_ITEM_FIELDS } from "../invoices/invoiceSchema.js";
import { parseRelative } from "../paths/sourcePath.js";

// The field-source catalogue (CERTIFICATES_V2_PLAN.md §8.2, §10.3). Generated
// from the Prisma `Product` model plus the invoice header/item schemas, so the
// UI's source picker can never offer a path the resolver doesn't know.

const PRODUCT_HIDDEN = new Set(["id", "categoryId", "brandId", "companyId", "createdAt", "updatedAt"]);
const PRODUCT_LABELS = {
  productCode: "Product code",
  activeIngredients: "Active ingredients (all)",
  targetSpecies: "Target species",
  userSafety: "User safety",
  routeOfAdmin: "Route of administration",
};
const MAX_INGREDIENT_SLOTS = 6;
// other printed labels for product columns (plan.md §5.2 step 2: code before AI)
const PRODUCT_SYNONYMS = {
  name: ["product name", "product", "trade name", "name of product", "product description"],
  producer: ["manufacturer", "manufactured by", "producer", "made by"],
  origin: ["country of origin", "origin", "made in"],
  packaging: ["packaging", "pack size", "package", "presentation"],
  registrationNumber: ["registration no", "reg no", "registration number", "license no"],
  storage: ["storage conditions", "storage", "store"],
  "category.name": ["category", "product category", "type of product"],
  "brand.name": ["brand"],
  physicalForm: ["form", "physical form", "dosage form"],
  appearance: ["appearance", "description"],
};

const humanize = (s) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

function productPaths() {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "Product");
  const paths = model.fields
    .filter((f) => f.kind === "scalar" && !PRODUCT_HIDDEN.has(f.name) && f.name !== "specifications")
    .map((f) => ({ path: f.name, label: PRODUCT_LABELS[f.name] || humanize(f.name), type: f.type === "DateTime" ? "date" : "string", ...(PRODUCT_SYNONYMS[f.name] ? { synonyms: PRODUCT_SYNONYMS[f.name] } : {}) }));
  paths.push({ path: "category.name", label: "Category", type: "string", synonyms: PRODUCT_SYNONYMS["category.name"] });
  paths.push({ path: "brand.name", label: "Brand", type: "string", synonyms: PRODUCT_SYNONYMS["brand.name"] });
  for (let i = 0; i < MAX_INGREDIENT_SLOTS; i++) {
    paths.push({ path: `activeIngredients[${i}].name`, label: `Active ingredient ${i + 1} — name`, type: "string" });
    paths.push({ path: `activeIngredients[${i}].concentration`, label: `Active ingredient ${i + 1} — concentration`, type: "string" });
  }
  return paths;
}

const COMPANY_PATHS = [
  { path: "name", label: "Company name", type: "string" },
  { path: "address", label: "Company address", type: "string" },
  { path: "phone", label: "Company phone", type: "string" },
  { path: "email", label: "Company email", type: "string" },
];
const BRAND_PATHS = [{ path: "name", label: "Brand name", type: "string" }];

// ── repeating groups (§7.8, §10.3) ───────────────────────────────────────────
// A group's rows come from a list on the product, from the certificate's
// invoice lines (per_invoice), or are typed in the editor. Each cell then
// reads a path of ITS row: { kind: "row", path }.
const PRODUCT_LISTS = [
  {
    path: "activeIngredients",
    label: "Active ingredients",
    rowPaths: [
      { path: "name", label: "Name", type: "string" },
      { path: "concentration", label: "Concentration", type: "string" },
    ],
  },
];

function invoiceLineRowPaths() {
  const product = productPaths()
    .filter((p) => !p.path.includes("["))
    .map((p) => ({ path: `product.${p.path}`, label: `Product · ${p.label}`, type: p.type }));
  return [...INVOICE_ITEM_FIELDS.map((p) => ({ ...p })), ...product];
}

export const GROUP_SOURCE_KINDS = ["product_list", "invoice_lines", "manual"];
export const CELL_SOURCE_KINDS = ["row", "static", "manual"];
export const GROUP_MODES = ["repeat", "fixed_rows"];
export const WHEN_EMPTY = ["dash", "hide"];

let groupCached = null;
export function groupSourceCatalogue() {
  if (groupCached) return groupCached;
  groupCached = {
    kinds: [
      { kind: "product_list", label: "A list on the product", description: "One row per entry, e.g. each active ingredient", lists: PRODUCT_LISTS },
      { kind: "invoice_lines", label: "The invoice lines", description: "One row per invoice line of a collective (per invoice) certificate", rowPaths: invoiceLineRowPaths() },
      { kind: "manual", label: "Typed in the editor", description: "Rows are added, removed and reordered by hand" },
    ],
    cellKinds: [
      { kind: "row", label: "From the row", needs: "path" },
      { kind: "static", label: "Fixed text", needs: "text" },
      { kind: "manual", label: "Typed in the editor" },
    ],
    modes: [
      { mode: "repeat", label: "Add rows as needed", description: "Rows are copied from the sample row; the content below moves down" },
      { mode: "fixed_rows", label: "Fixed rows", description: "The design draws the maximum number of rows; unused rows are hidden and the gap closed" },
    ],
    whenEmpty: [
      { value: "dash", label: "Show one row with “—”" },
      { value: "hide", label: "Remove the row (label included)" },
    ],
  };
  return groupCached;
}

/** The row paths a cell may read for a group source, or null when cells can't read the row. */
export function rowPathsFor(groupSource) {
  if (!groupSource) return null;
  if (groupSource.kind === "product_list") return PRODUCT_LISTS.find((l) => l.path === groupSource.path)?.rowPaths || null;
  if (groupSource.kind === "invoice_lines") return invoiceLineRowPaths();
  return null;
}

export function validateGroupSource(source) {
  if (!source || typeof source !== "object") return ["source is required"];
  if (!GROUP_SOURCE_KINDS.includes(source.kind)) return [`unknown group source "${source.kind}" (use ${GROUP_SOURCE_KINDS.join(", ")})`];
  if (source.kind === "product_list" && !PRODUCT_LISTS.some((l) => l.path === source.path) && !isJsonListPath(source.path)) {
    return [`unknown product list "${source.path}" (use ${PRODUCT_LISTS.map((l) => l.path).join(", ")}, or a list inside a product JSON column)`];
  }
  return [];
}

// AI plan §5.3: any list of objects inside a product JSON column can fill a
// group (what lists exist is the company's data dictionary). Keys only — no
// [index]/[filter] in a list path or a row path.
const keysOnly = (path) => {
  const p = parseRelative(path);
  return p.ok && p.segments.every((s) => s.t === "key") ? p.segments : null;
};
function isJsonListPath(path) {
  const segs = keysOnly(path);
  return !!segs && productJsonColumns().has(segs[0].k);
}

/** Problems with a group cell's source, given its group's source. */
export function validateCellSource(source, groupSource) {
  if (!source || typeof source !== "object") return ["source is required"];
  if (!CELL_SOURCE_KINDS.includes(source.kind)) return [`a group cell's source must be one of ${CELL_SOURCE_KINDS.join(", ")}`];
  if (source.kind === "static" && (typeof source.text !== "string" || !source.text.length)) return ["source.text is required for fixed text"];
  if (source.kind === "row") {
    const paths = rowPathsFor(groupSource);
    if (!paths) {
      if (groupSource?.kind === "product_list" && isJsonListPath(groupSource.path)) return keysOnly(source.path) ? [] : [`invalid row path "${source.path}" (a key of the list's elements)`];
      return ["this group's rows are typed by hand — its cells can't read a row path (use manual or static)"];
    }
    if (!paths.some((p) => p.path === source.path)) return [`unknown row path "${source.path}"`];
  }
  return [];
}

/** The type a cell source yields (formats). */
export function cellSourceType(source, groupSource) {
  if (source?.kind !== "row") return "string";
  return rowPathsFor(groupSource)?.find((p) => p.path === source.path)?.type || "string";
}

export const DATE_TOKENS = ["DD", "MM", "MMM", "YYYY", "YY"];
export const CASES = ["upper", "lower", "title"];

let cached = null;

/** → the catalogue served by GET /certificate-field-sources. */
export function getSourceCatalogue() {
  if (cached) return cached;
  cached = {
    kinds: [
      { kind: "item", label: "Invoice line", description: "The invoice line this certificate is for", paths: INVOICE_ITEM_FIELDS },
      { kind: "invoice", label: "Invoice", description: "The invoice header", paths: INVOICE_HEADER_FIELDS },
      { kind: "product", label: "Product", description: "The catalogue product the line is matched to", paths: productPaths() },
      { kind: "company", label: "Company", description: "Your company", paths: COMPANY_PATHS },
      { kind: "brand", label: "Brand", description: "The product's brand", paths: BRAND_PATHS },
      { kind: "today", label: "Generation date", description: "The date the certificate is generated", type: "date" },
      { kind: "static", label: "Fixed text", description: "The same text on every certificate", needs: "text" },
      { kind: "manual", label: "Typed in the editor", description: "Left empty at generation; filled in by hand" },
      {
        kind: "template",
        label: "Combination",
        description: "Text with placeholders, e.g. COA{{item.batchNo}} — no expressions",
        needs: "template",
      },
    ],
    formats: {
      date: { tokens: DATE_TOKENS, examples: ["MM/YYYY", "DD/MM/YYYY", "DD MMM YYYY", "YYYY-MM-DD"], appliesTo: "date" },
      case: CASES,
      number: { decimals: "0–6", thousands: "a separator character, e.g. ','", appliesTo: "number" },
      prefix: "text added before",
      suffix: "text added after",
    },
    groups: groupSourceCatalogue(),
  };
  return cached;
}

const PATH_KINDS = new Set(["item", "invoice", "product", "company", "brand"]);

// One placeholder: {{kind}} or {{kind.<path>}} where <path> is the plan.md
// §3.1 grammar — identifiers, [n], ["quoted key"], [key="value"].
const PATH_SEGMENT = String.raw`(?:[^{}"\s\[\]]|\[(?:\d+|"(?:[^"\\]|\\.)*"|[^\]"{}=\s]+="(?:[^"\\]|\\.)*")\])`;
export const TEMPLATE_TOKEN_RE = new RegExp(String.raw`\{\{\s*([a-z]+)(?:\.(${PATH_SEGMENT}+))?\s*\}\}`, "g");

// Product columns that hold JSON: any key path inside them is addressable
// (plan.md §3.1) — what is actually in them is the company's data dictionary.
let jsonColumns = null;
export function productJsonColumns() {
  if (!jsonColumns) jsonColumns = new Set(Prisma.dmmf.datamodel.models.find((m) => m.name === "Product").fields.filter((f) => f.kind === "scalar" && f.type === "Json").map((f) => f.name));
  return jsonColumns;
}
// item.extra holds the per-line columns extraction saw but couldn't map (§9.1)
const ITEM_JSON_KEYS = new Set(["extra"]);

/** → { type } when kind/path is known, else null. */
export function lookupPath(kind, path) {
  const entry = getSourceCatalogue().kinds.find((k) => k.kind === kind);
  if (!entry) return null;
  if (!PATH_KINDS.has(kind)) return { type: entry.type || "string" };
  const hit = entry.paths.find((p) => p.path === path);
  if (hit) return { type: hit.type };
  // a path inside a JSON column: structurally valid = addressable (its value
  // may be absent on some products — that is what `required` and the
  // dictionary's coverage are for)
  const parsed = parseRelative(path);
  if (!parsed.ok || parsed.segments.length < 2 || parsed.segments[0].t !== "key") return null;
  const head = parsed.segments[0].k;
  if (kind === "product" && productJsonColumns().has(head)) return { type: "string" };
  if (kind === "item" && ITEM_JSON_KEYS.has(head) && parsed.segments.length === 2 && parsed.segments[1].t === "key") return { type: "string" };
  return null;
}

/** The value type a source yields (decides which formats apply). */
export function sourceType(source) {
  if (!source) return "string";
  if (source.kind === "today") return "date";
  if (PATH_KINDS.has(source.kind)) return lookupPath(source.kind, source.path)?.type || "string";
  return "string";
}

/** → list of human-readable problems (empty when valid). */
export function validateSource(source) {
  if (!source || typeof source !== "object") return ["source is required"];
  const { kind } = source;
  if (!getSourceCatalogue().kinds.some((k) => k.kind === kind)) return [`unknown source kind "${kind}"`];
  if (PATH_KINDS.has(kind)) {
    if (!source.path) return [`source.path is required for kind "${kind}"`];
    if (!lookupPath(kind, source.path)) return [`unknown ${kind} path "${source.path}"`];
  }
  if (kind === "static" && (typeof source.text !== "string" || !source.text.length)) return ["source.text is required for fixed text"];
  if (kind === "template") {
    if (typeof source.template !== "string" || !source.template.length) return ["source.template is required for a combination"];
    const problems = [];
    let n = 0;
    for (const m of source.template.matchAll(TEMPLATE_TOKEN_RE)) {
      n++;
      const [, k, p] = m;
      if (k === "today") continue;
      if (!PATH_KINDS.has(k)) problems.push(`placeholder {{${k}…}}: only item, invoice, product, company, brand and today may be used`);
      else if (!lookupPath(k, p)) problems.push(`placeholder {{${k}.${p || ""}}} is not a known source`);
    }
    const stray = source.template.replace(TEMPLATE_TOKEN_RE, "");
    if (/\{\{|\}\}/.test(stray)) problems.push("the combination has an unclosed or invalid {{placeholder}}");
    if (!n) problems.push("a combination needs at least one {{placeholder}}; use fixed text otherwise");
    return problems;
  }
  return [];
}

const DATE_FORMAT_RE = new RegExp(`^(?:${["YYYY", "MMM", "DD", "MM", "YY"].join("|")}|[\\s./\\-,])+$`);

/** → problems with `format` for a source (empty when valid or absent). `groupSource` for group cells. */
export function validateFormat(format, source, groupSource = undefined) {
  if (format === null || format === undefined) return [];
  if (typeof format !== "object") return ["format must be an object"];
  const problems = [];
  const type = groupSource !== undefined ? cellSourceType(source, groupSource) : sourceType(source);
  for (const key of Object.keys(format)) {
    if (!["date", "case", "number", "prefix", "suffix"].includes(key)) problems.push(`unknown format option "${key}"`);
  }
  if (format.date !== undefined && format.date !== null) {
    if (type !== "date") problems.push("a date format only applies to a date source");
    else if (typeof format.date !== "string" || !DATE_FORMAT_RE.test(format.date)) problems.push(`invalid date format "${format.date}" (use DD MM MMM YYYY YY)`);
  }
  if (format.case !== undefined && format.case !== null && !CASES.includes(format.case)) problems.push(`case must be one of ${CASES.join(", ")}`);
  if (format.number !== undefined && format.number !== null) {
    if (type !== "number") problems.push("a number format only applies to a number source");
    const { decimals, thousands } = format.number || {};
    if (decimals !== undefined && !(Number.isInteger(decimals) && decimals >= 0 && decimals <= 6)) problems.push("number.decimals must be 0–6");
    if (thousands !== undefined && thousands !== null && !(typeof thousands === "string" && thousands.length <= 1)) problems.push("number.thousands must be one character");
  }
  for (const k of ["prefix", "suffix"]) {
    if (format[k] !== undefined && format[k] !== null && (typeof format[k] !== "string" || format[k].length > 60)) problems.push(`${k} must be text (≤ 60 characters)`);
  }
  return problems;
}
