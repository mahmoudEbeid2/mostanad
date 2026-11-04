import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import { createProduct } from "../../productService.js";
import { same } from "../../catalogues/fieldProvenance.js";
import { publicAiError } from "../../ai/aiErrorMessage.js";
import { scheduleDictionaryRebuild } from "../dictionary/rebuildScheduler.js";
import { selectTemplates } from "../generation/templateSelector.js";
import { selectorInvoice, usableTemplates } from "../generation/planService.js";
import { listFields, listGroups } from "../templates/fieldService.js";
import { canonicalFull, parse, resolveRelative } from "../paths/sourcePath.js";
import { classifyPath, productPathsOf, setIn } from "../insights/productNeeds.js";
import { productJsonColumns } from "../templates/sourceCatalogue.js";
import { matchInvoice, matchLine, normalizeName } from "../matching/productMatcher.js";
import { confirmAlias } from "../matching/productAliases.js";
import { getAiSettings, aiAllowed } from "../ai/aiSettings.js";
import { recordSuggestion, decideSuggestion } from "../ai/aiSuggestions.js";
import { askInference } from "../inference/productInference.js";
import { allowsInference, isBatchFact, isLabResult } from "../inference/policy.js";
import { refreshIfChecked } from "../dataNeeds/dataNeedsService.js";
import { assertEditable, EDITABLE, loadItem, matchSummaryOf, reopen } from "./invoiceService.js";

// A product created from an unmatched invoice line (mockup D2). The draft is code only: what the
// line says, and which product values the certificates of THIS line will read: its selected
// templates' fields, through the same path reading as the product completeness check. "Suggest
// with AI" is the product inference (tier I) on the draft's own text, always marked estimated,
// and stored nowhere until the person creates the product. A value kept as suggested goes on the
// product as an unconfirmed estimate, so the data check asks a person to sign for it before any
// certificate uses it. Lab results and batch facts are never asked for: they stay on the line.

// Every product field the form offers, in the order of the full form.
const FORM = [
  ["productCode", "Product code"],
  ["packaging", "Packaging"],
  ["brand.name", "Brand", "brand"],
  ["category.name", "Category", "category"],
  ["description", "Description", "long"],
  ["indications", "Indications", "long"],
  ["targetSpecies", "Target species", "tags"],
  ["physicalForm", "Physical form"],
  ["dosageForm", "Dosage form"],
  ["appearance", "Appearance"],
  ["activeIngredients", "Composition / active ingredients", "ingredients"],
  ["strength", "Strength"],
  ["dosage", "Dosage", "long"],
  ["routeOfAdmin", "Route of administration"],
  ["mixingInstructions", "Mixing instructions", "long"],
  ["withdrawalPeriod", "Withdrawal period"],
  ["contraindications", "Contraindications", "long"],
  ["userSafety", "User safety", "tags"],
  ["storage", "Storage", "long"],
  ["origin", "Country of origin"],
  ["producer", "Manufacturer"],
  ["productType", "Product type"],
  ["prescriptionStatus", "Prescription status"],
  ["registrationNumber", "Registration number"],
  ["specifications", "Specifications", "specs"],
].map(([path, label, input = "text"]) => ({ path, label, input }));
const FORM_BY_PATH = new Map(FORM.map((f) => [f.path, f]));
// the identity of the product and the two relations are chosen by a person; a registration number comes only from the official registry
const NOT_SUGGESTED = new Set(["name", "productCode", "brand.name", "category.name", "registrationNumber", "specifications"]);
const EXPECTED_TYPE = { ingredients: 'ingredient list, written "Name: amount; Name: amount"', tags: "comma-separated list" };

// 1L, 500 ml, 25KG, 1L x12, 12 x 1L, x12
const UNIT = String.raw`(?:ml|cc|lt?r?|litres?|liters?|kgs?|gms?|gr|g|mg)`;
const PACK_RE = new RegExp(String.raw`\b\d+\s*[x×*]\s*\d+(?:[.,]\d+)?\s*${UNIT}\b|\b\d+(?:[.,]\d+)?\s*${UNIT}\b(?:\s*[x×*]\s*\d+\b)?|(?<![\p{L}\p{N}])[x×*]\s*\d+\b`, "giu");

