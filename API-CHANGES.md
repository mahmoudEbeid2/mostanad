# API Changes Log

Append-only. Newest at the bottom. Each entry: phase, endpoint, change type, notes.

## Phase 0

- `POST /reference-labels/generate-text-ai` (existing) — **breaking-ish**: now
  requires `companyId` in the request body when called by a system user (was
  previously silently generated with `companyId: null`). A company-authenticated
  caller is unaffected — its own id is always used.

## Phase 1

- `GET /labels` — **new**. `protect` + `restrictToPermission("read_labels")`.
  Query: `page`, `limit`, `productId`, and `companyId` (system-user callers only —
  ignored/overridden for a company caller). Tenant-scoped.
- `GET /labels/:id` — **new**. Same auth. Returns
  `{ label, currentVersion, latestValidation, provenance }`. 404 (not 403) if the
  label exists but belongs to a different tenant.
- `GET /labels/:id/versions` — **new**. Same auth + scoping. Returns the full
  append-only version history, oldest first.
- `POST /reference-labels/generate-text-ai` result shape change: `BackgroundTask.result`
  is now `{ taskId, labelId, label }` instead of the bare label JSON. `labelId` is
  the new stable `GeneratedLabel.id` — any caller reading `.result` directly (not
  `.result.label`) needs to update.

## Phase 2

- `POST /products/verify-label` (existing) — **breaking**. `BackgroundTask.result.
  validation` changed from an AI-judged shape:
  `{ compliant, checkedAgainstDb, isExactMatch, dbProductName, country, results: [{category, issue, location, solution}] }`
  to a deterministic shape:
  `{ passed, errorCount, warningCount, verdicts: [FieldVerdict...], coveragePercent, engineVersion, rulesetIds, aiAssisted }`.
  `FieldVerdict` = `{ path, label:{en,ar}, status, presence, severity, layer, ruleKey, message, citation, sourceDocumentId, autoFixable, suggestion }`
  (§10.2). `result.product.extractedDetails` also changed shape — it's now a
  partial `labelSchema`-conformant object (e.g. `productName.translations.en`),
  not the old flat `{name, category, productCode, ...}` object. `existsInDb`/
  `isExactMatch`/`dbProduct` under `product` are unchanged.
- `POST /labels/:id/validate` — **new**. `protect` + `restrictToPermission("update_labels")`.
  Runs the deterministic engine against the label's current `labelData`,
  persists a `ValidationReport`, updates `label.status`. Returns `{ report }`
  (a `ValidationReport` row, `verdicts` = `FieldVerdict[]`).
- `GET /labels/:id/validation` — **new**. `protect` + `restrictToPermission("read_labels")`.
  Returns the most recent `ValidationReport` for the label. 404 if none exists yet
  (validate first) or if the label belongs to a different tenant.

## Phase 3

- `GET /eda-requirements`, `PATCH /eda-requirements/:id`, `DELETE /eda-requirements/:id`,
  `POST /eda-requirements` — **unchanged**, still work exactly as before. Backed
  by `regulatory_documents` now instead of `eda_requirements` (table renamed),
  via a service shim — no caller-visible change.
- `GET /regulatory-documents` — **new**. `read_regulatory`. Filters: `country`,
  `authority`, `status`.
- `POST /regulatory-documents` — **new**. `create_regulatory`. Multipart:
  `file` (PDF only), `country`, `title?`, `authority?`, `productScope?`
  (comma-separated or array), `sourceUrl?`, `documentVersion?`. Returns
  `202 { taskId, documentId: null }` — `documentId` is null until extraction
  completes (poll `GET /background-tasks/:taskId`, read `.result.id`).
- `GET /regulatory-documents/:id` — **new**. `read_regulatory`. Returns the
  document with its `rules` included.
- `POST /regulatory-documents/:id/compile-rules` — **new**. `approve_regulatory`.
  Runs `ruleCompiler` against the document's extracted text. Returns
  `201 { rules: RegulatoryRule[] (created, pending_review), rejected: [{candidate, reason}] }`.
- `POST /regulatory-documents/:id/audit-coverage` — **new**. `approve_regulatory`.
  Runs `coverageAuditor`, persists `clauseTotal/clauseCovered/coveragePercent/uncoveredClauses`
  onto the document. Returns the updated document.
- `POST /regulatory-documents/:id/approve` — **new**. `approve_regulatory`.
  `422` if coverage < 95% and unresolved clauses remain; `400` if never
  coverage-audited. Sets `status: "approved"`.
- `PATCH /regulatory-documents/:id/clauses/clear` — **new, not in §15's literal
  list** (added because the 95% gate needs a way for a human to clear a
  false-positive uncovered clause). Body: `{ reference }`. Removes that entry
  from `uncoveredClauses`.
- `GET /regulatory-rules` — **new**. `read_regulatory`. Filters: `documentId`,
  `ruleType`, `severity`, `status`.
- `POST /regulatory-rules/preview` — **new**. `read_regulatory`. Body:
  `{ labelId }`. Dry-runs every `approved` rule scoped to the label's country
  against its current `labelData`. Returns `{ verdicts, ruleCount }`, writes
  nothing.
