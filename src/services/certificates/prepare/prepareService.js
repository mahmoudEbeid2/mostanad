import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { loadInvoice, matchSummaryOf } from "../invoices/invoiceService.js";
import { matchInvoice } from "../matching/productMatcher.js";
import { getAiSettings, aiAllowed } from "../ai/aiSettings.js";
import { CHECKABLE, AWAITING, computeNeeds, webLookupNeeds, recheckCode, blockingCounts } from "../dataNeeds/dataNeedsService.js";
import { runCoaJob } from "../labResults/coaService.js";
import { getGrid } from "../labResults/resultsGrid.js";
import { entityCost } from "../../ai/aiCostReports.js";

// "Prepare certificates" (fill automatically, item 5, owner 2026-10-26): ONE button on the
// invoice runs, in order, as a background job with named stages and progress:
//   matching      — lines still without a product (a confirmed invoice has none: skipped)
//   product_data  — the data check: DB → invoice → catalogue → inference (one gap call, one
//                   inference call), then the web for what is still missing, where allowed
//   batch_results — lab results of the same company + product + batch, reused by code
//   supplier_coa  — the uploaded supplier COAs not read yet (only if there are any)
// and ends with what still needs a person: estimated / unconfirmed values (Confirm all) and the
// results grid. Generation is possible as soon as nothing required is missing (`canGenerate`).
// A stage that fails is reported with its reason and the others still run — never hidden.

export const STAGES = [
  { key: "matching", label: "Matching products" },
  { key: "product_data", label: "Filling product data" },
  { key: "batch_results", label: "Reusing batch results" },
  { key: "supplier_coa", label: "Reading supplier COAs" },
];

/** POST /invoices/:id/prepare → 202 { taskId } */
export async function startPrepare(invoiceId, companyScope, userId = null) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  if (!CHECKABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `There is nothing to prepare for an invoice that is ${invoice.status}`, 409);
  const task = await enqueueTask({ queueName: QUEUES.invoice, jobName: "prepare", type: "certificate_prepare", companyId: invoice.companyId, data: { entity: "invoice", entityId: invoice.id, invoiceId: invoice.id, userId } });
  return { taskId: task.id, stages: STAGES };
}

/** What still needs a person after preparing (the job result, and GET-able again through the check). */
export async function preparedView(invoice) {
  const rows = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id } });
  const awaiting = rows.filter((r) => AWAITING.includes(r.status) && r.value !== null);
  const missing = rows.filter((r) => r.required && r.status === "missing");
  const open = await blockingCounts(invoice.id);
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId: invoice.id }, select: { matchStatus: true } });
  const unmatched = items.filter((i) => i.matchStatus === "needs_match").length;
  const grid = await getGrid(invoice.id, invoice.companyId);
  return {
    toConfirm: awaiting.map((r) => ({ needId: r.id, label: r.label, value: r.value, status: r.status, estimated: r.provenance?.estimated === true, estimateBasis: r.provenance?.estimateBasis || null })),
    estimated: awaiting.filter((r) => r.provenance?.estimated === true).length,
    missing: missing.length,
    missingLabResults: grid.summary.blocking,
    missingOther: missing.length - Math.min(missing.length, grid.summary.blocking),
    unmatchedLines: unmatched,
    open,
    // generation needs nothing required open and every line matched or ignored (a person then confirms + generates)
    canGenerate: open.missing === 0 && open.needsConfirmation === 0 && unmatched === 0,
  };
}

/**
 * The `prepare` job. deps (tests): { matchGenerate, generate, inferGenerate, search, fetchPage, coaGenerate }
 * → { stages: [{ key, label, status: done|skipped|failed, detail, error? }], prepared, cost }
 */
