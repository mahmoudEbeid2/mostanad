# Mostanad Label Engine — Build Progress

**Read this first if you are a fresh session with no memory of this run.**
Source of truth: `MOSTANAD_ARCHITECTURE.md`. `CLAUDE.md` has conventions/invariants.
This file is a running log, updated at the end of every phase. Most recent phase
is at the bottom. `API-CHANGES.md` (repo root) has the full endpoint change log.

## Environment notes for whoever resumes this

- Local dev DB/Redis run via `docker-compose.dev.yml` (`postgres`, `redis` services
  only — do not need the full app+workers docker stack for dev; `node src/server.js`
  + individual `node src/workers/*.js` processes work directly against the exposed
  ports).
- **GEMINI_API_KEY free-tier daily quota (20 req/day on gemini-2.5-flash) was
  exhausted during Phase 0/1 verification.** Any phase whose "proof" requires a
  live Gemini call may show 429 quota errors that are NOT code bugs — check the
  error message for `generate_content_free_tier_requests` before assuming a
  regression. Consider a paid-tier key or waiting for daily reset.
- Local migration history had pre-existing drift from before this session (two
  committed-but-unapplied migrations, one DB-applied-but-not-on-disk migration).
  Resolved during Phase 1 — see below. `prisma migrate dev` will still refuse and
  offer to reset if it re-detects the `companies.logo_url` drift; do NOT accept
  that reset. Use `prisma migrate diff --from-schema=<old> --to-schema=<new>
  --script` + `prisma db execute --file <script>` + `prisma migrate resolve
  --applied <name>` instead (bypasses the shadow-DB drift check entirely).

## Phase 0 — tenant leak, SDK migration, defect fixes ✅ (commit `f7ff8df`)

See that commit message for full detail. Summary: closed the `labelGeneratorWorker.js:142`
cross-tenant leak, migrated 7 label-engine files off deprecated `@google/generative-ai`
to `@google/genai`, added `modelRegistry.js`, removed dead code (`processAndCreate`,
`currentModel` fallback, `dbProduct.routeOfAdmin`).

**Decisions not in the doc:**
- `certificateService.js`/`catalogService.js`/`aiTemplateService.js` NOT migrated off
  the deprecated SDK — separate subsystems, out of label-engine scope. Both SDKs
  installed side by side.
- `thinkingLevel` → `thinkingBudget`: verified live that `gemini-2.5-flash` rejects
  `thinkingConfig.thinkingLevel` ("not supported for this model"). That's a
  `gemini-3.x`-only parameter. `modelRegistry.js` uses `thinkingBudget` (token count)
  for all entries until/unless a later phase upgrades the model family.

**New finding (not in the verified defect list):** `referenceLabelService.getAll`/
`getById` has NO tenant scoping at all — same defect class as G5, different endpoint.
Not fixed (out of scope), still open.

## Phase 1 — Persistence foundation ✅

**Built:**
- `prisma/schema.prisma`: `GeneratedLabel`, `LabelVersion`, `ValidationReport`,
  `LabelChatMessage` (§5.1-5.4), plus `Product.routeOfAdmin/dosageForm/strength/
  productType/prescriptionStatus` (§5.10). All additive/nullable.
- Migration `20260828010000_add_generated_label_core` — applied. Also applied two
  pre-existing pending migrations (`20260728021800_add_brand_to_reference_label`,
  `20260729143000_enhance_reference_labels`) to resolve drift that predated this
  session — reviewed, purely additive (nullable columns + one `NOT NULL DEFAULT
  'upload'` column on `reference_labels`, safe with 0 existing rows).
- `src/services/label/versioning/versionService.js` — `createInitial`,
  `createVersion`, `diff`, `restore` (forward-only). Verified directly (see below).
- `labelGeneratorWorker.js` rewired: persists via `versionService.createInitial`
  instead of only `BackgroundTask.result`. Result shape is now
  `{ taskId, labelId, label }`.
- `src/services/label/generatedLabelService.js` + `generatedLabelController.js` +
  `generatedLabelRoutes.js`: `GET /labels`, `GET /labels/:id`,
  `GET /labels/:id/versions`. Tenant-scoped (company caller always forced to its
  own `companyId`; system user can optionally filter by `?companyId=`, otherwise
  sees all tenants — same posture as every other internal-role resource in this
  codebase, e.g. `read_companies`).
- `read_labels` permission seeded; `"labels"` added to `authMiddleware.js`'s
  `companyAllowedModules` so company tenants can use it.
