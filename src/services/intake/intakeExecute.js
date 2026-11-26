import { prisma } from "../../lib/prisma.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { enqueueRaw, QUEUES } from "../certificates/jobs/queues.js";
import { extractPages, readPages } from "./intakeText.js";
import { readProductSheet } from "./productSheet.js";
import { queueReferenceLabel, uploadedOn } from "../label/labelUploads.js";
import { uploadInvoice } from "../certificates/invoices/invoiceService.js";
import { uploadCatalogue } from "../catalogues/catalogueService.js";
import { uploadCoas } from "../certificates/labResults/coaService.js";
import { createTemplateFromUpload, uploadNewVersion } from "../certificates/templates/templateService.js";
import { createType } from "../certificates/types/certificateTypeService.js";
import { KNOWN_TYPES, findType } from "../certificates/templates/fromFiles.js";
import { suggestFields } from "../certificates/templates/assistService.js";
import { replaceFields } from "../certificates/templates/fieldService.js";
import { createProduct, updateProduct } from "../productService.js";
import { itemAiCost } from "./intakeAi.js";
import { recordConflicts } from "../catalogues/compositionReview.js";
import { harvestFile, mergeAll, kindOf, summaryAr } from "../harvest/harvestService.js";
import { applyDropHarvest } from "../harvest/harvestAi.js";

// The `intakeExecute` job: every item of a drop the person accepted goes through
// the pipeline that already exists for its kind — reference label, certificate
// template (+ field suggestions), supplier COA / issued certificate kept as
// evidence, invoice, catalogue, product list. One item failing never stops the
// others; each says what happened, and the drop ends with a plain summary.
// Batch facts on evidence are only those READ from the document (page given).

const ORDER = ["invoice", "manufacturing_order", "catalogue", "product_list", "label", "label_design", "certificate_template", "certificate_both", "bundle", "bundle_template", "issued_document", "certificate_filled", "other"];
const base = (n) => String(n || "").replace(/\.[a-z0-9]+$/i, "");

async function bufferOf(item) {
  const { buffer } = await fileStore.readFile(item.fileId);
  return item.pageFrom ? extractPages(buffer, item.pageFrom, item.pageTo || item.pageFrom) : buffer;
}
const asPdfName = (n) => `${base(n)}.pdf`;
const fileOf = (item, buffer) => ({ buffer, originalname: /\.(pdf|ai)$/i.test(item.name) || item.pageFrom ? asPdfName(item.name.replace(/ — .*$/, "")) : item.name, mimetype: item.mimeType === "application/pdf" || item.pageFrom ? "application/pdf" : item.mimeType, size: buffer.length });

// ── one item per kind ──────────────────────────────────────────────────────────
async function asLabel(item, plan) {
  const buffer = await bufferOf(item);
  // linked to its product when the drop names exactly one (26 Nov: the drop's labels were never filed)
  const productId = (plan.productIds || []).length === 1 ? plan.productIds[0] : null;
  const out = await queueReferenceLabel({ buffer, originalName: asPdfName(item.name), mimeType: item.mimeType?.startsWith("image/") ? item.mimeType : "application/pdf", country: plan.country || "Global", companyId: plan.companyId, brandId: plan.brandId, productId });
  if (out.skipped) return { referenceLabel: { skipped: true, uploadedOn: uploadedOn(out.existing.createdAt) }, link: "/reference-labels" };
  return { referenceLabel: { taskId: out.taskId }, taskId: out.taskId, link: "/reference-labels" };
}

// a page continuing the certificate as its product list (ADDVET's HC p.2 "ATTACHED LIST")
const LIST_PAGE = /\bATTACHED\s+LIST\b|\bLIST\s+OF\s+(?:THE\s+)?PRODUCTS\b|\bPRODUCTS?\s+LIST\b|\bANNEX(?:ED)?\s+LIST\b/i;

