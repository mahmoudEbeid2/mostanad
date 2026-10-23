import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import { getDictionary, pathSynonymMap } from "../dictionary/dataDictionary.js";
import { getAiSettings, aiAllowed } from "../ai/aiSettings.js";
import { runLogged, logNotRun, sha16, stableStringify } from "../ai/aiRunLog.js";
import { recordSuggestion, decideSuggestion, clampConfidence } from "../ai/aiSuggestions.js";
import { neededProductPaths } from "./productNeeds.js";
import { publicAiError } from "../../ai/aiErrorMessage.js";

// Dictionary health (plan.md §9, A4) — what is messy in a company's product
// JSON, and what to do about it WITHOUT rewriting any product:
//   lowCoverage     keys few products have (often a one-off spelling)
//   typeConflicts   a key holding numbers in some products and text in others
//   nearDuplicates  sibling keys that look like the same thing ("Assay" / "Assay %",
//                   "pH" / "PH value") → offered as a path synonym (one click, a person)
//   variants        spellings code already groups (pH / PH / ph) — information only
// plus AI label synonyms (CERT_DICTIONARY, §3.2): ONE call proposes human labels
// for opaque keys (ws_period → "Withdrawal period"); each stays a pending
// suggestion until a person accepts it (§12 Q3) — never auto-applied.

const LOW_COVERAGE = 0.25;
const MAX_SYNONYM_KEYS = 150;

const lastKey = (path) => path.match(/(?:\.|\["?)([^."[\]]+)"?\]?$/)?.[1] || path;
const parentOf = (path) => path.slice(0, path.length - (path.match(/(?:\.[^."[\]]+|\["(?:[^"\\]|\\.)*"\])$/)?.[0]?.length || 0));
const alnum = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const words = (s) => new Set(String(s).replace(/([a-z]{2,})([A-Z])/g, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Two sibling keys look like the same value. → reason or null */
export function looksDuplicate(a, b) {
  const x = alnum(a);
  const y = alnum(b);
  if (!x || !y || x === y) return x && x === y ? "same letters" : null;
  if (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x))) return "one key extends the other"; // short keys (pH) only as whole words, below
  if (Math.min(x.length, y.length) >= 5 && lev(x, y) <= 2) return "almost the same spelling";
  const wa = words(a);
  const wb = words(b);
  if (wa.size && wb.size && [...wa].every((w) => wb.has(w)) !== [...wb].every((w) => wa.has(w))) return "one key's words contain the other's";
  return null;
}

/** GET /certificate-data-dictionary/health */
export async function healthReport(companyId) {
  const dict = await getDictionary(companyId);
  const synonyms = pathSynonymMap(dict.entries);
  const { texts } = await neededProductPaths(companyId);
  const needed = new Set([...texts.keys()].map((p) => `product.${p}`));
  const observed = dict.entries.filter((e) => e.source === "observed" && e.type !== "collection" && !e.collection);
  const view = (e) => ({ path: e.path, label: e.label, coverage: e.coverage, examples: e.examples, neededByTemplates: needed.has(e.path) });
  const lowCoverage = observed.filter((e) => e.coverage < LOW_COVERAGE).sort((a, b) => a.coverage - b.coverage).map(view);
  const typeConflicts = observed.filter((e) => e.typeMix).map((e) => ({ ...view(e), types: e.typeMix }));
  const nearDuplicates = [];
  const byParent = new Map();
  for (const e of observed) {
    const p = parentOf(e.path);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(e);
  }
  for (const sibs of byParent.values()) {
    for (let i = 0; i < sibs.length; i++) {
      for (let j = i + 1; j < sibs.length; j++) {
        const reason = looksDuplicate(lastKey(sibs[i].path), lastKey(sibs[j].path));
        if (!reason) continue;
        const [canonical, alternative] = sibs[i].coverage >= sibs[j].coverage ? [sibs[i], sibs[j]] : [sibs[j], sibs[i]];
        nearDuplicates.push({ reason, canonical: view(canonical), alternative: view(alternative), alreadySynonym: (synonyms[canonical.path] || []).includes(alternative.path), action: { canonical: canonical.path, alternative: alternative.path } });
      }
    }
  }
  const variants = observed.filter((e) => e.labels?.length > 1).map((e) => ({ path: e.path, label: e.label, spellings: e.labels }));
  const pendingSynonyms = await prisma.aiSuggestion.findMany({ where: { companyId, kind: "dictionary_synonym", status: "pending" }, orderBy: { createdAt: "desc" }, take: 200 });
  return {
    dictionary: { version: dict.version, builtAt: dict.builtAt, productCount: dict.productCount, entries: dict.entries.length },
    lowCoverage,
    typeConflicts,
    nearDuplicates,
    variants,
    pathSynonyms: Object.entries(synonyms).map(([canonical, alternatives]) => ({ canonical, alternatives })),
    synonymSuggestions: pendingSynonyms.map((s) => ({ id: s.id, path: s.proposal.path, label: s.proposal.label, synonyms: s.proposal.synonyms, confidence: s.confidence, rationale: s.proposal.rationale })),
  };
}

// ── AI label synonyms (CERT_DICTIONARY) ──────────────────────────────────────
const INSTRUCTIONS = [
  "You name the keys of a company's product data so people can find them.",
  "For each key whose meaning is not obvious from its name (abbreviations, codes, other languages), give a short human label as printed on certificates,",
  "and up to 3 other names people print for the same value. Skip keys that are already clear. Use only the paths given.",
  "confidence 0–1; rationale: one short sentence (from the key and its examples).",
].join("\n");
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    keys: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, label: { type: "string" }, synonyms: { type: "array", items: { type: "string" } }, confidence: { type: "number" }, rationale: { type: "string" } },
        required: ["path", "label", "confidence"],
      },
    },
  },
  required: ["keys"],
};
export const SYNONYM_PROMPT_HASH = sha16(INSTRUCTIONS + JSON.stringify(RESPONSE_SCHEMA));
const defaultGenerate = (args) => geminiClient.generateJson(args);