- `generateLabelAi` controller: `companyId` now required (explicit body field for
  system-user callers, forced to `req.company.id` for company callers) since
  `GeneratedLabel.companyId` is NOT NULL. `createdByUserId` threaded from
  `req.user?.id` through the job payload into the persisted row.

**Decisions not in the doc:**
- `GeneratedLabel.productProfile` made nullable (doc has it required) — Phase 4's
  `productProfile.js` doesn't exist yet, nothing real to put there.
- `schemaVersion` = `"vet-label@2.0.0"` (matches §6.3's `z.literal`) even though
  this worker's actual JSON doesn't conform to that schema's shape yet (no
  `LocalizedText`, no `withdrawalPeriod`, etc.). This is deliberate: Phase 2's
  `schemaValidator` will correctly report that gap as a real FAIL rather than the
  version number silently drifting. Labels from this phase will need re-validation
  once Phase 2 lands.
- Per-field provenance in `labelGeneratorWorker.js` (`buildFieldProvenance`) is a
  **stopgap**: tier/source derived from what the worker already knows (`matchTier`,
  user hints, `estimatedFields`), NOT the full Tier 1-6 ladder from §8.2 (needs
  Phase 4's `productProfile` reading the `Product` row — Tier 1 never appears here
  for that reason).
- `GET /labels` cross-tenant admin visibility for system users omitting
  `?companyId=` is deliberate, matches existing codebase convention, not a new
  leak class (company callers are always hard-scoped).

