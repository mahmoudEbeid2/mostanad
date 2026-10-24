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

## Certificate AI layers (plan.md) — Phase A3 Product matching (2026-10-23)

Additive.
- **`PATCH /invoices/:id/items/:itemId`:** accepts `aiSuggestionId` (the AI pick shown on that line). With the same `productId` → `matchMethod: "ai_confirmed"`, suggestion `accepted`; another product while a pick was shown → suggestion `edited`. A suggestion of another line/company → 404. Every product a person sets (here or on `POST /invoices/:id/items`) is remembered as an alias of the line's name.
- **Matching** (`POST /invoices/:id/rematch` and after extraction): a learned alias is step 1; then exact code, exact name, ranked candidates; then one AI call for the lines still ambiguous. `matchMethod` gains `alias` and `ai_confirmed`. An AI pick that isn't auto-accepted appears as the first `matchCandidates` entry with `ai: { suggestionId, confidence, reasons }`. `rematch` responds `{ matched, needsMatch, ai: { used, calls, reused, asked, suggested, autoAccepted, unavailable?, reason? } }` and now also keeps `ai_confirmed` lines.

## Certificate AI layers (plan.md) — Phase A4 Advanced (2026-10-23)

Additive.
- **New:** `GET /certificate-data-dictionary/health` (`read_certificate_templates`); `POST /certificate-data-dictionary/synonym-suggestions` and `POST /certificate-data-dictionary/synonym-suggestions/:id` `{ decision: accept|reject, synonyms? }` (`update_certificate_templates`); `GET /certificate-product-completeness` (`read_products`); `GET /certificate-products/:id/data` (`read_products`) and `PATCH /certificate-products/:id/data` `{ values?, lists? }` (`update_products`); `GET /certificate-ai-stats?days=` (`read_certificate_templates`). All tenant-forced (a system user passes `?companyId=`).
- **Data dictionary:** observed entries may carry `typeMix: { string: n, number: n }` (after a rebuild).
- **AiSuggestion:** new `entityType` `dictionary_entry` (kind `dictionary_synonym`).
- **New env (optional):** `CERT_AI_PRICE_INPUT_PER_M`, `CERT_AI_PRICE_OUTPUT_PER_M`, `CERT_AI_PRICE_CACHED_PER_M` (USD per 1M tokens, defaults 0.30 / 2.50 / 0.075) — only the dashboard's cost estimate reads them.
- **`POST /invoices/:id/data-needs` (A2):** concurrent checks of one invoice are serialised in the API process and need rows are upserted, so two checks at once no longer fail (found in the A4 UI check: the review screen fires two).

## Certificate AI layers — post-A4 fixes (2026-10-23)

- **Extraction** now also runs the certificate data check automatically (after matching). From then on `POST /invoices/:id/generate` is gated on it (409 `DATA_NEEDS_OPEN`) even if the review panel was never opened. Invoices created before this change are not gated.
- **`GET /invoices/:id`** adds `matchSummary` `{ matched, needsMatch, ai: { used, calls, suggested, autoAccepted, unavailable?, reason? }, by: extraction|rematch, at }` and `dataCheckedAt`. `POST /invoices/:id/rematch` rewrites `matchSummary`.
- Migration `20261023140000_cert_ai_auto_check` (two nullable columns).

## Certificate AI layers (plan.md) — Phase A6.1 Catalogue kept as a source document (2026-10-23)

Additive. The V1 `POST /products/upload-catalog` is unchanged and keeps working until the new flow is live (plan §15.8).
- **New:** `POST /catalogues` (multipart `file` + `companyId` required, `manufacturer?`, `brandId?`, `label?`) and `POST /catalogues/:id/versions` (`file`, `label?`) → 202 `{ catalogueId, versionId, jobId }`; `POST /catalogue-blocks/:id/link` `{ productId }` → `{ blockId, productId, catalogueRef }`. All three need the new permission **`manage_catalogues`** (module `catalogues`, not company-allowed → system users only).
- **New (read, `read_products`, tenant-forced; a system user passes `?companyId=`):** `GET /catalogues`, `GET /catalogues/:id`, `GET /catalogue-versions/:id` (version + blocks), `GET /catalogue-versions/:id/file` (the kept PDF), `GET /catalogue-blocks/:id` (block + line geometry). Another company's row → 404.
- **Background task** type `catalogue_segment` on the new `catalogueQueue` (consumed by the existing catalog-worker process). Version status: `uploaded → segmenting → segmented` (or `failed`).
- **Product:** two nullable columns returned with every product — `catalogueRef` `{ catalogueId, catalogueVersionId, blockId, page }` and `fieldProvenance` (per field `{ tier: "C"|"I", … }`, written from A6.3).
- **Errors:** 400 `COMPANY_REQUIRED`, `BRAND_NOT_IN_COMPANY`, `FILE_REQUIRED`; 409 `NOT_A_PRODUCT_BLOCK`; 413 `FILE_TOO_LARGE` (60 MB); 415 `NOT_A_PDF`.
- Migration `20261023160000_catalogues` (3 tables, 2 nullable product columns). Permission seeded in `prisma/seed.js`.

