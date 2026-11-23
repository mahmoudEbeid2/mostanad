import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { scheduleDictionaryRebuild } from "./certificates/dictionary/rebuildScheduler.js";
import { isUnconfirmedEstimate, same } from "./catalogues/fieldProvenance.js";

// "Copy to another brand": brand B sells brand A's product under another name —
// same composition and the rest of the product data. The copy is a new product
// in the target brand; it never takes what is specific to one product/brand
// registration or to its batches:
//   never copied — registrationNumber (left empty, flagged), batch / lab
//   results, certificate values, aliases, catalogue refs, generated labels,
//   invoices (all live in their own tables or columns not listed below).
// Each copied field's provenance is { tier: "copied", sourceProductId, at,
// byUserId } and keeps the source's own entry under `from` — an unconfirmed
// estimate stays an estimate (estimated: true) in the copy.
// Tenancy: a company caller copies within its own company only; a system user
// may copy to another company's brand. The brand must belong to the target company.

/** The product data a copy may take, by group (the copy modal's checklist). Order matters for the UI. */
export const COPY_FIELD_GROUPS = [
  { key: "composition_form", label: "Composition & form", fields: ["activeIngredients", "strength", "dosageForm", "physicalForm", "appearance"] },
  { key: "indications_use", label: "Indications & use", fields: ["description", "indications", "targetSpecies", "routeOfAdmin", "dosage", "mixingInstructions"] },
  { key: "withdrawal_safety", label: "Withdrawal & safety", fields: ["withdrawalPeriod", "contraindications", "userSafety"] },
  { key: "storage_packaging", label: "Storage & packaging", fields: ["storage", "packaging"] },
  { key: "origin_producer", label: "Origin & producer", fields: ["origin", "producer"] },
  { key: "specifications_group", label: "Specifications", fields: ["specifications"] },
  { key: "type_category", label: "Type & category", fields: ["productType", "prescriptionStatus", "categoryId"] },
];
export const COPYABLE_FIELDS = COPY_FIELD_GROUPS.flatMap((g) => g.fields);
if (COPY_FIELD_GROUPS.some((g) => COPYABLE_FIELDS.includes(g.key))) throw new Error("productCopyService: a group key must not be a field name");
/** Asked for, refused: each product/brand needs its own. */
export const NEVER_COPIED = ["registrationNumber"];
const ARRAY_FIELDS = new Set(["targetSpecies", "userSafety"]);
const groupOf = (field) => COPY_FIELD_GROUPS.find((g) => g.fields.includes(field))?.key ?? null;
const NEEDS_REGISTRATION = "needs its own registration number";

// Group keys are snake_case and never a field name, so "storage" is always the field.
/** fieldsToCopy (field names and/or group keys) → the field list (default: every copyable field). Throws 400 on anything else. */
export function resolveFields(fieldsToCopy, { groups = true } = {}) {
  if (fieldsToCopy === undefined || fieldsToCopy === null) return [...COPYABLE_FIELDS];
  if (!Array.isArray(fieldsToCopy)) throw new AppError("fieldsToCopy must be a list of fields or field groups", 400);
  const out = new Set();
  const bad = [];
  for (const f of fieldsToCopy) {
    const g = groups ? COPY_FIELD_GROUPS.find((x) => x.key === f) : null;
    if (g) g.fields.forEach((x) => out.add(x));
    else if (COPYABLE_FIELDS.includes(f)) out.add(f);
    else bad.push(f);
  }
  const never = bad.filter((f) => NEVER_COPIED.includes(f));
  if (never.length) throw new AppError(`${never.join(", ")} is never copied: each product needs its own registration number`, 400);
  if (bad.length) throw new AppError(`These can't be copied: ${bad.join(", ")}. Copyable: ${COPYABLE_FIELDS.join(", ")}`, 400);
  return COPYABLE_FIELDS.filter((f) => out.has(f));
}

const empty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
const copyValue = (field, v) => (empty(v) ? (ARRAY_FIELDS.has(field) ? [] : null) : JSON.parse(JSON.stringify(v)));

/** A product the caller may read (company caller: own company only; another tenant → 404). */
async function loadVisible(id, scopeCompanyId, db = prisma) {
  const p = await db.product.findUnique({ where: { id }, include: { brand: { select: { id: true, name: true } }, company: { select: { id: true, name: true } } } });
  if (!p || (scopeCompanyId && p.companyId !== scopeCompanyId)) throw new AppError("Product not found!", 404);
  return p;
}

