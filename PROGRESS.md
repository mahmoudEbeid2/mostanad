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

## Phase 10 — §14.5 Label Verification, Plausibility Wiring, Invariant #7 & Engine Parity ✅

**Built & Landed:**
1. **§14.5 Verification Schema & Migration:**
   - Added `origin` (String @default("generated")), `extractionMeta` (Json?), and `sourceFileRef` (String?) to `GeneratedLabel` model in `prisma/schema.prisma`.
   - Applied migration `20260828080000_add_label_verification_fields`.
   - Regenerated Prisma Client v7.8.0.

2. **Validation Engine (§10, §14.5) & Plausibility Wiring:**
   - Bumped `ENGINE_VERSION` to `1.2.0`.
   - Layer 6 Plausibility (`plausibilityValidator.js`) wired asynchronously into `validationEngine.validate()`. Status is strictly keyed off `plausibilitySource` (`"external"` -> `WARN`, `"model_knowledge"` -> `NEEDS_REVIEW`); no `PASS`/`FAIL` paths exist; `remediation.suggested` is strictly `null`.
   - Extraction Confidence Check (§14.5.3, T19): fields with extraction confidence < 0.75 emit `NEEDS_CONFIRMATION` with `comparison: "data_mismatch"`, `layer: "extraction"`, snippets, and bounding boxes. Low-confidence fields are excluded from product comparison and not failed at schema/applicability.
   - 3-Way Product Data Match (§14.5.1, T20): compares label data against DB `Product` row facts (`name`, `strength`, `pharmaceuticalForm`, `routeOfAdministration`, `withdrawalPeriod`, `registrationNumber`). Emits `status: "FAIL"`, `layer: "product_match"`, `comparison: "data_mismatch"`, and structured remediation with `source: "product_row"`.
   - Restricted Field Remediation Protection (Invariant #5, T21): `withdrawalPeriod`, `strength`, `amount`, `registrationNumber` never guess suggested values unless explicitly grounded in `source: "product_row"` or `source: "rule"`.
   - Engine Parity (§4.2, T23): deterministic verification engine uses the exact same core pipeline whether a label originated from AI generation or PDF/image extraction.
   - Verification Non-Completion (§14.5.4, T22): missing fields emit `FAIL` without hallucinating or auto-filling values.

3. **Label Extraction & Confirmation Services & Endpoints:**
   - `src/services/label/extraction/labelExtractor.js`: returns `extractionMeta` with per-field confidence, snippets, and bounding boxes.
   - `src/services/label/generatedLabelService.js`: implemented `getExtraction(id, { companyId })` and `confirmField(id, { path, value, expectedVersion, userId, companyId })`.
   - Exposed `GET /labels/:id/extraction` (`read_labels`) and `POST /labels/:id/confirm-field` (`update_labels`).
   - OpenAPI specifications added in `src/docs/paths/labels/labels-id-extraction.yaml` and `labels-id-confirm-field.yaml`; validated via `npm run docs:export`.

4. **Worker Invariant & Socket Fixes:**
   - Fixed Invariant #7 in `labelGeneratorWorker.js`: ingredient extraction failure is caught, `referenceGroundingFailed = true` and `matchTier = "none"` are recorded, and `UNVERIFIABLE` is emitted on reference-grounded fields.
   - Added `companyId` to all `job_status_update` socket events in `labelGeneratorWorker.js` and `edaRequirementWorker.js`.

5. **Model Registry & Rate Limiter Audit:**
   - Restored `RULE_COMPILE` and `COVERAGE_AUDIT` to `gemini-2.5-pro` in `modelRegistry.js`.
   - Verified that all 14 Gemini API call sites route through `geminiClient.generateContentWithRetry` with active token-bucket rate limiter.

6. **Test Suites Verified (T19–T23):**
   - `tests/verify.extraction.confidence.test.js` (T19) — PASSED (1/1)
   - `tests/verify.threeway.test.js` (T20) — PASSED (1/1)
   - `tests/verify.remediation.test.js` (T21) — PASSED (1/1)
   - `tests/verify.no_completion.test.js` (T22) — PASSED (1/1)
   - `tests/verify.engine_parity.test.js` (T23) — PASSED (1/1)



---

# Certificates V2

Spec: `CERTIFICATES_V2_PLAN.md` (decisions D1–D11, implementation log §20). Tests: `tests/certificates-v2/`, run by `npm test` on the guarded stack (`npm run dev:test`, `GEMINI_DISABLED=true`).

## Phase 0 — Safety ✅ (owner sign-off 2026-10-16)
Tenant-scoped background tasks + V1 template/certificate ownership (404 cross-tenant), V1 mock fallbacks removed, `generate-ai` → 410, `execFileSync` for Inkscape, permission parsing fixed (`permissionModule`) + 13 V2 permissions seeded, `GEMINI_DISABLED` guard + `npm test` preflight. `brand.test.js` fails pre-existing (brand logos removed in `7a0f57e`).

## Phase 1 — Foundations
**Plan**
1. Prisma (additive): `StoredFile`, `CertificateType`, `CertificateTemplate`, `TemplateVersion` + partial unique index on the template slot.
2. `storage/fileStore` (UUID paths under `uploads/certificates/{companyId}/`, sha256), `conversion/pdf2htmlexClient` (zoom 4/3, error mapping), `sanitize/htmlSanitizer` (allowlist + CSS sanitizer + `data-page`/`data-line`).
3. `engine/fieldEngine.browser.js` (`analyse`) + `engine/renderer.js` (one browser, page pool, network blocked, recycle at 200) + font coverage via fontkit.
4. Template service + `certificateTemplateWorker` `convert` job: upload → converting → draft (or failed `NO_PDF_CONTENT`/`NO_LIVE_TEXT`); thumbnail at 25%.
5. Routes: certificate types CRUD, `POST/GET /certificate-templates`, `GET /certificate-templates/:id`, `GET /template-versions/:id`, `…/html` (CSP + nosniff), `…/thumbnail`.
6. FE: `CertificateTypes`, `CertificateTemplates`, wizard step 1, `DocumentFrame`, `useTaskProgress`, `useCompanyScope`, Sidebar group "Certificates" (V1 under "Legacy").
7. Tests: sanitizer malicious corpus, fixtures `no_pdf_content.ai` / `outlined_text.pdf` / `malicious.html`, goldens convert → draft, sanitized-vs-raw pixel diff = 0, tenancy 404s.

**Report (2026-10-17) — ✅ done, awaiting owner sign-off**
- **Checked every plan item against the code (backend + `mostanad_front`):** all 7 present. Backend: migration `20261016160945_certificates_v2_foundations` (4 tables + partial slot index), `services/certificates/{storage,conversion,sanitize,analysis,engine,templates,types,jobs}`, `certificateTemplateWorker` (convert), `certificatesV2Routes` (types CRUD, templates create/list/get/patch/versions/archive, version get/html/thumbnail), compose + `runDev` entries. FE: `CertificateTypes`, `CertificateTemplates`, `CertificateTemplateWizard` step 1 (`UploadStep`), `DocumentFrame`, `AuthImage`, `CompanyPicker`, `StatusBadge`, `useTaskProgress`, `useCompanyScope`, Sidebar "Certificates" + "Legacy". Nothing was missing; `prepareEngine.js` (Phase 2) left untouched as instructed.
- **Exit criteria (§17):**
  - ADDVET + PHARMAVET upload → convert → `draft`; stored sanitized preview vs pdf2htmlEX raw output: **0 differing pixels** on both (`p1.foundations.test.js`). Page 793.69×1122.52 px = 595.27×841.89 pt; ADDVET 33 lines, PHARMAVET 27.
  - Malicious HTML neutralised: static corpus (45/45, `sanitizer.test.js`), in a real browser nothing runs and nothing is fetched, stored file + `/html` headers (CSP `default-src 'none'`, `nosniff`).
  - Tenancy: every type/template/version/html/thumbnail/task route → 404 for another company.
  - UI: `ui-smoke.mjs --phase 1` against Vite + the guarded stack: **13/13**, zero console errors (types empty state → create, upload ADDVET, sandboxed preview `allow-same-origin` only, 33 lines, addressable URL, thumbnail).
- **Tests:** `npm test` on `npm run dev:test`: **45/46 suites**; the only failure is the pre-existing `brand.test.js` (Phase 0 note). `p1.foundations` 70/70. `oxlint` on all V2 frontend files: clean (remaining warnings are pre-existing in V1/other pages).
- **Found & fixed (local dev DB only):** the DB had drifted again: `_prisma_migrations` listed all 24 migrations as applied (2026-10-16) but 16 tables were missing (all 4 Certificates V2 tables, `generated_labels`, `regulatory_*`, `label_*`, …) and `companies.logo_url` was gone. `prisma migrate status` only reads the ledger, so it reported "up to date". With owner approval, applied `prisma migrate diff` (live → `schema.prisma`) **minus** its only destructive statement (`DROP TABLE eda_requirements`, not in `schema.prisma`), plus the raw-SQL slot index, in one transaction; then re-ran the idempotent seed. Remaining diff: only that deliberately-skipped drop. `scripts/checkSchemaDrift.sql`'s table list predates Certificates V2 (it reports the V2 migration as a phantom); left as is.
- **Deferred:** API docs (`src/docs/paths`, FRONTEND-GUIDE, API-CHANGES) — §17 puts docs in Phase 6.

**Re-verified 2026-10-18** (a resume prompt assumed Phase 1 was unfinished; it was not — Phases 1–2 were done and Phase 3 was mid-flight). All 7 plan items present; `npm test` 49/50 (only pre-existing `brand.test.js`); `p1.foundations` 71/71 (both goldens → `draft`, sanitized vs raw **0 differing pixels**; malicious corpus neutralised; every route 404 cross-tenant); UI smoke phase 1 13/13, zero console errors; `oxlint` clean on V2 files.
- **Bug found & fixed (Phase 1 code):** `optionalUuid`/`optionalCountry` in `certificatesV2Validator.js` turned an *absent* key into `null`, so `PATCH /certificate-templates/:id { name }` silently cleared the template's brand and country (and `PATCH /invoices/:id { header }` the invoice's brand hint and destination country); `"null"` became country `"NULL"`. Absent now stays absent; `""`/`"null"`/`null` clear. Regression assertions in `p1.foundations` and `p3.invoices`.
- **Root cause of the recurring "DB drift" found:** `scripts/start.sh` runs `prisma db push --accept-data-loss` whenever `NODE_ENV` ≠ production. The `mostanad-app` container (`restart: always`, image with a stale pre-V2 schema) runs it every time Docker Desktop starts → every table/column its old schema lacks is dropped, while `_prisma_migrations` keeps saying "applied". It happened again on 2026-10-18 (17 tables left). With owner approval: restored by the same additive-only `migrate diff` as before (no `DROP`; skips `DROP TABLE eda_requirements`) + the slot index + idempotent seed; the 9 app/worker containers set to `restart=no` locally (reversible: `docker update --restart=always …`). **`start.sh` left unchanged by owner decision — it will wipe the DB again whenever a stale app image starts.**

## Phase 2 — Fields & prepare
**Plan**
1. Prisma (additive): `TemplateField` (§6.1 + D10 `origin`/`confirmed`).
2. Fields API: `PUT /template-versions/:id/fields` (§8.2 validation against lines **and** the real layout), `GET /certificate-field-sources` (generated from the Prisma `Product` model + invoice schema).
3. Engine: `inspect` (server-side "suggest center", D11), `clear` + gate (§7.3/§7.6, `prepareEngine.js`), `fill`.
4. `prepare` job → `ready` / back to `draft` with report + diff image; `activate` (D10: refused while a field is unconfirmed), `new-version` clone, `preview` (values / product), `html?variant=sample`; optional `suggest` (CERT_ASSIST).
5. FE: wizard steps 2–5 — `FieldMarker` (selection → one field per line, Ctrl/⌘ multi-select, Enter/Esc, CSS Custom Highlight API + overlay fallback), `FieldPanel`, `SourcePicker`, `PrepareReport`, test fill, activate.
6. Tests: §16.2 golden field sets through the engine, Phase 2 API suite, `valueResolver` (§16.3), UI smoke phase 2.

