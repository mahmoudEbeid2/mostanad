import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import { loadInvoice } from "../invoices/invoiceService.js";
import { normalizeDate } from "../invoices/dateNormalizer.js";
import { listFields } from "../templates/fieldService.js";
import { sourceType, productJsonColumns } from "../templates/sourceCatalogue.js";
import { computePlan } from "../generation/planService.js";
import { resolveField, applyFormat } from "../generation/valueResolver.js";
import { getDictionary, pathSynonymMap } from "../dictionary/dataDictionary.js";
import { fromSource, canonicalFull, resolve } from "../paths/sourcePath.js";
import { getAiSettings, aiAllowed } from "../ai/aiSettings.js";
import { logNotRun, sha16, stableStringify } from "../ai/aiRunLog.js";
import { recordSuggestion, decideSuggestion } from "../ai/aiSuggestions.js";
import { locateItemSpans } from "./itemSpans.js";
import { askGaps, buildPayload, nearMisses, PROMPT_HASH as GAPS_PROMPT_HASH } from "./gapResolver.js";

// The certificate data check (plan.md §6.1, §6.2; Phase A2).
//   plan (templateSelector) × each template field → one CertificateDataNeed:
//     resolved        code read it from the field's source (or an accepted synonym path)
//     not_applicable  optional and empty
//     missing         required and empty
//   → ONE CERT_INVOICE_GAPS call for the missing ones not asked before
//     resolved_ai        found with verified evidence, auto-accepted (company setting, P4)
//     needs_confirmation found with verified evidence, a person must accept it
//   → a person: accept / edit (provided) / reject.
// Generation reads `provided` / `resolved_ai` first (batchService). Group
// cells are not needs: a group's rows come from its declared list.

export const NEED_STATUSES = ["resolved", "resolved_ai", "needs_confirmation", "missing", "provided", "not_applicable"];
export const BLOCKING = ["missing", "needs_confirmation"];
export const USABLE = ["provided", "resolved_ai"]; // what generation takes from the check
const CHECKABLE = ["review", "ready", "generated", "partially_failed"];
const MAX_VALUE = 500;

const normLabel = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const isDateField = (field) => !!field.format?.date || sourceType(field.source || { kind: "manual" }) === "date";

/** A value about to be stored for a field: dates become ISO when the text is unambiguous (the field's format then applies). */
export function storedValue(field, text) {
  const v = String(text ?? "").trim().slice(0, MAX_VALUE);
  if (!v) return null;
  return isDateField(field) ? normalizeDate(v) || v : v;
}

/** Header-level or line-level (row scope, plan.md §6.1). */
function scopeOf(need, field) {
  if (!need.invoiceItemId) return "header";
  if (["invoice_header", "company", "constant"].includes(field.dataCategory)) return "header";
  return ["invoice", "company"].includes(field.source?.kind) ? "header" : "line";
}

function codeProvenance(field, r) {
  const s = field.source || { kind: "manual" };
  if (s.kind === "static") return { kind: "static" };
  if (s.kind === "today") return { kind: "today" };
  if (s.kind === "template") return { kind: "template", template: s.template, ...(r.via ? { via: r.via } : {}) };
  return { kind: "path", path: r.via || canonicalFull(fromSource(s)) || fromSource(s), ...(r.via ? { via: "synonym", canonical: canonicalFull(fromSource(s)) } : {}) };
}

// ── loading ──────────────────────────────────────────────────────────────────
async function loadContext(invoice) {
  const plan = await computePlan(invoice);
  const items = await prisma.invoiceItem.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { lineNo: "asc" },
    include: { product: { include: { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } } } },
  });
  // tenant guard: a product is only ever read for its own company
  for (const it of items) if (it.product && it.product.companyId !== invoice.companyId) it.product = null;
  const versionIds = [...new Set(plan.entries.map((e) => e.templateVersionId))];
  const versions = await prisma.templateVersion.findMany({ where: { id: { in: versionIds } }, include: { template: { include: { brand: { select: { id: true, name: true } } } } } });
  const fields = new Map();
  for (const id of versionIds) fields.set(id, (await listFields(id)).filter((f) => !f.groupKey));
  const company = await prisma.company.findUnique({ where: { id: invoice.companyId }, select: { id: true, name: true, address: true, phone: true, email: true } });
  const invoiceBrand = invoice.brandId ? await prisma.brand.findUnique({ where: { id: invoice.brandId }, select: { id: true, name: true } }) : null;
  const dict = await getDictionary(invoice.companyId);
  return { plan, items, versions: new Map(versions.map((v) => [v.id, v])), fields, company, invoiceBrand, pathSynonyms: pathSynonymMap(dict.entries), dictEntries: dict.entries };
}

