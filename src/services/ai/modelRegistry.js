// The ONLY file in this codebase where a Gemini model ID may be a string literal
// (Invariant #9 in CLAUDE.md). Every label-engine caller resolves its model,
// temperature, and thinking budget from here instead of hardcoding them.
//
// Scope note: this covers the label-engine call sites migrated in Phase 0
// (geminiClient, labelGeneratorWorker, referenceLabelWorker, edaRequirementWorker,
// productAiWorker, labelService). catalogService.js (the V1 catalogue upload)
// moved onto geminiClient + CATALOGUE_LEGACY in plan.md A6.3. (The V1
// certificate/template services were removed in Certificates V2 Phase 8.)
//
// DEVIATION FROM MOSTANAD_ARCHITECTURE.md §9.2/§9.3: the doc's registry example
// sets a qualitative `thinking: "high"` (etc.) and assumes a `thinkingLevel` on
// every model. Verified against the live API: gemini-2.5-flash — the model this
// entire codebase currently runs on — rejects `thinkingConfig.thinkingLevel`
// with "Thinking level is not supported for this model" (confirmed live, not
// from docs). `thinkingLevel` only exists for newer model families (the doc's
// own examples are gemini-3.x, not 2.5). Phase 0 keeps gemini-2.5-flash — no
// model upgrade was in scope — so thinking effort is expressed here as
// `thinkingBudget` (token budget: 0 disabled, -1 dynamic/automatic, or a fixed
// token count), which 2.5-flash does accept. Re-map to `thinkingLevel` if/when
// a later phase moves these to a 3.x model family that supports it.
// 2026-11-23: done — thinkingConfigFor (below) re-maps the budget for 3.x.
// The per-task notes below that say "gemini-2.5-flash" describe the model
// those budgets were tuned on, not the model a task runs on today.

// The model IDs themselves, named once. MODELS below and the price table
// (modelPrices.js) both refer to these — no other file spells a model ID.
// Which one a task runs on is configuration (env), never code: see
// resolveModel below.
export const MODEL_IDS = {
  GEMINI_2_5_FLASH: "gemini-2.5-flash",
  GEMINI_2_5_PRO: "gemini-2.5-pro",
  GEMINI_3_1_PRO_PREVIEW: "gemini-3.1-pro-preview",
  GEMINI_3_1_FLASH_LITE: "gemini-3.1-flash-lite",
  GEMINI_3_5_FLASH_LITE: "gemini-3.5-flash-lite",
  GEMINI_3_8_FLASH: "gemini-3.8-flash",
};

// 2026-11-23 (owner decision): every task runs on one stable, cheap default;
// a second stable model takes over only while the default is overloaded
// (geminiClient: repeated 503 / an open circuit breaker). Both are env:
//   AI_MODEL_DEFAULT   — every task's model unless a task override says otherwise
//   AI_MODEL_FALLBACK  — used only on overload; set it equal to the default to turn fallback off
//   AI_MODEL_<TASK>    — one task on another model, e.g. AI_MODEL_ASSISTANT=gemini-3.8-flash
// Checked against ListModels on 2026-11-23: the key can call both defaults below.
// gemini-2.5-flash is not a fallback: Google routes it to gemini-3.5-flash-lite
// from 2026-12-01 (deprecations page) and limits it to projects that used it.
export const DEFAULT_MODEL_ID = MODEL_IDS.GEMINI_3_1_FLASH_LITE;
export const DEFAULT_FALLBACK_MODEL_ID = MODEL_IDS.GEMINI_3_5_FLASH_LITE;

const MODEL_ID_SHAPE = /^gemini-[a-z0-9.-]+$/;
function envModel(name) {
  const v = (process.env[name] || "").trim();
  if (!v) return null;
  if (!MODEL_ID_SHAPE.test(v)) {
    console.error(`[modelRegistry] ignoring ${name}="${v}": not a Gemini model id`);
    return null;
  }
  return v;
}