/** "MULTIVIT AD3E FORTE 1L x12" → { name: "MULTIVIT AD3E FORTE", pack: "1L x12" } */
export function splitPackSize(text) {
  const raw = String(text || "").trim();
  const packs = raw.match(PACK_RE) || [];
  const name = raw.replace(PACK_RE, " ").replace(/\s+/g, " ").replace(/[\s,;:·-]+$/, "").trim();
  return { name: name.length >= 2 ? name : raw, pack: packs.join(" ") || null };
}

/** A product path a template reads → the one input that fills it, or null when no product field does. */
function formPath(full) {
  const canon = canonicalFull(full);
  const p = canon ? parse(canon) : null;
  if (!p?.ok || !["product", "brand"].includes(p.root)) return null;
  if (p.root === "brand") return "brand.name";
  const column = p.segments[0]?.k;
  if (column === "brand" || column === "category") return `${column}.name`;
  const c = classifyPath(canon);
  if (c) return c.kind === "list" ? c.collection : c.rel;
  return column === "name" || FORM_BY_PATH.has(column) ? column : null;
}

const inputOf = (path) => FORM_BY_PATH.get(path)?.input || "text";

/** Where a field's value comes from when it isn't the product: the modal never asks for it. */
function comesFrom(field) {
  if (isLabResult(field)) return "results grid";
  if (isBatchFact(field)) return "invoice line";
  if (field.source?.kind === "item" || field.dataCategory === "invoice_line") return "invoice line";
  if (field.source?.kind === "invoice" || field.dataCategory === "invoice_header") return "invoice header";
  return null;
}

/** The fields of one plan entry that can read a product, cells of a list of invoice lines included. */
async function readersOf(entry) {
  const [fields, groups] = await Promise.all([listFields(entry.templateVersionId), listGroups(entry.templateVersionId)]);
  const out = entry.scope === "per_product" ? fields.filter((f) => !f.groupKey).map((field) => ({ field, label: field.label, required: field.required, paths: productPathsOf(field.source) })) : [];
  for (const g of groups) {
    const cells = fields.filter((f) => f.groupKey === g.key);
    if (g.source?.kind === "product_list" && entry.scope === "per_product") out.push({ field: { label: g.label, source: { kind: "product", path: g.source.path }, dataCategory: "product_data" }, label: g.label, required: g.required, paths: [`product.${g.source.path}`] });
    if (g.source?.kind !== "invoice_lines") continue;
    for (const cell of cells) {
      if (cell.source?.kind !== "row") continue;
      const required = g.required || cell.required;
      const path = String(cell.source.path);
      // a cell reading the product is that product value; the rest of the row is the line's
      if (path.startsWith("product.")) out.push({ field: { ...cell, groupKey: null, source: { kind: "product", path: path.slice("product.".length) } }, label: cell.label, required, paths: [path] });
      else out.push({ field: cell, label: cell.label, required, paths: [], from: "invoice line" });
    }
  }
  return out;
}

/** What this line's certificates read → { neededFields (with their template fields), notAsked, typeCodes } */
async function lineNeeds(invoice, item, brandId) {
  const line = { ...item, matchStatus: "matched", productId: item.id, product: { id: item.id, name: item.data?.name || null, brandId } };
  const plan = selectTemplates({ invoice: selectorInvoice(invoice), items: [line], templates: await usableTemplates(invoice) });
  const needed = new Map();
  const notAsked = new Map();
  // the plan's order follows ids; this one is shown
  const entries = [...plan.entries].sort((a, b) => String(a.typeCode).localeCompare(String(b.typeCode)));
  for (const entry of entries) {
    for (const r of await readersOf(entry)) {
      const from = r.from || comesFrom(r.field);
      if (from) {
        notAsked.set(r.label, { label: r.label, from });
        continue;
      }
      for (const full of r.paths) {
        const path = formPath(full);
        if (!path) continue;
        if (!needed.has(path)) needed.set(path, { path, label: r.label, input: inputOf(path), types: [], required: false, fields: [] });
        const n = needed.get(path);
        if (entry.typeCode && !n.types.includes(entry.typeCode)) n.types.push(entry.typeCode);
        n.required ||= !!r.required;
        n.fields.push(r.field);
      }
    }
  }
  return { needed: [...needed.values()], notAsked: [...notAsked.values()], planned: plan.entries.length, typeCodes: [...new Set(entries.map((e) => e.typeCode).filter(Boolean))] };
}

