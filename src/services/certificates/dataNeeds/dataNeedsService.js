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
import { allowsInference, allowsWeb, allowsCatalogue, isLabResult } from "../inference/policy.js";
import { findCatalogueValue, verifyBlockQuote } from "../../catalogues/catalogueSections.js";
import { maskEstimates, provenanceFor, isUnconfirmedEstimate } from "../../catalogues/fieldProvenance.js";
import { askInference } from "../inference/productInference.js";
import { lookupProduct, cachedFact, storeFact, CACHE_KIND } from "../inference/webLookup.js";
import { saveProductData } from "../insights/productNeeds.js";
import { askGaps, buildPayload, nearMisses, PROMPT_HASH as GAPS_PROMPT_HASH } from "./gapResolver.js";
import { loadProfiles, profileValue, rememberValue, profileAllowed } from "./productProfile.js";
import { publicAiError } from "../../ai/aiErrorMessage.js";
import { loadBatchResults, batchValue, reusedProvenance, rememberBatchResult, batchOf } from "../labResults/batchResults.js";

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

// A5 (plan.md §14): inferred (tier I) and web_found (tier W) always wait for a person.
// A6 (plan.md §15.5): catalogue_found (tier C) — the product's own catalogue block, found by
// code — waits for a person too, and so does an estimated product value (status inferred).
// Fill automatically (owner, 2026-10-24, item 3): `reused` — a value code read from the
// product's certificate profile (proven or confirmed before) — needs nobody and no AI.
// A value proven by a verbatim quote is filled directly (resolved_ai, provenance
// filled: "direct") when the company's fillVerifiedDirectly is on (default); estimates
// stay inferred / web_found (provenance estimated: true) until a person confirms them.
// Item 4 (owner, 2026-10-26): a lab result confirmed for the same company + product + batch
// number (a person, or a verified supplier COA) is `reused` too (provenance kind batch_result).
export const NEED_STATUSES = ["resolved", "resolved_ai", "needs_confirmation", "missing", "provided", "not_applicable", "inferred", "web_found", "catalogue_found", "reused"];
export const AWAITING = ["needs_confirmation", "inferred", "web_found", "catalogue_found"]; // a value a person must accept
export const BLOCKING = ["missing", ...AWAITING];
export const USABLE = ["provided", "resolved_ai", "reused"]; // what generation takes from the check
const AI_VALUE = ["resolved_ai", ...AWAITING];

// Which steps already looked at a need with its current basis: aiAskedBasis =
// basis (the A2 gap call) + "|I" (tier I) + "|W" (tier W) + "|C" (tier C, A6) + "|E" (an
// estimated product value offered, A6). The same gap is never asked twice, and a
// value a person rejected is never offered again.
// The bare basis means "the gap call asked" (A2); I and W were only ever added
// after it. The code steps C and E (A6) don't imply it, so a row carrying only
// them records the gap call explicitly as "G".
const CODE_STEPS = new Set(["C", "E"]);
const stepsOf = (row) => {
  const a = row.aiAskedBasis || "";
  if (!row.basis || !a.startsWith(row.basis)) return null;
  return a.slice(row.basis.length).split("|").filter(Boolean);
};
const askedBy = (row, step) => {
  const steps = stepsOf(row);
  if (!steps) return false;
  if (step === "gap") return steps.length === 0 || steps.some((s) => !CODE_STEPS.has(s));
  return steps.includes(step);
};
const markAsked = (row, step) => {
  const steps = stepsOf(row);
  if (!steps) return step === "gap" ? row.basis : `${row.basis}|${step}`;
  if (askedBy(row, step)) return row.aiAskedBasis;
  return `${row.aiAskedBasis}|${step === "gap" ? "G" : step}`;
};
export const CHECKABLE = ["review", "ready", "generated", "partially_failed"];
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
  // tier C (plan.md §15.5): each matched product's linked catalogue block — that block only, the company's own
  const blockIds = [...new Set(items.map((it) => it.product?.catalogueRef?.blockId).filter(Boolean))];
  const blocks = blockIds.length ? await prisma.catalogueBlock.findMany({ where: { id: { in: blockIds }, companyId: invoice.companyId, kind: "product" } }) : [];
  const settings = await getAiSettings(invoice.companyId);
  // item 3: each matched product's certificate profile (the company's own rows only)
  const profiles = settings.rememberProductValues ? await loadProfiles(invoice.companyId, items.map((it) => it.product?.id)) : new Map();
  // item 4: lab results already confirmed for these lines' (product, batch number) pairs
  const batchResults = await loadBatchResults(invoice.companyId, items.filter((it) => it.product));
  return { batchResults, plan, items, versions: new Map(versions.map((v) => [v.id, v])), fields, company, invoiceBrand, pathSynonyms: pathSynonymMap(dict.entries), dictEntries: dict.entries, blocks: new Map(blocks.map((b) => [b.id, b])), settings, profiles };
}