/** Item row spans in the invoice text (plan.md §6.1 row scope). Extraction stores them;
 *  for lines without one (older invoices, lines added by hand) code locates them once. */
async function ensureSpans(invoice, items) {
  if (!invoice.textContent) return;
  const todo = items.filter((it) => it.textSpan === null || it.textSpan === undefined);
  if (!todo.length) return;
  const spans = locateItemSpans(invoice.textContent, items.map((it) => ({ id: it.id, data: it.data })));
  for (const it of todo) {
    const span = spans.get(it.id) || { none: true }; // {none} = looked, not found (don't search again on every check)
    it.textSpan = span;
    await prisma.invoiceItem.update({ where: { id: it.id }, data: { textSpan: span } });
  }
}
const spanOf = (it) => (it?.textSpan && !it.textSpan.none ? it.textSpan : null);

/** The resolver context of one plan entry (the same shape generation uses). */
function entryContext(entry, ctx, invoice) {
  const lines = entry.invoiceItemIds.map((id) => ctx.items.find((i) => i.id === id)).filter(Boolean);
  const c = { invoice: invoice.header || {}, company: ctx.company, today: new Date(), pathSynonyms: ctx.pathSynonyms };
  c.lines = lines.map((l) => ({ ...(l.data || {}), product: l.product || {} }));
  if (entry.scope === "per_product") {
    const line = lines[0];
    c.item = line?.data || {};
    if (line?.product) {
      c.product = line.product;
      c.brand = line.product.brand || null;
    }
  } else c.brand = ctx.versions.get(entry.templateVersionId)?.template?.brand || ctx.invoiceBrand || null;
  return c;
}

// ── compute ──────────────────────────────────────────────────────────────────
/** Code resolution of every need of the invoice, merged with what was already decided. → rows */
async function computeCode(invoice, ctx) {
  const existing = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id } });
  const byKey = new Map(existing.map((n) => [`${n.planKey}|${n.fieldKey}`, n]));
  const keep = new Set();
  const out = [];
  for (const entry of ctx.plan.entries) {
    const rctx = entryContext(entry, ctx, invoice);
    const itemId = entry.scope === "per_product" ? entry.invoiceItemIds[0] : null;
    for (const field of ctx.fields.get(entry.templateVersionId) || []) {
      const key = `${entry.planKey}|${field.key}`;
      keep.add(key);
      const r = resolveField(field, rctx);
      const basis = sha16(stableStringify({ source: field.source, required: field.required, productId: entry.productId, itemId, category: field.dataCategory }));
      const code = r.resolved !== ""
        ? { status: "resolved", value: r.resolved, provenance: codeProvenance(field, r) }
        : { status: field.required ? "missing" : "not_applicable", value: null, provenance: null };
      const prev = byKey.get(key);
      let data;
      if (prev && prev.basis === basis) {
        if (prev.status === "provided") data = {}; // a person's value stands
        else if (code.status === "resolved") data = { ...code, suggestionId: null, aiAskedBasis: null }; // closed by code: if it reopens, it is a new gap
        else if (["resolved_ai", "needs_confirmation"].includes(prev.status)) data = {}; // verified AI value stands until decided
        else data = code;
      } else data = { ...code, aiAskedBasis: null, suggestionId: null, decidedByUserId: null, decidedAt: null };
      const base = { label: field.label, category: field.dataCategory || null, required: field.required, templateVersionId: entry.templateVersionId, invoiceItemId: itemId, productId: entry.productId, basis };
      const row = prev
        ? await prisma.certificateDataNeed.update({ where: { id: prev.id }, data: { ...base, ...data } })
        : await prisma.certificateDataNeed.upsert({
            // upsert, not create: a concurrent check on another API process may have just written it
            where: { invoiceId_planKey_fieldKey: { invoiceId: invoice.id, planKey: entry.planKey, fieldKey: field.key } },
            create: { companyId: invoice.companyId, invoiceId: invoice.id, planKey: entry.planKey, fieldKey: field.key, ...base, ...code },
            update: {},
          });
      out.push({ row, field, entry });
    }
  }
  const stale = existing.filter((n) => !keep.has(`${n.planKey}|${n.fieldKey}`)).map((n) => n.id);
  if (stale.length) await prisma.certificateDataNeed.deleteMany({ where: { id: { in: stale } } });
  return out;
}

