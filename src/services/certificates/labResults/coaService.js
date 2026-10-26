import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { loadInvoice, detectInvoiceFormat } from "../invoices/invoiceService.js";
import { cleanText } from "../invoices/invoiceExtractor.js";
import { runLogged } from "../ai/aiRunLog.js";
import { getAiSettings, aiAllowed } from "../ai/aiSettings.js";
import { listFields } from "../templates/fieldService.js";
import { isLabResult } from "../inference/policy.js";
import { readPdfLayout } from "../../catalogues/pdfLayout.js";
import { CHECKABLE, recheckCode, storedValue } from "../dataNeeds/dataNeedsService.js";
import { batchOf, normLabel, rememberBatchResult } from "./batchResults.js";
import { verifyCoa } from "./coaVerifier.js";

// Supplier COA / lab report upload (fill automatically, item 4, owner 2026-10-26).
// Several PDFs / images per invoice; a background job reads each (ONE AI call per
// document, through runLogged → ai_runs + the AI cost ledger) and code verifies every
// value (coaVerifier). Where code checked the quote against the PDF's own text layer,
// an accepted value is the batch's result ("Supplier COA p.N"), reused on every line
// and invoice of that batch. A scan has no text layer: its quotes can only be checked
// against the model's transcription, so its values wait in the data check for a person
// (needs_confirmation) and become the batch's result only when someone accepts them.

export const MAX_COA_FILES = 10;
const TEXT_PER_PAGE = 40; // fewer printed characters per page than this = a scan

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    textContent: { type: "string", nullable: true, description: "ONLY when asked: every piece of text printed, page by page; each page starts with a line '=== Page N ==='" },
    batches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          batchNo: { type: "string", description: "the batch / lot number exactly as printed" },
          product: { type: "string", nullable: true },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                labelKey: { type: "string", description: "one of the wanted labelKeys" },
                value: { type: "string", description: "the result exactly as printed (copied from inside quote)" },
                quote: { type: "string", description: "the printed text containing the value, copied exactly from the document text" },
              },
              required: ["labelKey", "value", "quote"],
            },
          },
        },
        required: ["batchNo", "results"],
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: ["batches"],
  propertyOrdering: ["textContent", "batches", "warnings"],
};

const PROMPT = [
  "You read a supplier's certificate of analysis / lab report for a veterinary or feed product.",
  "For every batch (lot) the document reports analysis results for, give its batch number exactly as printed and,",
  "for each WANTED result it prints, the result value exactly as printed and a verbatim quote containing it.",
  "Rules:",
  "- Copy, never compute: do not convert units, round, translate, complete or guess. A result the document doesn't print is left out.",
  "- labelKey must be one of the wanted labelKeys; a wanted result may be printed under a different name (e.g. 'pH value' for 'ph result').",
  "- quote: copy it character for character from the document text given below (the same words in the same order); value must appear inside quote.",
  "- The specification / limit is not the result: give the measured or reported result (e.g. '7.1' or 'Complies'), not the specification column.",
  "- If the document prints several batches, keep each batch's results under that batch.",
].join("\n");

export const PROMPT_HASH = crypto.createHash("sha256").update(PROMPT + JSON.stringify(RESPONSE_SCHEMA)).digest("hex").slice(0, 16);

const defaultGenerate = (args) => geminiClient.generateJson({ ...args, ledger: { feature: "certificates.coa" } });

/** A PDF's text layer as "=== Page N ===" text, one printed row per line (cells by position). → { text, pages, chars } */
export async function pdfText(buffer) {
  const layout = await readPdfLayout(buffer);
  const out = [];
  let chars = 0;
  for (const p of layout.pages) {
    const rows = [];
    for (const it of [...p.items].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, Math.min(r.h, it.h) * 0.5));
      if (row) row.items.push(it);
      else rows.push({ y: it.y, h: it.h, items: [it] });
    }
    const lines = rows.map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" | "));
    chars += lines.join("").replace(/\s|\|/g, "").length;
    out.push(`=== Page ${p.n} ===`, ...lines);
  }
  return { text: out.join("\n"), pages: layout.pages.length, chars };
}