/** A verified (quoted) value: filled directly, or waiting for a person when the company turned direct filling off. */
const directStatus = (settings, fallback) => (settings?.fillVerifiedDirectly !== false ? "resolved_ai" : fallback);
const direct = (settings) => settings?.fillVerifiedDirectly !== false;
const blockOf = (ctx, product) => (product?.catalogueRef?.blockId ? ctx.blocks?.get(product.catalogueRef.blockId) || null : null);

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
  // an unconfirmed estimated product value is not a value until a person signs for it (A6)
  c.lines = lines.map((l) => ({ ...(l.data || {}), product: maskEstimates(l.product) || {} }));
  if (entry.scope === "per_product") {
    const line = lines[0];
    c.item = line?.data || {};
    if (line?.product) {
      c.product = maskEstimates(line.product);
      c.brand = line.product.brand || null;
    }
  } else c.brand = ctx.versions.get(entry.templateVersionId)?.template?.brand || ctx.invoiceBrand || null;
  return c;
}

// ── lab results (item 4, owner 2026-10-26) ───────────────────────────────────
// A field marked lab result is NEVER filled by inference or the web, on any path: not by
// the inference / web tiers (policy), not by an estimate on the product, not by a product
// value that inference or the web put there, even one a person confirmed later.
const inferredOrigin = (p) => !!p && (["I", "W"].includes(p.tier) || p.estimated === true || ["web", "product_estimate"].includes(p.kind));
export const fromInferenceOrWeb = (p) => inferredOrigin(p) || inferredOrigin(p?.from);

/** A lab-result field's code value read from a product path that inference or the web filled → not a value. */
function guardLabResult(field, r, rawProduct) {
  if (!isLabResult(field) || r.resolved === "" || field.source?.kind !== "product" || !rawProduct) return r;
  const prov = provenanceFor(rawProduct, canonicalFull(fromSource(field.source)));
  return inferredOrigin(prov) ? { ...r, resolved: "", refused: true } : r;
}

/**
 * "Show the specification instead": the field prints what its specification field
 * holds and never asks for a result. → the need it mirrors, or null (it stays missing)
 * — never a specification inference or the web produced.
 */
function specMirror(field, specRow) {
  if (!specRow || specRow.value === null) return null;
  if (!["resolved", ...USABLE].includes(specRow.status) || fromInferenceOrWeb(specRow.provenance)) return null;
  return { status: "reused", value: specRow.value, provenance: { kind: "spec_instead", specFieldKey: field.specFieldKey, from: specRow.provenance } };
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
    const item = itemId ? ctx.items.find((i) => i.id === itemId) : null;
    // a field showing its specification follows that field, so it is computed after the others
    const versionFields = ctx.fields.get(entry.templateVersionId) || [];
    const entryRows = new Map(); // fieldKey → this entry's row
    for (const field of [...versionFields.filter((f) => !f.showSpecInstead), ...versionFields.filter((f) => f.showSpecInstead)]) {
      const key = `${entry.planKey}|${field.key}`;
      keep.add(key);
      const r = guardLabResult(field, resolveField(field, rctx), item?.product);
      const basis = sha16(stableStringify({ source: field.source, required: field.required, productId: entry.productId, itemId, category: field.dataCategory }));
      const prev = byKey.get(key);
      let code = r.resolved !== ""
        ? { status: "resolved", value: r.resolved, provenance: codeProvenance(field, r) }
        : { status: field.required ? "missing" : "not_applicable", value: null, provenance: null };
      if (r.resolved === "" && field.showSpecInstead) {
        // refused: the specification on the product came from inference / the web → not printed as a result
        if (!r.refused) code = specMirror(field, entryRows.get(field.specFieldKey)) || code;
      } else if (r.resolved === "") {
        const offer = codeOffer(field, entry, ctx, rctx);
        const seen = { basis, aiAskedBasis: prev && prev.basis === basis ? prev.aiAskedBasis : null };
        // item 4: a lab result of the same product + batch, confirmed before (a person or a verified supplier COA)
        const batchHit = item ? batchValue(ctx.batchResults, item, field) : null;
        // item 3: the product's certificate profile — proven or confirmed before, so nobody and no AI is asked again
        const saved = !batchHit && entry.productId ? profileValue(ctx.profiles, entry.productId, field) : null;
        if (batchHit) code = { status: "reused", value: storedValue(field, batchHit.value), provenance: reusedProvenance(batchHit) };
        else if (saved) code = { status: "reused", value: storedValue(field, saved.value), provenance: { kind: "profile", profileId: saved.id, estimated: saved.estimated, confirmedByUserId: saved.confirmedByUserId, confirmedAt: saved.confirmedAt, from: saved.provenance } };
        else if (offer && !askedBy(seen, offer.step)) {
          code = { status: offer.status, value: storedValue(field, offer.value), provenance: offer.provenance, aiAskedBasis: markAsked(seen, offer.step) };
          if (offer.status === "resolved_ai") await rememberValue({ companyId: invoice.companyId, productId: entry.productId, field, value: offer.value, provenance: offer.provenance, invoiceId: invoice.id });
        }
      }
      let data;
      if (prev && prev.basis === basis) {
        if (prev.status === "provided") data = {}; // a person's value stands
        else if (["resolved", "reused"].includes(code.status)) data = { ...code, suggestionId: null, aiAskedBasis: null }; // closed by code: if it reopens, it is a new gap
        else if (AI_VALUE.includes(prev.status)) data = {}; // a verified AI value stands until decided
        else data = code;
      } else data = { aiAskedBasis: null, suggestionId: null, decidedByUserId: null, decidedAt: null, ...code };
      const base = { label: field.label, category: field.dataCategory || null, required: field.required, templateVersionId: entry.templateVersionId, invoiceItemId: itemId, productId: entry.productId, basis };
      const row = prev
        ? await prisma.certificateDataNeed.update({ where: { id: prev.id }, data: { ...base, ...data } })
        : await prisma.certificateDataNeed.upsert({
            // upsert, not create: a concurrent check on another API process may have just written it
            where: { invoiceId_planKey_fieldKey: { invoiceId: invoice.id, planKey: entry.planKey, fieldKey: field.key } },
            create: { companyId: invoice.companyId, invoiceId: invoice.id, planKey: entry.planKey, fieldKey: field.key, ...base, ...code },
            update: {},
          });
      entryRows.set(field.key, row);
      out.push({ row, field, entry });
    }
  }
  const stale = existing.filter((n) => !keep.has(`${n.planKey}|${n.fieldKey}`)).map((n) => n.id);
  if (stale.length) await prisma.certificateDataNeed.deleteMany({ where: { id: { in: stale } } });
  return out;
}

