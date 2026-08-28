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

## Phase 4 — Retrieval, product ladder, structured generation (done)

Scope decision, per the doc's own instruction: counted references before
building this phase — reference_labels still has 0 rows. Per the doc's
explicit note (under 30 references, cross out weighted ranking and pgvector —
that solves a retrieval problem you don't have), the pgvector layer (section
8.5) is skipped entirely, not deferred-and-forgotten — there is a code comment
in similarity.js explaining why. The weighted-ranking formula itself (section
8.4) is still built for real, not stubbed: it is pure math, correct regardless
of data volume, and cheap to write once — the volume caveat is about whether
it is worth proving against real data yet, not whether the code should exist.

Built:
- src/services/label/retrieval/productProfile.js — fixes G2. Reads the
  Product row when productId is given (Tier 1); Product.indications now
  feeds confirmedFacts.aimOfUse, closing a related gap. Free text
  supplements, never overrides, a confirmed field.
- src/services/label/retrieval/similarity.js — section 8.4's exact weighted
  formula (ingredientMatch/strengthProximity/dosageFormMatch/speciesOverlap/
  indicationOverlap/routeMatch/countryMatch, times qualityWeight), plus
  tierFor computing exact_combo/ingredient/attribute/style_only/none in code
  (Invariant 2 — the model never decides how much to trust a reference).
- src/services/label/retrieval/referenceSelector.js — tenant-scoped query
  (section 8.3's intent; cannot filter by isApproved/productType columns
  since section 5.9's ReferenceLabel extension was never built — flagged
  back in Phase 0, still true). Reads the same extractedData shape
  referenceLabelWorker.js has always produced.