/** What the invoice's lines need: lines with their batch number and their lab-result labels. */
async function wantedOf(invoice) {
  const needs = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id, invoiceItemId: { not: null } } });
  const fieldsBy = new Map();
  for (const id of [...new Set(needs.map((n) => n.templateVersionId))]) fieldsBy.set(id, await listFields(id));
  const fieldOf = (n) => (fieldsBy.get(n.templateVersionId) || []).find((f) => f.key === n.fieldKey) || null;
  const results = needs.filter((n) => {
    const f = fieldOf(n);
    return f && isLabResult(f) && !f.showSpecInstead;
  });
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id }, orderBy: { lineNo: "asc" }, include: { product: { select: { id: true, name: true, companyId: true } } } });
  const lines = items
    .filter((it) => it.matchStatus !== "ignored")
    .map((it) => {
      const own = it.product && it.product.companyId === invoice.companyId;
      const labels = new Map();
      for (const n of results.filter((x) => x.invoiceItemId === it.id)) labels.set(normLabel(n.label), n.label);
      return { invoiceItemId: it.id, lineNo: it.lineNo, productId: own ? it.productId : null, productName: own ? it.product.name : it.data?.name || null, batchNo: batchOf(it), labels: [...labels].map(([labelKey, label]) => ({ labelKey, label })), item: it };
    })
    .filter((l) => l.labels.length);
  return { lines, results, fieldOf };
}

/**
 * POST /invoices/:id/supplier-coas (files[]) → 202 { taskId, coas }
 * Each file: PDF / PNG / JPEG / WebP by magic bytes, ≤ 15 MB. One background job reads them all.
 */
export async function uploadCoas({ invoiceId, companyScope, files, userId = null }) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  if (!CHECKABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `A supplier COA can be added once the invoice is reviewed (this one is ${invoice.status})`, 409);
  if (!files?.length) throw new CertError("NO_FILES", "Choose at least one supplier COA / lab report (PDF or image)", 400);
  if (files.length > MAX_COA_FILES) throw new CertError("TOO_MANY_FILES", `At most ${MAX_COA_FILES} files at a time`, 400);
  const settings = await getAiSettings(invoice.companyId);
  if (!aiAllowed(settings)) throw new CertError("AI_DISABLED", "AI is turned off for this company, so a supplier COA can't be read — type the results in the results grid", 409);
  const detected = files.map((f) => {
    try {
      return { file: f, ...detectInvoiceFormat(f.buffer) };
    } catch (err) {
      throw new CertError(err.code || "UNSUPPORTED_FORMAT", `${f.originalname || "file"}: ${err.code === "UNSUPPORTED_FORMAT" ? "upload a supplier COA as a PDF, PNG, JPEG or WebP file" : err.message}`, err.statusCode || 400);
    }
  });
  const coas = await prisma.$transaction(async (tx) => {
    const out = [];
    for (const d of detected) {
      const stored = await fileStore.putFile({ companyId: invoice.companyId, kind: "supplier_coa", buffer: d.file.buffer, mimeType: d.mimeType, originalName: d.file.originalname || null, ext: d.ext, tx });
      out.push(await tx.supplierCoa.create({ data: { companyId: invoice.companyId, invoiceId: invoice.id, fileId: stored.id, fileName: d.file.originalname ? String(d.file.originalname).slice(0, 200) : null, mimeType: d.mimeType, uploadedByUserId: userId } }));
    }
    return out;
  });
  const task = await startCoaJob(invoice, coas.map((c) => c.id));
  return { taskId: task.id, coas: await prisma.supplierCoa.findMany({ where: { id: { in: coas.map((c) => c.id) } }, orderBy: { createdAt: "asc" } }) };
}