**Report (2026-10-17) — ✅ done, awaiting owner sign-off**
- **Backend:** migration `20261017120000_certificates_v2_template_fields`; `templates/{sourceCatalogue,fieldService,prepareService,assistService}.js`, `generation/{valueResolver,contextLoader}.js`, `invoices/invoiceSchema.js`; engine `inspect`; worker `prepare` handler; 9 routes; `INVOICE_EXTRACT` + `CERT_ASSIST` in `modelRegistry.js`.
- **Frontend:** `FieldMarker`, `FieldPanel`, `SourcePicker`, `PrepareReport`, `FlagBadges`, `wizard/{Fields,Settings,Prepare,Activate}Step`, `utils/certificateFieldSources.js`, API functions; `DocumentFrame` got an `overlay(scale)` layer (never touches the document).
- **Exit criteria (§17):** both golden field sets pass the gate — ADDVET pixel diff **0.0107 %**, PHARMAVET **0.0173 %** (≤ 0.05 %), every field calibration and round-trip ≤ 0.005 px (`engine.golden.test.js` 55/55, `p2.fields_prepare.test.js` 73/73). Anchoring: longer/shorter values move neighbours ≤ 0.011 px; centered fields keep their center ≤ 0.5 px; 3× values beyond limits → `shrunk`/`overflow`, neighbours unmoved; `B`/`X` on ADDVET → `glyph:BX`. UI: `ui-smoke.mjs --phase 2` **32/32**, zero console errors — marks 3 fields on ADDVET in the browser (single, Ctrl-multi, multi-line split, highlights, autosave), prepares (gate passes in the UI), test-fills on the server, activates. *Owner still to do:* mark and activate both templates himself.
- **Tests:** `npm test` 47/48 suites (only pre-existing `brand.test.js`); `valueResolver.test.js` 39/39; `oxlint` clean on all V2 files; `vite build` OK.
- **Owner decision taken during the phase:** §7.3 vs §16.2 overflow conflict → **text margins** (plan §20 I10).
- **Bugs found & fixed:** engine scale was measured via integer `offsetWidth` → up to 0.71 px neighbour drift on long values (I11, now ≤ 0.011 px); "suggest center" never fired on PHARMAVET with the literal 2 px (I7); `valueResolver` could read `constructor`/prototype paths — now own properties only, unmatched `{{…}}` → empty; FE sent `null` JSON bodies that Express rejects (also affected Phase 1's archive call).
- **Decisions logged:** plan §20 I7–I13 (center heuristic, `fields/confirm` route, `CERT_ASSIST_ENABLED`, text-margin limits, probe scale, diff images + stale report flag, resolver built early).
- **Deferred:** suggest (CERT_ASSIST) is wired and guarded but untested against the live API (tests never call Gemini). Found: V1 `GET /products` is not tenant-forced (filters by query string only) — outside certificates scope, **not fixed**, flagged for the owner; V2 screens use the new tenant-forced `GET /certificate-products` instead (plan §20 I14).

## Phase 3 — Invoices
**Plan**
1. Prisma (additive): `Invoice`, `InvoiceItem` (§6.1).
2. Upload (`POST /invoices`, magic bytes, ≤ 15 MB) → `extract` job (`INVOICE_EXTRACT`, native file, `responseSchema`, raw output frozen, dates → ISO only when unambiguous) → automatic matching → `review`; failure → `failed` with the real message and zero items.
3. Matching (§9.2): exact code → exact normalised name → ranked candidates; tenant-scoped; manual matches/ignores survive re-matching.
4. Review (§9.3): header/item edits, add/remove lines, manual match, ignore, confirm → `ready`; editing a confirmed invoice re-opens it.
5. FE (§13.5, mockups B1–B3): invoices list + upload, reading loader, review (header card, items table, match select, original side by side).
6. Tests: extraction failure, matching (§16.3), review flow, tenancy 404s; UI smoke phase 3.

**Report (2026-10-18) — ✅ done, awaiting owner sign-off; one exit-criterion item needs the owner (below)**
- **Backend** (the previous session wrote most of it; finished and verified here): migration `20261017140000_certificates_v2_invoices`; `invoices/{invoiceService,invoiceExtractor,invoiceSchema,dateNormalizer}.js`, `matching/{productMatcher,productSearch}.js`, `invoiceWorker` (concurrency 1), 11 routes. Added: `POST /invoices/:id/retry` (plan §20 I17) and `GET /invoices?q=` (number/customer, case-insensitive, LIKE wildcards literal) for mockup B1.
- **Frontend:** `pages/Invoices.jsx` (B1: upload panel + recent invoices, search, per-status action; `/invoices/new` is the same page), `pages/InvoiceReview.jsx` (B2 loader with named stages + failure card with *Try again*; B3 original beside the details card, "edited" markers, needs-match banner, full-width lines), `components/certificates/{InvoiceUploadPanel,InvoiceItemsTable,ProductMatchSelect,InvoiceSourceViewer}.jsx`, `services/apiInvoices.js`, routes + Sidebar "Invoices". Built to the owner's mockups in `mostanad_front/design/certificates/` (found this session).
- **Exit criteria (§17):**
  - *Every line resolvable:* exact code / exact name / ranked candidates (brand bonus, reasons) / manual match from the tenant-forced catalogue search / ignore; confirm refused while any line `needs_match` (lists the lines). `p3.invoices` 71/71; UI smoke phase 3 **21/21**, zero console errors.
  - *Failures are explicit:* upload → `failed` with `EXTRACTION_FAILED: … GEMINI_DISABLED …`, zero items, zero certificates; shown verbatim in the UI; *Try again* re-runs the same extraction and fails the same explicit way.
  - *Real invoices extracted:* **not verifiable here — owner action.** No real invoice exists on disk (§16.1's `invoice_*.pdf` + `.expected.json` were never provided) and `npm test` is barred from Gemini. Added `tests/live/certificates.invoice_extract.live.mjs` (opt-in `GEMINI_LIVE=1`, never run by `npm test`): drop 2–3 anonymised invoices + expected JSON into `fixtures/certificates/` and run it; it reports every wrong value.
- **Tests:** `npm test` 49/50 (only pre-existing `brand.test.js`); `oxlint` clean on V2 files; `vite build` OK.
- **Bugs found & fixed:** the PATCH absent-key bug (see Phase 1 re-verification); Esc in an invoice cell *saved* the value (stale closure) — now reverts; the review table was squeezed into a horizontal scroll beside the original — re-laid out per B3.
- **Decisions logged:** plan §20 I15 (certificate key by invoice line), I16 (template selection per type *and* scope) — owner decisions taken now for Phase 4; I17 (retry route).

## Phase 4 — Generation
**Plan**
1. Prisma (additive): `CertificateBatch`, `Certificate`, `CertificateItem`, `CertificateVersion` (§6.1 + owner decision I15 `planKey`).
2. `templateSelector` (pure, §10.1 + I16), `valueResolver` (built in Phase 2), engine `fill` (built in Phase 2).
3. `POST /invoices/:id/generate` → batch + certificates in one transaction → `generateBatch` job (render worker, 2 pages in parallel) → version 1 per certificate, flags, `flagCount`; partial failure; idempotent by `planKey`.
4. Reads: `GET /certificate-batches/:id`, `GET /certificates`, `GET /certificates/:id`, `…/html`, `…/thumbnail`; plan preview.
5. FE (mockups B3/B4): plan preview, Generate, batch progress + certificate cards + gaps, generated-certificates list.
6. Tests: `templateSelector` matrix (§16.3), Phase 4 integration suite, UI smoke phase 4.

**Report (2026-10-18) — ✅ done, awaiting owner sign-off**
- **Backend:** migration `20261018120000_certificates_v2_generation` (4 tables, additive); `generation/{templateSelector,batchService}.js`, `certificates/certificateService.js`, `certificateRenderWorker` (+ compose ×3, `runDev`, `npm test` preflight), `certificateController`, 7 routes. `renderFilled` can return a page-1 thumbnail from the same render.
- **Frontend:** `PlanPreview`, `BatchView`, `CertificateCard`, `pages/CertificatesList.jsx` (`/certificates`, Sidebar "Generated certificates"), `services/apiCertificatesV2.js`; `InvoiceReview` gets the plan preview, "Confirm & continue", "Generate N certificates", the batch view (run selector, "Generate again") and "Show invoice & lines".
- **Exit criterion (invoice → correct certificates, values, flags):** `p4.generation` 54/54 against 4 real templates (both goldens; COA countryless + COA TR, collective FSC, brand-specific HC): 6 certificates for a 4-line invoice (ignored line skipped; same product on 2 lines → 2 COAs; FSC covers lines 1–3; HC only for the brand's lines, the other line reported as a gap); TR invoice picks the TR template. Values checked per source kind (item, product incl. `activeIngredients[1]`, invoice, company, `template` `COA{{item.batchNo}}`), formats (`MM/YYYY` from month and full ISO; ambiguous date → raw kept + `format`), `missing` on empty required values, `glyph:…` on characters absent from the subset font, `flagCount` = blocking flags. Static HTML has the values, not the design's samples, no script. A broken design fails only its own certificates (`partially_failed`, error on each); a retried job duplicates nothing; regenerate = new batch, old untouched; every route 404 cross-tenant. `templateSelector` 21/21. UI smoke phase 4 **13/13** (plan preview → Generate → live batch → 2 cards with server thumbnails → list/search), zero console errors.
- **Tests:** `npm test` all green except pre-existing `brand.test.js`; `oxlint` clean on V2 files; `vite build` OK.
- **Decisions logged:** plan §20 I15/I16 (owner), I18 (`pending` status, thumbnails), I19 (plan-preview route).
- **Note:** a card links to `/certificates/:id` — the editor is Phase 5.

## Phase 5 — Edit, export, finalize
**Plan**
1. `PATCH /certificates/:id/values` (optimistic concurrency → 409 `VERSION_CONFLICT`), reset a field from its source, versions list, forward-only restore.
2. PDF export (P7/P8: `screen` media, `@page` = `.pf` size, no margin, one `.pf` per page) as a job; download with `{type}-{product}-{batch}.pdf`; batch ZIP.
3. Finalize (refused while blocking flags remain; PDF frozen) / duplicate; a final certificate rejects every change (409 `CERTIFICATE_FINAL`).
4. FE (§13.6, mockup B5): `CertificateEditor` (server-rendered frame, instant ephemeral preview, 1 s autosave / Ctrl+S, Esc reverts, conflict dialog), `CertificateValuesForm`, `VersionsDrawer`, export, finalize, duplicate; "Download all (ZIP)" on the batch view.
5. Tests: §16.2 PDF acceptance on both goldens, Phase 5 API suite, UI smoke phase 5.

**Report (2026-10-18) — ✅ done, awaiting owner sign-off**
- **Backend:** `certificates/editService.js`, `renderer.printPdf`, render-worker jobs `exportPdf` / `exportZip`, 10 routes (`…/values`, `…/fields/:key/reset`, `…/versions`, `…/versions/:n/restore`, `…/export-pdf`, `…/pdf`, `…/finalize`, `…/duplicate`, `certificate-batches/:id/export`, `…/zip`). Downloads expose `Content-Disposition` to the cross-origin app (that response only; the app-wide CORS is unchanged).
- **Frontend:** `pages/CertificateEditor.jsx` (`/certificates/:id`), `CertificateValuesForm`, `VersionsDrawer`, API functions + `waitForTask`; `BatchView` "Download all (ZIP)".
- **Exit criteria (§17):**
  - *Full loop on both goldens:* generate → edit → reset → versions → restore → export → finalize → duplicate, `p5.edit_export` **53/53**; UI smoke phase 5 **22/22** (all phases 87/87, 3 consecutive green runs), zero unexpected console errors (the deliberate 409 is declared by the test).
  - *PDF acceptance (§16.2), both goldens filled with their own sample values and exported through the API:* 1 page; page size = source **Δ 0.32 × 0.03 pt** (≤ 0.5); text real and extractable; visual diff vs the source at 100 dpi **1.61 % (ADDVET), 1.64 % (PHARMAVET)** (≤ 3 %).
  - Concurrency: two simultaneous edits of the same version → exactly one 200, one 409; the frozen PDF of a final certificate is byte-identical in `GET …/pdf` and in the ZIP. Every new route 404 cross-tenant.
- **Tests:** `npm test` 52/53 (only pre-existing `brand.test.js`); `oxlint` clean on V2 files; `vite build` OK.
- **Bug found & fixed (Phase 1 component):** `DocumentFrame` unmounted its iframe on every reload; Chrome's async `about:blank` navigation of the new sandboxed frame could wipe the freshly written document → an intermittently blank editor frame after a save (reproduced 1 in 2 runs). The iframe now stays mounted and is rewritten once if replaced; 3/3 green after.
- **Decisions logged:** plan §20 I20–I22.

## Phase 6 — Hardening
**Plan**
1. Idempotency audit of every job entry point (convert, prepare, extract, generateBatch, exportPdf, exportZip).
2. Daily cleanup job: orphan `StoredFile`s > 24 h, stuck tasks > 30 min → failed with a reason (§15).
3. Metrics (§15) + app health reporting converter reachability.
4. Load test: 20 templates, a 50-line invoice, < 3 min on free-tier RPM.
5. Docs: `src/docs/paths`, `FRONTEND-GUIDE.md`, `API-CHANGES.md`, `npm run docs:export`; manual QA script (§16.3).
6. Zero console errors.

**Report (2026-10-18) — ✅ done, awaiting owner sign-off**
- **Idempotency audit — 2 real bugs found & fixed:** (1) `convertVersion` skipped a retry only for `draft`: a late retry for an already **active** version re-converted it and reset it to `draft`, silently deactivating a live template — it now runs only from `uploaded`/`converting`. (2) `runPrepareJob` threw for a retry after activation (spurious failed task) — now skipped for `ready`/`active`/`superseded` with the same field hash. Every entry point run twice: no duplicate rows or files (`exportZip` replaces the batch's ZIP; the old one is cleaned as an orphan).
- **Maintenance:** `maintenance/maintenanceService.js` — orphan files (references gathered from every file column + `prepareReport.diffImages` JSON; > 24 h only, so a file written just before its row is never touched; certificate versions are never orphans) and stuck tasks (task → `failed` "STUCK: …"; its version → `failed`/`draft`, invoice → `failed`, batch → `failed`/`partially_failed` with pending certificates failed and the invoice released). Scheduled with a BullMQ job scheduler on the render queue, daily 03:00 (`CERT_MAINTENANCE_CRON`), verified registered.
- **Metrics:** `GET /certificate-metrics?days=` — conversion ms (avg/p95), prepare pass rate, render ms per certificate + batch ms (now recorded in `CertificateBatch.counts`), flags per batch, extraction failures by reason. **Health:** `GET /api/v1/health` (public; booleans/timings only).
- **Load test** (`tests/load/certificates.load.mjs`, not in `npm test`): 20 active templates (4 types × any / brand / country / brand+country / per_invoice), 50-line SA invoice → **204 certificates in 24.9 s** (231 ms/certificate, 0 failed, 0 misrouted by the selector); + 60 s extraction allowance (1 Gemini call per invoice, inside the 8 RPM free tier) = **84.9 s < 180 s**.
- **Docs:** 46 OpenAPI path files / 53 operations generated into `src/docs/paths/certificates-v2/` (+ `_shared.yaml`), registered in `swagger.yaml` (7 tags); `npm run docs:export` OK, `redocly lint` valid (warnings are the house-wide missing `operationId`s). Fixed the stale `background-tasks` doc ("no tenant check" — tenant-scoped since Phase 0). `API-CHANGES.md` and `FRONTEND-GUIDE.md` Certificates V2 sections; manual QA script in `mostanad_front/FRONTEND-STATUS.md`.
- **Exit criteria:** load test passes; docs updated; zero console errors (UI smoke 87/87). `p6.hardening` 24/24; `npm test` 53/54 (only pre-existing `brand.test.js`).
- **Decisions logged:** plan §20 I23.
- **Deferred / owner:** the generator script for the OpenAPI files lives outside the repo (it was a one-off); the files say "generated" and are plain YAML to edit by hand from now on.

## Phase 7 — Repeating groups
**Plan** (§7.8, §17 row 7; owner decisions 2026-10-20 after the spike): SVG background only for versions with a group (`enable-groups` → a new draft version), detection of both sample-row shapes, an engine-proposed footer line the user can drag, fill with the pitch down to 85 %, `whenEmpty` dash/hide, overflow with "rows that fit", fixed rows as the fallback, the hairline fix, sources product list / invoice lines / manual, row editing. Continuation pages are a follow-up (§17 7b).

**Report (2026-10-21) — ✅ Step 2 done, awaiting owner sign-off**
- **Engine** (`fieldEngine.browser.js`): `normalizeBackground` (convert time, §20 I26), `inspectGroups` (shape `cell_list` / `table_rows`, frame, background classification, footer proposal, capacity, refusals), `removeGroupPlaceholders` (prepare), `fill(…, groups)` (rows cloned per item, `cell_list` vertical rules stretched, `table_rows` row drawings cloned per row, content between the band and the footer line moved by Δ, `hide` closes the gap, fixed rows cut the background). The SVG stays a base64 `<img>`; the engine decodes / edits / re-encodes it.
- **Backend:** migration `20261020120000_certificates_v2_repeating_groups` (additive: `template_versions.background_format` default `png`, table `template_groups`); `POST /template-versions/:id/enable-groups`; `PUT …/fields` with `groups` (validation incl. scope ↔ source, I28) + `groupDetection`; prepare gate check `groups` + round trip with the original rows; generation (`resolveGroups`: product list rows; invoice lines with each line's tenant-scoped product); preview; `PATCH …/values` rows (add / remove / reorder / edit = one version, summaries "5 rows → 6 rows", "rows reordered", "1 row edited"); group reset; `overflow` blocks finalize (already a blocking flag). The pdf2htmlex service takes `?bg=svg`; an older image is refused with `CONVERTER_OUTDATED`.
- **Hairline (decision 8):** reproduced in Chrome's PDF viewer (headless PDFium) on the raw SVG export — a grey box around ADDVET's signature block and PHARMAVET's stamp. Fixed by the blend rewrite (I26). The test now checks it the way the owner sees it (I27): exported vs **original** PDF, both in PDFium, new ink on blank paper; the raw export is a negative control (244 px / 46 px runs, normalised ≤ 23 px, limit 30). PHARMAVET's red header brackets print solid in the export: they print solid in the original PDF too (0.25 pt strokes at the viewer's minimum line width) — not a defect, no change.
- **Frontend** (`mostanad_front`): `GroupPanel` (enable groups on a PNG version; add group; label/key, source + list, mode, when empty, required; detection result; refusal with "Use fixed rows"; footer line state + "Use the proposal"), `GroupOverlay` (band tinted, footer line draggable with mouse and arrow keys), `FieldPanel` "Row of group" + cell sources (`row` paths of the group, fixed text, typed), `GroupRowsEditor` in the certificate editor (rows table: add, delete, move up/down, edit cells; flags, "Only N rows fit", capacity), `apiCertificateTemplates.enableGroups` / `saveFields(…, groups)`.
- **Tests:** `p7.groups.golden.test.js` **136/136** — both goldens × N = 0 dash / 0 hide / 1 / sample count / 2× / overflow (rows, pitch, Δ, footer + watermark + side band unmoved, N = 1 = a normal row, original rows 0 % vs the design, PDF 1 page A4 + extractable text + no hairline), round trip ≤ 0.05 % (ADDVET 0 %, PHARMAVET 0 %; fixed rows 0.0095 %), fixed rows on SVG and PNG, refusals (raster → `GROUP_NEEDS_SVG`, one combined stroke → `GROUP_RULES_COMBINED`, accepted as fixed rows). `p7.groups.api.test.js` **58/58**. UI smoke phases 1–5 + 7 **146/146**, zero console errors (phase 7: enable groups, mark the cells, add the group, choose the source, drag the footer line and reset it, prepare/activate, edit rows in the editor; a11y audit on both screens). Full `npm test` 2026-10-21: 63/63 suites.
- **Measured:** ADDVET `cell_list`, 3 sample rows, pitch 16 px, footer proposed 802.8 px (above the signature), 10 rows at full pitch / 12 at 85 %; PHARMAVET `table_rows`, 1 sample row, pitch 23.6 px, footer 859.7 px (above the stamp), 12 rows. Prepare with a group ≈ 1.9 s. SVG backgrounds: ADDVET 0.95 MB, PHARMAVET 1.5 MB (base64).
- **Decisions logged:** plan §20 I26–I29; §3.2 corrected; §7.8 new; §8.2, §10.3, §10.4, §11, §12, §16.3, §17 (+ 7b continuation pages), §18 A1/A5, §19 updated.

**Defects found in this phase** (money and security first — none found in either category)
| Severity | Where | Defect | Status |
|---|---|---|---|
| — money | — | none: Phase 7 adds no Gemini call and no paid API; the extra cost is render time only | — |
| — security | — | none found. Checked: SVG stays an `<img>` (cannot run script or fetch), normalisation strips script/foreignObject/handlers/external hrefs and the sanitizer runs again after it; `enable-groups`, `PUT …/fields` and row edits are 404 to another company (tested); invoice-line rows only carry a product of the certificate's company | — |
| Medium (correctness of a regulated document) | engine, `inspectGroup` | A table rule drawn as one perfectly vertical stroke through the rows has a zero-width box, so the combined-rule refusal (`overlap > 0`) never fired: such a design was accepted, and its rule would not have been stretched with the rows. | **Fixed** (I29); test now places the stroke from the detected band (the old probe sat outside the band and could never fail) |
| Medium (UX blocker) | frontend wizard `loadVersion` | Overlapping loads (a new version id + its convert task finishing): a slow older response put back `converting` after the task was done → the page stayed on "Converting your design" for good. Hit by enable-groups (fast SVG conversions); could hit any upload. | **Fixed** (newest load wins) |
| Low (owner decision 4) | `fieldService` group validation | `minPitchRatio` accepted 0.5–1, so a group could be saved that shrinks rows to 50 % — decision 4 makes 85 % the floor. Found in the close-out check. | **Fixed** (0.85–1; `p7.groups.api` asserts 0.7 → 422) |
| Low | `invoiceService.confirmInvoice` | `ITEMS_NEED_MATCH` listed lines in database order ("lines 4, 3"). | **Fixed** (`orderBy lineNo`) — `p3.invoices` caught it |
| Info | `GET /certificate-templates` | `versions[]` summaries gained `backgroundFormat` (additive, documented); `templates.list_gate` pinned the exact key set and was updated. | expected |

**A5 — full-font upload, estimate for scheduling.** Lists hit missing glyphs much more often: "B" (Biotin) on ADDVET; "F", "4", "Z" on PHARMAVET in the overflow list. Today the `glyph:` flag blocks finalize and the browser draws the character in a fallback font. Proposed design: a company uploads the full font files (TTF/OTF/WOFF/WOFF2); each design font class (`ff1`, `ff2` …) is matched to an upload by PostScript name **and** by identical advance widths on the subset's glyphs (proves it is the same font); the prepared document gets a second `@font-face` per class used only as the per-glyph fallback (`font-family: ffN, ffN-full`), so existing glyphs and the calibrated layout never change and only the missing characters come from the full font; `fontCoverage` merges both, so `glyph:` remains only for characters neither has. Work: model + additive migration (0.5 d) · upload API with fontkit validation, size limit, tenancy, permission (1 d) · subset ↔ full matching (1–1.5 d) · prepare/fill injection + coverage (1.5 d) · tests incl. a golden "Biotin" render compared pixel-wise with the design's own "B" weight (1–1.5 d) · UI: fonts used by the design with coverage + upload per font in the settings step (1.5 d) · docs (0.5 d). **≈ 7–8 developer days.** Blockers on the owner's side: the designers' actual font files for ADDVET/PHARMAVET and the right to embed them in exported PDFs (Chrome subsets fonts it embeds, but the licence must allow embedding).

**Owner / follow-ups:** (1) continuation pages (§17 7b) need a layout decision; (2) detection is proven on the two goldens — new designs it can't read are refused with the reason and offered fixed rows; (3) A5 above.

## Phase 8 — Retire V1
**Plan** (§17): remove V1 routes/workers/services/pages, the `aiTemplate*` pipeline and Inkscape from the Dockerfile; remove the Legacy nav. V1 DB tables/columns stay (additive rule). Exit: no V1 code paths remain; tests green.

**Report (2026-10-18) — ✅ done, awaiting owner sign-off**
- **Safety first (owner decision this session):** everything from Phases 0–6 was still uncommitted, including the Phase 0 fixes to the V1 files this phase deletes. Committed first as a restore point: backend `5d74569`, frontend `5cfc926`. (`uploads/certificates/` — per-tenant runtime files — added to `.gitignore` instead of committed.)
- **Backend removed:** `routes/{templateRoutes,certificateRoutes}.js`, `controllers/{templateController,certificateController}.js`, `services/{templateService,certificateService,aiTemplateService}.js`, `services/ai/{pipeline,prompts}.js`, `services/render/puppeteerService.js` (only the AI template pipeline used it), `validators/{templateValidator,certificateValidator}.js`, `workers/{certificateWorker,aiTemplateWorker}.js`; `certificateQueue` + `addCertificateJob` (`lib/queue.js`); `TEMPLATE_RECONSTRUCT` (`modelRegistry.js`); the two worker services from all 3 compose files and `runDev.js`; `inkscape` from the Dockerfile; V1 docs (`src/docs/paths/{templates,certificates}`, 2 tags, 7 schemas) → `docs:export` re-bundled, `redocly lint` valid.
- **Frontend removed:** `pages/{TemplatesList,Certificates,AiTemplateGenerator,CertificateGenerator}.jsx`, `services/{apiTemplates,apiCertificates}.js`, their 4 routes, the Sidebar "Legacy" group.
- **Kept on purpose:** V1 tables `templates`/`template_images` and old `BackgroundTask` rows (additive rule); V1 permissions in `seed.js` (data, not code paths); `GET /dashboard`'s `certificate_generation` task-type counter (historical tasks, unchanged contract).
- **Tests:** `templates.test.js` and `certificates.test.js` (V1 suites) deleted; `certificates.phase0_safety` now asserts every former V1 endpoint is a plain 404 for company and system callers and queues nothing (26/26); `gemini.guard` drops the two deleted V1 services; `auth.test.js` TEST 10 proved company-token auth via V1 `POST /certificates/generate` — now via `GET /certificate-types` (28/28); `runAll.js` no longer requires consumers on the two retired queues.
- **Exit criteria:** no import, route, queue, worker, compose service or doc path of V1 remains (grep over `src`/`tests`/`scripts`/FE `src` clean; `docker compose config` OK for all 3 files). `npm test` on `npm run dev:test`: **51/52** (only pre-existing `brand.test.js`); UI smoke all phases **87/87**, zero console errors; `oxlint` clean on V2 files; `vite build` OK.
- **Owner / follow-ups:** (1) stopped local containers `certificate-worker` and `ai-template-worker` still exist (exited) — remove with `docker rm certificate-worker ai-template-worker`; their scripts are gone. (2) `ghostscript imagemagick librsvg` in the Dockerfile now have no caller in `src` either — not removed (outside the §17 list). (3) `@google/generative-ai` is still used by `catalogService.js`, so the package stays.

## Template screens ↔ mockups A1–A5 (2026-10-18)
Phases 1–2 built the template screens before the owner's mockups (`mostanad_front/design/certificates/`) were found. Rules: the plan wins over the mockups; app Tailwind + `ui/` components; no behaviour or API changes.

**Differences found (before the fix)**

*All certificates pages (types, templates, wizard, invoices, invoice review, generated certificates, editor)*
- `CompanyPicker` renders nothing for a company account; the mockups show the company name read-only (gray box) where system users get the picker.
- Role banner (A1/B1) missing everywhere except `Invoices.jsx` — and there it is always indigo; the mockups use indigo "System admin" vs green "Company account" (+ company name).

*A1 — `CertificateTemplates.jsx`*
- Filters: bare selects under the header → mockup puts Company · Type · Brand in one filter card, status as pill buttons on the right. No Brand filter at all (the list API already takes `brandId`).
- Status filter is a `<select>` ("Any status") → pills (All · N / Active / Draft / Failed …).
- Card: type/scope/brand/country are one dotted gray text line → separate gray pills (type code monospace); no status-specific line (mockup: "Passed the gate — not active yet" for `ready`, the failure reason in red for `failed`, "draft" hint in amber); version line "Active: v1 Latest: v1 (draft)" → "v2 active · v1 superseded"; action is always "Open" → status-specific ("Continue marking", "Activate", "Upload new version", "Open").
- No dashed "Upload a design" tile at the end of the grid.
- Header has only "Upload template" → mockup also has a secondary "Certificate types" button.
- *Not adopted (plan/API):* "8 fields · round-trip 0.018 %" on cards — the list endpoint returns neither field counts nor gate numbers; adding them is an API change. "Converting" status kept in the filter (plan §4 lifecycle). Archive + "Show archived" kept (plan §12 behaviour).

*A2 — wizard step 1 (`UploadStep`)*
- Two-column layout (drop zone left, form card right) → one card: drop zone on top, the picked file as its own row (format badge · name · size · Replace), a 2-column field grid, scope as two large radio cards, footer Cancel / "Upload & convert →".
- Company: picker sits in the page header → it is the first field of the form ("· you can create for any company"); company account: read-only "· your company".
- Type: "+ New type" button above the select → hint "· or create a new type" in the label; Brand/Country hints "· optional" (· this company's brands).
- Title "Upload a certificate template" → "New certificate template"; back link styled blue "← Templates".
- Scope copy: "One certificate per… Product / Invoice" → "One certificate for… Each product / The whole invoice". *Plan wins:* the per-invoice hint keeps "invoice-level fields only for now" (repeating groups = Phase 7, not built).
- Step pills: smaller, bordered → mockup size, completed steps "✓ n Name" in green without border; while converting the first pill reads "1 Upload · converting…".

*A3 — converting state*
- One spinner + thin bar with the raw task message → card with spinner, "Converting your design" + "Usually under 10 seconds. You can leave — we'll keep going.", current stage + % above a progress bar, and five named stages (uploaded ✓ / converted / cleaned / measuring lines & fonts / thumbnail) with done/active/pending states; the backend reports 15/45/65/85 % per stage, so the stage is derived from progress.
- No preview aside → thumbnail placeholder "The thumbnail appears when conversion finishes."
- Failure: a small red text box "Upload a corrected file below as a new version." with the upload form underneath → a failure card with the specific title (NO_PDF_CONTENT / NO_LIVE_TEXT), the human message, the backend message, and an "Upload a new file" button that opens the new-version upload.
- *Not adopted:* per-stage timings and file size (the version payload has no source size, timings only after the job ends) — no API change.

*A4 — `FieldMarker` + `FieldPanel` (step 2)*
- Document toolbar: zoom only → instruction "Select the text that changes. **Ctrl** + select to add several." on the left of the zoom controls.
- Field highlight colour yellow → blue tint (mockup `.f`), active field stronger blue; "Make field" button shows the "Enter" hint.
- Field rows: chevron + label/sample → blue dot, monospace **key**, “sample” in quotes, source pill, align pill (L/C/R).
- Header "Fields (n)" + violet full-width AI button inside the list → "Fields · n" with a secondary "✦ Suggest fields (AI)" button in the header.
- Editor: plain bordered box → blue 2px card titled with the sample; Label/Key side by side; "Anchor" button row → "Align" segmented control; "Required" → "Required — flag the certificate if empty".
- Save state inside the panel header → page header, next to the status pill (mockup: `draft` · ✓ Saved).
- "Next: settings" above the panel → panel footer with "Back" + "Next: settings →".
- *Plan wins:* the mockup's "New field from selection … Cancel / Add field" form would make field creation a two-step confirm; the plan (§13.4) creates one draft per line immediately on "Make field"/Enter and autosaves. Kept; the newly made field opens in the editor card styled as in the mockup.

*A5 — `PrepareReport`, test fill, `ActivateStep` (steps 4–5)*
- Report: a status line + a list of check labels → a status band (green "Prepare passed — ready to activate" / red failed) with "Run again", then metric cards per check (measured value, limit, ✓ pass / ✗ fail) computed from the stored report.
- Pixel comparison hidden behind a `<details>` link → visible "Pixel comparison" with the original thumbnail and the diff image per page ("Difference · x %"). *Not adopted:* the "Cleared + refilled" image — no endpoint serves it (API change).
- Per-field table "Calibration Δx/Δw · Round-trip Δx/Δw · Status" → "Field · Align · Position Δ · Width Δ · Result" (pill). Calibration failures still listed in Result.
- Layout: report and test fill stacked full width → report left, test fill as an aside on the right ("Rendered on the server — exactly what the PDF will show."); flags explained in sentences under the preview.
- Aside footer: "Activating replaces vN / no active version in this slot." + the next action. *Plan wins:* activation stays its own confirmation step (§13.4 step 5); the footer button leads to it.
- Activate step: blue "Activate" → green "Activate vN"; the "replaces" sentence as in the mockup.
- *Not adopted (plan gap noted):* "Invoice item (optional)" picker in test fill — plan §13.4 mentions it and the API accepts `invoiceItemId`, but the UI never had it; adding it is new behaviour, so it's left for an owner decision.

**Fix (2026-10-18) — done; UI smoke pending (see below)**
- **Shared:** `CompanyPicker` now shows a company account's own name read-only (`data-testid="company-fixed"`) where system users get the select (`variant="inline"` for headers, `"field"` for filter cards/forms); `useCompanyScope` exposes `companyName` (from `GET /auth/me`'s `company.name`). New `RoleBanner` (indigo "System admin" / green "Company account" + name) on every certificates page: types, templates, wizard, invoices (B1 copy kept), invoice review, generated certificates, editor.
- **A1** `CertificateTemplates.jsx`: filter card (Company · Type · Brand), status pills (count on the selected pill — the API returns one total per query), show-archived kept; cards with pills, status hint line, version line, status-specific action; dashed "Upload a design" tile; "Certificate types" button.
- **A2** `UploadStep`: one card — drop zone, file row with Replace, 2-col grid incl. Company field, "or create a new type" hint, scope radio cards, Cancel / "Upload & convert →". New-version upload = file only.
- **A3** wizard converting state: `ConvertingCard` (5 named stages derived from the job's 15/45/65/85 % progress, % + progress bar, "You can leave", thumbnail placeholder); `FailureCard` with the specific title for `NO_PDF_CONTENT`/`NO_LIVE_TEXT`, the human + backend message, "Upload a new file" (opens the new-version file input below). Step pills restyled; "1 Upload · converting…".
- **A4** `FieldPanel`/`FieldMarker`/`FieldsStep`: rows (dot · key · “sample” · source pill · L/C/R), editor card (Label/Key, Value comes from, Format, Align segmented, "Required — flag the certificate if empty"), "Fields · n" header with "Suggest fields (AI)", footer Back / "Next: settings →"; save state moved to the page header beside the status pill; blue highlights + "Make field Enter"; toolbar instruction via a new optional `DocumentFrame` `hint` prop.
- **A5** `PrepareReport`/`PrepareStep`/`ActivateStep`: status band with actions, 7 metric cards (value vs limit, pass/fail) computed from the stored report, visible pixel comparison (original thumbnail + diff per page), Field/Align/Position Δ/Width Δ/Result table; test fill as the right-hand aside with the server-rendered frame and the "Activating replaces …" footer; green "Activate vN".
- No API, route, payload or behaviour changes (same calls, same autosave/prepare/activate flow).
- **Smoke updated** (`tests/certificates-v2/ui-smoke.phases.mjs`): new copy ("Upload & convert", "Prepare passed — ready to activate", "Position Δ", "Activate v1"); phase 1 now also asserts the system-admin banner + picker, then logs in as the throwaway **company account** (sets a bcrypt password on it, real `POST /companies/login`) and asserts the read-only name, green banner and no picker on the list and the upload form (A1/A2), then restores the admin session; phase 2 asserts the 7 check cards.
- **Checks:** `oxlint` on every V2 file: clean (0 warnings/errors); `vite build` OK.
- **UI smoke:** run 2026-10-19 — see below.

**Finish (2026-10-19) — smoke, owner decisions, B-screens, accessibility**
- **Stack:** fresh `npm run dev:test` (then one shared restart with the backend review session to load both sessions' code); login = throwaway local Admin `qa_ui_smoke` (random password kept only in the session scratchpad), deleted afterwards — 0 users left, password file gone, 0 smoke companies left. The e9 test bypass is an API header, not a browser session, so it couldn't be used for the UI login.
- **Found by the smoke:** a **company account** was redirected to the dashboard from every certificates page and had no Certificates menu: `GET /auth/me` gives a company session a fixed slug list (`manage_company_brands`, `create_certificates`, `read_dashboard`) while the API lets company tokens through every V2 route (`COMPANY_ALLOWED_MODULES`). Fixed in the frontend only: `hasPermission()` grants the four V2 modules (certificates, certificate_types, certificate_templates, invoices) to an `isCompany` session; the sidebar now uses `hasPermission()`.
- **Company-account pass:** changes only the throwaway company's password hash; the original hash is read first and written back in a `finally`, asserted ("original password hash restored"). It now also checks the sidebar and the invoices page (B1).
- **Owner decisions:** (1) A5 test fill **"Invoice item (optional)"** added — lines of the company's confirmed invoices (ready / generating / generated / partially_failed), grouped by invoice, ignored lines left out, sent as `invoiceItemId`; clearing it falls back to product / typed values. (2) A1 **"N fields · round-trip x %"** added: `GET /certificate-templates` gains additive `fieldCount` + `pixelDiffPct` per template (active version, else latest `ready`; null otherwise) — OpenAPI path file + bundle, `tests/certificates-v2/templates.list_gate.test.js` (9/9); the card shows it on active cards (in place of the hint) and under "Passed the gate" on ready ones. (3) "Cleared + refilled" image: skipped.
- **B1–B5 + company variants:** B1 — Company is the upload form's first field ("· you can upload for any company"; read-only name for a company account), header picker only when there's no form, 3:2 grid; B2 — "Review screen loading…" skeleton; B4/B5/A1 — status pills lowercase as in every mockup; B5 — flags as code pill ("missing") + the plan's sentence; A1 company — filter shows the name only, 40px like its selects. *Kept on purpose:* the company picker in detail-page headers (review, editor — removing it would strand a system user on another company's link), role banners on B3–B5 (added in A1–A5 for every page), B2's "When done → Review" button (the page switches by itself; a button would be new behaviour), B4's "← INV-…" back link (target change).
- **Accessibility:** every control labelled (search fields, list filters, source picker + its fixed-text/combination inputs, invoice cells "Line n · Column", test-fill selects); icon-only buttons have `aria-label` (invoice line change/ignore/delete, AI chip accept/reject, value reset, thumbnail link); `role="progressbar"` with value + name on convert, invoice reading, prepare and generation; stage lists use `aria-current="step"` + "done / in progress / not started" in text; live regions narrowed to the stage name / batch heading / save state. The smoke now runs a DOM audit on 15 screens (labels, icon-only names, progressbars, a visible focus ring on every Tab stop).
- **Checks:** `oxlint` clean on all certificates files; `vite build` OK; UI smoke **112/112 three consecutive runs**, zero console errors.
- **Commits:** frontend `6d9a5e2`; backend `2d6010c` (list fields only).
- **Left:** nothing open from this list.

## Review fixes (groups 0–4) (2026-10-18 → 2026-10-19)
Owner's review of Certificates V2, fixed in this order, one commit per group and repo. After each group `npm test` ran on the `npm run dev:test` stack; the only expected failure is the pre-existing `brand.test.js`.

**Group 0 (CRITICAL)**: backend `88276e5`
- `scripts/start.sh` ran `prisma db push --accept-data-loss` on container start, which is how the local DB lost 16–17 tables twice (a stale image dropped every table its schema lacked). Both branches now run `prisma migrate deploy`.
- Test `tests/deploy.no_db_push.test.js` fails if `db push` / `accept-data-loss` appears in start.sh, scripts/*.sh, any Dockerfile, the compose files or a package.json script.
- `eda_requirements` (read-only finding): no code uses it. Migration `20260828030000` renamed it to `regulatory_documents`, and the only remaining "eda_requirements" strings are permission slugs (`*_eda_requirements`, module label). The table in the live DB is an orphan, most likely recreated by an old image's `db push`; `prisma migrate diff` (DB → schema) shows it as the only difference. **Not touched; waits for the owner's decision.**
- The empty `-- DropTable` / `-- DropForeignKey` headers in `20261018120000` stay: Prisma's checksum covers the whole file.

**Group 1 (HIGH)**: backend `67949fc`
- #1 Test bypass is opt-in: `ALLOW_TEST_BYPASS=true` + `TEST_BYPASS_SECRET` (≥ 16 chars, from env, none hardcoded). The app refuses to boot with `ALLOW_TEST_BYPASS` + `NODE_ENV=production`. Only `npm run dev:test` enables it (random secret per start in the gitignored `.test-bypass-secret`), and runAll's preflight checks it. `docker-compose.prod.yml` sets `NODE_ENV=production` on the app and all 9 workers.
- #2 Products are tenant-scoped for company callers (`GET /products`, `GET/PATCH/DELETE /products/:id`, create paths); another tenant → 404.
- #6 `permissions.jwt.test.js`: real JWTs, no bypass, every V2 route × company token × system users with/without each permission. Also `auth.test_bypass.test.js`, `products.tenancy.test.js`.

**Group 2 (MEDIUM)**: backend `18ccc97`; frontend `9bccfc6`, `7834ca5`
- #3 Sanitizer decodes CSS letter escapes before checking (`u\72 l()`, `@\69mport`) and neutralises non-`data:` strings in `image-set()`/`image()`/`cross-fade()`/`src()`. SVG presentation attributes keep only `url(#id)`. `@import` is removed entirely. Both `/html` responses carry the CSP as the first `<meta http-equiv>` in `<head>`. Every bypass is in `fixtures/certificates/malicious.html`.
- #4 `quantityNormalizer`: a lone `.`/`,` + exactly 3 digits → `quantity: null`, `quantityRaw` kept, `quantityAmbiguous: true`, extraction warning. Review edits use the same parser (ambiguous → 422 `AMBIGUOUS_QUANTITY`). The UI shows amber cells + banner. Test `quantityNormalizer.test.js` (US + European formats).
- #5 Maintenance asks BullMQ first (active/waiting/delayed/prioritized jobs and their entities are skipped). Batches use the new `certificate_batches.updated_at` (migration `20261019120000`, additive). p6 drives a real active job and a real waiting job.

**Group 3 (LOW)**: backend `5edd367`; frontend `b4e4027`
- #7 non-blocking `glyph_unknown` + `FONT_UNREADABLE:` conversion warning (`isBlocking` matches `glyph:` only; the frontend too).
- #8 `expectedVersion` required on reset/restore/finalize.
- #9 CAS activation.
- #10 PUT /fields can't confirm (or re-label as manual) a suggested field.
- #12 `templates` out of `COMPANY_ALLOWED_MODULES`.
- #13 `today` in `CERT_TZ` (default Africa/Cairo, `.env.example`).
- #14 disk files under `uploads/certificates` without a StoredFile row, > 24 h, deleted.
- #15 P2002 on the slot index → 409 `TEMPLATE_SLOT_TAKEN`.
- #16 renderer drains and recycles under load.
- #17 converter timeout covers the body.
- #18 no `toolVersion` on `/health`.
- #21 Dockerfile without ghostscript/imagemagick/librsvg (`docker build` OK, Chromium runs).
- Tests: `templates.races` (held row lock; the old activation code fails it), `renderer.recycle`, `converter.timeout`, plus cases in engine.golden, p2, p5, p6, valueResolver, permissions.parsing.

**Group 4 (decisions)**: backend `b02cd61`, `ce85b75`; frontend `b5080e4`
- Plan §20 I24 (#11), I25 (#19). §19: the Chromium `--no-sandbox` risk + recommendation (owner decision pending). Plan-preview copy "recalculated when you click Generate" (I19).

**Breaking API changes**
- `expectedVersion` is **required** on `POST /certificates/:id/fields/:key/reset`, `POST /certificates/:id/versions/:n/restore`, `POST /certificates/:id/finalize` (missing → 400, stale → 409 `VERSION_CONFLICT`).
- `GET /health` no longer returns `converter.toolVersion`.
- (Close-out, below) `GET /auth/me` for a company account returns its effective permissions instead of the fixed `["manage_company_brands", "create_certificates", "read_dashboard"]`.

**Close-out (2026-10-19)**
- `GET /auth/me` → a company account's `role.permissions` = every seeded slug `restrictToPermission` lets a company through (`companyMayUse`, the same rule as the gate) + `read_dashboard`. `read_dashboard` is kept because it is the app's landing route, and the frontend's permission fallback redirects to it, so dropping it would loop; the stats API itself still refuses companies, as before. This includes products, categories, labels (incl. `approve_labels`) and regulatory (incl. `approve_regulatory`), which the API already allowed companies; the UI now shows what the API allows. `manage_company_brands` (not a seeded permission) is gone.
- Frontend: `hasPermission()` has no company special case. `CertificateTypes` `|| isCompany` and `ReferenceLabels` delete `|| isCompany` were removed (the latter route needs `delete_eda_requirements`, which the API refuses to companies). Identity-based checks (company picker, role banner, ApprovalTab's "never global for a company", LabelGenerator) stay.
- Test: `permissions.jwt` asserts the company `/auth/me` list = the V2 route permissions + only gate-allowed slugs. `/auth/me` is now documented (`src/docs/paths/auth/auth-me.yaml`); postman regenerated (includes `fieldCount`/`pixelDiffPct`).
- Results on a fresh `npm run dev:test`: full `npm test` **60/61** (only the pre-existing `brand.test.js`); UI smoke all phases **112/112**, zero console errors (throwaway local admin, deleted afterwards).

### First production deploy with `migrate deploy` (checklist, not done; no non-local DB was touched)
1. **Back up first.** `pg_dump -Fc` of the production DB to storage outside the server; check it restores (`pg_restore --list`). Also back up `uploads/`.
2. **Look at the ledger, read-only:** `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at;` and compare with `prisma/migrations/` (28 folders as of `20261019120000`). Also `npx prisma migrate status` from a one-off container with the prod `DATABASE_URL` (read-only).
3. **If `_prisma_migrations` exists and is complete:** `migrate deploy` applies only the missing (additive) migrations. Read their SQL first.
4. **If the ledger is missing or partial** (the DB was built with `db push`, which writes no ledger): do **not** run `migrate deploy` blind, because it would try to create tables that exist. Baseline instead:
   1. Diff the live DB against the schema: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` (read-only). An empty diff means the DB already matches. Anything else means drift: stop and decide per statement (e.g. the orphan `eda_requirements`).
   2. Mark every migration the DB already contains as applied, without running it: `npx prisma migrate resolve --applied <migration_name>`, one per folder, oldest first.
   3. `npx prisma migrate status` → "Database schema is up to date"; only then let `start.sh` run `migrate deploy` on the next start.
5. **Never** `db push`, `migrate dev` or `migrate reset` against production (`tests/deploy.no_db_push.test.js` guards start.sh/compose/package.json).
6. After deploy: `GET /api/v1/health`, one login per account type, the daily maintenance job registered, the BullMQ queues draining.

## Ops 2026-10-21 — "production feels slow" after the Certificates V2 deploy
**Measured (before):** 2 CPUs, load 0.11; RAM 2.6 / 7.8 GiB used, 5.1 GiB available, no swap, no OOM kills, 0 restarts. Server-side response: `/api/v1/health` ~30 ms, login page 25–50 ms. From the client: TCP connect ~230 ms with 1–6 s spikes, the 507 KB gzip bundle at 14–29 KB/s (~35 s), while the same client gets 131 KB/s from a CDN and the server gets 2.7 MB/s outbound. **The slowness is the network path client ↔ Hostinger Frankfurt, not the server** (TCP congestion control is `cubic`; bundle grew only 1.4 % in the deploy). `mostanad_front_dev` does not exist on the server; nothing on :5173.
**Memory fix anyway** (idle Chromium was the stack's largest consumer: ~290 MiB PSS in `mostanad-app` and in `certificate-template-worker`):
- `renderer.js`: browser still launched on the first render, now closed after `CERT_BROWSER_IDLE_MS` (default 5 min) without one; the next render relaunches it; recycle-after-200 unchanged (the idle close restarts its count). Pool size `CERT_RENDER_PAGES` (1 in production, 2 elsewhere; `RENDER_POOL_SIZE` still read).
- Worker concurrency from env with today's defaults: `CERT_TEMPLATE_CONCURRENCY` 2, `CERT_RENDER_CONCURRENCY` 1, `INVOICE_CONCURRENCY` 1.
- `docker-compose.prod.yml`: `restart: unless-stopped` + `mem_limit` for the app, 9 workers and pdf2htmlex (1536m for the three Chromium users — the full SVG convert/analyse/screenshot/print path peaked at ~1.0 GiB locally; 512m invoice; 384m plain workers at 25–52 MiB; 768m pdf2htmlex at ~115 MiB peak). traefik/postgres/redis untouched.
- Test `renderer.idle.test.js` (11 checks): lazy launch, timer re-armed by a render, a render longer than the timeout is not cut off, closed after the timeout (process gone), relaunch on the next render. `npm test` 64/64.

## Certificate AI layers — Phase A0 Foundations (plan.md, 2026-10-22)
Plan: `plan.md` (Certificates — AI Layers Plan v1). Only A0 was built; A1 (template mapping) waits for approval (plan §11: "Do not start a phase before the previous is approved").

**Built**
- **Source path grammar** `src/services/certificates/paths/sourcePath.js` (`parse`, `resolve`, `resolveRelative`, `toLabel`, `fromSource`): `["quoted"]` keys, `[n]`, `[key="value"]` filters (case- and space-insensitive). Reads own data properties only (`__proto__`/`constructor`/`prototype` refused), never throws, never evaluates, and reports the concrete path it hit. A key spelling variant (`PH` for `pH`) matches only when it is the single variant in that object; when it is ambiguous the result is "not found", never a guess. `valueResolver.readPath` and combination placeholders (`TEMPLATE_TOKEN_RE`) use it. `validateSource` accepts any structurally valid path inside a product JSON column (or `item.extra`). Stored sources keep `{ kind, path }` (kind = root). Old spellings are adapted when read (`specifications.values.Assay %` → `["Assay %"]`); there is no data migration.
- **Data dictionary** `src/services/certificates/dictionary/dataDictionary.js`, table `data_dictionaries`: schema entries (product columns with coverage/examples, relations, invoice line/header, company, brand) plus observed JSON shapes. Key variants are grouped, keeping every spelling in `labels`. Arrays of objects become `collection` entries with a `keyField`/`keyValues`, and pickable `[name="…"]` paths are listed for the 50 most common element names. Bounds: depth 6, 2000 entries, 200 keys per object, 5 examples of ≤ 60 characters. Synonyms survive rebuilds.
- **Rebuilds:** lazily on first read; after product create/update/delete (`productService`), a catalog upload (`catalogService`) or an AI-created product (`productAiWorker`) via `rebuildScheduler.scheduleDictionaryRebuild` (template worker job `rebuildDictionary`); nightly at 02:30 (`CERT_DICTIONARY_CRON`, job `rebuildDictionaries`); and on demand with `POST /certificate-data-dictionary/rebuild`.
- **Source picker:** `GET /certificate-field-sources?companyId=` adds the company's observed JSON paths (with coverage and examples) to the `product` kind. Frontend: they appear as a "Product details" group with "N % of products · e.g. …" under each option, plus a "Refresh" link (mostanad_front `SourcePicker`, `FieldPanel`, `FieldsStep`, `certificateFieldSources.js`, `apiCertificateTemplates.js`).
- **AI infrastructure:** `modelRegistry` entries `CERT_FIELD_MAP` (1024, 0), `CERT_INVOICE_GAPS` (1024, 0), `CERT_PRODUCT_MATCH` (0, 0), `CERT_DICTIONARY` (0, 0), all on gemini-2.5-flash. `ai/aiRunLog.js` (`runLogged`, `logNotRun`) writes one `ai_runs` row per call (kind, company, entity, inputHash, promptHash, modelId, tokens via `generationMetrics`, ms, outcome ok/failed/disabled/skipped). Invoice extraction and CERT_ASSIST now go through it. `ai/aiSuggestions.js` (`recordSuggestion`, `decideSuggestion`) writes the `ai_suggestions` table. `ai/aiSettings.js` reads `Company.aiSettings` (null = defaults) and serves `GET/PATCH /certificate-ai-settings`.
- **Invoice text:** extraction now also returns `textContent` (first in the schema, `=== Page N ===` markers, table rows on one line separated by ` | `), stored in `invoices.text_content` (≤ 200 000 characters). `maxOutputTokens` went from 16384 to 32768. Returned by `GET /invoices/:id`, not by the list.
- **Migration** `20261022120000_cert_ai_foundations` (additive: 2 nullable columns, 3 tables). Applied to the local DB with `migrate deploy` (`migrate dev` wanted a reset because of the known orphan `eda_requirements`; I did not reset).
- **Tests:** `a0.sourcePath.test.js` (74), `a0.dictionary.test.js` (36), `a0.foundations.test.js` (42, API). The last one proves the exit criterion: on the ADDVET golden, `ph_result` → `specifications.values.pH` and `constituent_2_amount` → `activeIngredients[name="Sodium selenite"].concentration`; after prepare, the preview renders `4.0` / `75 mg`, and on a second product (spelled `PH`, lower-case ingredient name, other order) `6.5` / `60 mg`. It also covers tenant isolation of the dictionary and picker, the throttled rebuild job, the nightly scheduler, settings, a failed `ai_runs` row with Gemini disabled (P8), and that the invoice list omits `textContent`. One real bug was found and fixed while writing the tests: the dictionary walker listed an own `__proto__` key from JSON.

**Differences from plan.md (recorded, not silently renamed)**
- `invoice.header.invoiceDate` (plan §3.1 example) is `invoice.invoiceDate` in the code: the `invoice` root already is the reviewed header (V2 §10.3).
- **`AiRun` table added** (`ai_runs`). Plan §4 does not list it, but §3.3's "aiRunLog" needs somewhere to persist, and failed or disabled calls have no `AiSuggestion` to hang on.
- **`aiSettings.autoAccept` added (default false)**. This is §12 Q1's default ("confirm everything for the first 2 weeks, then 0.90") as an explicit switch the owner turns on, rather than a date rule. `autoAcceptThreshold` default 0.90 as planned.
- **Rebuild is a throttle, not a pure debounce:** the first change rebuilds after about 5 s; later changes coalesce into one rebuild at most every 10 min per company (jobId per 10-minute bucket). A change that lands while that bucket's job is already running is picked up by the nightly rebuild.
- **No new permissions:** the dictionary and AI settings reuse `read_certificate_templates` / `update_certificate_templates`.
- `item.extra["…"]` (the per-line columns the extractor saw but couldn't map) is now an addressable source; plan §6.3 needs it.
- The static positional ingredient slots (`activeIngredients[0..5].…`) stay in the catalogue so existing fields keep their labels. The dictionary omits them in favour of `[name="…"]` paths.

**Deferred (belongs to a later phase or needs a decision)**
- The `CERT_DICTIONARY` synonym call (§3.2 "optional"). The registry entry and the `allowSynonyms` setting exist; per Q3's default, nothing would apply without a user accepting it, and nothing consumes synonyms before A1/A2.
- `FieldMappingMemory`, `ProductAlias`, `CertificateDataNeed`, `TemplateField.mappingOrigin`, new `matchMethod` values (A1–A3 entities), and `InvoiceItem.textSpan` (A2 row scope).
- Frontend "Settings → AI" screen (§8): the API exists; the UI is not built.
- **Not verified live:** `textContent` extraction against real Gemini (tests never call a paid API). Before A2, upload one real invoice on a Gemini-enabled stack and check `GET /invoices/:id` → `textContent`, plus the `ai_runs` row's token counts. The bigger output also costs more output tokens per invoice.
- **Verified:** full `npm test` on a fresh `npm run dev:test`: **70/70 suites** (run again after the owner-review fixes: 70/70) (the 67 existing plus the 3 new A0 ones). The frontend builds (`vite build`) and passes oxlint.
- **Invoice text exposure (owner review, 2026-10-22):** `textContent` leaves the API only through `GET /invoices/:id`, which is tenant-scoped (another company → 404). It is omitted (`TEXT_OMIT` in `invoiceService`) from `GET /invoices` **and** from the `PATCH /invoices/:id` and `POST /invoices/:id/confirm` responses, which also returned the full row. `editService`'s `invoice: true` is internal to the resolver context and never serialised. Tests in `a0.foundations` cover: a unique marker never appears anywhere in the raw list payload (plain, `q=`, `status=`, system user); the invoice really is in the list; the PATCH and confirm responses don't contain it; a cross-tenant GET returns 404 without the text.
- **Migration vs schema check (owner review, 2026-10-22).** Prisma 7.8 has no `--shadow-database-url`; I used a temporary config with `datasource.shadowDatabaseUrl` → a throwaway local DB `mostanad_shadow_a0` (created, then dropped):
  `npx prisma migrate diff --config <tmp> --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`.
  **Result: not empty, but nothing from A0.** The only output is `ALTER TABLE "regulatory_documents" ALTER COLUMN "product_scope" DROP DEFAULT, ALTER COLUMN "activation_mode" DROP NOT NULL;`. Running the same diff on the pre-A0 state (HEAD's `schema.prisma` + migrations without `20261022120000`) gives **exactly the same two statements**, so this is older drift in the regulatory tables: migrations `20260828030000` (`product_scope … NOT NULL DEFAULT '{}'`) and `20260913182628` (`activation_mode … NOT NULL DEFAULT 'full'`) vs `productScope String[]` (no default) and `activationMode String?` in the schema. Every A0 table, column, index and FK matches `schema.prisma` exactly. **Not fixed:** it is outside A0, and either fix (schema to match the DB, or a migration) is a decision for the regulatory pipeline's owner. The DB is the stricter side, so nothing is broken at runtime.

## Certificate AI layers — Phase A1 Template field mapping (plan.md §5, 2026-10-22)
A0 approved by the owner. A1 approved by the owner on 2026-10-22, who then asked for A2–A4 without stopping between phases. Auto-accept stays off by default (owner, §12 Q1).

**Built**
- **Label proposal (code)** `mapping/labelProposal.js` + the engine. `fieldEngine.inspect` now also returns `labelContext` per field: `columnHeader` is the nearest text above in the value's column printed in a *different font* (headers are styled; the values stacked between header and value are not). The engine also returns the row's cells and the value's cell. Text is rebuilt from glyph geometry, so kerning spans don't insert spaces. Order of rules: same line `Label:`/`Label #`, then the column header; a generic header (Specifications/Results/…) defers to the row's own label ("pH" + Results → "pH result"); otherwise null and the AI names it. On the goldens: ADDVET Batch No., Product Name, Expiry Date, Production Date, pH result, Document, "Sodium selenite result", and null for the constituent name. PHARMAVET Expiration date, Manufacturing date, Batch number, pH result, Producer, "Constituents (per gm) result". NFKC handles PDF ligatures ("Speciﬁcations").
- **batch_data (code):** a value in a RESULT column whose row has a specification cell before it (a range, a limit or %) is a per-batch result → manual, `dataCategory: batch_data`, with the UI note. A "Results" column alone is not enough: ADDVET puts constituent amounts in it.
- **Format inference** `mapping/formatInference.js`: MM/YYYY, MM.YYYY, DD/MM/YYYY vs MM/DD/YYYY (decided only by a number > 12, otherwise `ambiguousDate` is shown to the user), YYYY-MM-DD, DD MMM YYYY, MMM YYYY. Letter case only for samples without digits (SUPPLEMENT → upper; AVVS1122005 untouched).
- **Mapping chain** `mapping/fieldMapper.js`, `POST /template-versions/:id/map-fields`:
  1. memory (`field_mapping_memory`: this certificate type first, then any type);
  2. batch_data layout rule;
  3. dictionary match `mapping/dictionaryMatch.js`: labels, synonyms and key words, with No./Nr./Num. → number. It is used only for a single hit whose type the sample fits, and that agrees with the sample product when one is given. Built-in synonyms were added to the schema paths (invoiceSchema/sourceCatalogue: expiration date, mfg date, lot no, manufacturer…);
  4. one `CERT_FIELD_MAP` call for everything still open, with groups. Prompt order: instructions → dictionary (≤ 200 entries) → raw JSON of ≤ 5 of the company's products (4 KB each) → fields. Code validates every answer (`validateAiField`): paths only from the dictionary (an element `[i]`/`[key="v"]` of an observed collection counts), fixed text must equal the printed sample, every placeholder must be in the dictionary, and `product_text` is kept as a proposal (see deferred). Plausibility against the sample product: agrees → ≥ 0.97 with evidence; disagrees → × 0.6. An AiSuggestion is stored per answer (invalid ones as `rejected` with the reason). AI off, failing or over quota still returns the code mappings, plus `ai.unavailable`/`ai.reason`.
- **Saving / confirming / learning** (`fieldService`, `prepareService`): new TemplateField columns `mappingOrigin`, `mappingSuggestionId`, `mappingConfirmed`, `dataCategory`. On PUT the server reconciles each field with its suggestion: same source → pending until confirmed; a different source → the suggestion is recorded `edited` and the mapping becomes manual; a client claiming `ai` without a real suggestion → manual. `/fields/confirm` accepts pending mappings (recording who and when) and remembers them. Activation is refused while a mapping is pending (`FIELDS_UNCONFIRMED` + `mappings`), and on success remembers every label (a label used twice in one version is skipped as ambiguous).
- **Group binding (§5.3):** code first. With a sample product, the one product collection whose element holds every cell's sample. Otherwise the AI's answer, validated: the collection and child keys must be in the dictionary. Groups may now read any list inside a product JSON column (not only `activeIngredients`).
- **Frontend** (mostanad_front):
  - **New field:** `make()` proposes the label/key (`label-proposals`), then maps the field.
  - **Field card:** origin badge "Memory ✓ / Dictionary ✓ / AI 0.94 ✓ / AI 0.71 — confirm" (amber card plus Confirm, which saves first, then calls `/fields/confirm`); "Why?" panel (rationale, dictionary entry with coverage and examples, sample-product check, note); batch_data note; ambiguous day/month hint.
  - **Toolbar:** "Map all" and an optional sample-product picker.
  - **Re-mapping:** happens on label blur.
  - **Activate step:** lists pending AI mappings.
  - **Accessibility:** `.cert-select` focus ring for react-select inputs.
- **Tests:**
  - `a1.unit.test.js` (65): labels, batch rule, formats, dictionary match, AI-answer validation.
  - `a1.mapping.test.js` (76, API + in-process with a stand-in model): label proposals on both goldens; AI off; AI down; golden sets; adversarial answers (invented path / text / placeholder, an answer for an unasked field, quota error, 503, no answer); prompt tenant isolation and order; group binding (code and AI, invented collection refused); PUT/edit/claim reconciliation; activation gate; confirm; memory; second template with 0 AI calls; "Why?" tenancy.
  - Shared harness `mappingHarness.js`.
  - Golden mapping sets `fixtures/certificates/mapping/{ADDVET_COA,PHARMAVET_COA,products}.json`.
  - UI smoke through the wizard (phases 1–2): 47/47, zero console errors. It used a throwaway local admin, deleted afterwards.
- **Live eval** `npm run eval:cert-mapping` (`scripts/evalCertMapping.js`): refuses unless `RUN_LIVE_GEMINI=1`; writes `golden/ai-eval-<date>.json` (scores, tokens, ms per template); exits 1 below the §5.4 bar or on a > 2-point drop from the previous scorecard.

**§5.4 acceptance: what is proven and what is not**
- Proven without AI (code only): on ADDVET 5/8 fields and on PHARMAVET 5/6 resolve by dictionary/layout, all correct, with 0 AI calls for them. pH result is batch_data on both (100 %). 0 invalid paths reach the DB (validation + tests). Memory: the second template with the same labels → **0 AI calls**, every field from memory. AI disabled → the wizard works, and labels plus dictionary matching still run. Cost: **one AI call per template** whatever the field count (asserted).
- With a *correct* stand-in model the golden sets score 8/8 and 6/6. This proves the pipeline (validation, plausibility, provenance) but **not the real model's accuracy**. The remaining 4 golden fields (two ADDVET constituent fields, the COA{{item.batchNo}} combination, the PHARMAVET constituent amount) depend on the live model. **The ≥ 90 % live number is not measured yet**: it needs `RUN_LIVE_GEMINI=1 npm run eval:cert-mapping` (paid; not run without the owner's go).

**Differences from plan.md (recorded)**
- Mapping memory is written at **activation** (every field) and on **confirming an AI mapping**, not "on save": autosave runs every 800 ms on half-edited fields and would teach the memory unfinished choices.
- `FieldMappingMemory.category` added (so a remembered batch_data field stays batch_data); the plan's model has no category.
- `map-fields` writes nothing to the fields; the client applies the result and the normal autosave PUT stores it. A server-side write would race the 800 ms autosave of the whole list.
- Batch results are recognised by code first (layout rule), not only by the AI's category.
- `product_text` (value inside a longer product string, §5.2): the AI's proposal is validated and stored, but the field stays manual with a note. Per-product extraction with a verbatim check is §6.1 machinery (A2).
- Code-proposed and code-bound group bindings are applied directly; an AI group binding is applied as `pending` in the UI, but there is no server-side activation gate for groups (fields only).
- **Migration fix:** my first `20261022130000` named the memory index `…certificate_type_id_key` (64 chars). Postgres truncates identifiers to 63, so the name didn't match Prisma's. Fixed in the (unreleased) file to Prisma's name `…certificate_type_key`; locally I renamed the index and updated the ledger checksum. `migrate diff --from-migrations` (shadow DB) → only the old regulatory drift; local DB → schema only the orphan `eda_requirements`; `migrate status` up to date.

**Deferred / not done**
- The live accuracy run (above).
- When code finds no label, the AI proposes one in the same call (`label` in the answer), but the UI only takes it while the field still has its placeholder label.
- The V2 "Suggest fields (AI)" (CERT_ASSIST) button is unchanged; it now logs to `ai_runs`.
- **Verified:** full `npm test` on a fresh `npm run dev:test`: **72/72 suites** (70 + a1.unit + a1.mapping). Frontend: `vite build` OK and oxlint clean; UI smoke phases 1–2: 47/47.

## Certificate AI layers — Phase A2 Invoice intelligence (plan.md §6, 2026-10-23)
Owner approved A1 and asked for A1 → A4 back to back with one review at the end (no stop between phases). §12 defaults in force: auto-accept off, lab results entered at invoice review, AI synonyms only after a person accepts each, invoice text may go to Gemini, free tier (every AI path batched).

**Built**
- **Data needs** `dataNeeds/dataNeedsService.js`, table `certificate_data_needs`: the generation plan (now `generation/planService.js`, shared with `batchService`) × every plain template field → one row per (invoice, planKey, fieldKey). Code resolves each field exactly as generation does (same resolver context) → `resolved` (provenance path/static/today/template), `not_applicable` (optional, empty) or `missing`. A person's `provided` value and a verified AI value survive re-runs; a change of the field's source, required flag, category, product or line (`basis` hash) resets them. Rows of entries no longer in the plan are deleted.
- **Gap resolution** `dataNeeds/gapResolver.js`: ONE `CERT_INVOICE_GAPS` call per check for every `missing` need not asked with the same basis before (`aiAskedBasis`) → 0 calls when nothing new is missing, even across re-runs. Gaps are de-duplicated per (line or header, source, label): a lab result needed by three certificate types is asked once. Prompt order: instructions → invoice text → extracted invoice + matched products (raw JSON columns + text columns, 8 KB each; dictionary paths empty for that product; near-miss keys) → gaps. The model only points (invoice_text quote+page / product_path / product_json_text path+quote).
- **Evidence verifier** `dataNeeds/evidenceVerifier.js` (P2): normalisation (NFKC, case, Turkish İ/ı, accents, unicode dashes and quotes, whitespace, ` | ` cell separators) with an index map back to real offsets. invoice_text: quote in the stored text, value in the quote, and row scope — a line-level value must be quoted inside THAT line's row (`InvoiceItem.textSpan`), a header value outside every item row. product_path: code reads it; the DB value replaces the model's. product_json_text: quote inside the product's string, value inside the quote. One proving entry is enough; every entry's check is kept on the suggestion. Unverified → the need stays `missing`, the AiSuggestion is `rejected` with `evidenceVerified=false` and the reasons.
- **Statuses:** verified + `initialStatus` = auto_accepted (auto-accept on and ≥ threshold) → `resolved_ai`; verified otherwise → `needs_confirmation` (with the §12 Q1 default: always). A verified product_path at a different key than the template's records `nearMiss { canonical, alternative }`.
- **Row spans** `dataNeeds/itemSpans.js`: code locates each line's row: the extractor's new `rowText` hint if found exactly once, else the one text line holding the line's code (+ batch), else name + batch, else name; ambiguous → none; two lines on one span → none for both. Stored at extraction (`invoiceService.runExtractJob`); computed once later for older invoices and lines added by hand (`{ none: true }` when not found).
- **Extractor** (§6.3): `rowText` per item; the per-line `extra` description names lot/mfg/exp/analysis no.; `extractionHints(companyId)` tells the single extraction call which item/invoice paths (with their printed synonyms) and which per-batch labels the active templates need. The hint is input (inputHash), not prompt (promptHash unchanged).
- **Decisions** `PATCH /invoices/:id/data-needs`: accept / edit (provided, manual provenance; `applyTo: "line"` = every certificate of that line with the same label) / reject (not asked again) / reset. AiSuggestion statuses follow (accepted / edited / rejected).
- **Synonym learning:** `POST /certificate-data-dictionary/synonyms` stores `pathSynonyms` on the dictionary entry (a non-pickable stub entry when no product has the canonical path); they survive rebuilds. `valueResolver` (fields and placeholders) tries them only when the declared path is empty and reports `via`. Never applied without a person (§12 Q3); product data never changes.
- **Generation** (§4 "Generation"): `batchService.resolveWithNeed` — a `provided` / `resolved_ai` value of the certificate's planKey is rendered first (formatted by the field's format), stored with `origin: "data_check"` and `provenance`; otherwise the source, with synonyms. `editService.resetField` does the same. Gate in `startGeneration`: if the invoice's check was ever run, it is refreshed by code and open required values → 409 `DATA_NEEDS_OPEN`; `force: true` needs `update_certificates` (`requestScope.mayDo`).
- **Frontend** (mostanad_front): `DataCheckPanel` in InvoiceReview (review/ready/generated): summary bar, AI note (found N with checked evidence / refused K / unavailable → by hand), lab-results form per line (one input per label for all certificate types), per-certificate groups (open ones expanded; "Show all values"), per row accept/reject/edit/override/reset, "use for all certificates of this line", source chips (an invoice quote opens the passage with the quote highlighted in the stored text), "Add as synonym for all products" on near misses. Generate is disabled while values are open, with "Generate anyway" for `update_certificates`. Certificate value rows show "from the data check". The check re-runs after every review edit (code; AI only for new gaps).
- **Golden invoices** `fixtures/certificates/invoices/` (setup + INV_A/B/C + `.expected.json`): a two-line ADDVET-style proforma (per-line pH/analysis in each row — the wrong-row trap), a single-line PHARMAVET-style invoice over two pages with Turkish İ and an en dash, an exporter invoice with a "PH value" near miss and two unresolvable products. 14 resolvable gaps, 6 that must stay missing. Shared harness `tests/certificates-v2/invoiceGoldenHarness.js`.
- **Tests:** `a2.unit.test.js` (56: normalisation, every verifier rule, spans, near misses, stored values, hints, synonyms in the resolver, check-first generation, the force permission) and `a2.dataNeeds.test.js` (83: goldens, stored provenance, prompt order/isolation, cost, all §6.4 adversarial cases, AI off / over quota / disabled, decisions, synonyms incl. rebuild, tenancy, and a real prepared ADDVET template: gate 409 → accept + type → render with the confirmed values and provenance; reset-to-source keeps them; force renders flagged; a never-checked invoice is unchanged).
- **Live eval** `npm run eval:cert-gaps` (`scripts/evalCertGaps.js`) refuses without `RUN_LIVE_GEMINI=1`; writes `golden/ai-eval-gaps-<date>.json`. Not run (paid). `evalCertMapping.js` now only compares with `ai-eval-<date>.json` cards, so the A2/A3 cards don't collide.

**§6.4 acceptance: proven / not proven**
- With a correct stand-in model: 14/14 resolvable gaps filled with verified evidence (100 % ≥ 80 %), 0 false fills, 0 unverified values, exactly 1 call per invoice, 0 on a re-run. All five adversarial cases refused (plus no-evidence and forbidden-path). AI off/down: needs computed, gaps missing.
- **The live fill rate is not measured** (needs `RUN_LIVE_GEMINI=1 npm run eval:cert-gaps`).

**Differences from plan.md (recorded)**
- `CertificateDataNeed` has extra columns: `templateVersionId`, `invoiceItemId`, `productId`, `label`, `category` (the review panel groups by them), `basis` / `aiAskedBasis` (re-run rule: "without calling the AI again unless new gaps appear"), `suggestionId`, `decidedAt`, timestamps.
- **Single-line invoices:** a line-level quote may come from anywhere in the text (plan: "inside that item's row"). With one line there is no other row to take a wrong value from, and per-line values are often printed below the table (INV_B's analysis no. on page 2). With two or more lines the row rule is strict, and a line whose row can't be located gets no invoice_text values.
- **Product text columns** are sent with the JSON columns (plan: "raw JSON columns"): the model can't quote a `description` it never saw (product_json_text works on any string path).
- **Provenance** is stored in `values[key].provenance` with `origin: "data_check"`, not inside `values[key].source` (plan §4): `source` stays the template field's source, which edit/reset/restore rely on.
- **The server-side generate gate** applies only once the check was run for the invoice (the UI always runs it). Otherwise every existing V2 flow and test that generates with missing values (D7, flagged) would change. Never-checked invoices keep V2 behaviour; finalisation is still blocked by `missing` flags.
- "Use for all certificates of this product" is scoped to the **invoice line**, not the product: two lines of the same product are two batches with different lab results.
- Synonyms are offered only for near misses without a list position (`[0]`); the plan's "dictionary synonym" is a path synonym here (label synonyms already existed in A0).
- The evidence chip highlights the quote in the stored invoice text, not inside the PDF viewer (the browser's PDF iframe can't be highlighted into).
- Repeating-group cells are not data needs (their rows come from the declared list).
- Re-runs after edits: the frontend re-runs the check after every review edit; the server does not hook invoice edits (the generate gate refreshes by code anyway).

**Deferred / not done**
- The live gap-fill run (above). Also not verified live: the extractor's new `rowText` and hints against real Gemini.
- **Also fixed (outside A2):** frontend `components/label-detail/EditFieldModal.jsx` called hooks after an early return (4 oxlint `rules-of-hooks` errors, oxlint exit 1); split into wrapper + body. oxlint now exits 0.
- **Verified:** full `npm test` on a fresh `npm run dev:test`: **74/74 suites** (72 + a2.unit + a2.dataNeeds; a2.dataNeeds green 3 runs in a row after fixing an ordering bug in the test's stand-in model). Frontend `vite build` OK, `oxlint` exit 0. Migration `20261023120000_cert_ai_invoice_intelligence` (additive: 1 nullable column, 1 table) applied locally with `migrate deploy`.

## Certificate AI layers — Phase A3 Product matching (plan.md §7, 2026-10-23)

**Built**
- **ProductAlias** (`product_aliases`, migration `20261023130000_cert_ai_product_aliases`: one table, FKs cascade on company/product): `matching/productAliases.js` (`aliasMap`, `rememberAlias` — refuses a product of another company). Written on every confirmation: a person's match (`PATCH …/items/:id`, `POST …/items`) → `user_confirmed`; an AI pick auto-accepted at/above the threshold → `ai_confirmed`. A later confirmation to another product replaces the alias.
- **Order** (`matching/productMatcher.js`): 1 alias of the normalised line name → `alias`; 2 exact code; 3 exact name; 4 ranked candidates (5 shown, top 10 kept for the AI); 5 `matching/aiMatcher.js`: ONE `CERT_PRODUCT_MATCH` call for the lines still ambiguous. Input per line `{ lineNo, name, code, packing, extra, candidates: [{ id, name, code, packaging, brand, keyFacts: { form, strength, species } }] }`; output `{ lineNo, productId|null, confidence, reasons }`.
- **Code checks:** the pick must be one of THAT line's candidates and a product of the company (else the suggestion is stored `rejected` with the reason); contradictions (`contradictions()`: pack size in g/ml — "1 KG" vs "500 G" — and strength % between the invoice line and the product's packaging/strength/name) halve the confidence and are shown as "⚠ …" reasons.
- **Confirmation:** `initialStatus` (auto-accept on and ≥ threshold) → matched `ai_confirmed` + alias; otherwise the pick goes first among the line's candidates with `ai: { suggestionId, confidence, reasons }`. Confirming it (`aiSuggestionId`) → `ai_confirmed`, suggestion `accepted`, alias; picking another product → suggestion `edited`. Re-matching keeps `user` and `ai_confirmed` lines.
- **Cost:** a line already answered for the same (line text, candidates) reuses the answer — a pick, "none" or a refused pick — so re-matching never pays twice (`ai.reused`). A failed call is not an answer: asked again next time. AI off (`allowAiMatching`/`enabled`) → `disabled` run row, candidates as before.
- **Frontend:** match column shows "AI suggests X (93 %) — Confirm" (amber with ⚠ when contradicted; reasons on hover), badges "✓ remembered" (alias) and "✓ AI" (ai_confirmed); the product picker marks the AI's option ("AI 93 %") and choosing it confirms it; the re-match toast reports AI suggestions or why AI was unavailable.
- **Golden set** `fixtures/certificates/matching/goldens.json`: 10-product catalogue with near-duplicates (pack sizes, strengths), a look-alike catalogue in another company, invoice 1 (11 lines: renamed lines, an exact-code line, an unknown product, a line that can't tell 10 % from 20 %) and invoice 2 (same supplier, later). Harness `tests/certificates-v2/matchingGoldenHarness.js`.
- **Tests:** `a3.matching.test.js` (44): code checks, alias step, goldens 11/11 with ONE call, the exact-code line never sent, 0 cross-tenant candidates and no foreign id in the prompt, key facts in the prompt, provenance, re-match reuse (0 calls), adversarial picks (not a candidate / other tenant / invented id), contradiction halving + no auto-accept, auto-accept → aliases → next invoice only asks the unlearned line, a person's confirmations via the API → next invoice 0 calls, edited/accepted suggestion statuses, 404s, aliases never cross tenants, AI off / model down / retry, API rematch reuse.
- **Live eval** `npm run eval:cert-matching` (`scripts/evalCertMatching.js`; `RUN_LIVE_GEMINI=1`): invoice 1 live, a person confirms it as expected (in-process `updateItem`), invoice 2 must need 0 calls; writes `golden/ai-eval-match-<date>.json`. Not run (paid).

**§7 acceptance: proven / not proven**
- With a correct stand-in model: 11/11 lines of invoice 1 correctly matched or correctly left (≥ 95 %), 0 cross-tenant candidates, second upload of the same supplier → 0 AI calls (all by alias, all correct). **The live accuracy is not measured** (`RUN_LIVE_GEMINI=1 npm run eval:cert-matching`).

**Differences from plan.md (recorded)**
- `ProductAlias` has `product` / `company` relations (cascade) and `updatedAt`; not in the plan's model. A deleted product takes its aliases with it.
- A person's AI confirmation records the alias as `user_confirmed` (a person decided); `ai_confirmed` is kept for auto-accepted picks. The line's `matchMethod` is `ai_confirmed` in both cases; the suggestion status tells them apart (`accepted` vs `auto_accepted`).
- An AI pick waiting for confirmation is not a new `matchStatus`: the line stays `needs_match` (so confirming the invoice still requires a person) and the pick rides in `matchCandidates[0].ai`.
- "None of the candidates" answers are stored as suggestions (status pending, confidence 0) so they are reused, not re-asked.
- Contradiction checks cover pack sizes (g/ml) and strength percentages; other units (MIU, mg per unit) are not compared.

**Deferred / not done**
- The live matching run (above).
- AI-matching status from the extraction job is not shown in the review screen (only after "Re-run matching"); it is in `ai_runs`.
- **Verified:** full `npm test` on a fresh `npm run dev:test` (restarted with the A3 code): **75/75 suites** (74 + a3.matching). Frontend `vite build` OK, `oxlint` exit 0. Migration `20261023130000_cert_ai_product_aliases` applied locally with `migrate deploy`.