/** The AI step: one call for every missing need not asked with this basis before. */
async function fillGaps(invoice, ctx, rows, { generate, settings }) {
  const ai = { used: false, calls: 0, asked: 0, filled: 0, rejected: 0 };
  const open = rows.filter((x) => x.row.status === "missing" && x.row.aiAskedBasis !== x.row.basis);
  if (!open.length) return ai;
  if (!aiAllowed(settings, "allowInvoiceGapFill")) {
    ai.unavailable = true;
    ai.reason = settings.enabled ? "AI gap filling is turned off for this company" : "AI is turned off for this company";
    await logNotRun({ companyId: invoice.companyId, kind: "CERT_INVOICE_GAPS", outcome: "disabled", reason: ai.reason, entityType: "invoice", entityId: invoice.id });
    return ai;
  }
  const jsonColumns = [...productJsonColumns()];
  // one gap per (line or header, field source, label): the same batch result asked once for three certificate types
  const gaps = new Map();
  const productRefs = new Map(); // productId → ref
  const products = new Map();
  const lineNo = (id) => ctx.items.find((i) => i.id === id)?.lineNo ?? null;
  for (const x of open) {
    const scope = scopeOf(x.row, x.field);
    const itemId = scope === "line" ? x.row.invoiceItemId : null;
    const sig = `${itemId || "header"}|${stableStringify(x.field.source)}|${normLabel(x.field.label)}`;
    if (!gaps.has(sig)) {
      const item = itemId ? ctx.items.find((i) => i.id === itemId) : null;
      let productRef = null;
      if (item?.product) {
        if (!productRefs.has(item.product.id)) {
          const ref = `P${productRefs.size + 1}`;
          productRefs.set(item.product.id, ref);
          const empty = ctx.dictEntries.filter((e) => e.root === "product" && e.pickable !== false && e.type !== "collection" && !resolve({ product: item.product }, e.path).found).map((e) => e.path.slice("product.".length));
          products.set(ref, { product: item.product, emptyPaths: empty, nearMisses: [] });
        }
        productRef = productRefs.get(item.product.id);
      }
      const wantedPath = x.field.source?.kind === "product" ? canonicalFull(fromSource(x.field.source)) : null;
      if (wantedPath && productRef) {
        const p = products.get(productRef);
        const nm = nearMisses(p.product, wantedPath, jsonColumns);
        if (nm.length) p.nearMisses.push({ wanted: wantedPath.slice("product.".length), candidates: nm });
      }
      gaps.set(sig, {
        gap: {
          gapId: `G${gaps.size + 1}`,
          fieldKey: x.field.key,
          label: x.field.label,
          category: x.field.dataCategory || "unknown",
          expectedType: isDateField(x.field) ? "date" : sourceType(x.field.source || { kind: "manual" }),
          ...(x.field.format?.date ? { dateFormat: x.field.format.date } : {}),
          scope,
          ...(itemId ? { lineNo: lineNo(itemId) } : {}),
          ...(productRef ? { productRef } : {}),
          ...(wantedPath ? { wantedPath } : {}),
        },
        itemId,
        product: item?.product || null,
        needs: [],
      });
    }
    gaps.get(sig).needs.push(x);
  }
  const groups = [...gaps.values()];
  const items = ctx.items.filter((i) => i.matchStatus !== "ignored").map((i) => ({ lineNo: i.lineNo, data: i.data, productRef: i.product ? productRefs.get(i.product.id) || null : null }));
  const payload = buildPayload({ invoice, items, gaps: groups.map((g) => g.gap), products, jsonColumns });
  const activeItems = ctx.items.filter((i) => i.matchStatus !== "ignored");
  const allSpans = activeItems.map(spanOf).filter(Boolean);
  const gapCtx = new Map(
    groups.map((g) => {
      const item = g.itemId ? ctx.items.find((i) => i.id === g.itemId) : null;
      return [g.gap.gapId, { textContent: invoice.textContent, scope: g.itemId ? "item" : "header", span: spanOf(item), otherSpans: allSpans, singleItem: activeItems.length === 1, product: g.product }];
    })
  );
  let res;
  try {
    res = await askGaps({ companyId: invoice.companyId, invoiceId: invoice.id, textContent: invoice.textContent, payload, gapCtx }, { generate });
  } catch (err) {
    // P8: the check still works by hand; the gaps are asked again next time
    ai.unavailable = true;
    ai.reason = err.message;
    return ai;
  }
  ai.used = true;
  ai.calls = 1;
  ai.asked = groups.length;
  const dict = await getDictionary(invoice.companyId);
  for (const g of groups) {
    const { answer, verdict } = res.answers.get(g.gap.gapId);
    let suggestion = null;
    if (answer) {
      suggestion = await recordSuggestion(
        {
          companyId: invoice.companyId,
          kind: "invoice_gap",
          entityType: "certificate_field",
          entityId: g.needs[0].row.id,
          proposal: { gap: g.gap, needIds: g.needs.map((x) => x.row.id), answer, verifiedValue: verdict.verified ? verdict.value : null },
          evidence: answer.evidence || [],
          evidenceVerified: verdict.verified,
          confidence: answer.found ? answer.confidence : 0,
          modelKind: "CERT_INVOICE_GAPS",
          promptHash: GAPS_PROMPT_HASH,
          inputHash: res.inputHash,
          dictionaryVersion: dict.version,
          aiRunId: res.run?.id,
        },
        settings
      );
      if (!verdict.verified) {
        await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: verdict.reason, checks: verdict.checks } } });
        if (answer.found) ai.rejected++;
      }
    }
    for (const x of g.needs) {
      const data = { aiAskedBasis: x.row.basis };
      if (verdict.verified && suggestion) {
        const value = storedValue(x.field, verdict.value);
        Object.assign(data, {
          status: suggestion.status === "auto_accepted" ? "resolved_ai" : "needs_confirmation",
          value,
          provenance: { ...verdict.provenance, suggestionId: suggestion.id, confidence: answer.confidence, ...(answer.note ? { note: String(answer.note).slice(0, 200) } : {}) },
          suggestionId: suggestion.id,
        });
      } else if (suggestion) data.suggestionId = suggestion.id;
      x.row = await prisma.certificateDataNeed.update({ where: { id: x.row.id }, data });
    }
    if (verdict.verified) ai.filled++;
  }
  return ai;
}

