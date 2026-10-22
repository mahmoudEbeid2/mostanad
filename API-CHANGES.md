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
- `POST /reference-labels/generate-text-ai` — **result shape gains two fields,
  not previously logged here**. `BackgroundTask.result` now also carries
  `riskScore` (int) and `autonomyTier` (`auto_approve`|`batch_review`|
  `mandatory_review`|`dual_review`) alongside the `taskId`/`labelId`/`label`/
  `validation` keys Phase 4 added — risk scoring got wired directly into
  `labelGeneratorWorker.js` in this phase, not just exposed via the new
  `/labels/:id/audit` endpoint. Additive — no caller reading the Phase 4 keys
  is affected, but any caller that inspects the whole `result` object (e.g.
  strict shape validation) needs to allow these two new keys.

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

## Phase 8

- `GET /assurance/shadow` — **behavior change, same endpoint**. Previously
  always returned `{ comparisons: [] }` (Phase 8 didn't exist yet). Now
  returns real `ShadowComparison` rows when any exist; still returns
  `{ comparisons: [] }` with an explanatory `message` when none do (there is
  no live migration being shadowed right now — see PROGRESS.md's Phase 8
  entry). No caller-visible shape change otherwise.

## Phase 9

- `POST /labels/:id/replay` — **new**. `read_labels`. No body. Re-runs
  generation against the label's stored `productProfile` and returns
  `{ identical, fieldsDiffered, promptHashMatches, referenceSetDrifted,
  ruleSetDrifted, originalGenerationMeta, regeneratedGenerationMeta,
  interpretation }`. Read-only — does not create a new version. `422` if the
  label predates Phase 4 (no stored `productProfile` to replay from).
- `generationMeta` (already returned wherever a label's full record is
  returned, e.g. `GET /labels/:id`) gains a `promptHash` key going forward.
  Labels generated before Phase 9 will not have one (`null`/absent, not an
  error).
- No new endpoint for the Batch API — `batchClient.js` exists as an
  internal wrapper only; nothing under `/labels` or elsewhere calls it yet
  (see PROGRESS.md's Phase 9 entry for why: `ai.batches.create()` 400s on
  this project's free-tier Gemini key, so there is no verified call site to
  expose).

## Post-Phase 9 (found while writing this handoff — not part of the label engine, but caller-visible)

- `POST /companies/:companyId/templates` and `PATCH /templates/:id` — **bug
  fix, caller-visible for a request that was already broken**. Creating (or
  updating) a template with `isGlobal: false` and no `productId` used to
  reach the duplicate-template check with `productId: undefined` in the
  Prisma `where` clause — Prisma treats `undefined` as "don't filter on this
  field," not "match null," so the check silently matched ANY other
  non-global template of that type for the company and returned the wrong
  error: `400 "A template of this type already exists for this company and
  product. Please delete the existing template first."` (or, if none
  existed, silently created a broken template row with no `productId` at
  all). Fixed in `src/services/templateService.js`
  (commit `be8d53a`): now returns `400 "Product ID is required for a
  non-global (product-scoped) template."` immediately. No previously-working
  request is affected — this only changes the error a caller sees for a
  request that was never valid to begin with.
- **Known gap, not a phase-introduced change — flagging because it
  contradicts CLAUDE.md's invariant #10** ("every reference-label query is
  tenant-scoped"): `GET /reference-labels` and `GET /reference-labels/:id`
  do **not** apply the `where: { OR: [{ companyId }, { companyId: null }] }`
  scoping — that pattern is only applied inside the internal generation
  pipeline's own reference-selection query
  (`labelGeneratorWorker.js`), not in these public read endpoints. Today,
  any authenticated caller can list or fetch any tenant's reference labels
## Phase 10 (§14.5 Verification)
- `GET /labels/:id/extraction` — **new**. `read_labels`. Returns `{ extractionMeta, sourceFileRef, origin }` for an extracted label (confidence scores, snippets, bounding boxes, ambiguity flags). `404` if the label belongs to a different tenant.
- `POST /labels/:id/confirm-field` — **new**. `update_labels`. Body: `{ path, value, expectedVersion }`. Sets user confirmation on a low-confidence extracted field, updates `extractionMeta[path]` with `confidence: 1.0` and `confirmedByUser: true`, bumps version (append-only), and re-runs deterministic validation.
- `POST /products/verify-label` — **updated**. Now performs full 3-way product matching against DB `Product` row facts and regulatory rules, returning structured remediations (`action: "correct"`, `source: "product_row"`).

## Post-Phase 10 — chat/patch refusal is no longer thrown (caller-visible)

- `POST /labels/:id/chat` (edit intent) and `PATCH /labels/:id` — **breaking
  for any caller that caught the old error**. A structurally invalid patch
  (unknown path, unsupported op, missing `value`, or the bulk-replacement
  threshold) used to be a **thrown `422`** (`{status:"fail", message:
  "Proposed edit was rejected: ..."}` / `"Patch rejected: ..."`) — an
  exception carries no `path` and no structured reason, so the only thing a
  caller could do with it was show "something went wrong". It is now a
  **normal `200`**, aligned with the existing `applied`/`conflict` shape so a
  client switches on `data.status` alone:
  `{ status: "refused", path, reason, previousValue, errors: [{path, reason,
  previousValue}, ...] }` (chat also keeps its `intent: "edit"`). `path` is
  `null` for a patch-level error not tied to one change (empty `changes[]`,
  the bulk-replacement threshold). Nothing changed about *when* a patch is
  refused — same shape/path-allowlist/bulk-replacement checks as before —
  only how the refusal is delivered. `422` is no longer returned by either
  endpoint for this case (other, unrelated `422`s — approval gates, coverage
  preconditions — are unaffected). Every existing caller was audited before
  this change: `generatedLabelController.js`'s `postChat`/`patchLabel` (no
  change needed — both already mapped any non-`"conflict"` `result.status`
  to `200`), and the only tests exercising this path
  (`tests/label.chat.patch.test.js`, `tests/label.editing.guards.test.js`)
  were updated for the new `{path, reason, previousValue}` error shape.
  `dryRunPatch`'s own internal `status: "invalid"` (patchApplier.js) is
  unchanged — only the two callers that used to throw on it now return it
  as `"refused"`.