/**
 * What code can offer for a field its source left empty (A6, no AI), in the
 * owner's order DB path → invoice → catalogue → inference → web:
 *  - an ESTIMATED value already on the product (tier I, status inferred): it is
 *    the product's data, but a person must sign for it before any certificate uses it;
 *  - else the product's own catalogue block (tier C, status catalogue_found): the
 *    section the field names, a verbatim slice verified against that block only.
 * Never for batch data / results / invoice values (allowsCatalogue — the hard line).
 * → { status, value, provenance, step } | null
 */
function codeOffer(field, entry, ctx, rctx) {
  if (entry.scope !== "per_product") return null;
  // item 4: never an estimate (or a catalogue value) for a lab result
  if (isLabResult(field)) return null;
  const raw = ctx.items.find((i) => i.id === entry.invoiceItemIds[0])?.product;
  if (!raw) return null;
  if (field.source?.kind === "product") {
    const unmasked = resolveField(field, { ...rctx, product: raw });
    const path = canonicalFull(fromSource(field.source));
    const prov = unmasked.resolved !== "" ? provenanceFor(raw, path) : null;
    if (prov && isUnconfirmedEstimate(prov)) {
      const { path: p, estimated, basis, modelId, promptHash, at } = prov;
      return { status: "inferred", value: unmasked.resolved, step: "E", provenance: { tier: "I", kind: "product_estimate", estimated, path: p, basis, modelId, promptHash, at } };
    }
  }
  if (!allowsCatalogue(field)) return null;
  const block = blockOf(ctx, raw);
  const hit = block ? findCatalogueValue(field, block) : null;
  const ok = hit ? verifyBlockQuote(block, hit.quote, hit.value) : null;
  if (!ok?.ok) return null;
  // the product's own catalogue, quoted verbatim: filled directly (item 3) unless the company turned that off
  return {
    status: directStatus(ctx.settings, "catalogue_found"),
    value: hit.value,
    step: "C",
    provenance: { tier: "C", kind: "catalogue_text", via: "code", catalogueVersionId: block.versionId, blockId: block.id, page: block.page, section: hit.section, quote: ok.quote, ...(direct(ctx.settings) ? { filled: "direct" } : {}) },
  };
}