**Verified (no live Gemini calls needed for any of this):**
- `node -e` script: `versionService.createInitial` → v1, `createVersion` → v2,
  `restore(labelId, 1)` → v3 with `restoredFrom: 1` and v1's `labelData` restored
  (not v2's) — forward-only confirmed structurally correct.
- `versionService.diff` — correctly reports `replace`/`add`/`remove` ops on a
  nested-object test case.
- HTTP: `GET /labels`, `GET /labels/:id`, `GET /labels/:id/versions` all return
  200 with correct data for the owning company; cross-tenant company gets 404 on
  `/labels/:id` and `total: 0` on the list — tenant isolation confirmed live.
- `node tests/runAll.js`: 11/16 suites passed. Same 5 failures as Phase 0's
  baseline (`brand`, `certificates`, `label`, `queue`, `templates`) — all
  pre-existing/unrelated to this phase (see Phase 0 section) or Gemini-quota-
  blocked. No new regressions.

**Deferred:** nothing from Phase 1's explicit scope. `LabelApproval` (§5.5) is
Phase 7, not built here.

## Phase 2 — Schema + deterministic validation + engine unification ✅

**Built:**
- `src/services/label/schema/labelSchema.js` — the real §6.3 Zod schema
  (`LocalizedText` primitive per §6.2, not `{en,target}`). Single source of truth.
- `src/services/label/schema/geminiSchema.js` — derives Gemini's structured-output
  schema from `labelSchema` via Zod 4's native `z.toJSONSchema()`, passed as
  `responseJsonSchema` (an alternative to the older `responseSchema` field that
  accepts raw JSON Schema directly — no Gemini-specific re-encoding needed).
  **NOT yet live-verified against the Gemini API** — quota still exhausted (see
  Phase 0's note). Structurally valid JSON Schema, confirmed by inspection; a
  live call is the real test, pending quota reset.
- `src/services/label/schema/fieldCatalog.js` — conditional applicability (§6.4):
  `withdrawalPeriod`/`routeOfAdministration`/`pharmaceuticalForm`/`strength`/
  `sideEffects`/`feedClassification`/`analysis`/`shelfLifeAfterOpening`, each with
  an `appliesWhen` predicate. `isFoodProducingSpecies`/`isMultiDose` are heuristic
  lists — explicitly documented as a fallback superseded by Phase 3's real
  RegulatoryRule conditional rules once compiled per country.
- `src/services/label/validation/{schemaValidator,ruleValidator,coherenceValidator,
  validationEngine}.js` — layers 1-4 (§10.1), pure functions, no AI. `ruleValidator`
  runs the full §7.3 constraint DSL (`required_field`, `forbidden_content`,
  `format`, `value_constraint`, `language_set`, `conditional`; `semantic` is
  routed to Phase 5's aiValidator, not silently dropped; an unrecognized `kind`
  throws, per §7.3's own rule) against a plain `rules` array — works standalone
  before Phase 3's `RegulatoryRule` table exists (empty array → one
  `NO_AUTHORITATIVE_REQUIREMENTS`/`UNVERIFIABLE` verdict per §7.1 case 4, not
  silence) and after (real DB rows, unchanged interface).
- `src/services/label/extraction/labelExtractor.js` — replaces
  `labelService.verifyProductLabel`'s Steps 1-2. **Extraction only** — one AI
  call producing a labelSchema-shaped partial JSON, no compliance judgement.
  `labelService.js` is now a ~25-line orchestrator: extract → `validationEngine.
  validate()` → return `{ product, validation }`. Engine unification (§4.2)
  achieved: an uploaded label and a generated label are judged by the identical
  `validationEngine`.
- Deleted Steps 3.5/3.6 from `labelGeneratorWorker.js` (G3 — a second AI
  generation pass that called itself "validation," no pass/fail ever produced,
  both wrapped in swallowing catches).
- `POST /labels/:id/validate` (mutates: creates a `ValidationReport`, sets
  `label.status` to `validated`/`failed_validation` — `update_labels` permission,
  newly seeded), `GET /labels/:id/validation` (`read_labels`).
- `tests/label.determinism.test.js` (T10) — proves layers 1-4 are pure: identical
  input+rules → byte-identical verdicts; changing input changes verdicts (not a
  constant function); a fixture `forbidden_content` rule fires/doesn't fire
  correctly. No server, no DB, no Gemini call.

**Breaking API change (see API-CHANGES.md):** `POST /products/verify-label`'s
result shape changed from an AI-judged `validation.results[]`
(`category/issue/location/solution`) to a deterministic `validation.verdicts[]`
(`FieldVerdict[]`, §10.2) plus `validation.passed/errorCount/warningCount/
engineVersion`. `tests/label.test.js` updated to match. This is a deliberate,
in-scope consequence of Phase 2's explicit instruction ("route labelExtractor
through validationEngine") and of Invariant #1 (the old Step 3 was an AI
generating a "compliant: true/false" verdict from free-form prompting — the
exact anti-pattern G3 already condemned on the generation side).

**Decisions not in the doc:**
- Did NOT rewrite `labelGeneratorWorker`'s generation prompt/output shape to
  literally conform to `labelSchema` in this phase — that's Phase 4's
  "`labelGenerator` مقيّد" (schema-constrained generation). Running the current
  ad-hoc-shaped generator output through `validationEngine` today would just be
  schema-layer noise (field names don't match: `ingredients` vs
  `activeIngredients`, no `productType`, etc.). Noted directly in a code comment
  where Steps 3.5/3.6 used to be.
- `labelExtractor`'s extracted text is wrapped as single-language `LocalizedText`
  (`{translations:{en:text}, primary:"en"}`) regardless of the label's actual
  printed language — one AI call's budget in Phase 2, no language detection.
  Flagged in the file's own header comment.
- Coherence layer's 4 checks (§10.1) are genuinely implemented but are honestly
  heuristic where the doc is vague: analysis-vs-amounts uses a loose
  substring+numeric-equality match; species-list coherence checks for duplicates
  (a concrete, useful check) rather than attempting a full list↔free-text
  cross-language match.
- `POST /labels/:id/validate` requires the NEW `update_labels` permission
  (seeded), not `read_labels` — validating mutates state (report row + label
  status), so it doesn't belong on the read-only permission.

**Verified:**
- `node -e` smoke tests: `validationEngine.validate()` on a valid feed_additive
  label (correctly PASSes/FAILs per applicability) and a veterinary_drug label
  with a food-producing species (correctly requires `withdrawalPeriod`,
  `sideEffects`, etc.) — both by direct inspection of verdicts.
- `tests/label.determinism.test.js`: 7/7 assertions pass.
- `MOCK_GEMINI=true` end-to-end run of the new `labelService.verifyProductLabel`
  (no quota spent): extraction → mapping → validation → real DB match against a
  leftover test product — full pipeline confirmed working, verdicts shown for
  every top-level field, `_regulatory` correctly `UNVERIFIABLE` since no
  `RegulatoryRule`s exist yet.
- `POST /labels/:id/validate` + `GET /labels/:id/validation` tested live over
  HTTP against a deliberately incomplete label: 201/200, `passed:false`,
  `errorCount:20`, `label.status` updated to `failed_validation`, cross-tenant
  request correctly 404s.
- `node tests/runAll.js`: 12/17 (added `label.determinism.test.js`). Same 5
  pre-existing failures as Phase 0/1's baseline (`brand`, `certificates`,
  `label`, `queue`, `templates`) — `label.test.js`'s failure is still the
  pre-existing broken hand-rolled PDF fixture (`test_label_mock.pdf` has no real
  page tree — Gemini's File API rejects it with "The document has no pages,"
  same error the untouched `certificateService.js` hits on its own synthetic
  fixture). Not fixed — pre-existing, out of Phase 2's scope, tracked here.