/** The design's last page: its first, plus the pages right after it that are its attached product list */
export async function designLastPage(buffer) {
  try {
    const { pages } = await readPages(buffer, { maxPages: 4, maxChars: 800 });
    let last = 1;
    for (const p of pages.sort((a, b) => a.n - b.n)) if (p.n === last + 1 && LIST_PAGE.test(p.text)) last = p.n;
    return last;
  } catch (err) {
    console.error(`[intake] the design's pages couldn't be read (its first page is used): ${err.message}`);
    return 1;
  }
}

/** The type (created for the company when missing) → a draft template from the design's first page (+ its attached list). */
export const templateFromItem = (...a) => asTemplate(...a);
async function asTemplate(item, plan, userId, record = null) {
  const code = plan.certCode;
  if (!code) throw new Error("Which certificate is it? (no type)");
  let type = await findType(plan.companyId, code);
  let typeCreated = false;
  if (!type) {
    type = await createType(plan.companyId, { name: KNOWN_TYPES[code]?.name || code, code });
    typeCreated = true;
    if (record) await record("certificate_type", { id: type.id, name: `${type.code} · ${type.name}` }, item.id, plan.companyId);
  }
  const full = await bufferOf(item);
  const isPdf = /\.(pdf|ai)$/i.test(item.name) || item.pageFrom;
  const buffer = isPdf && !item.pageFrom ? await extractPages(full, 1, await designLastPage(full)) : full;
  const file = { buffer, originalname: isPdf ? asPdfName(item.name) : item.name };
  const slot = await prisma.certificateTemplate.findFirst({ where: { companyId: plan.companyId, certificateTypeId: type.id, brandId: plan.brandId || null, country: null, scope: "per_product", archivedAt: null }, select: { id: true } });
  const brand = plan.brandId ? await prisma.brand.findUnique({ where: { id: plan.brandId }, select: { name: true } }) : null;
  const out = slot ? await uploadNewVersion({ templateId: slot.id, companyId: plan.companyId, userId, file }) : await createTemplateFromUpload({ companyId: plan.companyId, userId, file, settings: { certificateTypeId: type.id, brandId: plan.brandId || null, country: null, scope: "per_product", name: `${brand ? `${brand.name} ` : ""}${type.code}` } });
  // once converted, the fields are suggested and saved as "to check" (a follow-up job: the convert runs on this queue too)
  await enqueueRaw(QUEUES.template, "intakeTemplateFields", { itemId: item.id, versionId: out.versionId, companyId: plan.companyId }, { attempts: 60, backoff: { type: "fixed", delay: 3000 } });
  return { template: { code: type.code, typeCreated, templateId: out.templateId, versionId: out.versionId, newVersion: !!slot, fields: "pending" }, taskId: out.taskId, link: `/certificates/templates/${out.templateId}/versions/${out.versionId}` };
}

/** An issued certificate / supplier COA: kept with what it says (page by page), attached to the invoice of its batch when there is one. */
async function asEvidence(item, plan, userId) {
  const facts = (item.classification?.batches || []).map((b) => ({ batchNo: b.batchNo, productionDate: b.productionDate, expiryDate: b.expiryDate, source: { file: item.name.replace(/ — .*$/, ""), page: b.page, fileId: item.fileId } })); // the page of the dropped file (a split part's pages keep their numbers)
  const evidence = { certCode: plan.certCode, productIds: plan.productIds, products: (item.classification?.productNames || []), batches: facts };
  const attached = await attachEvidence(item, plan, userId, facts);
  if (!attached && facts.some((f) => f.batchNo)) await enqueueRaw(QUEUES.template, "intakeAttachEvidence", { itemId: item.id }, { delay: 120000, attempts: 12, backoff: { type: "exponential", delay: 120000 } });
  return { evidence, attached: attached || null, waiting: !attached && facts.some((f) => f.batchNo) ? facts.filter((f) => f.batchNo).map((f) => f.batchNo) : null };
}