/** The AI step: one call for every missing need not asked with this basis before. */
async function fillGaps(invoice, ctx, rows, { generate, settings }) {
  const ai = { used: false, calls: 0, asked: 0, filled: 0, rejected: 0 };
  // a field printing its specification is never asked for (it follows its specification field)
  const open = rows.filter((x) => x.row.status === "missing" && !x.field.showSpecInstead && !askedBy(x.row, "gap"));
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
          products.set(ref, { product: item.product, emptyPaths: empty, nearMisses: [], block: blockOf(ctx, item.product) });
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
          ...(isLabResult(x.field) ? { labResult: true } : {}),
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
      return [
        g.gap.gapId,
        {
          textContent: invoice.textContent,
          scope: g.itemId ? "item" : "header",
          span: spanOf(item),
          otherSpans: allSpans,
          singleItem: activeItems.length === 1,
          product: g.product,
          // tier C: that product's block only, and only when every field of the gap may come from a catalogue
          catalogueBlock: blockOf(ctx, g.product),
          catalogueAllowed: g.needs.every((x) => allowsCatalogue(x.field)),
          // a lab result: the invoice text only (never the product, its text or its catalogue)
          labResult: g.needs.some((x) => isLabResult(x.field)),
        },
      ];
    })
  );
  let res;
  try {
    res = await askGaps({ companyId: invoice.companyId, invoiceId: invoice.id, textContent: invoice.textContent, payload, gapCtx }, { generate });
  } catch (err) {
    // P8: the check still works by hand; the gaps are asked again next time
    ai.unavailable = true;
    ai.reason = publicAiError(err);
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
        // item 3: a verified quote is filled directly (recorded as auto-accepted)
        direct(settings) ? { ...settings, autoAccept: true, autoAcceptThreshold: 0 } : settings
      );
      if (!verdict.verified) {
        await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: verdict.reason, checks: verdict.checks } } });
        if (answer.found) ai.rejected++;
      }
    }
    for (const x of g.needs) {
      const data = { aiAskedBasis: markAsked(x.row, "gap") };
      if (verdict.verified && suggestion) {
        const value = storedValue(x.field, verdict.value);
        const auto = suggestion.status === "auto_accepted";
        Object.assign(data, {
          status: auto ? "resolved_ai" : "needs_confirmation",
          value,
          provenance: { ...verdict.provenance, suggestionId: suggestion.id, confidence: answer.confidence, ...(answer.note ? { note: String(answer.note).slice(0, 200) } : {}), ...(auto && direct(settings) ? { filled: "direct" } : {}) },
          suggestionId: suggestion.id,
        });
        // a product fact proven by a quote: the product's profile keeps it for the next invoice
        if (auto && x.row.productId && profileAllowed(x.field)) await rememberValue({ companyId: invoice.companyId, productId: x.row.productId, field: x.field, value, provenance: data.provenance, invoiceId: invoice.id });
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

// ── A5 tier I: inference from the product's own data (plan.md §14.2) ─────────
async function inferProductFacts(invoice, ctx, rows, { generate, settings }) {
  const out = { used: false, calls: 0, asked: 0, inferred: 0, rejected: 0 };
  if (!aiAllowed(settings) || !settings.allowProductInference) return { ...out, off: true };
  const productOf = (row) => ctx.items.find((i) => i.id === row.invoiceItemId)?.product || null;
  const open = rows.filter((x) => x.row.status === "missing" && x.row.invoiceItemId && productOf(x.row) && allowsInference(x.field) && !askedBy(x.row, "I"));
  if (!open.length) return out;
  const groups = new Map();
  for (const x of open) {
    const product = productOf(x.row);
    const sig = `${product.id}|${normLabel(x.field.label)}|${stableStringify(x.field.source)}`;
    if (!groups.has(sig)) groups.set(sig, { gap: { gapId: `I${groups.size + 1}`, field: x.field, label: x.field.label, expectedType: isDateField(x.field) ? "date" : sourceType(x.field.source || { kind: "manual" }), ...(x.field.format?.date ? { dateFormat: x.field.format.date } : {}), product }, needs: [] });
    groups.get(sig).needs.push(x);
  }
  let res;
  try {
    res = await askInference({ companyId: invoice.companyId, invoiceId: invoice.id, gaps: [...groups.values()].map((g) => g.gap) }, { generate });
  } catch (err) {
    return { ...out, unavailable: true, reason: publicAiError(err) };
  }
  Object.assign(out, { used: true, calls: 1, asked: res.sent.length });
  for (const g of groups.values()) {
    const got = res.answers.get(g.gap.gapId);
    let suggestion = null;
    if (got) {
      // §14.4: always a person's decision, whatever the auto-accept setting
      suggestion = await recordSuggestion(
        { companyId: invoice.companyId, kind: "product_infer", entityType: "certificate_field", entityId: g.needs[0].row.id, proposal: { label: g.gap.label, needIds: g.needs.map((x) => x.row.id), answer: got.answer, verifiedValue: got.verdict.ok ? got.verdict.value : null }, evidence: got.answer.evidence || [], evidenceVerified: got.verdict.ok, confidence: got.answer.found ? got.answer.confidence : 0, modelKind: "CERT_PRODUCT_INFER", promptHash: res.run?.promptHash || "-", inputHash: res.inputHash, aiRunId: res.run?.id },
        { ...settings, autoAccept: false }
      );
      if (!got.verdict.ok) {
        await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: got.verdict.reason } } });
        if (got.answer.found) out.rejected++;
      }
    }
    for (const x of g.needs) {
      const data = { aiAskedBasis: markAsked(x.row, "I") };
      if (got?.verdict.ok) {
        // item 3: a quoted / code-reproduced value is a fact of the product → filled directly; an estimate waits for a person
        const fill = !got.verdict.estimated && direct(settings);
        const value = storedValue(x.field, got.verdict.value);
        const provenance = { ...got.verdict.provenance, suggestionId: suggestion.id, confidence: got.answer.confidence, ...(got.answer.reasoning ? { reasoning: got.answer.reasoning } : {}), ...(fill ? { filled: "direct" } : {}) };
        Object.assign(data, { status: fill ? "resolved_ai" : "inferred", value, provenance, suggestionId: suggestion.id });
        if (fill && x.row.productId) await rememberValue({ companyId: invoice.companyId, productId: x.row.productId, field: x.field, value, provenance, invoiceId: invoice.id });
      } else if (suggestion) data.suggestionId = suggestion.id;
      x.row = await prisma.certificateDataNeed.update({ where: { id: x.row.id }, data });
    }
    if (got?.verdict.ok) {
      out.inferred++;
      if (got.verdict.estimated) out.estimated = (out.estimated || 0) + 1;
    }
    if (got?.verdict.ok && !got.verdict.estimated && direct(settings) && suggestion) await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "auto_accepted" } });
  }
  return out;
}

