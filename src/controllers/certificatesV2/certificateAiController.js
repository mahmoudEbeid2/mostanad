import catchAsync from "../../utils/catchAsync.js";
import { getDictionary, buildDictionary, dictionaryView } from "../../services/certificates/dictionary/dataDictionary.js";
import { getAiSettings, updateAiSettings } from "../../services/certificates/ai/aiSettings.js";
import { companyFor } from "./requestScope.js";

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