/** The invoice line of one of the evidence's batches → its supplier COA upload (the existing reader). → { invoiceId, taskId } | null */
async function attachEvidence(item, plan, userId, facts) {
  for (const f of facts.filter((x) => x.batchNo)) {
    const line = await prisma.invoiceItem.findFirst({ where: { invoice: { companyId: plan.companyId, status: { in: ["review", "ready", "generated", "partially_failed"] } }, data: { path: ["batchNo"], equals: f.batchNo } }, select: { invoiceId: true } });
    if (!line) continue;
    const buffer = await bufferOf(item);
    const out = await uploadCoas({ invoiceId: line.invoiceId, companyScope: plan.companyId, files: [fileOf(item, buffer)], userId });
    return { invoiceId: line.invoiceId, batchNo: f.batchNo, taskId: out.taskId, link: `/invoices/${line.invoiceId}` };
  }
  return null;
}

async function asInvoice(item, plan, userId) {
  const buffer = await bufferOf(item);
  const out = await uploadInvoice({ companyId: plan.companyId, userId, file: fileOf(item, buffer), brandId: plan.brandId || null, country: plan.country || null });
  return { invoiceId: out.invoiceId, taskId: out.taskId, link: `/invoices/${out.invoiceId}` };
}

async function asCatalogue(item, plan, userId) {
  const buffer = await bufferOf(item);
  const brand = plan.brandId ? await prisma.brand.findUnique({ where: { id: plan.brandId }, select: { name: true } }) : null;
  const company = await prisma.company.findUnique({ where: { id: plan.companyId }, select: { name: true } });
  const out = await uploadCatalogue({ companyId: plan.companyId, manufacturer: brand?.name || company?.name, brandId: plan.brandId || null, label: base(item.name), file: fileOf(item, buffer), userId });
  const versionId = out.version?.id || out.versionId || out.id;
  return { catalogue: { versionId }, link: versionId ? `/catalogues/versions/${versionId}/pages` : "/catalogues" };
}

const FIELDS = ["productCode", "packaging", "registrationNumber", "dosageForm"];
async function asProductList(item, plan, record) {
  const sheet = await readProductSheet(await bufferOf(item), (item.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase());
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of sheet.products) {
    const existing = await prisma.product.findFirst({ where: { companyId: plan.companyId, OR: [...(row.productCode ? [{ productCode: row.productCode }] : []), { name: { equals: row.name, mode: "insensitive" } }] } });
    const data = Object.fromEntries(FIELDS.filter((k) => row[k]).map((k) => [k, row[k]]));
    if (existing) {
      const change = Object.fromEntries(Object.entries(data).filter(([k, v]) => existing[k] !== v));
      if (Object.keys(change).length) {
        await updateProduct(existing.id, change, plan.companyId);
        updated++;
      } else unchanged++;
    } else {
      const p = await createProduct(plan.companyId, { name: row.name, ...data, ...(plan.brandId ? { brandId: plan.brandId } : {}), fieldProvenance: { name: { source: "intake", file: item.name } } });
      await record("product", p, item.id, plan.companyId);
      created++;
    }
  }
  return { products: { created, updated, unchanged, unknownColumns: sheet.unknownColumns }, link: "/products" };
}

/**
 * A Certificate of Composition page → its product's composition, pack and form (26 Nov: the
 * 10 ADDVET products had only a name). Only empty fields are filled — what a person or a
 * catalogue already set is never overwritten — each with its file, page and the printed quote.
 * Categories are shared: an existing one with the printed name is linked, none is created.
 * → { productId, filled: [field] } | null
 */
