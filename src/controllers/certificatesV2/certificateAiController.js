import catchAsync from "../../utils/catchAsync.js";
import { getDictionary, buildDictionary, dictionaryView, addPathSynonym } from "../../services/certificates/dictionary/dataDictionary.js";
import { getAiSettings, updateAiSettings } from "../../services/certificates/ai/aiSettings.js";
import * as fieldService from "../../services/certificates/templates/fieldService.js";
import * as fieldMapper from "../../services/certificates/mapping/fieldMapper.js";
import * as dataNeeds from "../../services/certificates/dataNeeds/dataNeedsService.js";
import { companyFor, scopeOf, actorId } from "./requestScope.js";

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