/**
 * POST /invoices/:id/data-needs — computes the check (code), then asks the AI
 * once for the gaps not asked before (unless `ai: false`). → the view.
 * deps.generate replaces the model call (tests).
 */
// One check per invoice at a time in this process: the review screen can fire
// two at once (re-render after an edit), and two runs would race on the rows
// and could pay for the same gaps twice. The second waits, then runs on the
// first one's result (its gaps are already asked → 0 calls).
const running = new Map(); // invoiceId → Promise
function serialized(invoiceId, fn) {
  const prev = running.get(invoiceId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  running.set(invoiceId, next);
  return next.finally(() => {
    if (running.get(invoiceId) === next) running.delete(invoiceId);
  });
}

export async function computeNeeds(invoiceId, companyScope, opts = {}) {
  return serialized(invoiceId, () => computeNeedsNow(invoiceId, companyScope, opts));
}

async function computeNeedsNow(invoiceId, companyScope, { ai = true, generate } = {}) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  if (!CHECKABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `There is nothing to check for an invoice that is ${invoice.status}`, 409);
  const ctx = await loadContext(invoice);
  await ensureSpans(invoice, ctx.items);
  const rows = await computeCode(invoice, ctx);
  // the check has run: from now on generate is gated on it (post-A4), even if no template applied yet
  await prisma.invoice.update({ where: { id: invoice.id }, data: { dataCheckedAt: new Date() } });
  let aiOut = { used: false, calls: 0 };
  if (ai) {
    const settings = await getAiSettings(invoice.companyId);
    aiOut = await fillGaps(invoice, ctx, rows, { generate, settings });
  }
  return buildView(invoice, ctx, aiOut);
}

/**
 * Code-only refresh, used by generation's gate: true when the invoice's check
 * was ever run — `dataCheckedAt` (automatic since post-A4), or need rows from a
 * check run by hand before that column existed. Older invoices: false (V2 behaviour).
 */
export async function refreshIfChecked(invoice) {
  if (!invoice.dataCheckedAt && !(await prisma.certificateDataNeed.count({ where: { invoiceId: invoice.id } }))) return false;
  await serialized(invoice.id, async () => {
    const ctx = await loadContext(invoice);
    await ensureSpans(invoice, ctx.items);
    await computeCode(invoice, ctx);
  });
  return true;
}

