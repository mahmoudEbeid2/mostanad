// The ONLY file in this codebase where a Gemini model ID may be a string literal
// (Invariant #9 in CLAUDE.md). Every label-engine caller resolves its model,
// temperature, and thinking budget from here instead of hardcoding them.
//
// Scope note: this covers the label-engine call sites migrated in Phase 0
// (geminiClient, labelGeneratorWorker, referenceLabelWorker, edaRequirementWorker,
// productAiWorker, pipeline.js, labelService). certificateService.js,
// catalogService.js, and aiTemplateService.js are separate subsystems still on
// the deprecated @google/generative-ai SDK with their own hardcoded model
// strings — out of scope for this phase, flagged separately.
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

export const MODELS = {
  // Mechanical extraction: PDF/DOCX -> raw text, raw text -> structured JSON.
  // No judgement involved, so thinking is disabled (§9.3: "minimal").
  EXTRACT: { id: "gemini-2.5-flash", thinkingBudget: 0, temperature: 0 },

  // Reference label ingestion: structuring an approved label into reusable
  // style/regulatory guidance. More interpretation than EXTRACT, less than
  // generation, so a small fixed budget (§9.3: "استيعاب مرجع -> low").
  INGEST: { id: "gemini-2.5-flash", thinkingBudget: 1024, temperature: 0 },

  // Label generation drafting (formulation -> label JSON). Balances three
  // conflicting contexts (regulatory text, references, product data), so a
  // generous fixed budget rather than dynamic (§9.3: "high" — deliberately not
  // -1/automatic, since automatic budget can under-think on exactly the
  // multi-context balancing this task requires). Small nonzero temperature:
  // the doc's own registry example (§9.2) uses 0.1 here, not 0 — drafting
  // language allows a little more variance than pure extraction.
  LABEL_GENERATE: { id: "gemini-2.5-flash", thinkingBudget: 8192, temperature: 0.1 },

  // Steps 3.5/3.6 in labelGeneratorWorker (compliance re-check, self-review).
  // These are removed in Phase 2 (G3 — a second generation pass masquerading
  // as validation); kept on record here only so Phase 0 doesn't leave any
  // Gemini call without an explicit model/temperature/thinking budget.
  LABEL_REVIEW: { id: "gemini-2.5-flash", thinkingBudget: -1, temperature: 0 },

  // Web-grounded search fallback for country regulatory requirements
  // (labelGeneratorWorker Step 2.6). Simple retrieval + summarization.
  WEB_SEARCH: { id: "gemini-2.5-flash", thinkingBudget: 1024, temperature: 0 },

  // AI template reconstruction pipeline (screenshot -> layout/OCR/table analysis
  // -> HTML/CSS draft -> visual critic loop). Not part of the label engine, but
  // shares geminiClient and was already routed through it, so it gets a registry
  // entry too rather than staying hardcoded. Multi-stage visual reasoning, so a
  // dynamic budget; temperature stays 0 to match this pipeline's pre-existing
  // behavior (geminiClient.generateJson always forced temperature 0).
  TEMPLATE_RECONSTRUCT: { id: "gemini-2.5-flash", thinkingBudget: -1, temperature: 0 },

  // Phase 3 — regulatory rule compilation (§9.3: "تجميع القواعد -> high", called
  // out as the hardest task in the whole system: translating legal text into
  // executable logic). Large fixed budget, temperature 0 for reproducibility —
  // a rule extraction that changes between runs on the same document is unusable.
  RULE_COMPILE: { id: "gemini-2.5-flash", thinkingBudget: 16384, temperature: 0 },

  // Phase 3 — coverage auditor (§7.5): the reverse pass over the same document,
  // checking which clauses produced no rule. Same reasoning weight as compilation
  // since it's re-reading the whole document with equal scrutiny.
  COVERAGE_AUDIT: { id: "gemini-2.5-flash", thinkingBudget: 16384, temperature: 0 },

  // Phase 5 — adversarial auditor (§14.1). §9.2's own invariant: "generator and
  // auditor MUST be different model families." This environment has ONLY a
  // Gemini credential (no ANTHROPIC_API_KEY/OPENAI_API_KEY configured) — a
  // real second vendor is genuinely not available here, not skipped by choice.
  // gemini-2.5-pro is used instead of gemini-2.5-flash as the closest available
  // approximation (a different model within the same family, not a different
  // family) — this reduces but does NOT eliminate shared-bias risk. Flagged in
  // PROGRESS.md as a "need from the user": a real second-vendor API key.
  AUDITOR: { id: "gemini-2.5-pro", thinkingBudget: 16384, temperature: 0 },
};