**Deferred:** "Run the golden set; report the delta" (Phase 2's own last line) —
the golden set doesn't exist yet. Building it next (Phase 0.5, done out of the
architecture doc's numeric order per the user's explicit instruction to build it
"anyway" despite missing real data). Will run it against Phase 2's validation
engine once the harness exists and report the baseline there.

## Phase 0.5 — Golden set harness ✅ (built out of numeric order, per explicit instruction)

**Built:**
- `GoldenEvalRun` model (§5.11) — pure `CREATE TABLE`, migration
  `20260828020000_add_golden_eval_run`.
- `golden/README.md` — tells whoever adds real cases exactly what goes in
  `input.json`/`expected.json`/`tolerances.json`, including the known gap that
  `expected.json`'s shape will need to migrate again once Phase 4 makes
  generation actually conform to `labelSchema`.
- `golden/001-synthetic-amoxicillin-poultry/` and `golden/002-synthetic-vitamin-cattle/`
  — 2 fully-synthetic fixture cases (clearly labeled as such in every file),
  proving the harness runs before real data exists.
- `scripts/goldenComparator.js` — the field-scoring logic (`compareField`),
  split into its own module specifically so it's unit-testable without the live
  pipeline.
- `scripts/evalGolden.js` — submits every `golden/` case through
  `POST /reference-labels/generate-text-ai`, polls to completion, scores
  field-by-field, persists a `GoldenEvalRun`, enforces CLAUDE.md invariant #11
  (>2% regression on ANY single field blocks — checked per-field against the
  previous run, not just on the overall average). `npm run eval:golden`.
- `tests/golden.comparator.test.js` — unit tests the scorer directly (10 cases:
  notApplicable, wrong, exact, partial, synonym-aware matching, numeric
  tolerance, array/object field flattening).

**A real bug found and fixed by writing the test above:** synonym expansion was
asymmetric — a canonical term ("poultry") never expanded to include its listed
synonyms ("chicken"), so `{en:"Poultry"}` vs `{en:"Chicken"}` with a
`poultry: ["chicken"]` tolerance would never reach full overlap. Fixed
`normalizeWords` to expand every group member bidirectionally, and added an
explicit "exact via full bidirectional overlap" branch to `compareField` (it
previously had no path to `"exact"` through synonyms at all — only literal
string equality or a >=0.6 threshold capped at `"partial"`). This is exactly
why the harness needed a data-independent unit test, not just a live run.

**Verified:**
- `npm run eval:golden` run against the two synthetic fixtures with the server
  and `labelGeneratorWorker` live: submission → polling → **both cases timed
  out at "processing"** (Gemini quota still exhausted — same constraint noted
  since Phase 0; the worker's own internal retry/backoff across 2-3 sequential
  AI calls per job takes longer than quota exhaustion allows to reach a final
  "failed" state) → correctly reported as errored cases, scored 0% across every
  field (not silently skipped), full table printed, `GoldenEvalRun` persisted
  as the first-ever run (`baselineAccuracy: null`, `regressed: false`). This
  proves the harness's submission/polling/failure-handling/reporting/persistence
  path end to end — but **not** the scorer against a real successful
  generation, since neither fixture case ever got that far today.
- `tests/golden.comparator.test.js`: 10/10, run directly against realistic
  synthetic label data (no server/DB/Gemini needed) — this is what actually
  proves `compareField`'s exact/partial/wrong/notApplicable logic is correct,
  independent of live quota.
- `node tests/runAll.js`: 13/18 (added `golden.comparator.test.js`). Same 5
  pre-existing failures as before, no new regressions.

**Decisions not in the doc:**
- Comparator lives in its own module (`goldenComparator.js`) rather than inline
  in `evalGolden.js` — pure testability, not in the doc's file list but a
  natural consequence of "build it, prove it works" without live Gemini access.