export async function runPrepareJob({ invoiceId }, ctx = {}, deps = {}) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new CertError("NOT_FOUND", "Invoice not found", 404);
  const stages = STAGES.map((s) => ({ ...s, status: "pending" }));
  const stage = (key) => stages.find((s) => s.key === key);
  let last = 0; // never goes back (a stage's own steps can run ahead of its end mark)
  const progress = (pct, key, message) => {
    last = Math.max(last, pct);
    ctx.progress?.(last, message || stage(key).label, { stage: key, stages });
  };
  const run = async (key, pct, fn) => {
    const s = stage(key);
    s.status = "running";
    progress(pct, key);
    try {
      Object.assign(s, (await fn()) || { status: "done" });
    } catch (err) {
      // reported on the stage (and so in the task result), the next stages still run
      Object.assign(s, { status: "failed", error: String(err.message || err).slice(0, 1000) });
    }
    progress(pct + 5, key, `${s.label}: ${s.status}`);
  };

  await run("matching", 5, async () => {
    const open = await prisma.invoiceItem.count({ where: { invoiceId, matchStatus: "needs_match" } });
    if (!open) return { status: "skipped", detail: "every line already has a product (or is ignored)" };
    const res = await matchInvoice(invoiceId, { generate: deps.matchGenerate });
    await prisma.invoice.update({ where: { id: invoiceId }, data: { matchSummary: matchSummaryOf(res, "prepare") } });
    return { status: "done", detail: `${res.matched} matched, ${res.needsMatch} still need a product`, ai: res.ai || null };
  });

  let check = null;
  await run("product_data", 25, async () => {
    check = await computeNeeds(invoiceId, invoice.companyId, { generate: deps.generate, inferGenerate: deps.inferGenerate });
    const settings = await getAiSettings(invoice.companyId);
    let web = null;
    if (aiAllowed(settings) && settings.allowWebLookup && check.tiers?.webEligible > 0) {
      progress(45, "product_data", "Looking up missing product facts on the web");
      check = await webLookupNeeds(invoiceId, invoice.companyId, { search: deps.search, fetchPage: deps.fetchPage });
      web = check.ai?.web || null;
    }
    const s = check.summary;
    return { status: "done", detail: `${s.ready} of ${s.values} values ready, ${s.estimated} estimated, ${s.missing} missing`, ai: { gaps: check.ai?.calls ?? 0, inference: check.ai?.inference?.calls ?? 0, web: web?.calls ?? 0, ...(check.ai?.unavailable ? { unavailable: check.ai.reason } : {}) } };
  });

  await run("batch_results", 60, async () => {
    // the data check above already read them; a code-only recheck picks up anything written since
    await recheckCode(invoiceId, invoice.companyId);
    const reused = await prisma.certificateDataNeed.count({ where: { invoiceId, status: "reused", provenance: { path: ["kind"], equals: "batch_result" } } });
    return { status: reused ? "done" : "skipped", detail: reused ? `${reused} lab result${reused === 1 ? "" : "s"} reused from earlier batches` : "no earlier result for these batches" };
  });

  await run("supplier_coa", 70, async () => {
    const unread = await prisma.supplierCoa.count({ where: { invoiceId, companyId: invoice.companyId, status: { in: ["uploaded", "failed"] } } });
    if (!unread) return { status: "skipped", detail: "no unread supplier COA" };
    const res = await runCoaJob({ invoiceId }, { progress: (p, m) => progress(70 + Math.round(p / 5), "supplier_coa", m) }, { generate: deps.coaGenerate });
    const done = res.coas.filter((c) => c.status === "done");
    return { status: "done", detail: `${done.length} of ${res.coas.length} read, ${done.reduce((a, c) => a + c.accepted, 0)} values taken, ${done.reduce((a, c) => a + c.rejected, 0)} refused`, coas: res.coas };
  });

  progress(95, "supplier_coa", "Working out what still needs you");
  const prepared = await preparedView(invoice);
  const cost = await entityCost({ type: "invoice", id: invoiceId, companyId: invoice.companyId });
  // the invoice's AI cost so far (ledger: its own calls + those made for it, e.g. web lookups, COAs)
  return { invoiceId, stages, prepared, cost: { attempts: cost.attempts, costUsd: cost.costUsd, byFeature: cost.byFeature } };
}