/** The model every task uses unless it has its own override (env AI_MODEL_DEFAULT). */
export const defaultModel = () => envModel("AI_MODEL_DEFAULT") || DEFAULT_MODEL_ID;
/** The model geminiClient switches to while the default is overloaded (env AI_MODEL_FALLBACK). */
export const fallbackModel = () => envModel("AI_MODEL_FALLBACK") || DEFAULT_FALLBACK_MODEL_ID;
/** task (a MODELS key) → model id: AI_MODEL_<TASK>, else the default. */
export const resolveModel = (task) => envModel(`AI_MODEL_${task}`) || defaultModel();

// Thinking is set per task as a token budget (the 2.5 family's knob, which
// every caller below was tuned with). Gemini 3.x rejects thinkingBudget: 0
// (HTTP 400, verified live 2026-11-23) and takes a thinkingLevel instead, so
// geminiClient translates the budget for whichever model actually answers —
// the default or the fallback. Mapping: 0 → minimal, ≤ 1024 → low,
// ≤ 8192 → medium, larger or -1 (dynamic) → high.
const usesThinkingLevel = (modelId) => /^gemini-([3-9]|\d{2,})[.-]/.test(String(modelId));
export function thinkingConfigFor(modelId, thinkingConfig) {
  if (!thinkingConfig) return thinkingConfig;
  const { thinkingBudget, thinkingLevel, ...rest } = thinkingConfig;
  if (!usesThinkingLevel(modelId)) return thinkingBudget === undefined ? thinkingConfig : { ...rest, thinkingBudget };
  if (thinkingLevel) return { ...rest, thinkingLevel };
  if (thinkingBudget === undefined) return rest;
  const level = thinkingBudget === 0 ? "minimal" : thinkingBudget > 0 && thinkingBudget <= 1024 ? "low" : thinkingBudget > 0 && thinkingBudget <= 8192 ? "medium" : "high";
  return { ...rest, thinkingLevel: level };
}

// Per-call timeout by feature area (the ledger feature's prefix); a call that
// takes longer is aborted and retried like a 503. Long-document work gets
// more room than an interactive answer.
export const TIMEOUT_MS_BY_AREA = {
  assistant: 60_000,
  labels: 180_000,
  products: 120_000,
  regulatory: 300_000,
  catalogue: 240_000,
  certificates: 120_000,
};
export const DEFAULT_TIMEOUT_MS = 120_000;
export const timeoutForFeature = (feature) => TIMEOUT_MS_BY_AREA[String(feature || "").split(".")[0]] ?? DEFAULT_TIMEOUT_MS;

// Background work (catalogue extraction/inference) may run on Flex: half the
// standard price, slower, more 503s, no server-side fallback (Google's
// flex-inference page; generateContent's config.serviceTier = "flex" in
// @google/genai 2.19). Off unless AI_BACKGROUND_SERVICE_TIER=flex.
export const BACKGROUND_FEATURES = ["catalogue.extract", "catalogue.infer", "catalogue.legacy"];
export const serviceTierForFeature = (feature) =>
  BACKGROUND_FEATURES.includes(feature) && process.env.AI_BACKGROUND_SERVICE_TIER === "flex" ? "flex" : null;

// A task's settings, with its model read from config on every access (so an
// env change in tests, or AI_MODEL_<TASK>, applies without code changes).
function task(name, settings) {
  return Object.defineProperty({ ...settings, task: name }, "id", { enumerable: true, get: () => resolveModel(name) });
}