export async function fillFromComposition(item, plan) {
  const comp = item.classification?.composition;
  if (!comp || (plan.productIds || []).length !== 1) return null;
  const p = await prisma.product.findFirst({ where: { id: plan.productIds[0], companyId: plan.companyId } });
  if (!p) return null;
  const at = new Date().toISOString();
  const src = { tier: "C", source: "intake", certCode: "COC", file: item.name.replace(/ — .*$/, ""), fileId: item.fileId || null, page: item.pageFrom || 1, quote: comp.quote, at };
  const data = {};
  const prov = {};
  let conflicts = [];
  if (!(Array.isArray(p.activeIngredients) && p.activeIngredients.length) && comp.ingredients?.length) {
    data.activeIngredients = comp.ingredients.map((x) => ({ name: x.name, concentration: x.amountRaw, amountRaw: x.amountRaw, amount: x.amount, unit: x.unit, basis: comp.basis }));
    prov.activeIngredients = src;
  } else if (comp.ingredients?.length) {
    // the product already has a composition: a value that disagrees is recorded for the reviewer, never overwritten
    conflicts = await recordConflicts(p, { ingredients: comp.ingredients, basis: comp.basis, source: src });
  }
  if (!p.compositionBasis && comp.basis) [data.compositionBasis, prov.compositionBasis] = [comp.basis, src];
  if (!p.packaging && comp.packaging) [data.packaging, prov.packaging] = [comp.packaging, src];
  if (!p.physicalForm && comp.form) [data.physicalForm, prov.physicalForm] = [comp.form, src];
  if (!p.categoryId && comp.category) {
    const cat = await prisma.category.findFirst({ where: { name: { equals: comp.category, mode: "insensitive" } }, select: { id: true } });
    if (cat) [data.categoryId, prov.categoryId] = [cat.id, src];
  }
  if (!Object.keys(data).length) return { productId: p.id, filled: [], conflicts: conflicts.length };
  const fresh = await prisma.product.findUnique({ where: { id: p.id }, select: { fieldProvenance: true } });
  await prisma.product.update({ where: { id: p.id }, data: { ...data, fieldProvenance: { ...(fresh.fieldProvenance || {}), ...prov } } });
  return { productId: p.id, filled: Object.keys(data), conflicts: conflicts.length };
}

// ── duplicates: what the same file became the first time ─────────────────────
const CERT_DOCS = ["certificate_filled", "certificate_template"];

/** A template of the company (not archived) → its version to use: the active one, else the one given */
async function templateRef(templateId, companyId, versionId = null, code = null) {
  const tpl = await prisma.certificateTemplate.findFirst({ where: { id: templateId, companyId, archivedAt: null }, select: { id: true, activeVersionId: true, certificateType: { select: { code: true } } } });
  const vid = tpl?.activeVersionId || (tpl ? versionId : null);
  if (!vid) return null;
  return { code: code || tpl.certificateType.code, templateId: tpl.id, versionId: vid, fields: "reused", reused: true, link: `/certificates/templates/${tpl.id}/versions/${vid}` };
}

/**
 * 26 Nov (prod: ADDVET's COC, COA and HC were filed before, so the Express drop was all duplicates and
 * made 0 certificates): a duplicate is not filed again, but it takes what the same file became the
 * first time — its company, products, invoice and template (the template's ACTIVE version now) — so
 * Express uses them. Without an earlier filing of it: the template made from those same bytes, else
 * the company's active template of its type; an Express certificate with none at all becomes its
 * type's template from this file. The status stays "duplicate" (nothing was filed twice); what the
 * earlier read stored (harvested_facts of that file) is already the company's.
 * → [{ itemId, from, template? }]
 */