/** The target company and brand, by the tenancy rules. → { companyId, brand } */
async function resolveTarget({ source, targetCompanyId, targetBrandId, scopeCompanyId }, db = prisma) {
  if (!targetBrandId) throw new AppError("Choose the brand to copy to", 400);
  let companyId = targetCompanyId || source.companyId;
  if (scopeCompanyId) {
    // a company user copies only within its company — another company reads as "not found"
    if (targetCompanyId && targetCompanyId !== scopeCompanyId) throw new AppError("Target company not found!", 404);
    companyId = scopeCompanyId;
  } else if (targetCompanyId) {
    const exists = await db.company.findUnique({ where: { id: targetCompanyId }, select: { id: true } });
    if (!exists) throw new AppError("Target company not found!", 404);
  }
  const brand = await db.brand.findFirst({ where: { id: targetBrandId, companyId }, select: { id: true, name: true } });
  if (!brand) throw new AppError("Selected brand not found or does not belong to this company!", 400);
  return { companyId, brand };
}

/** The copy's provenance for `fields`, from the source's. */
function copiedProvenance(source, fields, { at, byUserId }) {
  const fp = source.fieldProvenance && typeof source.fieldProvenance === "object" ? source.fieldProvenance : {};
  const out = {};
  const entry = (from) => ({ tier: "copied", sourceProductId: source.id, at, byUserId, ...(from ? { from } : {}), ...(from && isUnconfirmedEstimate(from) ? { estimated: true } : {}) });
  for (const f of fields) {
    if (empty(source[f])) continue;
    out[f] = entry(fp[f] || null);
    // nested entries (specifications.values.Assay …) keep their own source entry
    for (const [path, p] of Object.entries(fp)) if (path !== f && (path.startsWith(`${f}.`) || path.startsWith(`${f}[`))) out[path] = entry(p);
  }
  return out;
}

/** The fields of `source` that go into a copy (category only when it exists — categories are shared). */
async function copiedData(source, fields, db) {
  const data = {};
  for (const f of fields) {
    if (f === "categoryId") continue;
    data[f] = copyValue(f, source[f]);
  }
  if (fields.includes("categoryId") && source.categoryId) {
    const cat = await db.category.findUnique({ where: { id: source.categoryId }, select: { id: true } });
    if (cat) data.categoryId = cat.id;
  }
  return data;
}

/**
 * POST /products/:id/copy. opts: { targetCompanyId?, targetBrandId, name, productCode?, fieldsToCopy?, keepLinked = true }
 * actor: { scopeCompanyId (company caller), userId }. → { product, copied: [fields], skippedEmpty: [fields], needsRegistrationNumber: true }
 */
export async function copyProduct(sourceId, opts, { scopeCompanyId = null, userId = null } = {}, { tx = null } = {}) {
  const run = async (db) => {
    const name = String(opts.name || "").trim();
    if (name.length < 2) throw new AppError("The new product needs a name (at least 2 characters)", 400);
    const fields = resolveFields(opts.fieldsToCopy);
    const source = await loadVisible(sourceId, scopeCompanyId, db);
    const { companyId, brand } = await resolveTarget({ source, targetCompanyId: opts.targetCompanyId, targetBrandId: opts.targetBrandId, scopeCompanyId }, db);
    const at = new Date().toISOString();
    const keepLinked = opts.keepLinked !== false;
    const fieldProvenance = {
      ...copiedProvenance(source, fields, { at, byUserId: userId }),
      registrationNumber: { tier: "missing", reason: NEEDS_REGISTRATION, sourceProductId: source.id, at },
    };
    const product = await db.product.create({
      data: {
        ...(await copiedData(source, fields, db)),
        name,
        productCode: opts.productCode ? String(opts.productCode).trim() || null : null,
        registrationNumber: null,
        companyId,
        brandId: brand.id,
        sourceProductId: keepLinked ? source.id : null,
        fieldProvenance,
      },
      include: { category: true, brand: true },
    });
    return {
      product,
      source: { id: source.id, name: source.name, brand: source.brand, companyId: source.companyId },
      copied: fields.filter((f) => !empty(source[f])),
      skippedEmpty: fields.filter((f) => empty(source[f])),
      notCopied: ["registrationNumber", "batch and lab results", "certificate values", "aliases", "catalogue links", "labels", "invoices"],
      needsRegistrationNumber: true,
      linked: keepLinked,
    };
  };
  const out = tx ? await run(tx) : await prisma.$transaction(run);
  if (!tx) await scheduleDictionaryRebuild(out.product.companyId);
  return out;
}

/**
 * POST /products/copy-bulk. { productIds, targetCompanyId?, targetBrandId, names: [{ productId, name, productCode? }], fieldsToCopy?, keepLinked }
 * One transaction per product; a failure is reported for that product only. → { results: [{ productId, ok, product?, error? }], copied, failed }
 */