/**
 * POST /certificate-data-dictionary/synonym-suggestions — ONE call for the keys
 * never asked before. → { asked, suggested, ai: { used, calls, unavailable?, reason? } }
 */
export async function suggestSynonyms(companyId, { generate = defaultGenerate } = {}) {
  const settings = await getAiSettings(companyId);
  const dict = await getDictionary(companyId);
  const asked = new Set((await prisma.aiSuggestion.findMany({ where: { companyId, kind: "dictionary_synonym" }, select: { proposal: true } })).map((s) => s.proposal?.path));
  const keys = dict.entries
    .filter((e) => e.source === "observed" && e.type !== "collection" && !e.collection && !asked.has(e.path))
    .sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0))
    .slice(0, MAX_SYNONYM_KEYS)
    .map((e) => ({ path: e.path, key: lastKey(e.path), label: e.label, examples: e.examples, spellings: e.labels }));
  const ai = { used: false, calls: 0 };
  if (!keys.length) return { asked: 0, suggested: 0, ai };
  if (!aiAllowed(settings, "allowSynonyms")) {
    ai.unavailable = true;
    ai.reason = settings.enabled ? "AI synonyms are turned off for this company" : "AI is turned off for this company";
    await logNotRun({ companyId, kind: "CERT_DICTIONARY", outcome: "disabled", reason: ai.reason, entityType: "data_dictionary", entityId: companyId, promptHash: SYNONYM_PROMPT_HASH });
    return { asked: 0, suggested: 0, ai };
  }
  let result;
  let run;
  try {
    ({ result, run } = await runLogged(
      { companyId, kind: "CERT_DICTIONARY", promptHash: SYNONYM_PROMPT_HASH, input: keys, entityType: "data_dictionary", entityId: companyId, reason: `${keys.length} key(s) never named` },
      () => generate({ model: MODELS.CERT_DICTIONARY.id, temperature: MODELS.CERT_DICTIONARY.temperature, thinkingBudget: MODELS.CERT_DICTIONARY.thinkingBudget, contents: [INSTRUCTIONS, `Keys:\n${JSON.stringify(keys)}`], schema: RESPONSE_SCHEMA, maxOutputTokens: 8192 })
    ));
  } catch (err) {
    ai.unavailable = true;
    ai.reason = publicAiError(err);
    return { asked: 0, suggested: 0, ai };
  }
  ai.used = true;
  ai.calls = 1;
  const valid = new Set(keys.map((k) => k.path));
  const inputHash = sha16(stableStringify(keys));
  let suggested = 0;
  for (const k of result?.keys || []) {
    if (!valid.has(k.path) || !String(k.label || "").trim()) continue; // only the paths it was given (P5)
    const synonyms = [...new Set([k.label, ...(Array.isArray(k.synonyms) ? k.synonyms : [])].map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 4);
    // §12 Q3: never applied without a person — pending whatever the auto-accept setting
    await recordSuggestion(
      { companyId, kind: "dictionary_synonym", entityType: "dictionary_entry", entityId: k.path, proposal: { path: k.path, label: String(k.label).trim().slice(0, 60), synonyms, rationale: String(k.rationale || "").slice(0, 200) }, confidence: clampConfidence(k.confidence), modelKind: "CERT_DICTIONARY", promptHash: SYNONYM_PROMPT_HASH, inputHash, dictionaryVersion: dict.version, aiRunId: run?.id },
      { ...settings, autoAccept: false }
    );
    suggested++;
  }
  return { asked: keys.length, suggested, ai };
}

/**
 * POST /certificate-data-dictionary/synonym-suggestions/:id — { decision: accept|reject, synonyms? }
 * Accept adds the (possibly edited) synonyms to the entry's label synonyms, which
 * template mapping matches (A1 dictionary step). Product data never changes.
 */
export async function decideSynonym(companyId, id, { decision, synonyms = null }, userId = null) {
  const s = await prisma.aiSuggestion.findUnique({ where: { id } });
  if (!s || s.companyId !== companyId || s.kind !== "dictionary_synonym") throw notFound("Suggestion");
  if (s.status !== "pending") throw new CertError("ALREADY_DECIDED", `This suggestion is already ${s.status}`, 409);
  if (decision === "reject") {
    await decideSuggestion(companyId, id, { decision: "rejected", userId });
    return { status: "rejected" };
  }
  const chosen = [...new Set((synonyms ?? s.proposal.synonyms ?? []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 8);
  if (!chosen.length) throw new CertError("VALUE_REQUIRED", "Keep at least one synonym, or reject the suggestion", 422);
  const row = await getDictionary(companyId);
  const entries = [...row.entries];
  const e = entries.find((x) => x.path === s.proposal.path);
  if (!e) throw new CertError("ENTRY_GONE", "No product has this key any more", 409);
  e.synonyms = [...new Set([...(e.synonyms || []), ...chosen])];
  await prisma.dataDictionary.update({ where: { companyId }, data: { entries, version: { increment: 1 } } });
  const edited = stableStringify(chosen) !== stableStringify(s.proposal.synonyms);
  await decideSuggestion(companyId, id, { decision: edited ? "edited" : "accepted", finalValue: { synonyms: chosen }, userId });
  return { status: edited ? "edited" : "accepted", path: e.path, synonyms: e.synonyms };
}