const brandHintOf = (item) => Object.entries(item.data?.extra || {}).find(([k]) => /^brand$/i.test(k))?.[1] || null;

/** What the invoice says about the product → { name, productCode, packaging, brandId, brandName } */
async function linePrefill(invoice, item) {
  const { name, pack } = splitPackSize(item.data?.name);
  const brands = await prisma.brand.findMany({ where: { companyId: invoice.companyId }, select: { id: true, name: true } });
  const hint = brandHintOf(item);
  const brand = (hint && brands.find((b) => normalizeName(b.name) === normalizeName(hint))) || brands.find((b) => b.id === invoice.brandId) || null;
  return { name, productCode: item.data?.code || null, packaging: item.data?.packing || pack, brandId: brand?.id || null, brandName: brand?.name || null };
}

async function similarProducts(invoice, item) {
  const products = await prisma.product.findMany({ where: { companyId: invoice.companyId }, select: { id: true, name: true, productCode: true, brandId: true } });
  const m = matchLine(item.data || {}, products, { brandId: invoice.brandId });
  if (m.productId) {
    const p = products.find((x) => x.id === m.productId);
    return [{ productId: p.id, name: p.name, code: p.productCode || null, score: 1 }];
  }
  return (m.matchCandidates || []).slice(0, 3).map(({ productId, name, code, score }) => ({ productId, name, code, score }));
}

async function buildDraft(invoice, item) {
  const prefill = await linePrefill(invoice, item);
  const needs = await lineNeeds(invoice, item, prefill.brandId);
  return { prefill, ...needs };
}

/** GET /invoices/:id/items/:itemId/new-product-draft */
export async function newProductDraft(invoiceId, itemId, companyId) {
  const { inv, item } = await loadItem(invoiceId, itemId, companyId);
  const [draft, similar, company] = await Promise.all([buildDraft(inv, item), similarProducts(inv, item), prisma.company.findUnique({ where: { id: inv.companyId }, select: { name: true } })]);
  return {
    lineNo: item.lineNo,
    invoiceText: item.data?.name || null,
    companyName: company?.name || null,
    prefill: draft.prefill,
    neededFields: draft.needed.map(({ fields: _fields, ...n }) => n),
    notAsked: draft.notAsked,
    typeCodes: draft.typeCodes,
    noCertificate: draft.planned ? null : "No active template applies to this line, so it gets no certificate.",
    similar,
    fullFields: FORM,
  };
}

function assertOpenLine(item) {
  if (item.matchStatus !== "needs_match") throw new CertError("LINE_NOT_OPEN", `Line ${item.lineNo} is already ${item.matchStatus === "ignored" ? "ignored" : "matched"}`, 409);
}

// ── AI suggestions ───────────────────────────────────────────────────────────
const parseIngredients = (text) =>
  String(text)
    .split(/[;\n]+/)
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const at = row.lastIndexOf(":");
      return at > 0 ? { name: row.slice(0, at).trim(), concentration: row.slice(at + 1).trim() } : { name: row, concentration: "" };
    });
const parseTags = (text) =>
  String(text)
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
const formValue = (input, text) => (input === "ingredients" ? parseIngredients(text) : input === "tags" ? parseTags(text) : text);

const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const valueAt = (record, path) => {
  const r = resolveRelative(record, path);
  return r.found ? r.value : undefined;
};

/** What the model reads: the line's text and what was typed so far, under the product's own field names. */
function draftRecord(item, prefill, values) {
  const allowed = new Set(["name", ...FORM.map((f) => f.path)]);
  const typed = Object.fromEntries(Object.entries(values || {}).filter(([k, v]) => allowed.has(k) && !isEmpty(v)));
  const record = { id: item.id, name: prefill.name, productCode: prefill.productCode, packaging: prefill.packaging, ...typed };
  if (prefill.brandName) record.brand = { name: prefill.brandName };
  for (const [path, value] of Object.entries(values?.pathValues || {})) {
    const c = classifyPath(`product.${path}`);
    if (c?.kind === "text" && !isEmpty(value)) record[c.column] = setIn(record[c.column], parse(`product.${path}`).segments.slice(1), value);
  }
  return record;
}