export async function adoptDuplicates(batchId, { userId = null, record = null } = {}) {
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId }, select: { companyId: true, mode: true } });
  const dupes = await prisma.intakeItem.findMany({ where: { batchId, status: "duplicate", parentId: null } });
  const out = [];
  for (const item of dupes) {
    if (item.result?.reused) continue; // idempotent: adopted on an earlier run
    const c = item.classification || {};
    const p = c.proposal || {};
    const companyId = p.company?.id || batch.companyId;
    if (!companyId) continue;
    // the earlier filing: the same drop's first copy, else the latest drop of this company with these bytes
    const prior = p.duplicateOf?.itemId
      ? await prisma.intakeItem.findFirst({ where: { id: p.duplicateOf.itemId, status: "done" } })
      : item.sha256
        ? await prisma.intakeItem.findFirst({ where: { sha256: item.sha256, status: "done", parentId: null, batchId: { not: batchId }, companyId }, orderBy: { createdAt: "desc" } })
        : null;
    const children = prior ? await prisma.intakeItem.findMany({ where: { parentId: prior.id, status: "done" }, select: { result: true } }) : [];
    const productIds = [...new Set([...(prior?.result?.plan?.productIds || []), ...children.flatMap((x) => x.result?.plan?.productIds || [])])];
    const plan = { ...(prior?.result?.plan || {}), action: prior?.result?.plan?.action || "duplicate", companyId, brandId: prior?.result?.plan?.brandId ?? p.brand?.id ?? null, certCode: c.certCode || prior?.result?.plan?.certCode || null, productIds };
    let template = null;
    let from = prior ? "earlier_filing" : null;
    const code = plan.certCode;
    if (prior?.result?.template?.templateId) template = await templateRef(prior.result.template.templateId, companyId, prior.result.template.versionId, prior.result.template.code);
    if (!template && CERT_DOCS.includes(c.docType) && code) {
      // a template uploaded from these same bytes (the template screen, not an intake)
      const sources = item.sha256 ? await prisma.storedFile.findMany({ where: { sha256: item.sha256, companyId }, select: { id: true } }) : [];
      const v = sources.length ? await prisma.templateVersion.findFirst({ where: { sourceFileId: { in: sources.map((s) => s.id) }, template: { companyId, archivedAt: null } }, orderBy: { createdAt: "desc" }, select: { id: true, templateId: true } }) : null;
      if (v) [template, from] = [await templateRef(v.templateId, companyId, v.id, code), from || "same_file"];
      if (!template) {
        const type = await findType(companyId, code);
        const t = type ? await prisma.certificateTemplate.findFirst({ where: { companyId, certificateTypeId: type.id, archivedAt: null, activeVersionId: { not: null } }, orderBy: { updatedAt: "desc" }, select: { id: true } }) : null;
        if (t) [template, from] = [await templateRef(t.id, companyId, null, code), from || "company_template"];
      }
    }
    let extra = {};
    if (!template && CERT_DOCS.includes(c.docType) && code && batch.mode === "express") {
      // no template of this type anywhere: this file is the design (as "use my certificates as templates")
      try {
        extra = await asTemplate(item, plan, userId, record);
        template = extra.template;
        from = from || "made_from_file";
      } catch (err) {
        console.error(`[intake] duplicate ${item.name}: no template could be made from it: ${err.message}`);
        extra = { templateProblem: String(err.message).slice(0, 300) };
      }
    }
    if (!prior && !template) continue; // nothing to reuse: stays a plain duplicate
    const reused = { from, fromItemId: prior?.id || null, fromBatchId: prior?.batchId || null };
    const result = { ...(item.result || {}), ...extra, plan, reused, ...(template ? { template, link: template.link || extra.link } : {}), ...(prior?.result?.invoiceId ? { invoiceId: prior.result.invoiceId } : {}) };
    await prisma.intakeItem.update({ where: { id: item.id }, data: { companyId, result } });
    out.push({ itemId: item.id, from, template: template ? { code: template.code, versionId: template.versionId } : null });
  }
  return out;
}