export async function copyProductsBulk(opts, actor) {
  const ids = [...new Set(opts.productIds || [])];
  if (!ids.length) throw new AppError("Choose at least one product to copy", 400);
  if (ids.length > 100) throw new AppError("At most 100 products per copy", 400);
  resolveFields(opts.fieldsToCopy); // a bad field list fails the whole request up front
  const names = new Map((opts.names || []).map((n) => [n.productId, n]));
  const results = [];
  const companies = new Set();
  for (const productId of ids) {
    const n = names.get(productId) || {};
    try {
      const fallbackName = n.name ?? (await loadVisible(productId, actor.scopeCompanyId)).name;
      const out = await prisma.$transaction((tx) =>
        copyProduct(productId, { targetCompanyId: opts.targetCompanyId, targetBrandId: opts.targetBrandId, name: fallbackName, productCode: n.productCode, fieldsToCopy: opts.fieldsToCopy, keepLinked: opts.keepLinked }, actor, { tx })
      );
      companies.add(out.product.companyId);
      results.push({ productId, ok: true, product: { id: out.product.id, name: out.product.name, productCode: out.product.productCode, brand: out.product.brand }, copied: out.copied.length, needsRegistrationNumber: true });
    } catch (err) {
      results.push({ productId, ok: false, error: err.message, status: err.statusCode || 500 });
    }
  }
  for (const c of companies) await scheduleDictionaryRebuild(c);
  return { results, copied: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/**
 * The copy relationship as the caller may see it (GET /products/:id adds it):
 * { source: { id, name, brand } | null, sourceInOtherCompany, copies: [{ id, name, productCode, brand }], needsRegistrationNumber }
 * A source or copy in another company is not named to a company caller.
 */
export async function copyInfo(product, scopeCompanyId = null) {
  let source = null;
  let sourceInOtherCompany = false;
  if (product.sourceProductId) {
    const s = await prisma.product.findUnique({ where: { id: product.sourceProductId }, select: { id: true, name: true, companyId: true, brand: { select: { id: true, name: true } }, company: { select: { id: true, name: true } } } });
    if (s && (!scopeCompanyId || s.companyId === scopeCompanyId)) source = { id: s.id, name: s.name, brand: s.brand, company: s.companyId !== product.companyId ? s.company : null };
    else if (s) sourceInOtherCompany = true;
  }
  const copies = await prisma.product.findMany({
    where: { sourceProductId: product.id, ...(scopeCompanyId ? { companyId: scopeCompanyId } : {}) },
    select: { id: true, name: true, productCode: true, brand: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const reg = product.fieldProvenance?.registrationNumber;
  return { source, sourceInOtherCompany, copies, needsRegistrationNumber: !product.registrationNumber && reg?.reason === NEEDS_REGISTRATION };
}

/** The linked copy and its source, both visible to the caller. */
async function copyAndSource(copyId, scopeCompanyId) {
  const copy = await loadVisible(copyId, scopeCompanyId);
  if (!copy.sourceProductId) throw new AppError("This product isn't linked to an original", 400);
  const source = await prisma.product.findUnique({ where: { id: copy.sourceProductId }, include: { brand: { select: { id: true, name: true } } } });
  if (!source || (scopeCompanyId && source.companyId !== scopeCompanyId)) throw new AppError("The original product is not available", 404);
  return { copy, source };
}

/**
 * GET /products/:id/source-diff → { source, copy, fields: [{ field, group, source, copy, same }] } for every copyable field.
 * Read-only: nothing is changed until updateFromSource with the ticked fields.
 */
export async function diffFromSource(copyId, scopeCompanyId = null) {
  const { copy, source } = await copyAndSource(copyId, scopeCompanyId);
  const fields = COPYABLE_FIELDS.map((field) => ({ field, group: groupOf(field), source: source[field] ?? null, copy: copy[field] ?? null, same: same(source[field], copy[field]) }));
  return {
    source: { id: source.id, name: source.name, brand: source.brand, updatedAt: source.updatedAt },
    copy: { id: copy.id, name: copy.name, brand: copy.brand },
    fields,
    changed: fields.filter((f) => !f.same).length,
  };
}

/**
 * POST /products/:id/update-from-source { fields } — only the ticked fields take the
 * source's current value (and "copied" provenance); every other field stays as it is.
 */
export async function updateFromSource(copyId, fields, { scopeCompanyId = null, userId = null } = {}) {
  if (!Array.isArray(fields) || !fields.length) throw new AppError("Tick at least one field to update", 400);
  const wanted = resolveFields(fields, { groups: false }); // ticked fields, never a whole group
  const { copy, source } = await copyAndSource(copyId, scopeCompanyId);
  const at = new Date().toISOString();
  const data = await copiedData(source, wanted, prisma);
  if (wanted.includes("categoryId") && !("categoryId" in data)) data.categoryId = null;
  const fp = { ...(copy.fieldProvenance || {}) };
  for (const f of wanted) for (const path of Object.keys(fp)) if (path === f || path.startsWith(`${f}.`) || path.startsWith(`${f}[`)) delete fp[path];
  Object.assign(fp, copiedProvenance(source, wanted, { at, byUserId: userId }));
  const product = await prisma.product.update({ where: { id: copy.id }, data: { ...data, fieldProvenance: fp }, include: { category: true, brand: true } });
  await scheduleDictionaryRebuild(product.companyId);
  return { product, updated: wanted, unchanged: COPYABLE_FIELDS.filter((f) => !wanted.includes(f)) };
}