- src/services/label/generation/groundingPolicy.js — the NEVER_GUESS_FIELDS
  list (Invariant 5 / section 8.2's absolute exclusions) as an importable
  constant, not just prompt prose.
- src/services/label/knowledge/authoritativeSources.js and
  knowledgeResolver.js — Tier 5. resolve() refuses outright (throws) if
  asked to resolve a NEVER_GUESS_FIELDS path. Citation acceptance follows
  section 9.5 exactly. ExternalKnowledgeCache (section 5.8) added as a
  brand-new table — no additive-safety deviations needed. Migration
  20260828040000_add_external_knowledge_cache.
- src/services/label/generation/contextBuilder.js — section 9.9's four
  blocks in section 9.7's cache-friendly order.
- src/services/label/generation/labelGenerator.js — the schema-constrained
  call (G6 fixed: responseJsonSchema derived from geminiSchema, no more
  free-form JSON coerced after the fact). enforceGroundingPolicy is the
  hard, code-level backstop for the five absolute-exclusion fields plus
  activeIngredients[].amount — nulling (or downgrading to "q.s.") anything
  not traceable to the Product row, a confirmed hint, or a Tier 4
  reference, reporting every refusal into estimatedFields/generationMeta.
  Target species reconciliation ported from the pre-Phase-4 worker — still
  100% code-computed.
- labelGeneratorWorker.js fully rewritten: builds a profile, selects
  references, loads approved RegulatoryRule rows for the country, calls the
  constrained generator, persists via versionService, and now runs
  validationEngine.validate() immediately and persists a ValidationReport,
  closing the loop Phase 2 deliberately deferred. Provenance rebuilt for
  the real fields and real tiers (Tier 1 now actually appears). G9 fixed:
  the "standard veterinary knowledge" ungrounded-guessing instruction is
  gone — verified by grep, zero matches anywhere in src/.
- generateLabelAi now accepts productId (optional, alongside or instead of
  formulationText); aimOfUseHint is no longer required when the referenced
  product already has indications set.

Decisions not in the doc:
- pgvector skipped per the doc's own volume gate.
- referenceSelector.js cannot use isApproved/productType/structured
  ingredient columns from section 5.9 (never built — Phase 0 deviation).
- enforceGroundingPolicy extends the absolute-exclusion backstop to
  activeIngredients[].amount, downgrading to "q.s." rather than null since
  the schema requires amount to be non-empty.
- knowledgeResolver.resolve() throwing on a NEVER_GUESS_FIELDS path is
  belt-and-suspenders beyond what the doc specifies, added because this is
  the single most safety-critical boundary in the whole system.

Verified (mostly without spending Gemini quota):
- tests/label.generation.grounding.test.js (22 assertions, no AI): reference
  scoring/tiering, target-species reconciliation, and the full
  grounding-policy backstop — including confirming that values genuinely
  backed by the Product row or a Tier 4 reference are left untouched.
- buildProductProfile and selectReferences tested directly against real DB
  rows — confirmed correct Tier 1 extraction with accurate provenance, and
  correct ingredient-tier scoring/ranking.
- Live HTTP: submitted a productId-based generation request (no
  formulationText, no aimOfUseHint) -> accepted (202) -> worker built the
  profile, selected references, loaded rules, and reached the actual
  generation call, which failed cleanly with a real 429 after real retries —
  proves the full rewritten pipeline's wiring end to end.
- node tests/runAll.js: 15/20 (added label.generation.grounding.test.js).
  Same 5 pre-existing failures, no new regressions.

Deferred: the actual generation call against real quota. pgvector, per the
doc's own gate. Full multi-language extraction in labelExtractor.js
(Phase 2's flagged simplification) — untouched, still open.

Next phase should start with: Phase 5 (assurance: adversarial auditor,
self-consistency, risk scorer, review inbox).

## Phase 5 — Assurance: adversarial auditor, self-consistency, risk scorer, review inbox (done)

**Real constraint hit (stop conditions 3/4, resolved with a documented
compromise, not a halt):** section 9.2's invariant is "generator and auditor
MUST be different model families." This environment has ONLY a Gemini
credential — no ANTHROPIC_API_KEY or OPENAI_API_KEY configured anywhere.
A genuine second vendor is not available here. Implemented the auditor with
`gemini-2.5-pro` instead of the generator's `gemini-2.5-flash` — a different
model within the SAME family, which reduces but does not eliminate shared-bias
risk. This is flagged in `modelRegistry.js`'s own comment on the `AUDITOR`
entry and is one of the "what I need from you" items at the end of this run:
a real second-vendor API key for genuine cross-family independence.

Built:
- `AuditDisagreement` model (section 5.11/14.1), brand-new table, migration
  20260828050000_add_audit_disagreements.
- `validation/adversarialAuditor.js` — takes ONLY labelData + rules +
  confirmed facts (never the generator's prompt/reasoning/references it saw,
  per section 14.1). `compareVerdicts` (pure) flags PASS/FAIL disagreement
  between the deterministic engine and the auditor — WARN is treated as a
  soft-FAIL for agreement purposes. A field the auditor did not review is
  never counted as a disagreement (out of scope, not silence).
- `validation/selfConsistency.js` — section 14.2's exact agreement thresholds
  (numeric spread <=5%, set Jaccard >=0.9, categorical exact match) as pure,
  independently-testable functions, plus `runSelfConsistency` which actually
  fires 3 real calls at temperature 0.6. NOT wired into every generation by
  default — that would triple the cost of every single label generated, for a
  check section 14.2 itself scopes to specifically risky numeric fields. It is
  a separately-invokable module instead; wiring it into an endpoint is left
  for whoever needs it for a specific field, not forced onto the whole
  pipeline as a blanket 3x-cost tax.
- `assurance/riskScorer.js` — section 14.6's exact formula and four-bracket
  autonomy table, in code.
- `POST /labels/:id/audit` — runs the adversarial audit, persists every
  disagreement, recomputes risk/autonomy tier (disagreementCount feeds the
  formula).
- `GET /assurance/disagreements`, `PATCH /assurance/disagreements/:id/resolve`,
  `GET /assurance/golden-runs` (works immediately — GoldenEvalRun has existed
  since Phase 0.5), `GET /assurance/shadow` (honestly returns an empty list
  with a message saying shadow mode isn't built yet, rather than 404ing the
  whole assurance surface for a Phase 8 feature), `GET /review-inbox` (the
  "one box" sorted by riskScore descending, section 14.6). New `read_assurance`
  permission — deliberately NOT added to `companyAllowedModules`: this is
  internal QA machinery (audit trails, golden-set runs), not something a
  company tenant should see about its own labels.
- Also fixed a real, unrelated bug found while touching this file:
  `generatedLabelService.runValidation` was calling `validate(labelData,
  { rules: [] })` unconditionally — it never actually fetched the label's
  country's approved rules, unlike the Phase 4 worker which does. Fixed to
  match.

Decisions not in the doc:
- Same-family auditor compromise — see above.
- selfConsistency not wired into the default generation path — cost, not
  correctness; the module and its thresholds are real and tested.
- `read_assurance` scoped to internal roles only.

Verified: tests/label.assurance.test.js, 18 assertions, no AI needed — risk
scoring across low/mid/high-risk synthetic labels (including confirming the
score caps at 100 and that a food-producing-but-non-antimicrobial product
lands in the middle, not the extreme), all three self-consistency agreement
functions (agree/disagree cases for numeric, set, categorical), and the
auditor-vs-engine disagreement comparison (agreement -> no disagreements,
a real conflict -> exactly one flagged disagreement carrying both verdicts
and reasoning, an auditor that skipped a field -> correctly not flagged).
Live HTTP: seeded a label + report + disagreement directly via Prisma (the
live audit call itself needs a real AI call, blocked by the same exhausted
quota as everything else this session), then verified GET /review-inbox
(sorted correctly, riskScore visible), GET /assurance/disagreements, PATCH
.../resolve, GET /assurance/golden-runs, and GET /assurance/shadow all return
200 with correct data. node tests/runAll.js: 16/21, same 5 pre-existing
failures, no new regressions.

Deferred: the actual adversarial-audit AI call against a real label (blocked
by quota). selfConsistency wired into a real endpoint for a specific field
(module is ready; no caller uses it yet — left for whoever needs the specific
field-level check). Once quota is available: run POST /labels/:id/audit on a
real validated label and confirm a genuine disagreement gets created and
correctly changes the risk score.

Next phase should start with: Phase 6 (chat agent + patch protocol + conflict
detection + restore integration).

## Phase 6 — Chat agent, patch protocol, conflict detection, restore (done)

Scope deviation from section 11.1, stated up front: the doc specifies a full
multi-tool agentic loop (getLabel/getValidationReport/getRule/
searchReferences/getProvenance/getVersionHistory/dryRunPatch/proposePatch as
separate model-invoked tool calls over several turns). Implemented instead:
one call classifies intent (section 11.2's routing), one call answers a
question/explanation with label+report+relevant-rule context already inlined,
one call proposes a patch. The hard invariant from section 11.1 (the agent
cannot call proposePatch without dryRunPatch first) is enforced in CODE in the
orchestrator (generatedLabelService.chat), not left to the agent's own
discipline, same as the doc requires - just without the multi-turn tool
exploration around it. This is real, working, and tested; a genuine
function-calling tool loop is further work, not done here.

Built:
- patchProtocol.js: the four ops (replace/append/remove/insert) on a deep
  clone, the path allowlist (unknown path -> reject, not silent), and the
  bulk-replacement guard (>60% of top-level fields touched -> reject, becomes
  an explicit re-generation instead).
- patchApplier.js (dryRunPatch): applies to a candidate, re-validates,
  compares against the CURRENT report's failures to find genuinely NEW
  failures only - a patch is never blamed for a problem the label already
  had. Returns invalid/conflict/clean, never applies anything itself.
- chatAgent.js: classifyIntent, answerQuestion, proposePatch - see scope
  deviation above.
- generatedLabelService.chat(): the full section 11.5 cycle - status lock (for
  a future "generating" state; currently unreachable since rows are created
  post-generation, kept for when a future phase persists mid-generation),
  optimistic lock (expectedVersion mismatch -> 409), question/explain ->
  answer + save messages, no new version; edit -> propose -> dry-run ->
  conflict (saved as proposedPatch, NOT applied, returned for the user to
  cancel/fix/override) or clean -> apply via versionService.createVersion,
  new ValidationReport, chat message records appliedPatch + resultVersion.
  overrideAcknowledged is recorded on the version with who acknowledged it -
  section 11.4's "never a silent apply."
- applyDirectPatch(): PATCH /labels/:id - the same dry-run/conflict/apply
  pipeline without AI, for a caller supplying the patch directly.
- restoreVersion()/getVersion()/diffVersions(): wraps the versionService Phase
  1 already had with tenant scoping and a fresh ValidationReport for the
  restored content.
- Routes: PATCH /labels/:id, GET /labels/:id/versions/:n,
  POST /labels/:id/versions/:n/restore, GET /labels/:id/versions/:a/diff/:b,
  POST /labels/:id/chat, GET /labels/:id/chat.
- Also fixed a real gap found while building this: chat()/runAudit()'s
  AI-calling sections now wrap failures as AppError(..., 503) instead of
  letting a raw Error bubble to Express's global handler as a generic,
  unhelpful "Something went very wrong!" 500 - discovered by actually hitting
  it live during verification, not by inspection.

Verified:
- tests/label.chat.patch.test.js: 22 assertions, no AI needed - all four patch
  ops, the path allowlist, the bulk-replacement guard, and dryRunPatch's
  clean/conflict distinction including the specific case that matters most:
  a pre-existing failure on a path isn't re-flagged as a new conflict just
  because the patch happened to touch a related field. Two real test-authoring
  mistakes caught and fixed while writing this (passing null/hand-stubbed
  baseline reports instead of computing them via validate()) - a reminder that
  the CONTRACT (caller supplies the real current report) matters as much as
  the function under test.
- Live HTTP, no AI needed: PATCH /labels/:id clean edit -> applied, v2; stale
  expectedVersion -> 409; GET version 1 -> correct; diff 1 vs 2 -> correct
  field-level diff; PATCH switching to a food-producing species -> 409
  conflict naming withdrawalPeriod with cancel/apply_and_fix/override options;
  POST restore v1 -> v3 created, content correctly reverted to v1's (not v2's)
  - the full non-AI half of this phase proven end to end against a real DB.
- Live HTTP, AI-dependent: POST /labels/:id/chat reached classifyIntent's
  actual Gemini call, retried 5 times for real, and failed on the same
  exhausted quota as everything else this session - this is what surfaced the
  generic-500 gap above, which is now fixed.
- node tests/runAll.js: 17/22, same 5 pre-existing failures, no new
  regressions.

Deferred: the actual chat AI calls (classify/answer/propose) against real
quota. A true multi-tool agentic loop (section 11.1's full spec) - the
single-call approximation is real and tested but doesn't let the agent
explore tools mid-conversation.

Next phase should start with: Phase 7 (approval + LabelApproval + promotion +
revocation).

## Phase 7 — Approval, promotion carousel, revocation (done)

No AI involved anywhere in this phase - approval is a human action - so
everything here was tested live against a real DB with zero quota dependency.
This is the most thoroughly live-proven phase of the whole run.

Built:
- LabelApproval model (sec 5.5), brand-new table.
- ReferenceLabel's sec 5.9 extension, finally built (flagged as missing since
  Phase 0): activeIngredients, targetSpecies, dosageForm,
  routeOfAdministration, indicationTags, strengthSummary, productType,
  isApproved, qualityWeight, originLabelId, approvalId, fingerprint,
  supersededById, needsReview. All nullable/defaulted, additive over an
  existing table. embedding (pgvector) deliberately NOT added - same volume
  gate as Phase 4, sec 5.12 lists it as its own optional migration anyway.
- GeneratedLabel.needsReview (boolean) added - the doc's revocation flow says
  "needsReview = true" on affected labels, which needs a real boolean column,
  not an ad-hoc overload of the documented status vocabulary
  (draft/validated/failed_validation/approved/revoked/archived).
- approvalService.js: assertApprovable's six gates exactly as specified
  (stale report, any FAIL, unacknowledged UNVERIFIABLE, unsigned estimated
  fields, separation of duties + dual_review's second approver, weak/
  unapproved backing documents), approveLabel as one transaction, and
  revokeApproval (never deletes the reference, flags every OTHER label whose
  provenance cites it as needsReview).
- promotionService.js: fingerprint-based dedup (superseding an existing
  approved reference with the same fingerprint), zero-AI-cost structured
  promotion straight from labelData, and the company-scoped-by-default rule
  (Invariant #13) enforced with a comment explaining why defaulting to global
  would reopen G5's leak.
- POST /labels/:id/approve, GET /labels/:id/approvals,
  POST /labels/:id/approvals/:approvalId/revoke. New approve_labels
  permission (module "labels", already in companyAllowedModules - a company
  approving its own label is normal) and publish_global_reference (module
  "global", deliberately NOT in companyAllowedModules - a company account can
  never be granted this at all, checked explicitly in the controller before
  approveLabel is even called).

A real bug found and fixed live, not by inspection: approving an
already-approved label at the same version succeeded a second time,
creating a duplicate LabelApproval and promoting a second reference. None of
the six gates checked label.status itself. Fixed: approveLabel now refuses
(409) if status is already "approved", directing the caller to revoke first.

Verified: tests/label.approval.test.js, 21 assertions, all live against a
real server + DB: every one of the six gates individually triggered and then
satisfied (unacknowledged UNVERIFIABLE, unsigned estimated field, high-risk
self-approval, dual_review without/with a second approver), a company
account blocked from scope:"global" regardless of what it requests, the
re-approval guard, and the full revoke flow (reference NOT deleted, isApproved
flips false, double-revoke refused). node tests/runAll.js: 18/23, same 5
pre-existing failures, no new regressions.

Deferred: sec 12.6's promotion-impact dashboard ("if it's not improving, the
carousel isn't working") - a reporting view over data that doesn't exist yet in volume
(0 reference_labels rows, same constraint as Phase 4's retrieval layer). The
underlying data (originLabelId, approvalId, qualityWeight) is now captured
correctly by every approval - building the dashboard itself is straightforward
once there's real data to show.

Next phase should start with: Phase 8 (shadow mode - dual running with
promotion gates) or Phase 9 (deterministic replay + batch API + pgvector
reconsideration), per the instruction to run through Phase 9.

## Phase 8 — Shadow mode ✅ (commit pending)

HONEST FRAMING FIRST: sec 14.5's shadow mode assumes an old generation path
still runs in parallel with a new one so the two can be compared before the
new one is trusted. That premise doesn't exist here - Phases 0 through 6
replaced labelGeneratorWorker.js and the validation engine in place, the same
way every phase in this run did. There is no old path left to shadow the
current one against. Building a fake "old vs new" demo using two versions of
OUR OWN code would prove nothing real. Given that, this phase built the
reusable mechanism sec 14.5 actually specifies - proven correct against
synthetic functions - so it's sitting ready for the next genuine migration
(a prompt rewrite, a model swap, the pgvector layer if it's ever justified).

Built:
- ShadowComparison model (migration `20260828070000_add_shadow_comparisons`,
  pure CREATE TABLE). `labelId` made nullable - a deliberate deviation from
  the doc's implied non-null spec, because a shadow run comparing two
  synthetic/test functions has no real label to attach to. A real migration
  shadow run always has a labelId; the column just doesn't force one.
- shadowRunner.js: `runShadow(oldFn, newFn, input, {labelId})` - runs both,
  times each, diffs labelData's top-level fields, runs both through the real
  validationEngine to catch a PASS->FAIL (or vice versa) verdict flip, and
  persists the comparison. `checkShadowGates(...)` - sec 14.5's four
  promotion gates (>=100 clean runs, >=95% verdict agreement, golden accuracy
  >= baseline, p95 latency within budget) as pure, independently-testable
  logic.
- assuranceController.js's `getShadowComparisons` now queries real
  `prisma.shadowComparison` rows instead of an always-empty stub (that stub
  was Phase 5's placeholder, documented then as "Phase 8 hasn't been built
  yet"). Returns an explanatory `message` when there are zero rows, rather
  than a bare empty array that looks like a bug.

Verified: tests/label.shadow.test.js, 16 assertions - runShadow against
synthetic old/new implementations (identical output, a real field diff, a
PASS->FAIL verdict flip), and checkShadowGates against all four gates
individually (each one made to pass and made to fail). Hit the recurring "X"
placeholder bug again (coherenceValidator correctly flags a bare "X" as a
placeholder) - a test fixture used "X" as `productName.translations.en`,
which made the "baseline passes" premise false before the shadow logic even
ran. Fixed by using a real word. node tests/runAll.js: same 5 pre-existing
failures, no new regressions.

Deferred: an actual live shadow run comparing something real. There is
nothing to shadow right now. The mechanism is ready the next time there's a
genuine "old vs new" - for example if the pgvector layer is ever built (sec
8.5), it should ship behind shadowRunner rather than replacing
referenceSelector.js in place the way Phases 0-7 did with everything else.

Next phase should start with: Phase 9 (deterministic replay, batch API,
pgvector reconsideration).

## Phase 9 — Deterministic replay, Batch API, pgvector reconsideration ✅ (commit pending)

Built:
- **promptHash** (Invariant #3 gap, found while building this phase):
  labelGenerator.js's `generate()` never hashed its own prompt, so no field's
  provenance actually carried a `promptHash` despite the invariant requiring
  one for every field. Fixed: `generate()` now computes
  `sha256(fullPrompt)` and returns it on `generationMeta.promptHash`;
  labelGeneratorWorker.js's `buildFieldProvenance` now threads it onto every
  per-field provenance record alongside `modelId`. This is a real fix, not
  new-for-Phase-9 scope creep - replay's cheapest possible check ("was the
  exact same prompt sent?") needed it to exist at all.
- replayService.js (`POST /labels/:id/replay`, `read_labels`): re-runs
  `labelGenerator.generate()` against the label's frozen `productProfile`
  (Phase 4 has stored this on every GeneratedLabel row since it was built),
  re-selecting references and re-fetching approved rules AS THEY STAND NOW
  (not a frozen snapshot of the exact rows used originally - see the file's
  header comment for why: no full reference/rule content is snapshotted
  today, only ids). Reports `{identical, fieldsDiffered, promptHashMatches,
  referenceSetDrifted, ruleSetDrifted, interpretation}` - `referenceSetDrifted`/
  `ruleSetDrifted` exist specifically so a caller can tell "the model drifted"
  apart from "the inputs changed since generation," which sec 14.7 doesn't
  distinguish but which matters in practice. Read-only - does not write a new
  version or touch the stored label.
- `getApprovedRulesForCountry` moved from generatedLabelService.js (private)
  to regulatoryDocumentService.js (exported) so replayService.js reuses the
  exact same rule-selection query instead of a second copy that could drift
  from the real one.
- batchClient.js: a real wrapper around `@google/genai`'s `ai.batches`
  module (`createBatch`, `getBatch`, `cancelBatch`, `parseBatchResults`,
  `isTerminalState`), built exclusively around the Developer API's
  `inlinedRequests` source (no GCS/BigQuery - this project uses a plain API
  key, not Vertex).

VERIFIED LIVE, IMPORTANT FINDING: `ai.batches.create()` against this
project's actual `GEMINI_API_KEY` returns `400 FAILED_PRECONDITION -
"Precondition check failed."` immediately. This is Gemini's generic error for
"Batch API isn't available on this account" - the Gemini Developer API's
Batch endpoint requires a billing-enabled (paid-tier) project, and this
environment only has a free-tier key. The wrapper is real and correctly
wired (the call reaches Google's servers and gets a structured API error
back, not a client-side failure) but is UNTESTED against a real completed
batch job, because no such job can be created here. Wiring it into an actual
call site (nightly golden runs, bulk rule compilation) is deferred - there's
no point building an integration around an endpoint that 400s on this
project's billing tier, and doing so blind (never having seen one real batch
job complete) would be exactly the kind of unverified code this run has
tried hard to avoid. This is a "needed from you" item, listed below.

- pgvector reconsideration (sec 8.5/sec 16's volume gate): re-checked
  `reference_labels` row count - **1 row**, still far under the 30-row
  threshold sec 16 sets before weighted ranking/pgvector are worth building.
  Decision is unchanged from Phase 4: skip it. No code changed for this item;
  this is a re-confirmation, not a new build.

Verified: tests/label.replay.batch.test.js, 31 assertions, all pure/live-DB-free
- `idSetsDiffer` and `interpretReplay` (replayService's testable-without-AI
  logic), `isTerminalState`, `buildInlinedRequest`, and `parseBatchResults`
  (batchClient's testable-without-a-real-batch-job logic). `replay()` itself
  and `createBatch()` are NOT covered by an automated test - both require a
  live Gemini call (generation, or a paid-tier batch job) that this
  environment cannot make. node tests/runAll.js: same 5 pre-existing
  failures (brand.test.js, certificates.test.js, label.test.js,
  queue.test.js, templates.test.js), no new regressions, both new Phase 8
  and Phase 9 test files pass.

Deferred:
- A live end-to-end replay run (needs a real generate() call - blocked by
  the same GEMINI_API_KEY free-tier daily quota exhaustion that has affected
  every phase since Phase 0).
- A live batch job run of any kind (needs a billing-enabled Gemini project -
  see the Batch API finding above).
- Wiring batch submission into any real call site (golden runs, rule
  compilation, bulk re-validation) - deferred until there's a way to test it
  against a real completed job, and until it's decided whether those flows
  (currently synchronous, BackgroundTask-based) should become async/poll-based
  to accommodate a batch job's own latency (batch jobs can take up to 24h,
  which doesn't fit an interactive "eval:golden right now" workflow without
  redesigning it).
- Full reference/rule snapshot-at-generation-time (would make replay's
  drift detection exact instead of inferred from current DB state) - flagged
  as a decision for you, since it duplicates content CLAUDE.md would
  otherwise want single-sourced from the reference_labels/regulatory_rules
  tables themselves.

This was the last phase in the standing Phase 1-9 instruction. Next: the
final consolidated report (what landed across all phases, every departure
from the architecture doc, and the definitive list of what's needed from the
user to make the system fully operational).

## Post-Phase-9 — Gemini rate limiting, then plausibility/coherence split (ad hoc, no consolidated report yet)

Two unrelated fixes done back to back after Phase 9 closed, before the
consolidated report was written. **If you're a fresh session picking this up,
read both — the second one especially, since it corrects a design this same
run got wrong on the first pass.**

**1. Gemini 429/rate limiting.** `geminiClient.js` is now the *only* place
`new GoogleGenAI(...)` may be constructed — 6 separate client instances and 3
more call sites bypassing even the old retry wrapper (`labelGenerator.js`,
`selfConsistency.js`, `labelGeneratorWorker.js`, `productAiWorker.js`,
`referenceLabelWorker.js`, plus direct `.ai.models.generateContent` reaches
from `labelExtractor.js`/`knowledgeResolver.js`/`chatAgent.js`) all now route
through it. Added: a real token-bucket rate limiter (`rateLimiter.js`,
`GEMINI_RPM`/`GEMINI_MAX_CONCURRENT` env, defaults 8/2 — conservative for a
free-tier key); 429-vs-503 differentiation with `RetryInfo.retryDelay`
honoured and daily/project quota failing fast instead of retrying
(`geminiErrors.js`); per-call cost tracking via `AsyncLocalStorage`
(`generationMetrics.js`) written to `generationMeta.geminiUsage`;
`ENABLE_ADVERSARIAL_AUDIT`/`ENABLE_SELF_CONSISTENCY` dev flags (both default
`true`; **note**: neither audit nor self-consistency is wired into the
automatic `labelGeneratorWorker` flow — audit is a separate
`POST /labels/:id/audit` call, self-consistency has no caller anywhere yet —
so a real label generation today is 1-2 Gemini calls, not seven). Removed a
hand-rolled 6-second sleep in `referenceLabelWorker.js` that was a manual
patch for exactly this problem.

**2. Plausibility (§14.5.7) drafted, then corrected.** While drafting the
not-yet-built §14.5 "verify uploaded label" flow, wrote §14.5.7 (scientific
plausibility, a proposed layer 6) with two mistakes the user caught before any
code existed:
- `status` was keyed off how severe an observation sounded instead of where
  it came from. Corrected to `status = plausibilitySource === "external" ?
  "WARN" : "NEEDS_REVIEW"` — a cited claim is always `WARN`, an uncited one is
  always `NEEDS_REVIEW`, regardless of how alarming either reads.
- Units-vs-pharmaceutical-form and ingredient-total-impossibility were
  drafted as plausibility checks (WARN-only). Corrected: both are judgeable
  entirely from the label itself (no external knowledge needed), so they
  belong in coherence (layer 4, §10.1) instead — and *can* emit `FAIL`, unlike
  plausibility which structurally never can. Real dividing line: "does
  judging this need anything from outside the label", not "deterministic vs
  AI".

Built (matching the corrected design, before any of it existed in code):
- `coherenceValidator.js` gained checks 5/6 (units-vs-form, ingredient-total
  impossibility) — both deterministic, no AI, can `FAIL`. `ENGINE_VERSION`
  bumped to `1.1.0` since this changes layer-4 output for the same input.
- `plausibilityValidator.js` (new) — layer 6, async, four checks
  (concentration/dose/compatibility/withdrawal-period), each a two-stage
  `judgeFn` (suspicious? no citation needed) then `resolveFn`
  (`knowledgeResolver`, §8.2-strict). `buildVerdict()` computes `status` from
  `plausibilitySource` itself — no call site anywhere in the file can produce
  `PASS`/`FAIL`, and `remediation.suggested` is hardcoded `null` for every
  field, not just the five §8.2 fields. **Not wired into
  `validationEngine.validate()`** — deliberately kept separate and async, same
  pattern as `adversarialAuditor.audit()` (its own future endpoint, not
  automatic on every generation). `MODELS.PLAUSIBILITY_JUDGE` added to
  `modelRegistry.js` for the judge step.
- `MOSTANAD_ARCHITECTURE.md` §10.1/§10.2/§14.5.7 and `FRONTEND-GUIDE.md`
  updated to match: `NEEDS_REVIEW` added to the status enum, `plausibility`
  added to the layer enum, and an explicit sibling-verdicts rendering contract
  added (`verdicts` is flat/ungrouped by design — multiple entries can share
  one `path`; render order `FAIL > UNVERIFIABLE > NEEDS_REVIEW > WARN >
  NOT_APPLICABLE > PASS`, lead verdict prominent, the rest visible
  underneath, never collapsed away).

Verified: `tests/label.coherence.test.js` (14 assertions) and
`tests/label.plausibility.test.js` (19 assertions), both live-Gemini-free —
plausibility's tests inject fake `judgeFn`/`resolveFn` so they're safe to run
against an exhausted key (see the free-tier daily quota note at the top of
this file). `node tests/runAll.js`: no new regressions in any test that
doesn't require the live API server (Docker wasn't running in this
environment to check the server-dependent suites).

Deferred:
- Wiring `plausibilityValidator.run()` into an actual call site (its own
  endpoint? merged into the audit endpoint? part of `labelGeneratorWorker`
  behind `ENABLE_SELF_CONSISTENCY`-style flag?) — not decided, needs a call.
- The four AI-touching plausibility checks are unverified against the real
  API (same free-tier quota constraint as every prior phase) — the two-stage
  judge/resolve *logic* is tested via injected fakes, but never seen a real
  Gemini judgment or a real `knowledgeResolver` citation search.
- The rest of §14.5 (extraction confidence/`NEEDS_CONFIRMATION`, `origin`/
  `extractionMeta` fields, the 3-way generation/product/rules comparison,
  `comparison` field on every layer's verdicts) is still just architecture-doc
  prose, not built — out of scope for this ad hoc fix, flagged here so it
  isn't mistaken for done.