// ── the job ────────────────────────────────────────────────────────────────
export async function runExecute(batchId, ctx = {}, { userId = null } = {}) {
  const progress = ctx.progress || (() => {});
  const items = (await prisma.intakeItem.findMany({ where: { batchId, status: "executing" } })).sort((a, b) => ORDER.indexOf(a.result?.plan?.action) - ORDER.indexOf(b.result?.plan?.action));
  const record = (entityType, row, itemId, companyId) => prisma.intakeCreated.create({ data: { batchId, itemId, entityType, entityId: row.id, name: row.name, companyId } });
  // an urgent order's review list also shows the evidence and reference labels it filed
  const isExpress = (await prisma.intakeBatch.findUnique({ where: { id: batchId }, select: { mode: true } }))?.mode === "express";
  let n = 0;
  for (const item of items) {
    const plan = item.result?.plan || {};
    progress(5 + Math.round((n / Math.max(items.length, 1)) * 90), `Filing ${item.name}`);
    try {
      let result;
      switch (plan.action) {
        case "label":
          result = await asLabel(item, plan);
          break;
        case "label_design":
          result = { kept: true, says: "the label's design file (.ai), kept with the company's files" };
          break;
        case "certificate_template":
          result = await asTemplate(item, plan, userId, record);
          break;
        case "certificate_both":
          result = { ...(await asTemplate(item, plan, userId, record)), ...(await asEvidence(item, plan, userId)) };
          break;
        case "bundle":
          result = { split: true, says: "each certificate is filed on its own row" };
          break;
        case "bundle_template":
          {
            // the template is the page printing the most composition rows (a design keeps as many
            // ingredient rows as its page prints: ADDMECTIN's 2 rows can't hold AMINOVITA's 19)
            const page = await richestPage(item);
            result = { split: true, templatePage: page, ...(await asTemplate({ ...item, pageFrom: page, pageTo: page }, plan, userId, record)) };
          }
          break;
        case "certificate_filled":
        case "issued_document":
          result = await asEvidence(item, plan, userId);
          break;
        case "invoice":
        case "manufacturing_order":
          result = await asInvoice(item, plan, userId);
          break;
        case "catalogue":
          result = await asCatalogue(item, plan, userId);
          break;
        case "product_list":
          result = await asProductList(item, plan, record);
          break;
        default:
          result = { kept: true };
      }
      // 26 Nov: "الطلبات السريعة" lists the evidence and reference labels a drop filed, not only products / brand
      if (isExpress && result?.evidence) await record("evidence", { id: item.id, name: `${plan.certCode || "—"} · ${item.name}` }, item.id, plan.companyId).catch(() => {});
      if (isExpress && result?.referenceLabel?.taskId) await record("reference_label", { id: result.referenceLabel.taskId, name: item.name }, item.id, plan.companyId).catch(() => {});
      // a COC page also says what is in its product: filled where the product has nothing yet
      if (item.classification?.composition) result = { ...result, composition: await fillFromComposition(item, plan) };
      const cost = await itemAiCost(item.id);
      await prisma.intakeItem.update({ where: { id: item.id }, data: { status: "done", result: { ...item.result, ...result }, error: null, costUsd: cost.costUsd } });
    } catch (err) {
      console.error(`[intake] ${item.name}: ${err.message}`);
      await prisma.intakeItem.update({ where: { id: item.id }, data: { status: "failed", error: String(err.message).slice(0, 500) } });
    }
    n++;
  }
  // the files filed before: what they became then (template, products, invoice) is used again
  try {
    const adopted = await adoptDuplicates(batchId, { userId, record });
    if (adopted.length) console.log(`[intake] ${batchId}: ${adopted.length} duplicate(s) reuse their earlier filing (${adopted.map((a) => a.from).join(", ")})`);
  } catch (err) {
    console.error(`[intake] duplicates of ${batchId}: ${err.message}`);
  }
  // Harvest (28 Nov): read every filed file / page, then fill the products and the company from them —
  // before Express makes the templates and drafts, so those are filled too. A failure never stops the drop.
  let harvest = null;
  try {
    harvest = await harvestDrop(batchId, ctx);
  } catch (err) {
    console.error(`[intake] harvest of ${batchId}: ${err.message}`);
  }
  // the AI read finished before the filing: its facts now (they replace the rules reader's for its files)
  try {
    const ai = await applyDropHarvest(batchId);
    if (ai) harvest = { ...ai, reader: "ai" };
  } catch (err) {
    console.error(`[intake] AI harvest apply of ${batchId}: ${err.message}`);
  }
  const summary = { ...(await summarize(batchId)), ...(harvest ? { harvest } : {}) };
  const batch = await prisma.intakeBatch.update({ where: { id: batchId }, data: { status: "done", summary } });
  // Express: the certificate drafts next — templates used, one run for the products (retried until ready, ~30 min at most)
  if (batch.mode === "express") await enqueueRaw(QUEUES.template, "intakeExpress", { batchId }, { attempts: 600, backoff: { type: "fixed", delay: 3000 } });
  return summary;
}

