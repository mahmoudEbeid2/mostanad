// The ONLY file in this codebase where a Gemini model ID may be a string literal
// (Invariant #9 in CLAUDE.md). Every label-engine caller resolves its model,
// temperature, and thinking budget from here instead of hardcoding them.
//
// Scope note: this covers the label-engine call sites migrated in Phase 0
// (geminiClient, labelGeneratorWorker, referenceLabelWorker, edaRequirementWorker,
// productAiWorker, labelService). catalogService.js is a separate subsystem
// still on the deprecated @google/generative-ai SDK with its own hardcoded
// model strings — out of scope for this phase, flagged separately. (The V1
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
  EXTRACT_WITH_CATALOG: { id: "gemini-2.5-flash", thinkingBudget: 16384, temperature: 0 },

  // Phase 3 — regulatory rule compilation (§9.3: "تجميع القواعد -> high", called
  // out as the hardest task in the whole system: translating legal text into
  // executable logic). Large fixed budget, temperature 0 for reproducibility —
  // a rule extraction that changes between runs on the same document is unusable.
  // 2026-09-13: same gemini-2.5-pro 404 as EXTRACT_WITH_CATALOG above — see
  // that comment. Falls back to gemini-2.5-flash for the same reason.
  RULE_COMPILE: { id: "gemini-2.5-flash", thinkingBudget: 16384, temperature: 0 },

  // Phase 3 — coverage auditor (§7.5): the reverse pass over the same document,
  // checking which clauses produced no rule. Same reasoning weight as compilation
  // since it's re-reading the whole document with equal scrutiny.
  // 2026-09-13: same gemini-2.5-pro 404 as EXTRACT_WITH_CATALOG above.
  COVERAGE_AUDIT: { id: "gemini-2.5-flash", thinkingBudget: 16384, temperature: 0 },

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
  AUDITOR: { id: "gemini-2.5-pro", thinkingBudget: 16384, temperature: 0 },

  // Phase 6 — chat agent (§9.3: "تصنيف نية الشات -> minimal" for intent
  // classification; patch proposal gets a bit more room to reason since it's
  // producing structured content, not a one-word label).
  CHAT_AGENT: { id: "gemini-2.5-flash", thinkingBudget: 2048, temperature: 0.2 },

  // §14.5.7 — plausibility layer's "is this worth flagging at all" judgment
  // (concentration/dose/compatibility/withdrawal-period suspicion, before any
  // knowledgeResolver citation search runs). Deliberately a separate entry
  // from WEB_SEARCH even though the values currently match — this call never
  // touches the googleSearch tool, and giving it its own name lets the two be
  // tuned independently later without an unrelated caller silently following.
  PLAUSIBILITY_JUDGE: { id: "gemini-2.5-flash", thinkingBudget: 1024, temperature: 0 },

  // Certificates V2 (CERTIFICATES_V2_PLAN.md §5.1). Invoice extraction is the
  // ONLY AI call in the certificate pipeline: a mechanical read of one
  // invoice file into a fixed responseSchema — thinking off, temperature 0.
  INVOICE_EXTRACT: { id: "gemini-2.5-flash", thinkingBudget: 0, temperature: 0 },
  // Optional field suggestions (§8.3): receives template line TEXT only (never
  // HTML) and proposes values/names/sources the user accepts one by one.
  CERT_ASSIST: { id: "gemini-2.5-flash", thinkingBudget: 0, temperature: 0 },

  // Certificate AI layers (plan.md §3.3). gemini-2.5-flash: the only model
  // verified end-to-end on this key (see EXTRACT_WITH_CATALOG above).
  // Every one of these returns a CHOICE (a path, a candidate id) or a value
  // with verbatim evidence that code checks — never free data (plan.md P1/P2).
  // Template field → source path mapping, batched per template (A1): picks
  // from the company's data dictionary, so a little reasoning room.
  CERT_FIELD_MAP: { id: "gemini-2.5-flash", thinkingBudget: 1024, temperature: 0 },
  // Missing certificate values found in the invoice text / product JSON, with
  // quotes (A2): one call per invoice.
  CERT_INVOICE_GAPS: { id: "gemini-2.5-flash", thinkingBudget: 1024, temperature: 0 },
  // Invoice line → one of ≤ 10 given candidates (A3): a ranking, thinking off.
  CERT_PRODUCT_MATCH: { id: "gemini-2.5-flash", thinkingBudget: 0, temperature: 0 },
  // Human labels/synonyms for opaque JSON keys (ws_period → "Withdrawal
  // period"), one call per dictionary rebuild; suggestions only.
  CERT_DICTIONARY: { id: "gemini-2.5-flash", thinkingBudget: 0, temperature: 0 },
};
