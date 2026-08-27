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