/** The plain summary of a filed drop: what was made, what still needs a person. */
export async function summarize(batchId) {
  const [items, created] = await Promise.all([prisma.intakeItem.findMany({ where: { batchId } }), prisma.intakeCreated.findMany({ where: { batchId } })]);
  const count = (t) => created.filter((c) => c.entityType === t).length;
  const done = items.filter((i) => i.status === "done");
  const labels = done.filter((i) => i.result?.referenceLabel && !i.result.referenceLabel.skipped).length;
  const templates = done.filter((i) => i.result?.template);
  const invoices = done.filter((i) => i.result?.invoiceId && !i.result?.attached).length;
  const catalogues = done.filter((i) => i.result?.catalogue).length;
  const evidence = done.filter((i) => i.result?.evidence);
  const waiting = evidence.filter((i) => i.result.waiting?.length);
  const failed = items.filter((i) => i.status === "failed");
  const duplicates = items.filter((i) => i.status === "duplicate").length;
  // what needs a person: one line per kind (the waiting certificates are one line, not one per page)
  const batchesWaiting = [...new Set(waiting.flatMap((i) => i.result.waiting))];
  const needs = [
    ...templates.map((i) => ({ kind: "template_fields", item: i.name, link: i.result.link, ar: `راجع حقول قالب ${i.result.template.code}`, en: `Check the fields of the ${i.result.template.code} template` })),
    ...(waiting.length ? [{ kind: "evidence_waiting", items: waiting.map((i) => i.name), batches: batchesWaiting, ar: `${waiting.length} شهادة محفوظة هتتربط بفواتيرها لما التشغيلات تظهر في فاتورة (${batchesWaiting.slice(0, 4).join("، ")}${batchesWaiting.length > 4 ? "…" : ""})`, en: `${waiting.length} kept certificate(s) are attached to their invoices once the batches appear on one (${batchesWaiting.slice(0, 4).join(", ")}${batchesWaiting.length > 4 ? "…" : ""})` }] : []),
    ...failed.map((i) => ({ kind: "failed", item: i.name, ar: `${i.name}: ${i.error}`, en: `${i.name}: ${i.error}` })),
  ];
  const parts = (list) => list.filter(([n]) => n > 0);
  const madeAr = parts([[count("company"), "شركة"], [count("brand"), "براند"], [count("product"), "منتج"], [templates.length, "قالب شهادة (محتاجين مراجعة حقول)"], [labels, "ليبل"], [invoices, "فاتورة/أمر تصنيع"], [catalogues, "كتالوج"], [evidence.length, "شهادة محفوظة كإثبات"]]).map(([n, w]) => `${n} ${w}`).join("، ");
  const madeEn = parts([[count("company"), "company"], [count("brand"), "brand"], [count("product"), "products"], [templates.length, "certificate templates (fields to check)"], [labels, "labels"], [invoices, "invoices / orders"], [catalogues, "catalogues"], [evidence.length, "certificates kept as evidence"]]).map(([n, w]) => `${n} ${w}`).join(", ");
  return {
    created: { companies: count("company"), brands: count("brand"), products: count("product") },
    done: { labels, templates: templates.length, invoices, catalogues, evidence: evidence.length, attached: evidence.filter((i) => i.result.attached).length, duplicates, failed: failed.length },
    needs,
    text: {
      ar: `اتعمل: ${madeAr || "مفيش"}.${duplicates ? ` ${duplicates} ملف متكرر اتساب.` : ""}${needs.length ? ` محتاج منك: ${needs.length === 1 ? needs[0].ar : `${needs.length} حاجات تحت`}.` : ""}`,
      en: `Done: ${madeEn || "nothing"}.${duplicates ? ` ${duplicates} duplicate file(s) skipped.` : ""}${needs.length ? ` Needs you: ${needs.length === 1 ? needs[0].en : `${needs.length} things below`}.` : ""}`,
    },
  };
}

// ── follow-ups (same queue; retried by BullMQ until ready) ───────────────────────
/** After a template's conversion: its fields suggested and saved "to check" (never confirmed here). */
export async function runTemplateFields({ itemId, versionId, companyId }) {
  const version = await prisma.templateVersion.findUnique({ where: { id: versionId }, select: { status: true, error: true } });
  if (!version) return { gone: true };
  if (["uploaded", "converting"].includes(version.status)) throw new Error("still converting"); // retried
  const item = await prisma.intakeItem.findUnique({ where: { id: itemId } });
  const set = async (fields) => item && prisma.intakeItem.update({ where: { id: itemId }, data: { result: { ...item.result, template: { ...item.result?.template, fields } } } });
  if (version.status === "failed") return set({ error: version.error || "conversion failed" });
  if (version.status !== "draft") return set({ skipped: version.status });
  try {
    const { suggestions } = await suggestFields(versionId, companyId);
    if (suggestions.length) await replaceFields(versionId, companyId, suggestions);
    return set({ suggested: suggestions.length, toCheck: true });
  } catch (err) {
    return set({ suggested: 0, byHand: true, why: err.message.slice(0, 200) });
  }
}