/** → { missing, needsConfirmation } counts of required needs that block generation. */
export async function blockingCounts(invoiceId) {
  const rows = await prisma.certificateDataNeed.groupBy({ by: ["status"], where: { invoiceId, required: true, status: { in: BLOCKING } }, _count: { _all: true } });
  const n = (s) => rows.find((r) => r.status === s)?._count._all || 0;
  return { missing: n("missing"), needsConfirmation: n("needs_confirmation") };
}

/** Generation (batchService): planKey → { fieldKey → need } of the values the check settled. */
export async function usableNeeds(invoiceId) {
  const rows = await prisma.certificateDataNeed.findMany({ where: { invoiceId, status: { in: USABLE }, value: { not: null } } });
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.planKey)) out.set(r.planKey, new Map());
    out.get(r.planKey).set(r.fieldKey, r);
  }
  return out;
}

// ── view ─────────────────────────────────────────────────────────────────────
async function buildView(invoice, ctx, ai = null) {
  const rows = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id }, orderBy: [{ planKey: "asc" }, { fieldKey: "asc" }] });
  const byPlan = new Map();
  for (const r of rows) {
    if (!byPlan.has(r.planKey)) byPlan.set(r.planKey, []);
    byPlan.get(r.planKey).push(r);
  }
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const fieldFor = (r) => (ctx.fields.get(r.templateVersionId) || []).find((f) => f.key === r.fieldKey);
  const needView = (r) => {
    const f = fieldFor(r);
    const display = r.value !== null && f ? applyFormat(r.value, f.format).value : r.value;
    return { id: r.id, fieldKey: r.fieldKey, label: r.label, category: r.category, required: r.required, status: r.status, value: r.value, display, provenance: r.provenance, suggestionId: r.suggestionId, decidedAt: r.decidedAt };
  };
  const certificates = ctx.plan.entries
    .filter((e) => byPlan.has(e.planKey))
    .map((e) => {
      const item = e.scope === "per_product" ? itemById.get(e.invoiceItemIds[0]) : null;
      return {
        planKey: e.planKey,
        templateVersionId: e.templateVersionId,
        templateName: e.templateName,
        typeCode: e.typeCode,
        typeName: e.typeName,
        scope: e.scope,
        lineNos: e.lineNos,
        invoiceItemId: item?.id || null,
        productName: item?.product?.name || null,
        batchNo: item?.data?.batchNo || null,
        needs: (byPlan.get(e.planKey) || []).map(needView),
      };
    });
  // batch data (lab results): one input per line and label, whatever the number of certificate types needing it
  const batch = new Map();
  for (const r of rows.filter((x) => x.category === "batch_data" && x.invoiceItemId)) {
    const item = itemById.get(r.invoiceItemId);
    if (!batch.has(r.invoiceItemId)) batch.set(r.invoiceItemId, { invoiceItemId: r.invoiceItemId, lineNo: item?.lineNo ?? null, productName: item?.product?.name || item?.data?.name || null, batchNo: item?.data?.batchNo || null, fields: new Map() });
    const fields = batch.get(r.invoiceItemId).fields;
    const k = normLabel(r.label);
    if (!fields.has(k)) fields.set(k, { labelKey: k, label: r.label, needIds: [], statuses: [], value: null, required: false });
    const g = fields.get(k);
    g.needIds.push(r.id);
    g.statuses.push(r.status);
    g.required ||= r.required;
    if (r.value !== null && g.value === null) g.value = r.value;
  }
  const batchData = [...batch.values()]
    .sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0))
    .map((b) => ({
      ...b,
      fields: [...b.fields.values()].map((g) => ({
        labelKey: g.labelKey,
        label: g.label,
        needIds: g.needIds,
        required: g.required,
        value: g.value,
        status: g.statuses.some((s) => s === "missing") ? "missing" : g.statuses.some((s) => s === "needs_confirmation") ? "needs_confirmation" : g.statuses.every((s) => s === "not_applicable") ? "not_applicable" : g.statuses.some((s) => s === "provided") ? "provided" : g.statuses[0],
      })),
    }));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const blocking = rows.filter((r) => r.required && BLOCKING.includes(r.status)).length;
  return {
    summary: {
      certificates: certificates.length,
      values: rows.length,
      ready: count("resolved") + count("resolved_ai") + count("provided"),
      resolved: count("resolved"),
      resolvedAi: count("resolved_ai"),
      provided: count("provided"),
      needsConfirmation: count("needs_confirmation"),
      missing: count("missing"),
      notApplicable: count("not_applicable"),
      blocking,
    },
    certificates,
    batchData,
    unassigned: ctx.plan.unassigned,
    ...(ai ? { ai } : {}),
    computedAt: new Date().toISOString(),
  };
}

