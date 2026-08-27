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

**Next phase should start with:** Phase 2 — `labelSchema.js`/`geminiSchema.js`/
`fieldCatalog.js`, the deterministic validation engine (layers 1-4), engine
unification (`labelExtractor`), deleting Steps 3.5/3.6 from `labelGeneratorWorker`.