const asGap = (id, need, product) => ({ gapId: `N${id}`, need, field: need.fields[0], label: need.label, expectedType: EXPECTED_TYPE[need.input] || "string", product });
const synthetic = (f) => ({ ...f, types: [], fields: [{ label: f.label, source: { kind: "product", path: f.path }, dataCategory: "product_data" }] });

/**
 * POST /invoices/:id/items/:itemId/new-product-suggest — { mode, values }: the empty fields shown in
 * that mode. → { suggestions: [{ path, label, input, value, estimated, reasoning, confidence, suggestionId }],
 *               unavailable?, reason? }. Nothing is stored on a product.
 */
export async function suggestNewProduct(invoiceId, itemId, companyId, { mode = "needed", values = {} }, { generate } = {}) {
  const { inv, item } = await loadItem(invoiceId, itemId, companyId);
  assertEditable(inv);
  assertOpenLine(item);
  const settings = await getAiSettings(inv.companyId);
  if (!aiAllowed(settings) || !settings.allowProductInference) return { suggestions: [], unavailable: true, reason: settings.enabled ? "AI product suggestions are turned off for this company" : "AI is turned off for this company" };
  const draft = await buildDraft(inv, item);
  const record = draftRecord(item, draft.prefill, values);
  const others = FORM.filter((f) => !draft.needed.some((n) => n.path === f.path)).map(synthetic);
  const shown = mode === "full" ? [...draft.needed, ...others] : draft.needed.filter((n) => n.required);
  const open = shown.filter((n) => !NOT_SUGGESTED.has(n.path) && isEmpty(valueAt(record, n.path)) && n.fields.every(allowsInference));
  if (!open.length) return { suggestions: [] };
  const gaps = open.map((n, i) => asGap(i + 1, n, record));
  let res;
  try {
    res = await askInference({ companyId: inv.companyId, invoiceId: inv.id, gaps }, { generate });
  } catch (err) {
    return { suggestions: [], unavailable: true, reason: publicAiError(err) };
  }
  const suggestions = [];
  for (const g of gaps) {
    const got = res.answers.get(g.gapId);
    if (!got) continue;
    const value = got.verdict.ok ? formValue(g.need.input, got.verdict.value) : null;
    // every proposal is kept with its provenance (P7); this one always waits for a person
    const s = await recordSuggestion(
      { companyId: inv.companyId, kind: "product_infer", entityType: "invoice_item", entityId: item.id, proposal: { path: g.need.path, label: g.label, value, answer: got.answer }, evidence: got.answer.evidence || [], evidenceVerified: got.verdict.ok, confidence: got.answer.found ? got.answer.confidence : 0, modelKind: "CERT_PRODUCT_INFER", promptHash: res.run?.promptHash || "-", inputHash: res.inputHash, aiRunId: res.run?.id },
      { ...settings, autoAccept: false }
    );
    if (!got.verdict.ok) {
      await prisma.aiSuggestion.update({ where: { id: s.id }, data: { status: "rejected", finalValue: { reason: got.verdict.reason } } });
      continue;
    }
    suggestions.push({ path: g.need.path, label: g.label, input: g.need.input, value, estimated: true, reasoning: got.answer.reasoning || got.verdict.provenance.estimateBasis || null, confidence: got.answer.confidence, suggestionId: s.id });
  }
  return { suggestions };
}

// ── create ───────────────────────────────────────────────────────────────────
/** Writes values read by template paths that live inside a JSON column (a named specification). */
function applyPathValues(data, pathValues) {
  const json = productJsonColumns();
  for (const [path, value] of Object.entries(pathValues)) {
    if (isEmpty(value)) continue;
    const c = classifyPath(`product.${path}`);
    if (c?.kind !== "text" || !json.has(c.column)) throw new CertError("INVALID_PATH", `Not a product value: ${path}`, 400);
    data[c.column] = setIn(data[c.column], parse(`product.${path}`).segments.slice(1), value);
  }
  if (data.specifications && !data.specifications.type) data.specifications.type = "Specification";
}