/** GET /invoices/:id/data-needs — the stored check, as last computed (no AI). */
export async function getNeeds(invoiceId, companyScope) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  const ctx = await loadContext(invoice);
  return buildView(invoice, ctx);
}

// ── a person's decisions (§6.2) ──────────────────────────────────────────────
/**
 * PATCH /invoices/:id/data-needs
 * decisions: [{ needId, action: accept|edit|reject|reset, value?, applyTo?: "line" }]
 *   accept — a verified AI value (needs_confirmation / resolved_ai) is confirmed;
 *   edit   — the person's value (status provided, manual provenance); with
 *            applyTo "line" also every other open need of the same line with the same label
 *            ("use for all certificates of this product");
 *   reject — the AI value is wrong: back to missing, not asked again;
 *   reset  — forget the decision; the next check recomputes it.
 * → the view
 */
export async function decideNeeds(invoiceId, companyScope, decisions, userId = null) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  if (!CHECKABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `This invoice is ${invoice.status}`, 409);
  const ctx = await loadContext(invoice);
  const all = await prisma.certificateDataNeed.findMany({ where: { invoiceId: invoice.id } });
  const byId = new Map(all.map((n) => [n.id, n]));
  const fieldFor = (n) => (ctx.fields.get(n.templateVersionId) || []).find((f) => f.key === n.fieldKey) || { source: { kind: "manual" } };
  const now = new Date();
  for (const d of decisions) {
    const need = byId.get(d.needId);
    if (!need) throw notFound("Data need");
    switch (d.action) {
      case "accept": {
        if (!["needs_confirmation", "resolved_ai"].includes(need.status)) throw new CertError("NOTHING_TO_ACCEPT", `“${need.label}” has no AI value waiting for confirmation`, 409);
        await prisma.certificateDataNeed.update({ where: { id: need.id }, data: { status: "resolved_ai", decidedByUserId: userId, decidedAt: now } });
        if (need.suggestionId) await decideSuggestion(invoice.companyId, need.suggestionId, { decision: "accepted", finalValue: { value: need.value }, userId });
        break;
      }
      case "edit": {
        const targets = [need];
        if (d.applyTo === "line" && need.invoiceItemId) {
          for (const n of all) if (n.id !== need.id && n.invoiceItemId === need.invoiceItemId && normLabel(n.label) === normLabel(need.label) && n.status !== "resolved") targets.push(n);
        }
        for (const n of targets) {
          const value = storedValue(fieldFor(n), d.value);
          if (value === null) throw new CertError("VALUE_REQUIRED", `Type a value for “${n.label}” (or reset it)`, 422);
          await prisma.certificateDataNeed.update({ where: { id: n.id }, data: { status: "provided", value, provenance: { kind: "manual" }, decidedByUserId: userId, decidedAt: now } });
          if (n.suggestionId && ["needs_confirmation", "resolved_ai"].includes(n.status)) await decideSuggestion(invoice.companyId, n.suggestionId, { decision: n.value === value ? "accepted" : "edited", finalValue: { value }, userId });
        }
        break;
      }
      case "reject": {
        if (!["needs_confirmation", "resolved_ai"].includes(need.status)) throw new CertError("NOTHING_TO_REJECT", `“${need.label}” has no AI value to reject`, 409);
        await prisma.certificateDataNeed.update({ where: { id: need.id }, data: { status: need.required ? "missing" : "not_applicable", value: null, provenance: null, decidedByUserId: userId, decidedAt: now } });
        if (need.suggestionId) await decideSuggestion(invoice.companyId, need.suggestionId, { decision: "rejected", userId });
        break;
      }
      case "reset":
        await prisma.certificateDataNeed.update({ where: { id: need.id }, data: { basis: "", aiAskedBasis: need.aiAskedBasis, decidedByUserId: null, decidedAt: null } });
        break;
      default:
        throw new CertError("INVALID_ACTION", `Unknown action "${d.action}"`, 400);
    }
  }
  await computeCode(invoice, ctx); // resets recompute; nothing else changes
  return buildView(invoice, ctx);
}