- `PATCH /regulatory-rules/:id` — **new**. `approve_regulatory`. Body:
  `{ constraint?, severity?, targetPath? }`. `400` if the rule is already
  approved (reject + recompile instead of editing a live rule).
- `PATCH /regulatory-rules/:id/approve`, `PATCH /regulatory-rules/:id/reject` — **new**. `approve_regulatory`.

## Phase 4

- `POST /reference-labels/generate-text-ai` — **relaxed, not breaking**. Now
  accepts an optional `productId`. `formulationText` is required only when
  `productId` is absent (previously always required). `aimOfUseHint` is
  required only when neither an explicit hint NOR a referenced product with
  `indications` set is available (previously always required). Existing
  callers that always sent `formulationText` + `aimOfUseHint` are unaffected.
- Same endpoint's result shape (`BackgroundTask.result`) gains a `validation`
  summary: `{ taskId, labelId, label, validation: { passed, errorCount, warningCount } }`.
  `label` (the `labelData`) now conforms to `labelSchema` (§6.3) — `LocalizedText`
  objects (`{translations, primary}`), not the old `{en, target}` pair, plus
  fields the old shape never had at all (`withdrawalPeriod`, `strength`,
  `routeOfAdministration`, `registrationNumber`, `pharmaceuticalForm`, etc.).
  Any caller reading specific old field paths (`label.productName.en`,
  `label.ingredients`) needs to update to the new shape
  (`label.productName.translations.en`, `label.activeIngredients`).

## Phase 5

- `POST /labels/:id/audit` — **new**. `update_labels`. Runs the adversarial
  auditor against the label's latest `ValidationReport`, persists every
  disagreement as an `AuditDisagreement`, and recomputes `riskScore`/
  `autonomyTier`. Returns `{ auditorVerdicts, disagreements, riskScore, autonomyTier }`.
- `GET /assurance/disagreements` — **new**. `read_assurance`. Filters:
  `labelId`, `resolution`.
- `PATCH /assurance/disagreements/:id/resolve` — **new**. `read_assurance`.
  Body: `{ resolution, becameRuleId? }`.
- `GET /assurance/golden-runs` — **new**. `read_assurance`. Lists `GoldenEvalRun`
  rows (has worked since Phase 0.5's harness, just wasn't exposed over HTTP
  until now).
- `GET /assurance/shadow` — **new**. `read_assurance`. Always returns
  `{ comparisons: [] }` with an explanatory message — Phase 8 (shadow mode)
  hasn't been built yet; this exists so the assurance API surface doesn't 404
  for a feature that's simply not there yet.
- `GET /review-inbox` — **new**. `read_assurance`. The single risk-sorted queue
  (§14.6) of every label with `status` in `validated`/`failed_validation`.

## Phase 6

- `PATCH /labels/:id` — **new**. `update_labels`. Body:
  `{ changes: [{path, op, value?}], rationale?, expectedVersion }`. `409` on a
  stale `expectedVersion`; `409` (with `{status:"conflict", wouldViolate, options}`)
  if the patch introduces a new validation failure; `422` for a structurally
  invalid patch (unknown path, unsupported op, bulk-replacement threshold).
- `GET /labels/:id/versions/:n` — **new**. `read_labels`.
- `POST /labels/:id/versions/:n/restore` — **new**. `update_labels`.
  Forward-only: restoring version K creates a new version, never rewrites K.
- `GET /labels/:id/versions/:a/diff/:b` — **new**. `read_labels`. Returns
  `{ diff: [{path, op, before, after}] }`.
- `POST /labels/:id/chat` — **new**. `update_labels`. Body:
  `{ message, expectedVersion, overrideAcknowledged? }`. Returns
  `{ intent, answer }` for a question/explanation (no state change), or for an
  edit: `{ intent, status: "conflict", proposedPatch, wouldViolate, options }`
  (`409`, not applied) or `{ intent, status: "applied", resultVersion, report }`
  (`200`). `503` if the underlying AI call fails.
- `GET /labels/:id/chat` — **new**. `read_labels`. Full message history.

## Phase 7

- `POST /labels/:id/approve` — **new**. `approve_labels`. Body:
  `{ expectedVersion, signedEstimatedFields[], acknowledgedUnverifiable[], scope?, note?, secondApproverUserId? }`.
  `scope: "global"` additionally requires `publish_global_reference` (never
  available to a company-authenticated caller) — `403` otherwise. `409` on a
  stale version or an already-approved version; `422` on any of the other five
  gates (validation errors, unacknowledged UNVERIFIABLE, unsigned estimated
  fields, missing second approver for `dual_review`, weak backing documents);
  `403` on a high-risk label approved by its own creator. Returns
  `{ approval, reference }` — `reference` is the newly promoted `ReferenceLabel`.
- `GET /labels/:id/approvals` — **new**. `read_labels`.
- `POST /labels/:id/approvals/:approvalId/revoke` — **new**. `approve_labels`.
  Body: `{ reason }`. `400` if already revoked. Returns
  `{ approval, affectedLabelIds }` — every OTHER label whose provenance cites
  the now-revoked reference, flagged `needsReview: true`.