async function computeNeedsNow(invoiceId, companyScope, { ai = true, generate, inferGenerate } = {}) {
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
    aiOut.inference = await inferProductFacts(invoice, ctx, rows, { generate: inferGenerate, settings });
  }
  return buildView(invoice, ctx, aiOut);
}

// ── A5 tier W: web lookup with verified citations (plan.md §14.3) ─────────────
/**
 * POST /invoices/:id/data-needs/web-lookup — only on a person's request from
 * the data check, never during upload (§14.4). ONE call per product for its
 * missing web-eligible facts; a fact looked up in the last 90 days comes from
 * the company's cache (0 calls). → the view, with ai.web
 * deps (tests): { search, fetchPage }
 */
export async function webLookupNeeds(invoiceId, companyScope, deps = {}) {
  return serialized(invoiceId, () => webLookupNow(invoiceId, companyScope, deps));
}

async function webLookupNow(invoiceId, companyScope, { search, fetchPage } = {}) {
  const invoice = await loadInvoice(invoiceId, companyScope);
  if (!CHECKABLE.includes(invoice.status)) throw new CertError("INVOICE_NOT_REVIEWED", `There is nothing to check for an invoice that is ${invoice.status}`, 409);
  const ctx = await loadContext(invoice);
  const settings = await getAiSettings(invoice.companyId);
  const web = { used: false, calls: 0, fromCache: 0, found: 0, rejected: 0, products: 0 };
  if (!aiAllowed(settings) || !settings.allowWebLookup) {
    web.unavailable = true;
    web.reason = settings.enabled ? "Web lookup is turned off for this company" : "AI is turned off for this company";
    return buildView(invoice, ctx, { web });
  }
  const rows = await computeCode(invoice, ctx);
  const productOf = (row) => ctx.items.find((i) => i.id === row.invoiceItemId)?.product || null;
  const open = rows.filter((x) => x.row.status === "missing" && x.row.invoiceItemId && productOf(x.row) && allowsWeb(x.field) && !askedBy(x.row, "W"));
  const byProduct = new Map();
  for (const x of open) {
    const p = productOf(x.row);
    if (!byProduct.has(p.id)) byProduct.set(p.id, { product: p, labels: new Map() });
    const k = normLabel(x.field.label);
    const b = byProduct.get(p.id);
    if (!b.labels.has(k)) b.labels.set(k, { label: x.field.label, labelNorm: k, field: x.field, needs: [] });
    b.labels.get(k).needs.push(x);
  }
  // item 3: the manufacturer's own page or an official registry, about this product, quoted
  // verbatim → filled directly; a distributor's or an allow-listed page → filled, marked
  // estimated, a person confirms. The product's profile keeps a directly filled value.
  const OWN_SOURCES = ["manufacturer", "official_registry"];
  const apply = async (entry, product, verdictValue, provenance, suggestionId) => {
    const fill = verdictValue !== null && OWN_SOURCES.includes(provenance?.sourceType) && direct(settings);
    const prov = verdictValue === null ? null : { ...provenance, ...(fill ? { filled: "direct" } : { estimated: true, estimateBasis: `a ${String(provenance?.sourceType || "third-party").replace(/_/g, " ")} page, not the manufacturer's` }) };
    for (const x of entry.needs) {
      const data = { aiAskedBasis: markAsked(x.row, "W") };
      if (verdictValue !== null) Object.assign(data, { status: fill ? "resolved_ai" : "web_found", value: storedValue(x.field, verdictValue), provenance: prov, suggestionId });
      x.row = await prisma.certificateDataNeed.update({ where: { id: x.row.id }, data });
    }
    if (fill) await rememberValue({ companyId: invoice.companyId, productId: product.id, field: entry.field, value: verdictValue, provenance: prov, invoiceId: invoice.id });
    return fill;
  };
  // cost limits (item 3): products asked per check, and calls per company per day (UTC)
  const dayStart = new Date(new Date().toISOString().slice(0, 10));
  let callsToday = await prisma.aiRun.count({ where: { companyId: invoice.companyId, kind: "CERT_WEB_LOOKUP", outcome: { in: ["ok", "failed"] }, createdAt: { gte: dayStart } } });
  let asked = 0;
  for (const { product, labels } of byProduct.values()) {
    web.products++;
    const ask = [];
    for (const entry of labels.values()) {
      const cached = await cachedFact(invoice.companyId, product.id, entry.labelNorm);
      if (!cached) {
        ask.push(entry);
        continue;
      }
      web.fromCache++;
      const c = cached.citations?.[0];
      const filled = await apply(entry, product, cached.payload?.found ? cached.payload.value : null, cached.payload?.found ? { tier: "W", kind: "web", citations: cached.citations, sourceType: c?.sourceType || cached.sourceType, ...(c?.warning ? { warning: c.warning } : {}), cacheId: cached.id, fromCache: true } : null, null);
      if (cached.payload?.found) web.found++;
      if (filled) web.filled = (web.filled || 0) + 1;
    }
    if (!ask.length) continue;
    if (asked >= settings.webLookupMaxProductsPerCheck || callsToday >= settings.webLookupDailyLimit) {
      web.limited = (web.limited || 0) + 1;
      web.limitReason = callsToday >= settings.webLookupDailyLimit ? `the company's daily web lookup limit (${settings.webLookupDailyLimit}) is reached` : `at most ${settings.webLookupMaxProductsPerCheck} product(s) are looked up per check`;
      continue;
    }
    asked++;
    callsToday++;
    let res;
    try {
      res = await lookupProduct({ companyId: invoice.companyId, invoiceId: invoice.id, product, fields: ask, allowList: settings.webDomainAllowList }, { search, fetchPage });
    } catch (err) {
      // P8: by hand; asked again next time
      web.unavailable = true;
      web.reason = publicAiError(err);
      continue;
    }
    web.used = true;
    web.calls++;
    for (const entry of ask) {
      const { answer, verdict } = res.results.get(entry.labelNorm);
      const cache = await storeFact(invoice.companyId, product.id, entry.labelNorm, verdict.ok ? { found: true, value: verdict.value, citation: verdict.citation, label: entry.label } : { found: false, label: entry.label, reason: verdict.reason });
      let suggestion = null;
      if (answer) {
        suggestion = await recordSuggestion(
          { companyId: invoice.companyId, kind: "web_lookup", entityType: "certificate_field", entityId: entry.needs[0].row.id, proposal: { label: entry.label, needIds: entry.needs.map((x) => x.row.id), query: res.query, answer, verifiedValue: verdict.ok ? verdict.value : null, checks: verdict.checks }, evidence: answer.citations || [], evidenceVerified: verdict.ok, confidence: answer.found ? answer.confidence : 0, modelKind: "CERT_WEB_LOOKUP", promptHash: res.run?.promptHash || "-", inputHash: res.run?.inputHash || "-", aiRunId: res.run?.id },
          { ...settings, autoAccept: false }
        );
        if (!verdict.ok) {
          await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "rejected", finalValue: { reason: verdict.reason, checks: verdict.checks } } });
          if (answer.found) web.rejected++;
        }
      }
      const filled = await apply(entry, product, verdict.ok ? verdict.value : null, verdict.ok ? { tier: "W", kind: "web", citations: [verdict.citation], sourceType: verdict.citation.sourceType, ...(verdict.citation.warning ? { warning: verdict.citation.warning } : {}), cacheId: cache.id, suggestionId: suggestion?.id, confidence: answer?.confidence ?? null } : null, verdict.ok ? suggestion?.id ?? null : null);
      if (verdict.ok) web.found++;
      if (filled) {
        web.filled = (web.filled || 0) + 1;
        if (suggestion) await prisma.aiSuggestion.update({ where: { id: suggestion.id }, data: { status: "auto_accepted" } });
      }
    }
  }
  return buildView(invoice, ctx, { web });
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