/** Enqueues the reading of these COAs (one task). */
export async function startCoaJob(invoice, coaIds) {
  const task = await enqueueTask({ queueName: QUEUES.invoice, jobName: "coa", type: "supplier_coa_extract", companyId: invoice.companyId, data: { entity: "invoice", entityId: invoice.id, invoiceId: invoice.id, coaIds } });
  await prisma.supplierCoa.updateMany({ where: { id: { in: coaIds }, companyId: invoice.companyId }, data: { taskId: task.id } });
  return task;
}

/** DELETE /invoices/:id/supplier-coas/:coaId — the upload and its file. Results already stored for a batch stay (they are that batch's results). */
export async function deleteCoa(invoiceId, coaId, companyScope) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  const coa = await prisma.supplierCoa.findFirst({ where: { id: coaId, invoiceId: invoice.id, companyId: invoice.companyId } });
  if (!coa) throw notFound("Supplier COA");
  if (coa.status === "extracting") throw new CertError("COA_BUSY", "This supplier COA is being read; delete it when that has finished", 409);
  await prisma.supplierCoa.delete({ where: { id: coa.id } });
  await fileStore.deleteFile(coa.fileId);
}

/** The document's text: the PDF's own text layer when it has one, else the model is asked to transcribe it. */
async function documentText(buffer, mimeType) {
  if (mimeType !== "application/pdf") return { text: null, pages: 1, textSource: "transcription" };
  const t = await pdfText(buffer);
  return t.chars >= TEXT_PER_PAGE * Math.max(1, t.pages) ? { text: t.text, pages: t.pages, textSource: "pdf_text" } : { text: null, pages: t.pages, textSource: "transcription" };
}

/** One COA: read (1 AI call), verify (code). → { accepted, rejected, pages, textSource } */
async function readCoa(invoice, coa, lines, generate) {
  const { buffer } = await fileStore.readFile(coa.fileId, { companyId: invoice.companyId });
  const doc = await documentText(buffer, coa.mimeType);
  const wanted = {
    labels: [...new Map(lines.flatMap((l) => l.labels).map((x) => [x.labelKey, x])).values()],
    invoiceBatches: lines.filter((l) => l.batchNo).map((l) => ({ batchNo: l.batchNo, product: l.productName })),
  };
  // large shared content first (CLAUDE.md prompt order): the document → instructions → its text → what is wanted
  const contents = [
    { inlineData: { mimeType: coa.mimeType, data: buffer.toString("base64") } },
    PROMPT,
    doc.text ? `Document text (read by code from the PDF — copy every quote from it exactly):\n${doc.text}` : "This document has no text layer (a scan): first transcribe ALL its printed text into textContent, page by page, each page starting with '=== Page N ===', and copy every quote from that transcription.",
    `Wanted:\n${JSON.stringify(wanted)}`,
  ];
  const inputHash = crypto.createHash("sha256").update(buffer).update(JSON.stringify(wanted)).digest("hex").slice(0, 16);
  const { result } = await runLogged(
    { companyId: invoice.companyId, kind: "CERT_COA_EXTRACT", promptHash: PROMPT_HASH, inputHash, entityType: "supplier_coa", entityId: coa.id, parentType: "invoice", parentId: invoice.id, reason: `supplier COA ${coa.fileName || coa.id}` },
    () => generate({ model: MODELS.CERT_COA_EXTRACT.id, temperature: MODELS.CERT_COA_EXTRACT.temperature, thinkingBudget: MODELS.CERT_COA_EXTRACT.thinkingBudget, contents, schema: RESPONSE_SCHEMA, maxOutputTokens: doc.text ? 8192 : 32768 })
  );
  const text = doc.text || cleanText(result?.textContent);
  const verdict = verifyCoa({ text, answer: result, lines });
  return { ...verdict, pages: doc.pages, textSource: doc.textSource, warnings: Array.isArray(result?.warnings) ? result.warnings.map(String).slice(0, 20) : [] };
}