## Certificate AI layers (plan.md) — Phase A6.2 Tier C in certificates (2026-10-23)

Additive; no new endpoint, no migration.
- **Data check** (`GET/POST/PATCH /invoices/:id/data-needs`): new need status **`catalogue_found`** — a product-data value read by code from the line's product's linked catalogue block; provenance `{ tier: "C", kind: "catalogue_text", via: "code"|"gap_call", catalogueVersionId, blockId, page, section?, quote }`. Blocks generation like `needs_confirmation` until accepted. `summary.catalogueFound`; `summary.needsConfirmation` includes it.
- **Estimated product values:** a product field whose `fieldProvenance[path]` is `{ estimated: true }` without `confirmedAt` is never used by generation; the check returns it as `inferred` with provenance `{ tier: "I", kind: "product_estimate", estimated: true, path, basis, modelId, promptHash }`.
- **`PATCH …/data-needs` accept + `saveToProduct: true`:** now also for `catalogue_found` (writes the value + `product.fieldProvenance[path]` with tier C, block, page, quote, `confirmedAt`) and for estimates (sets `fieldProvenance[path].confirmedAt`; value unchanged). `CANNOT_SAVE_TO_PRODUCT` otherwise, as before.
- **Gap call evidence:** new type `catalogue_text { quote }` (verified against the product's own block; refused for batch data / results / invoice values).

## Certificate AI layers (plan.md) — Phase A6.3 Catalogue extraction quality (2026-10-23)

Additive; no migration.
- **New:** `POST /catalogue-versions/:id/extract` `{ infer? }` → 202 `{ versionId, jobId }` (task `catalogue_extract`); `PUT /catalogue-versions/:id/number-convention` `{ dotGroup3: "thousands"|"decimal" }` → `{ numberConvention, blocks, amountsReread }`. Both `manage_catalogues`.
- **Upload** (`POST /catalogues`, `POST /catalogues/:id/versions`): new optional field `extract` (`"false"` = segment only). By default the segment task's result carries `extractJobId` and the version goes `segmented → extracting → review` (a failed extraction call → back to `segmented` with `error`).
- **`GET /catalogue-versions/:id`:** each product block's `extracted` = `{ isProduct, record, quotes, estimated, flags, category, convention, modelId, promptHash, extractedAt }` (shape in the OpenAPI doc); version `extraction` adds `modelId, promptHash, blocksPerCall, calls, retriedBlocks, runIds, numberConvention { majority, blocksWithEvidence, admin }, inference { calls, estimated, refused, failed?, reason? }`.
- **Invoice matching:** a line whose code is carried by several products of the company is never matched automatically (`matchStatus: needs_match`, candidates shown; an auto-accepted AI pick for it stays `pending`). A learned alias still applies.
- **Models:** `CATALOGUE_EXTRACT`, `CATALOGUE_INFER`, `CATALOGUE_LEGACY` in `modelRegistry.js`. The V1 `POST /products/upload-catalog` now calls Gemini through `geminiClient` (same prompt and response); no source file imports `@google/generative-ai` any more.
- **New env (optional):** `CATALOGUE_BLOCKS_PER_CALL` (default 6). **New script:** `npm run eval:catalogue` (opt-in, `RUN_LIVE_GEMINI=1`).

## Certificate AI layers (plan.md) — Phase A6.4 Catalogue review (2026-10-23)

Additive; no migration.
- **New (read_products):** `GET /catalogue-versions/:id/review` → `{ version, counts, categories, blocks }`; each product block adds `lines` (printed line texts), `highlights` `{ field: [{ x, y, w, h }] }` (PDF points, scale 1, top-left origin — multiply by the page render scale), `categoryId`, `match` (existing product by code, else name) and `bulkAcceptable`.
- **New (manage_catalogues):** `PATCH /catalogue-blocks/:id` `{ values?, categoryId? }`; `POST /catalogue-blocks/:id/accept` → 201 `{ blockId, productId, product }`; `POST /catalogue-blocks/:id/reject`; `POST /catalogue-versions/:id/accept-unflagged` → `{ created, products, skipped }`; `POST /catalogue-versions/:id/merge-blocks` `{ blockIds: [a, b] }`; `POST /catalogue-blocks/:id/split` `{ atLine }`.
- **Changed:** `POST /catalogue-versions/:id/extract` accepts `blockIds` (re-read only those pending blocks, also on an `applied` version).
- **Accept never updates an existing product** (409 `EXISTING_PRODUCT` with `match`) — existing products change only through the re-upload diff (A6.5). An ambiguous "." + 3 digits → 409 `CONFIRM_NUMBER_CONVENTION` until the convention is set.
- **Products created from a catalogue:** `fieldProvenance[field]` = `{ tier: "C", catalogueVersionId, blockId, page, quote, at }` | `{ tier: "I", estimated: true, basis, modelId, promptHash, at }` | `{ tier: "manual", by, at }`; `activeIngredients` items `{ name, concentration, amountRaw, amount, unit, basis }` (`concentration` = the printed text, null when nothing is printed).
- **`PATCH /products/:id`:** ingredient items now accept (and keep) `amountRaw`, `amount`, `unit`, `basis`, `readAs`; `concentration` is optional/nullable. A changed field that carried a catalogue/estimate provenance becomes `{ tier: "manual", at, replaced }` — the "Estimated" badge goes and certificates may use the value.

## Certificate AI layers (plan.md) — Phase A6.5 Re-upload diff (2026-10-23)

Additive; no migration.
- **New:** `GET /catalogue-versions/:id/diff` (read_products) → `{ version, summary, items, removed }`; `POST /catalogue-blocks/:id/apply-diff` `{ fields?, productId? }` and `POST /catalogue-versions/:id/apply-diff` (manage_catalogues). Shapes in the OpenAPI docs.
- **Changed matching** (review and diff): a code printed for several products of one version is never used to match (the name decides); among several hits the products already linked to this catalogue win; a product already linked to another block of the version is never matched twice. An ambiguous `match` now carries `candidates [{ id, name, productCode }]`.
- **New version:** inherits the catalogue's last admin-confirmed `numberConvention` (`inheritedFromVersionId`) — confirmed once per catalogue.
- **Product `fieldProvenance`:** applied diff values carry `appliedByUserId` and `replacedValue`; a change not taken carries `declined { catalogueId, catalogueVersionId, value, byUserId, at }` (a pre-catalogue value then becomes `tier: "manual"`).

## Certificate AI layers (plan.md) — Phase A6.6 Catalogue search (2026-10-23)

- **Migration** `20261023170000_catalogue_search` (additive): `CREATE EXTENSION IF NOT EXISTS pg_trgm` (needs a role allowed to create extensions — the app role in docker-compose owns the database) + two GIN expression indexes on `catalogue_blocks` (FTS over title + text, trigram over the extracted name). No column changes; `prisma migrate diff` shows no drift for them.
- **New:** `GET /catalogue-search?q=&companyId=&limit=&allVersions=` (read_products) → `{ q, words, results }` (OpenAPI doc).
- **Invoice matching:** for a line still needing a product, products whose linked catalogue block (latest edition) prints ≥ half (and ≥ 2) of the line name's words join its candidates (reason `catalogue p.N: k/n words printed`, score ≤ 0.8) and the AI shortlist — never an automatic match. The match summary gains `catalogue { lines, added, failed? }`.

## Certificate AI layers (plan.md) — P8 manual invoice entry (2026-10-23)

Additive; no migration.
- **New:** `POST /invoices/:id/manual` (update_invoices) — a `failed` invoice moves to `review` with no lines and nothing filled in (`extraction: { manual: true, byUserId, at, reason }`, `error` cleared); the person types the header and lines with the existing review endpoints. 409 `INVOICE_NOT_FAILED` otherwise. Before this, an invoice that couldn't be read (AI unavailable) could only be retried — there was no manual path.

## P8 — AI unavailable, said up front (2026-10-23)

Additive; no migration.
- **New:** `GET /ai-status` (read_products; company accounts too) → `{ available, reason: null|"disabled"|"no_key"|"quota", message, since }`. The UI shows a global banner and disables AI buttons from it. `quota` = the latest real AI attempt (any company — the key is shared) failed on the daily quota and nothing succeeded since; re-probed after 6 h.
- **`POST /invoices`:** optional `extract: "false"` → no extraction job; the invoice is created under `review` with no lines (`extraction.manual: true`) and the response is **201** `{ invoiceId, taskId: null }` (default stays 202 + taskId).
- **`POST /catalogues`, `POST /catalogues/:id/versions`:** the UI now sends the existing `extract: "false"` while AI is unavailable (split only; products typed in the review).
- **AI errors are user-facing (P8).** An AI failure never reaches a response as raw text (Google's message, env flags, model ids):
  - error responses: `message` is a sentence and `code` is one of `AI_DISABLED | AI_NOT_CONFIGURED | AI_QUOTA | AI_BUSY | AI_BAD_ANSWER | AI_FAILED`;
  - `GET /background-tasks/:id`, `GET /invoices[/:id]`, `GET /catalogues`, `GET /catalogue-versions/:id[/review]`: a stored AI `error` is returned as that sentence plus `errorCode`; a coded non-AI error (`"UNSUPPORTED_FORMAT: …"`) loses the prefix, which moves to `errorCode`;
  - every `ai.reason` / `web.reason` / `inference.reason` (data check, mapping, matching, synonyms, catalogue inference) is the sentence.
  The raw text is unchanged in the database (`error` columns, `ai_runs.error`) and the server log — the maintenance report still reads it there.

## Certificates — fill automatically, item 1: lab-result flag + diagnosis (2026-10-24)

- `TemplateField.isLabResult` — **new** boolean (migration `20261025100000_cert_lab_result_flag`, default false;
  backfill pre-sets `batch_data` fields and labels matching result / assay / complies / conforms). Returned by every
  field read. `PUT /template-versions/:id/fields` accepts `isLabResult` per field (optional: omitted = keep the stored
  value, or the pre-set for a new field). A lab-result field's `inferencePolicy` is always stored `never`.
  Hard line in code: a lab result is never filled from a catalogue, inference, the web, or product data in the A2 gap
  call — only the invoice text (and, from item 4, a supplier COA / an earlier result of the same batch / a person).
  The A2 gap payload marks such gaps `labResult: true`.
- `GET /invoices/:id/data-needs/diagnosis` — **new**, `read_invoices`, read-only: every missing value with its template
  field, source path and reason, grouped `template_mapping | product_data | lab_result | invoice_data`, plus
  `staleVersions` when the stored needs were computed against a version that is no longer active.

## Certificates — fill automatically, item 2: "Fix this template" (2026-10-24)

- `GET /template-versions/:id/repair` — **new**, `read_certificate_templates`: the repair checklist (constituent group over
  `product.activeIngredients`, fixed text → fields with a suggested source, fixed results for the owner to decide per row,
  unnamed fields explained). Read-only.
- `POST /template-versions/:id/repair` — **new**, `update_certificate_templates`: `{ decisions }` → 202; a new version based on
  this one (re-converted with an SVG background when a group is added), the ticked changes applied, prepare re-run by the
  new `repair` job on the template queue (task type `certificate_template_repair`). The new version's `conversion.repair`
  records `{ basedOn, applied, byUserId, at }`.
- `TemplateField.showSpecInstead` / `specFieldKey` — **new** (migration `20261025110000_cert_show_spec_instead`): a
  lab-result field that prints its row's specification instead; `PUT …/fields` accepts both and keeps the field's
  source/format equal to the specification field's (422 when `specFieldKey` doesn't name another plain field).
- Renderer: `POST /v1/inspect` accepts `lineCells: true` → also returns every line's cells (offsets, x-range, font).

## Certificates — fill automatically, item 3: product data on by default (2026-10-24)

- **Behaviour change (defaults):** `allowProductInference` and `allowWebLookup` now default **true**. New settings
  `fillVerifiedDirectly` (true), `rememberProductValues` (true), `webLookupMaxProductsPerCheck` (10, 0–100),
  `webLookupDailyLimit` (30 per company per UTC day, 0–1000) on `GET/PATCH /certificate-ai-settings`. A company whose
  stored settings name a key keeps its value.
- Data check: a value proven by a verbatim quote — product data (`product_path` / `product_json_text`), the invoice
  text, the product's catalogue (tier C, code or gap call), tier I `quoted` / `derived`, a manufacturer or official
  registry page (tier W) — is filled directly: status `resolved_ai`, provenance `filled: "direct"`, its suggestion
  `auto_accepted`. Estimates are filled marked `provenance.estimated: true` (+ `estimateBasis`) and wait for a person:
  tier I `derivation: "estimate"` (new: a value inferred from facts of THIS product, each quoted and verified) and a
  distributor / allow-listed web page. With `fillVerifiedDirectly: false` the previous confirm-first statuses apply.
- New need status **`reused`** (usable by generation): a value read by code from the product's certificate profile
  (`provenance: { kind: "profile", profileId, estimated, confirmedByUserId, from }`). Summary gains `reused`,
  `filledDirectly`, `estimated`; each need gains `estimated`, `labResult`.
- `ProductCertificateValue` (table `product_certificate_values`, migration `20261025120000_cert_product_profile`):
  written when a value is filled directly or a person accepts / edits one (never for lab results, invoice / batch
  values, dates, quantities); a person's value is never overwritten by an automatic one.
- `PATCH /invoices/:id/data-needs` accepts `{ action: "confirm_all" }` (no `needId`): accepts every value waiting for a
  person.
- `GET /certificate-products/:id/profile` (`read_products`) and `DELETE /certificate-product-values/:id`
  (`update_products`) — **new**, tenant-scoped.
- Web lookup: identity also accepts the product code as the second mark (name + manufacturer, brand or code); the
  per-check and per-day limits add `ai.web.limited` / `limitReason`; directly filled facts are counted in `ai.web.filled`.