/**
 * Code-only recheck after values were written outside a check (results grid, supplier COA):
 * batch results are re-read, so every line of a batch gets them. No AI. → the view
 */
export async function recheckCode(invoiceId, companyScope) {
  return serialized(invoiceId, async () => {
    const invoice = await loadInvoice(invoiceId, companyScope);
    const ctx = await loadContext(invoice);
    await computeCode(invoice, ctx);
    return buildView(invoice, ctx);
  });
}

/** → { missing, needsConfirmation } counts of required needs that block generation. */
export async function blockingCounts(invoiceId) {
  const rows = await prisma.certificateDataNeed.groupBy({ by: ["status"], where: { invoiceId, required: true, status: { in: BLOCKING } }, _count: { _all: true } });
  const n = (st) => rows.find((r) => r.status === st)?._count._all || 0;
  return { missing: n("missing"), needsConfirmation: AWAITING.reduce((a, st) => a + n(st), 0) };
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
    return { id: r.id, fieldKey: r.fieldKey, label: r.label, category: r.category, required: r.required, status: r.status, value: r.value, display, provenance: r.provenance, suggestionId: r.suggestionId, decidedAt: r.decidedAt, estimated: r.provenance?.estimated === true, labResult: isLabResult(f), ...(f?.showSpecInstead ? { showsSpecification: true, specFieldKey: f.specFieldKey } : {}) };
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
  for (const r of rows.filter((x) => x.invoiceItemId && (x.category === "batch_data" || isLabResult(fieldFor(x))) && !fieldFor(x)?.showSpecInstead)) {
    const item = itemById.get(r.invoiceItemId);
    if (!batch.has(r.invoiceItemId)) batch.set(r.invoiceItemId, { invoiceItemId: r.invoiceItemId, lineNo: item?.lineNo ?? null, productName: item?.product?.name || item?.data?.name || null, batchNo: item?.data?.batchNo || null, noBatch: !batchOf(item), fields: new Map() });
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
  // item 4: a line whose lab results can't be kept for its batch (nothing to key them by)
  const warnings = batchData.filter((b) => b.noBatch).map((b) => ({ code: "NO_BATCH_NUMBER", invoiceItemId: b.invoiceItemId, lineNo: b.lineNo, message: `Line ${b.lineNo ?? "?"}: no batch number — results can't be reused` }));
  const count = (s) => rows.filter((r) => r.status === s).length;
  const blocking = rows.filter((r) => r.required && BLOCKING.includes(r.status)).length;
  // A5: what the panel may offer (web lookup only on request, only where policy allows)
  const settings = await getAiSettings(invoice.companyId);
  const fieldOf = (r) => (ctx.fields.get(r.templateVersionId) || []).find((f) => f.key === r.fieldKey);
  const webEligible = rows.filter((r) => r.status === "missing" && r.invoiceItemId && fieldOf(r) && allowsWeb(fieldOf(r)) && !askedBy(r, "W")).length;
  return {
    summary: {
      certificates: certificates.length,
      values: rows.length,
      ready: count("resolved") + count("resolved_ai") + count("provided") + count("reused"),
      reused: count("reused"),
      filledDirectly: rows.filter((r) => r.status === "resolved_ai" && r.provenance?.filled === "direct").length,
      estimated: rows.filter((r) => AWAITING.includes(r.status) && r.provenance?.estimated === true).length,
      resolved: count("resolved"),
      resolvedAi: count("resolved_ai"),
      provided: count("provided"),
      needsConfirmation: count("needs_confirmation") + count("inferred") + count("web_found") + count("catalogue_found"),
      inferred: count("inferred"),
      webFound: count("web_found"),
      catalogueFound: count("catalogue_found"),
      missing: count("missing"),
      notApplicable: count("not_applicable"),
      blocking,
    },
    tiers: { inference: aiAllowed(settings) && settings.allowProductInference, web: aiAllowed(settings) && settings.allowWebLookup, webEligible },
    certificates,
    batchData,
    warnings,
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

// ── product provenance (A6) ──────────────────────────────────────────────────
async function recordFieldProvenance(productId, companyId, path, entry) {
  const p = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true, fieldProvenance: true } });
  if (!p) throw notFound("Product");
  const { tier, kind, catalogueVersionId, blockId, page, quote, section, confirmedByUserId, confirmedAt } = entry;
  await prisma.product.update({ where: { id: p.id }, data: { fieldProvenance: { ...(p.fieldProvenance || {}), [path]: { tier, kind, catalogueVersionId, blockId, page, quote, section, at: new Date().toISOString(), confirmedByUserId, confirmedAt } } } });
}