/**
 * The `coa` job: reads every COA given (or every unread one of the invoice), applies what
 * code verified, rechecks the invoice by code. One document failing is recorded on its row
 * (status failed, the provider's message) and the others go on; all failing fails the task.
 * deps.generate replaces the model call (tests). → { coas: [{ id, status, accepted, rejected }] }
 */
export async function runCoaJob({ invoiceId, coaIds = null }, ctx = {}, deps = {}) {
  const generate = deps.generate || defaultGenerate;
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw notFound("Invoice");
  const coas = await prisma.supplierCoa.findMany({ where: { invoiceId, companyId: invoice.companyId, status: { in: ["uploaded", "failed"] }, ...(coaIds ? { id: { in: coaIds } } : {}) }, orderBy: { createdAt: "asc" } });
  if (!coas.length) return { invoiceId, coas: [], skipped: true };
  // the check must have run so there are needs to fill
  await recheckCode(invoice.id, invoice.companyId);
  const { lines, results, fieldOf } = await wantedOf(invoice);
  const out = [];
  for (const [i, coa] of coas.entries()) {
    ctx.progress?.(Math.round(10 + (80 * i) / coas.length), `Reading ${coa.fileName || "supplier COA"} (${i + 1} of ${coas.length})`, { stage: "supplier_coa" });
    await prisma.supplierCoa.update({ where: { id: coa.id }, data: { status: "extracting", error: null } });
    let read;
    try {
      read = await readCoa(invoice, coa, lines, generate);
    } catch (err) {
      const message = String(err.message || err).slice(0, 2000);
      await prisma.supplierCoa.update({ where: { id: coa.id }, data: { status: "failed", error: message } });
      out.push({ id: coa.id, status: "failed", error: message });
      continue;
    }
    const accepted = [];
    for (const a of read.accepted) {
      const prov = { kind: "supplier_coa", coaId: coa.id, fileName: coa.fileName, page: a.page, quote: a.quote, textSource: read.textSource, invoiceId: invoice.id, invoiceNumber: invoice.header?.invoiceNumber || null };
      const lineNeeds = results.filter((n) => a.invoiceItemIds.includes(n.invoiceItemId) && normLabel(n.label) === a.labelKey);
      if (read.textSource === "pdf_text") {
        // checked against the document's own text: the batch's result (a person's value still wins)
        const line = lines.find((l) => l.invoiceItemId === a.invoiceItemIds[0]);
        const row = await rememberBatchResult({ companyId: invoice.companyId, item: line.item, field: fieldOf(lineNeeds[0]), label: lineNeeds[0]?.label, value: a.value, source: "supplier_coa", provenance: prov, invoiceId: invoice.id });
        accepted.push({ ...a, stored: row?.source === "supplier_coa" ? "batch_result" : "kept_person_value" });
      } else {
        // a scan: the quote was checked against the model's own transcription → a person confirms it
        for (const n of lineNeeds.filter((x) => ["missing", "not_applicable"].includes(x.status))) {
          await prisma.certificateDataNeed.update({ where: { id: n.id }, data: { status: "needs_confirmation", value: storedValue(fieldOf(n), a.value), provenance: prov } });
        }
        accepted.push({ ...a, stored: "needs_confirmation" });
      }
    }
    const result = { accepted, rejected: read.rejected, warnings: read.warnings };
    await prisma.supplierCoa.update({ where: { id: coa.id }, data: { status: "done", pages: read.pages, textSource: read.textSource, result } });
    out.push({ id: coa.id, status: "done", accepted: accepted.length, rejected: read.rejected.length });
  }
  ctx.progress?.(95, "Filling every line of those batches", { stage: "supplier_coa" });
  await recheckCode(invoice.id, invoice.companyId);
  if (out.every((c) => c.status === "failed")) throw new CertError("COA_READ_FAILED", `No supplier COA could be read: ${out.map((c) => c.error).join(" | ")}`, 502);
  return { invoiceId, coas: out };
}