/** The suggestions behind this product: a value kept as suggested stays an estimate, a changed one is the person's. */
async function decidedSuggestions(inv, item, ids, valueOf) {
  if (!ids.length) return { provenance: undefined, decisions: [] };
  const rows = await prisma.aiSuggestion.findMany({ where: { id: { in: ids }, companyId: inv.companyId, kind: "product_infer", entityType: "invoice_item", entityId: item.id, status: "pending" } });
  const provenance = {};
  const decisions = [];
  const at = new Date().toISOString();
  for (const s of rows) {
    const { path, value, answer } = s.proposal;
    const final = valueOf(path);
    const kept = same(final, value);
    decisions.push({ id: s.id, decision: isEmpty(final) ? "rejected" : kept ? "accepted" : "edited", finalValue: { value: final ?? null } });
    if (kept) provenance[path] = { tier: "I", kind: "product_inference", estimated: true, basis: String(answer?.reasoning || "").slice(0, 300) || null, modelId: s.modelId, promptHash: s.promptHash, suggestionId: s.id, at };
  }
  return { provenance: Object.keys(provenance).length ? provenance : undefined, decisions };
}

/**
 * POST /invoices/:id/items/:itemId/create-product. In one transaction: the product (always in the
 * invoice's company), the line matched to it, and the line's name as an alias when asked for. Then
 * matching and the data check run again, so other lines and the plan follow. → { item, product, matching }
 */
export async function createProductFromLine(invoiceId, itemId, companyId, body, userId = null, { generate } = {}) {
  const { inv, item } = await loadItem(invoiceId, itemId, companyId);
  assertEditable(inv);
  assertOpenLine(item);
  const { rememberAlias = false, mode = "needed", suggestionIds = [], pathValues = {}, ...fields } = body;
  const data = { ...fields };
  if (mode === "needed") {
    // the needed form doesn't show these: what the invoice says is saved without asking
    const prefill = await linePrefill(inv, item);
    data.productCode ??= prefill.productCode;
    data.packaging ??= prefill.packaging;
    data.brandId ??= prefill.brandId;
  }
  applyPathValues(data, pathValues);
  const { provenance, decisions } = await decidedSuggestions(inv, item, suggestionIds, (path) => valueAt(data, path));
  const { product, updated } = await prisma.$transaction(async (tx) => {
    const created = await createProduct(inv.companyId, { ...data, fieldProvenance: provenance }, { tx });
    const claimed = await tx.invoiceItem.updateMany({ where: { id: itemId, invoiceId, matchStatus: "needs_match" }, data: { productId: created.id, matchStatus: "matched", matchMethod: "user", matchCandidates: Prisma.DbNull } });
    if (!claimed.count) throw new CertError("LINE_NOT_OPEN", `Line ${item.lineNo} was matched in the meantime`, 409);
    const editable = await tx.invoice.updateMany({ where: { id: invoiceId, status: { in: EDITABLE } }, data: reopen(inv) });
    if (!editable.count) throw new CertError("INVOICE_NOT_EDITABLE", "This invoice can no longer be edited", 409);
    // plan.md §7 learning: only on the person's explicit click
    if (rememberAlias === true) await confirmAlias({ companyId: inv.companyId, name: item.data?.name, productId: created.id, userId, invoiceId, invoiceItemId: itemId, tx });
    return { product: created, updated: await tx.invoiceItem.findUnique({ where: { id: itemId } }) };
  });
  await scheduleDictionaryRebuild(inv.companyId);
  for (const d of decisions) await decideSuggestion(inv.companyId, d.id, { decision: d.decision, finalValue: d.finalValue, userId });
  return { item: { ...updated, product }, product, matching: await followUp(inv, generate) };
}

/** The product exists either way: a failure here is reported, the next review edit runs them again. */
async function followUp(inv, generate) {
  try {
    const res = await matchInvoice(inv.id, { generate });
    const summary = matchSummaryOf(res, "rematch");
    const fresh = await prisma.invoice.update({ where: { id: inv.id }, data: { matchSummary: summary } });
    await refreshIfChecked(fresh);
    return summary;
  } catch (err) {
    console.error(`[invoice ${inv.id}] matching after a new product failed: ${err.message}`);
    return { error: err.message };
  }
}