## Certificates V2 (CERTIFICATES_V2_PLAN.md — Phases 0–8)

All new routes: `protect` + `restrictToPermission`, tenant-scoped (a system user passes `?companyId=`; another company's resource → **404**). Coded errors: `{ status, code, message, …extra }`. Full reference: Swagger `/api/v1/docs` (tags *Certificate Types … Operations*), files in `src/docs/paths/certificates-v2/`.

- **Phase 0 (safety, existing routes):** `GET /background-tasks/:id` — **breaking-ish**: tenant-scoped (another company's task → 404). V1 template/certificate routes enforce ownership. V1 `POST …/templates/generate-ai` → **410**. V1 mock fallbacks removed (a Gemini failure fails the task).
- **Phase 1 — new:** `GET/POST /certificate-types`, `PATCH/DELETE /certificate-types/:id`; `POST/GET /certificate-templates`, `GET/PATCH /certificate-templates/:id`, `POST /certificate-templates/:id/versions`, `POST /certificate-templates/:id/archive`; `GET /template-versions/:id`, `…/html?variant=sanitized|prepared|sample` (CSP `default-src 'none'`, nosniff), `…/thumbnail`.
- **Phase 2 — new:** `PUT /template-versions/:id/fields`, `POST …/fields/confirm`, `POST …/suggest`, `POST …/prepare` (202), `GET …/prepare-diff?page=`, `POST …/preview`, `POST …/activate`, `POST …/new-version`; `GET /certificate-field-sources`; `GET /certificate-products` (tenant-forced product search).
- **Phase 3 — new:** `POST /invoices` (202), `GET /invoices` (`status`, `q`, paging; rows carry `certificateCounts`), `GET/PATCH /invoices/:id`, `GET /invoices/:id/source`, `POST /invoices/:id/items`, `PATCH/DELETE /invoices/:id/items/:itemId`, `POST /invoices/:id/rematch`, `POST /invoices/:id/confirm`, `POST /invoices/:id/retry` (202).
- **Phase 4 — new:** `GET /invoices/:id/generation-plan`, `POST /invoices/:id/generate` (202), `GET /certificate-batches/:id`, `GET /certificates` (filters `invoiceId, batchId, status, certificateTypeId, flagged, q`), `GET /certificates/:id`, `…/html?version=`, `…/thumbnail`. `GET /invoices/:id` now includes `batches[]`.
- **Phase 5 — new:** `PATCH /certificates/:id/values` (`{ expectedVersion, changes }` → 409 `VERSION_CONFLICT {currentVersion}` / `CERTIFICATE_FINAL`), `POST …/fields/:key/reset`, `GET …/versions`, `POST …/versions/:n/restore`, `POST …/export-pdf` (202), `GET …/pdf`, `POST …/finalize`, `POST …/duplicate`, `POST /certificate-batches/:id/export` (202), `GET /certificate-batches/:id/zip`. Downloads expose `Content-Disposition`.
- **Phase 6 — new:** `GET /certificate-metrics?days=` (`read_certificates`); `GET /health` (public: `{ status, converter: { reachable, ms, toolVersion } }`).
- **Fixed (Phase 1 code, found 2026-10-18):** `PATCH /certificate-templates/:id` and `PATCH /invoices/:id` no longer clear `brandId`/`country` when those keys are absent from the body.
- **Phase 8 — removed (breaking, V1 retired):** `GET/POST /templates`, `GET/PATCH/DELETE /templates/:id`, `GET/POST /companies/:companyId/templates`, `POST /companies/:companyId/templates/generate-ai` (was 410), `POST /companies/:companyId/certificates/generate`, `POST /certificates/generate` → all now plain **404**. Use the Certificates V2 routes above. The V1 `certificateQueue`/`aiTemplateQueue` workers are gone; V1 tables (`templates`, `template_images`) and old `BackgroundTask` rows stay (additive rule). `GET /dashboard` still reports `certificate_generation` in its task-type breakdown (historical V1 tasks; unchanged contract).
- **Review group 2 (2026-10-19):** `GET /template-versions/:id/html` and `GET /certificates/:id/html` also carry the CSP as the first `<meta http-equiv="Content-Security-Policy">` in `<head>`. Invoice items: an ambiguous quantity ("1.250" / "1,250") is `quantity: null` + `quantityRaw` + `quantityAmbiguous: true` (and an extraction warning); `PATCH /invoices/:id/items/:itemId` with such a quantity → 422 `AMBIGUOUS_QUANTITY`, and a valid one clears the flag.
- **Review group 3 (2026-10-19), breaking:** `expectedVersion` is **required** on `POST /certificates/:id/fields/:key/reset`, `POST /certificates/:id/versions/:n/restore` and `POST /certificates/:id/finalize` (missing → 400; stale → 409 `VERSION_CONFLICT`). `GET /health` no longer returns `converter.toolVersion`. **Non-breaking:** `POST /template-versions/:id/activate` racing another activation or an archive → 409 `VERSION_CONFLICT`; a template create/settings change that loses the slot race → 409 `TEMPLATE_SLOT_TAKEN { existingTemplateId }` (was a generic unique-constraint error); `PUT /template-versions/:id/fields` ignores `confirmed` from the client and keeps the stored origin of a suggested/detected field (only `POST …/fields/confirm` confirms); new non-blocking field flag `glyph_unknown` (the design's font couldn't be parsed) + a `FONT_UNREADABLE:` entry in `conversion.warnings`; the `today` source is the date in `CERT_TZ` (default `Africa/Cairo`), not UTC.
- **Phase 7 — repeating groups (2026-10-21), additive:** new `POST /template-versions/:id/enable-groups` (202 → a new SVG-background draft version, fields copied). `PUT /template-versions/:id/fields` takes optional `groups[]` and fields take `groupKey`; the response adds `groups` + `groupDetection`; new codes 409 `GROUP_NEEDS_SVG`, 422 `GROUP_RULES_COMBINED` / `GROUP_TABLE_RASTER` / `GROUP_RULES_NOT_FOUND` (+ `fallback: "fixed_rows"`). `GET /template-versions/:id` and the template's versions carry `backgroundFormat` (`png|svg`) and `groups`. `GET /certificate-field-sources` adds `groups` (group sources with row paths, cell kinds, modes, whenEmpty). `POST …/preview` and `PATCH /certificates/:id/values` accept a list of rows for a group key. `GET /certificates/:id` adds `groups[]` (key, label, mode, source, whenEmpty, required, cells, capacity) and `fields[].groupKey`; a group's value is `{ kind: "group", rows, resolvedRows, source, origin, flags, rowsFit, … }`. `POST /certificates/:id/fields/:groupKey/reset` puts back the list's rows. Nothing changes for templates without groups.
- **Review close-out (2026-10-19):** `GET /auth/me` for a company account: `role.permissions` is now its effective permissions (every permission `restrictToPermission` lets a company through, plus `read_dashboard`), replacing the fixed `["manage_company_brands", "create_certificates", "read_dashboard"]`. `/auth/me` is now in the OpenAPI docs.

## Certificate AI layers (plan.md) — Phase A0 Foundations (2026-10-22)

Additive. Nothing existing changes shape for current callers.
- **New:** `GET /certificate-data-dictionary` (`read_certificate_templates`), `POST /certificate-data-dictionary/rebuild` (`update_certificate_templates`), `GET /certificate-ai-settings` (`read_certificate_templates`), `PATCH /certificate-ai-settings` (`update_certificate_templates`). Tenant-forced; a system user passes `?companyId=`.
- **`GET /certificate-field-sources`:** now accepts `?companyId=` (a company caller always gets its own). With a company, `product` paths also include the paths found inside its products' JSON (`specifications.values.pH`, `activeIngredients[name="Vitamin E"].concentration`, …) with `coverage`, `examples` and `fromDictionary: true`, and the response adds `dictionary: { version, builtAt, productCount }`. Without a company it is unchanged. Unknown company → 404.
- **Source paths:** a field or combination source path may now use the plan.md §3.1 grammar (`["quoted key"]`, and `[key="value"]` filters that ignore case and spaces) for paths inside product JSON columns and `item.extra`. `PUT /template-versions/:id/fields` validates them: a path inside a non-JSON column is refused. Every stored V2 path (`activeIngredients[1].name`, `specifications.values.Assay %`) keeps working unchanged.
- **`GET /invoices/:id`** adds `textContent`: the full text the extractor read, with `=== Page N ===` markers (null for invoices extracted before this change). `GET /invoices` does not include it.

## Certificate AI layers (plan.md) — Phase A1 Template field mapping (2026-10-22)

Additive. Nothing changes for callers that don't send the new properties.
- **New:** `POST /template-versions/:id/label-proposals` (`update_certificate_templates`): code-only label proposals `{ label, from, key, category, context }` per selected value. `POST /template-versions/:id/map-fields` (`update_certificate_templates`): memory → dictionary → one AI call; returns `{ mappings, groups, ai, dictionaryVersion }` and writes nothing to the fields. `GET /ai-suggestions/:id` (`read_certificate_templates`): the stored suggestion behind a mapping. All tenant-forced.
- **`PUT /template-versions/:id/fields`:** fields accept `mappingOrigin`, `mappingSuggestionId` and `dataCategory`, and the stored fields return them plus `mappingConfirmed`. The server decides `mappingConfirmed` and records a changed AI source as `edited` on its suggestion.
- **`POST /template-versions/:id/fields/confirm`:** also accepts the fields' pending AI mappings and remembers them for the company.
- **`POST /template-versions/:id/activate`:** also refused (409 `FIELDS_UNCONFIRMED`) while an AI mapping is unconfirmed; the error adds `mappings: [keys]`. Success adds `remembered` (labels written to the company's mapping memory).
- **Repeating groups:** a group's `product_list` source may name any list inside a product JSON column (keys only), and its cells any key of the list's elements. Before this, only `activeIngredients` was accepted.
- **Field sources:** schema paths now carry `synonyms` (e.g. `item.expiryDate` → "expiration date", "exp date"…), exposed in `GET /certificate-field-sources` and the data dictionary.

## Certificate AI layers (plan.md) — Phase A2 Invoice intelligence (2026-10-23)

Additive, with one behaviour change on generate (opt-in through the data check).
- **New:** `GET /invoices/:id/data-needs` (`read_invoices`): the certificate data check as last computed. `POST /invoices/:id/data-needs` (`update_invoices`): computes it (code) and asks the AI once for gaps not asked before; body `{ ai: false }` = code only. `PATCH /invoices/:id/data-needs` (`update_invoices`): `{ decisions: [{ needId, action: accept|edit|reject|reset, value?, applyTo?: "line" }] }`. `POST /certificate-data-dictionary/synonyms` (`update_certificate_templates`): `{ canonical, alternative }` path synonym for all products. All tenant-forced.
- **`POST /invoices/:id/generate`:** accepts `{ force?: boolean }`. Once the data check was run for the invoice, open required values (missing / needs confirmation) → **409 `DATA_NEEDS_OPEN`** `{ missing, needsConfirmation }`; `force: true` generates anyway (needs `update_certificates`, else 403). Invoices whose check was never run behave as before.
- **Certificate values** (`CertificateVersion.values[key]`): a value the check settled has `origin: "data_check"` and a new `provenance` object (`kind` invoice_text / product_path / product_json_text / manual, quote, page, needId…). A value read through an accepted path synonym has `provenance: { kind: "path", path, via: "synonym" }`. `POST /certificates/:id/fields/:key/reset` uses the check's value first, as generation does.
- **Invoice lines:** `InvoiceItem.textSpan` `{ page, start, end, via }` (or `{ none: true }`) — the line's row in `textContent`; returned with the items of `GET /invoices/:id`.
- **Data dictionary:** an entry may carry `pathSynonyms: [full paths]`; entries with `source: "synonym"` (not pickable) hold a synonym whose canonical path no product has.