- `evalGolden.js` provisions its own sandbox company (`golden_set_eval_co`)
  rather than requiring a `companyId` in each `input.json` — keeps fixtures
  portable across databases (Phase 1 made `companyId` required for
  generation, which the original §14.3 spec predates).
- Regression check is per-field (compare each field's `accuracyPercent` against
  that same field's value in the immediately preceding run), not just on the
  overall average — this is what CLAUDE.md invariant #11 actually says
  ("regression > 2% on ANY field"), even though §14.3's own worked example only
  shows an overall-accuracy delta.

**Deferred:** a live run against a real successful generation (blocked by
Gemini quota exhaustion, not code) — rerun `npm run eval:golden` once quota
resets or a paid-tier key is available; this becomes the real first baseline
once it produces non-zero scores. The 2 synthetic cases should stay as harness
smoke tests even after real cases are added — don't delete them.

## Phase 3 — Regulatory ingestion + coverage auditing ✅

**Built:**
- `RegulatoryDocument` + `RegulatoryRule` (§5.6-5.7). `eda_requirements` TABLE
  renamed to `regulatory_documents` via hand-written SQL (`ALTER TABLE ...
  RENAME TO ...` + `ADD COLUMN`s), NOT `prisma migrate diff`'s auto-generated
  script — that generated `DROP TABLE eda_requirements` + `CREATE TABLE
  regulatory_documents` (Prisma's diff engine matches by `@@map`, not model
  name, so a model rename looks like drop+create to it). Verified the correct
  script myself, hand-wrote the migration, applied and recorded it.
  Migration `20260828030000_add_regulatory_documents_and_rules`.
- `src/services/label/regulatory/officialSources.js` (§7.2) — the
  country→authority→allowed-domains registry.
- `src/services/label/regulatory/ruleCompiler.js` — whole document in one call
  (§9.4, never chunked), strict JSON schema, high thinking budget. Exports
  `validateProposedRule` (pure) separately from `compile` (the AI call) so the
  citation-verification and targetPath-validation logic is unit-testable
  without Gemini. **Rejects, never downgrades:** a bad citation, an unknown
  `targetPath`, or an unrecognized `constraint.kind` all drop the candidate
  rule entirely — reported back, never silently coerced or saved as a lesser
  severity.
- `src/services/label/regulatory/coverageAuditor.js` (§7.5) — the reverse pass,
  with `computeCoverage` (pure) separated from `auditDocument` (the AI call)
  for the same testability reason.
- `src/services/label/regulatory/regulatoryDocumentService.js` — orchestrates
  the whole journey: `createFromExtraction` (hash dedup, refuses a duplicate
  with 409), `compileRulesFor`, `auditCoverageFor`, `approveDocument` (the
  95%-coverage hard gate, §7.5), `markClauseNonNormative` (the human-clears-a-
  false-positive path), rule CRUD.
- `edaRequirementWorker.js` extended: still feeds the PDF to the model natively
  (never `pdf-parse`), now computes `documentHash` and refuses a duplicate via
  `regulatoryDocumentService.createFromExtraction`. Also fixed G4's specific
  complaint in the same pass while I was in this file: the web-search fallback
  in `labelGeneratorWorker.js` (Step 2.6) now stores its cache with
  `sourceIsOfficial: false, status: "pending_review"` instead of implying it's
  authoritative, and Step 2.5's lookup now prefers an `approved` document over
  a `pending_review` one for the same country.
- `edaRequirementService.js` is now a thin shim over `regulatoryDocument` —
  `edaRequirementController.js` (and the `/eda-requirements` routes) needed
  ZERO changes, exactly as the phase asked.
- New routes: `GET/POST /regulatory-documents`, `GET /regulatory-documents/:id`,
  `POST /regulatory-documents/:id/compile-rules`, `.../audit-coverage`,
  `.../approve`, `PATCH .../clauses/clear` (the human-clears-a-clause
  endpoint — not in §15's list verbatim, added because `approveDocument`'s
  gate needs somewhere for a human to actually clear a clause);
  `GET /regulatory-rules`, `POST /regulatory-rules/preview`,
  `PATCH /regulatory-rules/:id`, `.../approve`, `.../reject`. Three new
  permissions seeded: `read_regulatory`, `create_regulatory`,
  `approve_regulatory`; `"regulatory"` added to `authMiddleware.js`'s
  `companyAllowedModules`.
- `fixtures/regulatory/synthetic-authority-fixture.{txt,pdf}` — the ~15-clause
  synthetic document (clearly marked as fictional/synthetic in its own text),
  containing the conditional withdrawal-period rule and the forbidden-content
  no-cure-claims rule the instructions specifically asked for.
- `tests/regulatory.ingestion.test.js` — consolidates T9/T11/T12 from §17 into
  one file (the underlying logic is one pipeline; three near-identical files
  each re-deriving the same fixture felt like duplication for its own sake,
  not real separation of concerns). 29 assertions, all against real logic
  (not mocks): hash dedup, citation verification (accept + reject), targetPath
  validation, constraint-kind validation, the `UNVERIFIABLE`/
  `NO_AUTHORITATIVE_REQUIREMENTS` fallback, an actual compiled conditional
  rule firing correctly through `ruleValidator` (and correctly NOT firing for
  an exempt species), coverage math, and the full approve/block/clear/approve
  gate sequence.

**Decisions not in the doc:**
- Kept `extractedText`/`extractedData` as their pre-existing UNMAPPED physical
  column names (not `extracted_text`/`extracted_data` as §5.6's snippet shows)
  — renaming an existing column is exactly what the additive-migration rule
  forbids. `schema.prisma`'s `RegulatoryDocument` model has a header comment
  explaining this.
- `title`/`authority`/`sourceType` are `String?` here, not `String` (required)
  as §5.6 shows — adding a required column with no default to an existing
  table isn't an additive migration. Same reasoning as Phase 1's
  `GeneratedLabel` deviations.
- `product_scope: TEXT[] NOT NULL DEFAULT '{}'`, `source_is_official: BOOLEAN
  NOT NULL DEFAULT false`, `status: TEXT NOT NULL DEFAULT 'pending_review'`
  ARE `NOT NULL` additions to the existing table — but every one carries a
  `DEFAULT`, so Postgres backfills automatically with zero data-loss risk
  regardless of existing row count. Same judgment call made (and flagged) for
  Phase 1's `reference_labels` catch-up migration — applying it consistently
  here rather than treating the rule differently case to case.
- `PATCH /regulatory-documents/:id/clauses/clear` isn't in §15's literal
  endpoint list — added because the 95% gate (§7.5) is meaningless without
  somewhere for a human to actually clear a false-positive uncovered clause.
- `POST /regulatory-rules/preview` scopes by matching the label's `country` to
  `approved` documents for that country, then runs every rule attached to
  those documents — §15 doesn't specify the exact scoping logic, only that the
  endpoint should exist.

**Verified:**
- `tests/regulatory.ingestion.test.js`: 29/29 — every deterministic piece of
  the pipeline (everything except the two actual Gemini calls) proven correct
  against the real fixture text, not synthetic stand-ins.
- Live HTTP run: uploaded the real fixture PDF through
  `POST /regulatory-documents` → task queued → `edaRequirementWorker` picked
  it up → **extraction failed cleanly after 5 real retries against the still-
  exhausted Gemini quota** (`RESOURCE_EXHAUSTED`, same constraint since
  Phase 0) — this proves the route→controller→queue→worker→geminiClient
  wiring is correct; the actual text-extraction call itself is what's blocked.
  `GET /regulatory-documents`, `GET /regulatory-documents/:id`,
  `GET /regulatory-rules` all verified live (200s, correct data) against a
  document created directly through `regulatoryDocumentService` (bypassing
  the blocked extraction step).
- `node tests/runAll.js`: 14/19 (added `regulatory.ingestion.test.js`). Same 5
  pre-existing failures, no new regressions.

**Deferred:** the two actual AI calls (`ruleCompiler.compile`,
`coverageAuditor.auditDocument`) against the real fixture document — blocked
by Gemini quota exhaustion, not code. Once quota resets: upload
`fixtures/regulatory/synthetic-authority-fixture.pdf` via
`POST /regulatory-documents`, then `POST /regulatory-documents/:id/compile-rules`,
then `.../audit-coverage`, and report the actual coverage number against the
~15-clause fixture (the instructions' "run it and report the coverage number"
step) — the harness/fixture/gate are ready, only the live numbers are missing.
`POST /regulatory-documents/:id/supersede` (§15) was not implemented — lower
priority than the core journey, no document has ever reached `approved` status
long enough to need superseding yet in this environment.

**Next phase should start with:** Phase 4 (retrieval, product ladder,
structured generation) — this is also where the pre-existing scope note about
counting references before building weighted retrieval/pgvector applies
(§16's own caveat: <30 references, skip it — `reference_labels` still has 0
rows in this environment).