export const MODELS = {
  // Mechanical extraction: PDF/DOCX -> raw text, raw text -> structured JSON.
  // No judgement involved, so thinking is disabled (§9.3: "minimal").
  EXTRACT: task("EXTRACT", { thinkingBudget: 0, temperature: 0 }),

  // Reference label ingestion: structuring an approved label into reusable
  // style/regulatory guidance. More interpretation than EXTRACT, less than
  // generation, so a small fixed budget (§9.3: "استيعاب مرجع -> low").
  INGEST: task("INGEST", { thinkingBudget: 1024, temperature: 0 }),

  // Label generation drafting (formulation -> label JSON). Balances three
  // conflicting contexts (regulatory text, references, product data), so a
  // generous fixed budget rather than dynamic (§9.3: "high" — deliberately not
  // -1/automatic, since automatic budget can under-think on exactly the
  // multi-context balancing this task requires). Small nonzero temperature:
  // the doc's own registry example (§9.2) uses 0.1 here, not 0 — drafting
  // language allows a little more variance than pure extraction.
  LABEL_GENERATE: task("LABEL_GENERATE", { thinkingBudget: 8192, temperature: 0.1 }),

  // Steps 3.5/3.6 in labelGeneratorWorker (compliance re-check, self-review).
  // These are removed in Phase 2 (G3 — a second generation pass masquerading
  // as validation); kept on record here only so Phase 0 doesn't leave any
  // Gemini call without an explicit model/temperature/thinking budget.
  LABEL_REVIEW: task("LABEL_REVIEW", { thinkingBudget: -1, temperature: 0 }),

  // Web-grounded search fallback for country regulatory requirements
  // (labelGeneratorWorker Step 2.6). Simple retrieval + summarization.
  WEB_SEARCH: task("WEB_SEARCH", { thinkingBudget: 1024, temperature: 0 }),

  // Phase 4 — regulatory document ingestion's combined text+catalog extraction
  // (MOSTANAD ingestion overhaul §2). Replaces the old plain-text-only EXTRACT
  // call for regulatory documents specifically: this one call must both
  // transcribe the whole document AND discover its discriminants/fields, which
  // is real interpretation (not "minimal" mechanical extraction) — thinking
  // stays high, same weight as RULE_COMPILE/COVERAGE_AUDIT below. Interactive
  // (generateJson), never Batch — ingestion is user-triggered and must finish
  // within the same job, not queued for a nightly batch window.
  // 2026-09-13: was gemini-2.5-pro — confirmed LIVE-BROKEN on this API key
  // ("This model models/gemini-2.5-pro is no longer available to new users",
  // HTTP 404, not a quota/rate issue) during the real SFDA-document ingestion
  // run. gemini-3.1-pro-preview exists on this key but returned 429 (quota
  // exhausted) on the same run. Falls back to gemini-2.5-flash — the only
  // model this codebase has verified working end-to-end — keeping the "high"
  // thinking weight via thinkingBudget. Re-promote to a pro-tier model once
  // one is confirmed reachable on this key.
  EXTRACT_WITH_CATALOG: task("EXTRACT_WITH_CATALOG", { thinkingBudget: 16384, temperature: 0 }),

  // Phase 3 — regulatory rule compilation (§9.3: "تجميع القواعد -> high", called
  // out as the hardest task in the whole system: translating legal text into
  // executable logic). Large fixed budget, temperature 0 for reproducibility —
  // a rule extraction that changes between runs on the same document is unusable.
  // 2026-09-13: same gemini-2.5-pro 404 as EXTRACT_WITH_CATALOG above — see
  // that comment. Falls back to gemini-2.5-flash for the same reason.
  RULE_COMPILE: task("RULE_COMPILE", { thinkingBudget: 16384, temperature: 0 }),

  // Phase 3 — coverage auditor (§7.5): the reverse pass over the same document,
  // checking which clauses produced no rule. Same reasoning weight as compilation
  // since it's re-reading the whole document with equal scrutiny.
  // 2026-09-13: same gemini-2.5-pro 404 as EXTRACT_WITH_CATALOG above.
  COVERAGE_AUDIT: task("COVERAGE_AUDIT", { thinkingBudget: 16384, temperature: 0 }),

  // Phase 5 — adversarial auditor (§14.1). §9.2's own invariant: "generator and
  // auditor MUST be different model families." This environment has ONLY a
  // Gemini credential (no ANTHROPIC_API_KEY/OPENAI_API_KEY configured) — a
  // real second vendor is genuinely not available here, not skipped by choice.
  // gemini-2.5-pro is used instead of gemini-2.5-flash as the closest available
  // approximation (a different model within the same family, not a different
  // family) — this reduces but does NOT eliminate shared-bias risk. Flagged in
  // PROGRESS.md as a "need from the user": a real second-vendor API key.
  // 2026-09-13: NOT changed to gemini-2.5-flash despite the same live 404
  // confirmed on EXTRACT_WITH_CATALOG/RULE_COMPILE/COVERAGE_AUDIT above —
  // doing so would make this call IDENTICAL to LABEL_GENERATE's model
  // (both gemini-2.5-flash), which is strictly worse for this invariant than
  // today's "different model, same family" compromise. This entry is
  // currently unverified/likely broken on this key (untested this session —
  // out of scope for the ingestion work that surfaced the other three) —
  // needs its own fix decision, not a silent one bundled in here.
  // 2026-11-23: on the default model like every task (owner decision); move it
  // with AI_MODEL_AUDITOR. gemini-2.5-pro is no longer reachable on this key.
  AUDITOR: task("AUDITOR", { thinkingBudget: 16384, temperature: 0 }),

  // Phase 6 — chat agent (§9.3: "تصنيف نية الشات -> minimal" for intent
  // classification; patch proposal gets a bit more room to reason since it's
  // producing structured content, not a one-word label).
  CHAT_AGENT: task("CHAT_AGENT", { thinkingBudget: 2048, temperature: 0.2 }),

  // In-app assistant (C1): a function-calling loop over read-only tools, several
  // calls per message (choose tools → read results → answer). Choosing a tool
  // and reading its result is light reasoning: a small fixed budget, not dynamic.
  // Temperature 0: its answers are about stored data, never creative (an invented
  // product list was its first real bug — grounding.js now blocks one).
  ASSISTANT: task("ASSISTANT", { thinkingBudget: 512, temperature: 0 }),

  // §14.5.7 — plausibility layer's "is this worth flagging at all" judgment
  // (concentration/dose/compatibility/withdrawal-period suspicion, before any
  // knowledgeResolver citation search runs). Deliberately a separate entry
  // from WEB_SEARCH even though the values currently match — this call never
  // touches the googleSearch tool, and giving it its own name lets the two be
  // tuned independently later without an unrelated caller silently following.
  PLAUSIBILITY_JUDGE: task("PLAUSIBILITY_JUDGE", { thinkingBudget: 1024, temperature: 0 }),

  // Certificates V2 (CERTIFICATES_V2_PLAN.md §5.1). Invoice extraction is the
  // ONLY AI call in the certificate pipeline: a mechanical read of one
  // invoice file into a fixed responseSchema — thinking off, temperature 0.
  INVOICE_EXTRACT: task("INVOICE_EXTRACT", { thinkingBudget: 0, temperature: 0 }),
  // Optional field suggestions (§8.3): receives template line TEXT only (never
  // HTML) and proposes values/names/sources the user accepts one by one.
  CERT_ASSIST: task("CERT_ASSIST", { thinkingBudget: 0, temperature: 0 }),

  // Certificate AI layers (plan.md §3.3). gemini-2.5-flash: the only model
  // verified end-to-end on this key (see EXTRACT_WITH_CATALOG above).
  // Every one of these returns a CHOICE (a path, a candidate id) or a value
  // with verbatim evidence that code checks — never free data (plan.md P1/P2).
  // Template field → source path mapping, batched per template (A1): picks
  // from the company's data dictionary, so a little reasoning room.
  CERT_FIELD_MAP: task("CERT_FIELD_MAP", { thinkingBudget: 1024, temperature: 0 }),
  // Missing certificate values found in the invoice text / product JSON, with
  // quotes (A2): one call per invoice.
  CERT_INVOICE_GAPS: task("CERT_INVOICE_GAPS", { thinkingBudget: 1024, temperature: 0 }),
  // Invoice line → one of ≤ 10 given candidates (A3): a ranking, thinking off.
  CERT_PRODUCT_MATCH: task("CERT_PRODUCT_MATCH", { thinkingBudget: 0, temperature: 0 }),
  // Human labels/synonyms for opaque JSON keys (ws_period → "Withdrawal
  // period"), one call per dictionary rebuild; suggestions only.
  CERT_DICTIONARY: task("CERT_DICTIONARY", { thinkingBudget: 0, temperature: 0 }),
  // A5 tier I (plan.md §14.2): a missing product fact quoted from, or derived by
  // an allow-listed transformation of, the product's own record — code re-runs
  // the derivation and must reproduce the value exactly. One call per invoice.
  CERT_PRODUCT_INFER: task("CERT_PRODUCT_INFER", { thinkingBudget: 1024, temperature: 0 }),
  // A5 tier W (§14.3): Google-Search-grounded lookup of a product fact with
  // citations; the server fetches every cited page and checks the quote and the
  // product's identity there. Its own name (not WEB_SEARCH, the label engine's)
  // so the two can be tuned independently. One call per product per 90 days.
  CERT_WEB_LOOKUP: task("CERT_WEB_LOOKUP", { thinkingBudget: 1024, temperature: 0 }),
  // Item 4: a supplier COA / lab report (the file itself, natively) -> per batch, the
  // printed results with verbatim quotes that code checks against the document's text.
  // Copying, not reasoning: thinking off. One call per uploaded document.
  CERT_COA_EXTRACT: task("CERT_COA_EXTRACT", { thinkingBudget: 0, temperature: 0 }),

  // Product catalogues as source documents (plan.md §15, A6).
  // Block text → a schema-bound product record where every value carries a
  // quote that code verifies against THAT block (§15.3 steps 3–4): copying, not
  // reasoning — thinking off, as §15.7 specifies. Several blocks per call.
  CATALOGUE_EXTRACT: task("CATALOGUE_EXTRACT", { thinkingBudget: 0, temperature: 0 }),
  // Owner rule (A6.3): product facts the catalogue does NOT print are estimated
  // for the fields still empty — stored apart, marked estimated, never for
  // composition/codes/specifications/registration. One call per catalogue version.
  CATALOGUE_INFER: task("CATALOGUE_INFER", { thinkingBudget: 1024, temperature: 0 }),
  // The V1 upload (catalogService.processCatalogPDF), kept working until A6 is
  // live (§15.8): same model and behaviour as before (no thinking budget was
  // set, i.e. the model's dynamic default), now through geminiClient.
  CATALOGUE_LEGACY: task("CATALOGUE_LEGACY", { thinkingBudget: -1, temperature: 0 }),
  // 28 Nov (add-on Part B): a product's descriptive fields no file states (specifications per test,
  // appearance, form, category, storage, validity, dosage, administration, indications, species,
  // composition wording) estimated from the product and the company's similar products — each with
  // its reasoning and basis, printed marked «مستنتج». Reasoning: some thinking.
  PRODUCT_INFER: task("PRODUCT_INFER", { thinkingBudget: 4096, temperature: 0 }),
};

// 28 Nov (owner): reading every file of a drop — accuracy over cost. The model is env only
// (GEMINI_HARVEST_MODEL), never a code default, and never a flash / lite model: a harvest
// that would run on one is refused and the rules reader (harvestRules.js) runs instead.
// Checked against ListModels on 2026-11-28: the local key can call gemini-2.5-pro and
// gemini-3.1-pro-preview.
/** → { id } or { id: null, reason } */
export function harvestModel() {
  const raw = (process.env.GEMINI_HARVEST_MODEL || "").trim();
  if (!raw) return { id: null, reason: "GEMINI_HARVEST_MODEL is not set" };
  if (!MODEL_ID_SHAPE.test(raw)) return { id: null, reason: `GEMINI_HARVEST_MODEL="${raw}" is not a Gemini model id` };
  if (/flash|lite/i.test(raw)) return { id: null, reason: `GEMINI_HARVEST_MODEL="${raw}" is a flash / lite model — the harvest needs a Pro model` };
  return { id: raw };
}
// extraction and its verification: full thinking, no randomness
export const HARVEST_SETTINGS = { temperature: 0, thinkingBudget: 2048 }; // copying printed values: some thinking, bounded (unbounded made one call 10+ min)
