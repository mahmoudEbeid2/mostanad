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

**Next phase should start with:** Phase 0.5 (golden set harness + 2 synthetic
fixtures), then Phase 3 (regulatory ingestion).
