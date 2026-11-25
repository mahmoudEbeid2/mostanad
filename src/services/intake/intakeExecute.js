import { prisma } from "../../lib/prisma.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { enqueueRaw, QUEUES } from "../certificates/jobs/queues.js";
import { extractPages } from "./intakeText.js";
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
  const out = await queueReferenceLabel({ buffer, originalName: asPdfName(item.name), mimeType: item.mimeType?.startsWith("image/") ? item.mimeType : "application/pdf", country: plan.country || "Global", companyId: plan.companyId, brandId: plan.brandId });
  if (out.skipped) return { referenceLabel: { skipped: true, uploadedOn: uploadedOn(out.existing.createdAt) }, link: "/reference-labels" };
  return { referenceLabel: { taskId: out.taskId }, taskId: out.taskId, link: "/reference-labels" };
}

/** The type (created for the company when missing) → a draft template from the design's first page. */
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
  const buffer = isPdf && !item.pageFrom ? await extractPages(full, 1, 1) : full;
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

// ── the job ────────────────────────────────────────────────────────────────
export async function runExecute(batchId, ctx = {}, { userId = null } = {}) {
  const progress = ctx.progress || (() => {});
  const items = (await prisma.intakeItem.findMany({ where: { batchId, status: "executing" } })).sort((a, b) => ORDER.indexOf(a.result?.plan?.action) - ORDER.indexOf(b.result?.plan?.action));
  const record = (entityType, row, itemId, companyId) => prisma.intakeCreated.create({ data: { batchId, itemId, entityType, entityId: row.id, name: row.name, companyId } });
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
          result = { split: true, ...(await asTemplate({ ...item, pageFrom: 1, pageTo: 1 }, plan, userId, record)) };
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
      const cost = await itemAiCost(item.id);
      await prisma.intakeItem.update({ where: { id: item.id }, data: { status: "done", result: { ...item.result, ...result }, error: null, costUsd: cost.costUsd } });
    } catch (err) {
      console.error(`[intake] ${item.name}: ${err.message}`);
      await prisma.intakeItem.update({ where: { id: item.id }, data: { status: "failed", error: String(err.message).slice(0, 500) } });
    }
    n++;
  }
  const summary = await summarize(batchId);
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
