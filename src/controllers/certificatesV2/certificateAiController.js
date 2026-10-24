import catchAsync from "../../utils/catchAsync.js";
import { getDictionary, buildDictionary, dictionaryView, addPathSynonym } from "../../services/certificates/dictionary/dataDictionary.js";
import { getAiSettings, updateAiSettings } from "../../services/certificates/ai/aiSettings.js";
import * as fieldService from "../../services/certificates/templates/fieldService.js";
import * as fieldMapper from "../../services/certificates/mapping/fieldMapper.js";
import * as dataNeeds from "../../services/certificates/dataNeeds/dataNeedsService.js";
import { diagnoseInvoice } from "../../services/certificates/dataNeeds/diagnosis.js";
import { listProfile, forgetValue } from "../../services/certificates/dataNeeds/productProfile.js";
import { prisma } from "../../lib/prisma.js";
import { notFound } from "../../services/certificates/errors.js";
import * as health from "../../services/certificates/insights/dictionaryHealth.js";
import * as productNeeds from "../../services/certificates/insights/productNeeds.js";
import { aiStats } from "../../services/certificates/insights/aiStats.js";
import { getAiStatus } from "../../services/ai/aiStatus.js";
import { companyFor, scopeOf, actorId } from "./requestScope.js";

/** GET /ai-status — P8: can AI answer right now? (the UI banner and AI buttons read it) */
export const aiStatus = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await getAiStatus() });
});

// Certificate AI layers — foundations (plan.md §3, Phase A0). Thin: the
// dictionary and the settings live in services/certificates/{dictionary,ai}.

export const getDataDictionary = catchAsync(async (req, res) => {
  const row = await getDictionary(companyFor(req));
  res.status(200).json({ status: "success", data: { dictionary: dictionaryView(row) } });
});

export const rebuildDataDictionary = catchAsync(async (req, res) => {
  const row = await buildDictionary(companyFor(req));
  res.status(200).json({ status: "success", data: { dictionary: dictionaryView(row) } });
});

export const getSettings = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { settings: await getAiSettings(companyFor(req)) } });
});

export const updateSettings = catchAsync(async (req, res) => {
  const { companyId: _ignored, ...patch } = req.body;
  res.status(200).json({ status: "success", data: { settings: await updateAiSettings(companyFor(req), patch) } });
});

// ── A1: template field mapping (plan.md §5) ──────────────────────────────────
export const labelProposals = catchAsync(async (req, res) => {
  const proposals = await fieldService.proposeLabels(req.params.id, scopeOf(req), req.body.fields);
  res.status(200).json({ status: "success", data: { proposals } });
});

export const mapFields = catchAsync(async (req, res) => {
  const data = await fieldMapper.mapFields(req.params.id, scopeOf(req), req.body, { userId: actorId(req) });
  res.status(200).json({ status: "success", data });
});

export const getSuggestion = catchAsync(async (req, res) => {
  const suggestion = await fieldMapper.getSuggestion(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { suggestion } });
});

// ── A2: the certificate data check (plan.md §6) ──────────────────────────────
export const getDataNeeds = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { check: await dataNeeds.getNeeds(req.params.id, scopeOf(req)) } });
});

export const computeDataNeeds = catchAsync(async (req, res) => {
  const check = await dataNeeds.computeNeeds(req.params.id, scopeOf(req), { ai: req.body?.ai !== false });
  res.status(200).json({ status: "success", data: { check } });
});

export const decideDataNeeds = catchAsync(async (req, res) => {
  const check = await dataNeeds.decideNeeds(req.params.id, scopeOf(req), req.body.decisions, actorId(req));
  res.status(200).json({ status: "success", data: { check } });
});

/** "Add as synonym for all products" (plan.md §6.1 near-miss learning) — a person's decision, never automatic (§12 Q3). */
export const addDictionarySynonym = catchAsync(async (req, res) => {
  const row = await addPathSynonym(companyFor(req), req.body.canonical, req.body.alternative);
  res.status(200).json({ status: "success", data: { dictionary: dictionaryView(row) } });
});

// ── A4: advanced (plan.md §9) ────────────────────────────────────────────────
export const getDictionaryHealth = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { health: await health.healthReport(companyFor(req)) } });
});

export const suggestSynonyms = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await health.suggestSynonyms(companyFor(req)) });
});

export const decideSynonym = catchAsync(async (req, res) => {
  const data = await health.decideSynonym(companyFor(req), req.params.id, req.body, actorId(req));
  res.status(200).json({ status: "success", data });
});

export const getCompleteness = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { completeness: await productNeeds.completeness(companyFor(req)) } });
});

export const getProductData = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await productNeeds.productData(req.params.id, scopeOf(req)) });
});

export const saveProductData = catchAsync(async (req, res) => {
  const { companyId: _ignored, ...body } = req.body;
  res.status(200).json({ status: "success", data: await productNeeds.saveProductData(req.params.id, scopeOf(req), body) });
});

/** GET /certificate-products/:id/profile — the product's certificate profile (item 3), tenant-scoped. */
export const getProductProfile = catchAsync(async (req, res) => {
  const scope = scopeOf(req);
  const product = await prisma.product.findFirst({ where: { id: req.params.id, ...(scope ? { companyId: scope } : {}) }, select: { id: true, companyId: true, name: true } });
  if (!product) throw notFound("Product");
  res.status(200).json({ status: "success", data: { product, values: await listProfile(product.companyId, product.id) } });
});

/** DELETE /certificate-product-values/:id — forget one profile value; the next invoice fills it again. */
export const forgetProductValue = catchAsync(async (req, res) => {
  const scope = scopeOf(req);
  const row = await prisma.productCertificateValue.findFirst({ where: { id: req.params.id, ...(scope ? { companyId: scope } : {}) }, select: { id: true, companyId: true } });
  if (!row || !(await forgetValue(row.companyId, row.id))) throw notFound("Profile value");
  res.status(204).end();
});

export const getAiStats = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { stats: await aiStats(companyFor(req), { days: req.query.days }) } });
});

// ── A5: web lookup on request (plan.md §14.3) ────────────────────────────────
/** GET /invoices/:id/data-needs/diagnosis — why each value is missing, grouped by what fixes it (read-only). */
export const diagnoseDataNeeds = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { diagnosis: await diagnoseInvoice(req.params.id, scopeOf(req)) } });
});

export const webLookup = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { check: await dataNeeds.webLookupNeeds(req.params.id, scopeOf(req)) } });
});