/** Retried: the evidence's batch on an invoice line (once that invoice has been read) → attached. */
export async function runAttachEvidence({ itemId }) {
  const item = await prisma.intakeItem.findUnique({ where: { id: itemId } });
  if (!item || item.result?.attached) return { done: true };
  const facts = item.result?.evidence?.batches || [];
  const attached = await attachEvidence(item, item.result.plan, null, facts);
  if (!attached) throw new Error("no invoice line with this batch yet"); // retried
  await prisma.intakeItem.update({ where: { id: itemId }, data: { result: { ...item.result, attached, waiting: null } } });
  return attached;
}

/**
 * Harvest a filed drop: every page of every file, the bundle pages each for their own product,
 * then the merge. → { files, facts, filled, conflicts, batchMissing, ar } for the card's summary line
 */
export async function harvestDrop(batchId, ctx = {}) {
  const items = await prisma.intakeItem.findMany({ where: { batchId, status: "done", fileId: { not: null } } });
  const parents = new Set(items.filter((i) => items.some((x) => x.parentId === i.id)).map((i) => i.id));
  const companies = new Set();
  let facts = 0;
  const files = new Set();
  for (const item of items) {
    if (parents.has(item.id)) continue; // its pages are read one by one, each for its product
    const plan = item.result?.plan || {};
    const companyId = plan.companyId || item.companyId;
    if (!companyId) continue;
    companies.add(companyId);
    files.add(item.fileId);
    const productId = (plan.productIds || []).length === 1 ? plan.productIds[0] : null;
    const product = productId ? await prisma.product.findUnique({ where: { id: productId }, select: { name: true } }) : null;
    const c = item.classification || {};
    facts += await harvestFile({ companyId, fileId: item.fileId, fileName: item.name.replace(/ — .*$/, ""), kind: kindOf({ docType: c.docType, certCode: c.certCode, name: item.name }), certCode: c.certCode || null, pageFrom: item.pageFrom || null, pageTo: item.pageTo || null, productName: product?.name || null, productId });
  }
  let filled = 0;
  let conflicts = 0;
  for (const companyId of companies) {
    const m = await mergeAll(companyId);
    filled += m.filled;
    conflicts += m.conflicts;
  }
  const batchMissing = 0; // counted per certificate by Express once its drafts exist
  return { files: files.size, facts, filled, conflicts, batchMissing, ar: summaryAr({ files: files.size, filled, conflicts, batchMissing }) };
}

/** A bundle's page whose product has the most ingredients (its own composition, or the drop's COC for its product) → page number */
async function richestPage(item) {
  const parts = await prisma.intakeItem.findMany({ where: { parentId: item.id }, select: { pageFrom: true, classification: true } });
  if (!parts.length) return 1;
  const cocs = await prisma.intakeItem.findMany({ where: { batchId: item.batchId, parentId: { not: null }, classification: { path: ["certCode"], equals: "COC" } }, select: { classification: true } });
  const countFor = (names) => {
    for (const n of names || []) {
      const hit = cocs.find((c) => (c.classification?.productNames || []).some((x) => String(x).toUpperCase() === String(n).toUpperCase()));
      if (hit?.classification?.composition?.ingredients?.length) return hit.classification.composition.ingredients.length;
    }
    return 0;
  };
  let best = { page: parts[0].pageFrom || 1, n: -1 };
  for (const p of parts) {
    const n = p.classification?.composition?.ingredients?.length || countFor(p.classification?.productNames);
    if (n > best.n) best = { page: p.pageFrom || 1, n };
  }
  return best.page;
}
