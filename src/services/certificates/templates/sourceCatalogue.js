import { Prisma } from "@prisma/client";
import { INVOICE_HEADER_FIELDS, INVOICE_ITEM_FIELDS } from "../invoices/invoiceSchema.js";

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

const humanize = (s) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

function productPaths() {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === "Product");
  const paths = model.fields
    .filter((f) => f.kind === "scalar" && !PRODUCT_HIDDEN.has(f.name) && f.name !== "specifications")
    .map((f) => ({ path: f.name, label: PRODUCT_LABELS[f.name] || humanize(f.name), type: f.type === "DateTime" ? "date" : "string" }));
  paths.push({ path: "category.name", label: "Category", type: "string" });
  paths.push({ path: "brand.name", label: "Brand", type: "string" });
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
  };
  return cached;
}

const PATH_KINDS = new Set(["item", "invoice", "product", "company", "brand"]);
const INGREDIENT_RE = /^activeIngredients\[(\d{1,2})\]\.(name|concentration)$/;
const SPEC_RE = /^specifications\.values\.[A-Za-z0-9 _\-().%/]{1,60}$/;
export const TEMPLATE_TOKEN_RE = /\{\{\s*([a-z]+)(?:\.([A-Za-z0-9_.[\]]+))?\s*\}\}/g;

/** → { type } when kind/path is known, else null. */
export function lookupPath(kind, path) {
  const entry = getSourceCatalogue().kinds.find((k) => k.kind === kind);
  if (!entry) return null;
  if (!PATH_KINDS.has(kind)) return { type: entry.type || "string" };
  const hit = entry.paths.find((p) => p.path === path);
  if (hit) return { type: hit.type };
  if (kind === "product" && (INGREDIENT_RE.test(path || "") || SPEC_RE.test(path || ""))) return { type: "string" };
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

/** → problems with `format` for a source (empty when valid or absent). */
export function validateFormat(format, source) {
  if (format === null || format === undefined) return [];
  if (typeof format !== "object") return ["format must be an object"];
  const problems = [];
  const type = sourceType(source);
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