async function confirmEstimate(productId, companyId, path, userId) {
  const p = await prisma.product.findFirst({ where: { id: productId, companyId }, select: { id: true, fieldProvenance: true } });
  if (!p) throw notFound("Product");
  const fp = p.fieldProvenance || {};
  if (!fp[path]) throw new CertError("CANNOT_SAVE_TO_PRODUCT", "This product value is no longer an estimate", 409);
  await prisma.product.update({ where: { id: p.id }, data: { fieldProvenance: { ...fp, [path]: { ...fp[path], confirmedByUserId: userId, confirmedAt: new Date().toISOString() } } } });
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
  // "Confirm all" (item 3): every value of the invoice still waiting for a person, accepted as it is
  const expanded = decisions.flatMap((d) => (d.action === "confirm_all" ? all.filter((n) => AWAITING.includes(n.status) && n.value !== null).map((n) => ({ needId: n.id, action: "accept" })) : [d]));
  // a person's value is the product's from now on (its certificate profile), unless it is per batch / per invoice
  const remember = async (n, value, provenance, estimated = false) => {
    // a field printing its specification keeps nothing: it is not a result, and not a product fact of its own
    if (fieldFor(n).showSpecInstead) return null;
    // item 4: a person's lab result belongs to the line's batch (reused on every line / invoice of it)
    if (isLabResult(fieldFor(n)) && n.invoiceItemId) {
      const item = ctx.items.find((i) => i.id === n.invoiceItemId);
      const prov = { kind: "manual", via: "data_check", invoiceId: invoice.id, invoiceNumber: invoice.header?.invoiceNumber || null, ...(provenance?.kind === "supplier_coa" ? { from: provenance } : {}) };
      return rememberBatchResult({ companyId: invoice.companyId, item, field: fieldFor(n), value, source: "manual", provenance: prov, userId: userId || "person", invoiceId: invoice.id });
    }
    return n.productId ? rememberValue({ companyId: invoice.companyId, productId: n.productId, field: fieldFor(n), value, provenance, estimated, userId: userId || "person", invoiceId: invoice.id }) : null;
  };
  for (const d of expanded) {
    const need = byId.get(d.needId);
    if (!need) throw notFound("Data need");
    switch (d.action) {
      case "accept": {
        if (!AI_VALUE.includes(need.status)) throw new CertError("NOTHING_TO_ACCEPT", `“${need.label}” has no AI value waiting for confirmation`, 409);
        // A5 §14.4 "save to product": the confirmed tier I/W value becomes product data, so the next invoice reads it by code
        let savedTo = null;
        if (d.saveToProduct) {
          const field = fieldFor(need);
          if (!["inferred", "web_found", "catalogue_found"].includes(need.status) || field.source?.kind !== "product" || !need.productId) throw new CertError("CANNOT_SAVE_TO_PRODUCT", `“${need.label}” isn't a product fact found in the catalogue, by inference or on the web`, 409);
          savedTo = canonicalFull(fromSource(field.source)).slice("product.".length);
          if (need.provenance?.kind === "product_estimate") {
            // the value already is the product's: the person signs for the estimate there (A6)
            await confirmEstimate(need.productId, invoice.companyId, need.provenance.path || savedTo, userId);
          } else {
            await saveProductData(need.productId, invoice.companyId, { values: { [savedTo]: need.value } });
            // item 4: the product keeps where the value came from (catalogue, inference or the web), so a
            // lab result never takes an inferred / web value from the product later
            await recordFieldProvenance(need.productId, invoice.companyId, savedTo, { ...need.provenance, tier: need.provenance?.tier || { inferred: "I", web_found: "W", catalogue_found: "C" }[need.status], confirmedByUserId: userId, confirmedAt: now.toISOString() });
          }
        }
        await prisma.certificateDataNeed.update({ where: { id: need.id }, data: { status: "resolved_ai", decidedByUserId: userId, decidedAt: now, ...(savedTo ? { provenance: { ...(need.provenance || {}), savedToProduct: savedTo } } : {}) } });
        await remember(need, need.value, need.provenance || { kind: "accepted" }, need.provenance?.estimated === true || ["inferred", "web_found"].includes(need.status));
        if (need.suggestionId) await decideSuggestion(invoice.companyId, need.suggestionId, { decision: "accepted", finalValue: { value: need.value, ...(savedTo ? { savedToProduct: savedTo } : {}) }, userId });
        if (need.provenance?.cacheId) await prisma.externalKnowledgeCache.updateMany({ where: { id: need.provenance.cacheId, kind: CACHE_KIND }, data: { status: "approved", reviewedByUserId: userId } });
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
          await remember(n, value, { kind: "manual", invoiceId: invoice.id });
          if (n.suggestionId && AI_VALUE.includes(n.status)) await decideSuggestion(invoice.companyId, n.suggestionId, { decision: n.value === value ? "accepted" : "edited", finalValue: { value }, userId });
        }
        break;
      }
      case "reject": {
        if (!AI_VALUE.includes(need.status)) throw new CertError("NOTHING_TO_REJECT", `“${need.label}” has no AI value to reject`, 409);
        await prisma.certificateDataNeed.update({ where: { id: need.id }, data: { status: need.required ? "missing" : "not_applicable", value: null, provenance: null, decidedByUserId: userId, decidedAt: now } });
        if (need.suggestionId) await decideSuggestion(invoice.companyId, need.suggestionId, { decision: "rejected", userId });
        // a rejected web fact is not served from the cache again
        if (need.provenance?.cacheId) await prisma.externalKnowledgeCache.updateMany({ where: { id: need.provenance.cacheId, kind: CACHE_KIND }, data: { status: "rejected", reviewedByUserId: userId } });
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
