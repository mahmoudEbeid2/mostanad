# Frontend Integration Guide — the Label Engine (Phases 1-9)

This is the first handoff of this API surface — nothing here has shipped to a
UI yet. `API-CHANGES.md` lists every contract change phase-by-phase; this doc
is the "how do I actually build against this" companion. The OpenAPI spec
(`src/docs/swagger.yaml`, served at `/api/v1/docs`, bundled at
`src/docs/bundled.yaml`) is the source of truth for exact shapes — this doc
explains the *flows* those endpoints are meant to support.

Backend only, still: nothing in this repo renders anything. Every field below
is a contract, not a suggestion for how to lay it out.

## 0. Conventions you need before reading anything else

**Auth.** `Authorization: Bearer <JWT>` on every request below. Two kinds of
caller: a **company-authenticated caller** (a tenant) and a **system user**
(internal staff, via `/auth/login`). Most list/generate endpoints behave
differently depending on which one you are — called out per-endpoint.

**Envelope.** Every response is `{ status: "success"|"fail"|"error", data?, message?, results?, total? }`.
`status` in the outer envelope does **not** always mean "no error" — the chat
endpoint's conflict response is the one place `status:"success"` wraps a
`data.status:"conflict"` you must still treat as blocked. Watch for that
distinction throughout this doc.

**Tenant scoping.** Almost everything under `/labels` and `/assurance` is
scoped: a company caller only ever sees its own rows, and a cross-tenant
lookup by id returns **404, never 403** — you cannot distinguish "doesn't
exist" from "not yours" from the response, by design. Two exceptions where
this is *not* true today, and you should not rely on it being true:
`GET /reference-labels` and `GET /reference-labels/:id` (see §8) — do not
build an end-user-facing reference-label browser against these two until
that's fixed server-side.

**Background tasks.** Every long-running operation (label generation, PDF
label verification, regulatory-document extraction, reference-label
extraction) returns `202 { data: { taskId } }` (or `jobId` for
`POST /products/verify-label` specifically — same mechanism, different key
name). Poll `GET /background-tasks/{id}`:

```
GET /background-tasks/{id} → { data: { id, type, status, result, error, ... } }
```

`status` is `pending` → `processing` → `completed` | `failed`. `result` is
only populated on `completed`, `error` only on `failed`. Its shape depends on
which endpoint created the task — documented per-endpoint below. There is no
tenant check on this read — any authenticated caller can poll any task id.

**Field paths.** The patch protocol and chat's proposed patches both address
fields with a dotted/bracketed path against `labelSchema`:
`"withdrawalPeriod"`, `"activeIngredients[0].amount"`,
`"targetAnimalSpecies.list"`. The version-diff and replay endpoints return
paths in the same format. Learn this format once, reuse it for patch
construction, diff rendering, and conflict display.

**`labelSchema` in one paragraph.** Every generated label is bilingual —
almost every text field is a `LocalizedText`: `{ translations: {en, ar, ...},
primary: "en" }`, not a plain string. `activeIngredients` items add
`amount`/`unit`/`normalizedName` on top of that. `estimatedFields` is an
array of field-path strings the model flagged as not-confirmed — every entry
in it must be signed off at approval time. Full field list is in
`src/docs/components/components.yaml#LabelData` — don't hand-copy it into a
frontend type without checking that file, it will drift.

---

## 1. Generate a label — `POST /reference-labels/generate-text-ai`

The entry point for the whole pipeline. Async, schema-constrained,
reference- and rule-aware.

**Request** (JSON):

```
{
  productId?,          // if given, formulationText becomes optional
  formulationText?,     // required only when productId is absent
  country,               // required
  language,               // required
  aimOfUseHint?,          // required unless a referenced product already has `indications`
  targetSpeciesHint?,
  directionOfUseHint?,
  companyId?              // required for a system-user caller; ignored/overridden for a company caller
}
```

`400` cases to handle explicitly (each has its own message, don't lump them
into one generic "bad request" toast): missing `country`/`language`; neither
`productId` nor `formulationText`; no usable aim-of-use source; system caller
missing `companyId`.

**Flow:**

```
POST /reference-labels/generate-text-ai
  → 202 { data: { taskId } }
poll GET /background-tasks/{taskId} until status is completed|failed
  → on completed: result = {
      taskId, labelId,          // ← the id you use for every call from here on
      label,                     // labelSchema-conformant LabelData
      validation: { passed, errorCount, warningCount },
      riskScore, autonomyTier
    }
  → on failed: result.error is a human-readable message
```

**Do not keep the task id around after this.** Everything past generation —
validate, chat, patch, approve, replay — addresses the label by `labelId`,
not `taskId`. Navigate to a label-detail view keyed on `labelId` as soon as
the task completes.

`autonomyTier` here is a first read, already computed by the generation
worker; `POST /labels/{id}/audit` (§6) can recompute it later with a second
AI opinion factored in.

---

## 2. Labels core — list, fetch, version history

| Endpoint | Perm | Notes |
|---|---|---|
| `GET /labels` | `read_labels` | `?page&limit&productId&companyId` (companyId: system caller only) |
| `GET /labels/{id}` | `read_labels` | `{ label, currentVersion, latestValidation, provenance }` |
| `GET /labels/{id}/versions` | `read_labels` | oldest first |
| `GET /labels/{id}/versions/{n}` | `read_labels` | 404 if `n` out of range |
| `GET /labels/{id}/versions/{a}/diff/{b}` | `read_labels` | `{ diff: [{path, op, before, after}] }` |

`GET /labels` returns a **narrower `LabelSummary`** (id, companyId,
productId, country, language, status, matchTier, currentVersion, riskScore,
timestamps) — don't try to render a full label detail view off the list
response, fetch `GET /labels/{id}` when the user opens one.

`label.status` is the single most important field for UI state:
`draft → validated|failed_validation → approved | revoked`, or `archived`.
Drive your action-button visibility off this (e.g. don't show "Approve"
until `status` is `validated`) rather than re-deriving it from
`latestValidation.passed`, which can be stale relative to `currentVersion` —
see §5's Gate 1.

`currentVersion` is the optimistic-concurrency token used everywhere below
(`expectedVersion`). Always read it fresh before writing.

---

## 3. Validation — the deterministic engine

| Endpoint | Perm | Effect |
|---|---|---|
| `POST /labels/{id}/validate` | `update_labels` | Re-runs the engine, persists a new `ValidationReport`, updates `label.status` |
| `GET /labels/{id}/validation` | `read_labels` | Most recent report; **404** if never validated |

A `ValidationReport` is `{ passed, errorCount, warningCount, verdicts:
FieldVerdict[], engineVersion, rulesetIds, coveragePercent, aiAssisted,
createdAt }`. `coveragePercent` and `aiAssisted` are always `null`/`false`
today (reserved fields — don't build UI that expects them populated yet).

Each `FieldVerdict` is `{ path, label:{en,ar}, status, presence, severity,
layer, ruleKey, message, citation, sourceDocumentId, autoFixable,
suggestion }`. `status` is one of `PASS | FAIL | WARN | NOT_APPLICABLE |
UNVERIFIABLE | NEEDS_REVIEW` — **`UNVERIFIABLE` is not a pass** (CLAUDE.md
invariant #6): render it distinctly from `PASS`, and remember every
`UNVERIFIABLE` verdict on the label blocks approval until acknowledged (§5,
Gate 3). `NEEDS_REVIEW` is the plausibility layer's (§14.5.7) uncited case —
an observation the model flagged but couldn't back with a citable source
(`plausibilitySource: "model_knowledge"` on that verdict). Render it
distinctly from `WARN` too: a `WARN` from plausibility always carries a real
`citation`/`sourceUrl` (`plausibilitySource: "external"`); a `NEEDS_REVIEW`
never does — that distinction is the entire point of the status, so don't
merge the two into one generic "warning" badge. `layer` tells you where a
verdict came from (`schema`/`applicability`/`regulatory_rule`/`coherence`/
`semantic`/`plausibility`) — useful for grouping the report in a UI (e.g.
"Missing required fields" vs "Regulatory citations" vs "Consistency checks"
vs "Worth a second look").

**Sibling verdicts on the same `path`.** `verdicts` is a flat array with no
dedup or grouping by `path` — the same field can legitimately carry more than
one entry (e.g. coherence emits a `FAIL` on `activeIngredients` because the
totals are mathematically impossible, while plausibility separately emits a
`WARN` on `activeIngredients[0].amount` because one ingredient's concentration
is unusual — different layers, different questions, both real). **Never
collapse a field down to a single verdict or silently drop the others.**
Group by `path`, then within each group sort by this severity order (most
severe first) and render the lead verdict prominently with the rest visible
underneath it — a "+N more" expansion is fine, discarding them is not:

```
FAIL  >  UNVERIFIABLE  >  NEEDS_REVIEW  >  WARN  >  NOT_APPLICABLE  >  PASS
```

`FAIL` leads because it's a known, certain problem; `UNVERIFIABLE` right
behind it because it also blocks approval even though the system doesn't know
the answer. `NEEDS_REVIEW` outranks `WARN` deliberately: a `WARN` is already a
sourced, resolved observation, while `NEEDS_REVIEW` is unresolved uncertainty
that most needs a human's eyes next.

**`POST /products/verify-label` is a separate, older flow** — same
deterministic engine, but always validates with an **empty ruleset**
(`rulesetIds` is always `[]`), and it's async (202 + `jobId`, poll
`GET /background-tasks/{jobId}`), not the synchronous shape the old docs
implied. Don't confuse this with `POST /labels/{id}/validate` — it's for
ad-hoc "check this PDF I have lying around" verification outside the
generated-label pipeline, not part of the approve/promote workflow.

---

## 4. Chat — AI-assisted Q&A and editing

`POST /labels/{id}/chat` (`update_labels`) is one endpoint, three intents.
`GET /labels/{id}/chat` (`read_labels`) returns the full history, oldest
first.

**Request:** `{ message, expectedVersion?, overrideAcknowledged? }`.

### 4a. Question / explain_validation (no state change)

```
200 { data: { intent: "question"|"explain_validation", answer: "<free text>" } }
```

### 4b. Edit, clean apply

```
200 { data: { intent:"edit", status:"applied", resultVersion, report: ValidationReport } }
```

### 4c. Edit, conflict — **the flow the frontend must not skip**

The AI proposes a patch; if applying it would create a validation failure
that didn't exist before (a genuinely *new* FAIL, not a pre-existing one),
the server refuses to apply it automatically:

```
409 {
  status: "success",              // ← outer envelope, misleadingly "success"
  data: {
    intent: "edit",
    status: "conflict",           // ← branch on THIS, not the outer status
    proposedPatch: { rationale, changes: [{path, op, value}] },
    wouldViolate: [{ ruleKey, message, citation, path }],
    options: ["cancel", "apply_and_fix:<path>", ..., "apply_anyway_with_override"]
  }
}
```

`options` is a plain string array meant to drive your action buttons
directly — don't hardcode a set of buttons, render one per entry:

- `"cancel"` → discard, nothing changes.
- `"apply_and_fix:<path>"` (one per newly-failing field) → present as
  "apply, but I'll fix `<path>` afterward" — no special call needed, it's
  informational; the real escape hatch is the last option.
- `"apply_anyway_with_override"` → resend the **exact same `message`**, same
  `expectedVersion`, with `overrideAcknowledged: true`. The server
  re-classifies and re-proposes the patch from scratch on this retry — it
  does **not** replay the patch you were just shown. In the rare case the AI
  proposes something different the second time, that's expected, not a bug;
  show the user what actually got applied (`resultVersion`/`report`) rather
  than assuming it matches what they saw in `wouldViolate`.

Show `wouldViolate` to the user before they pick an option — it's the same
`FieldVerdict`-flavored shape used everywhere else in this API (`ruleKey`,
`message`, `citation`), so you can reuse your validation-report rendering
component here.

### 4d. Other status codes

| Code | Cause |
|---|---|
| `409` (plain envelope, not the conflict shape) | Stale `expectedVersion` — reload the label and retry |
| `422` | The AI's proposed patch was structurally invalid (rare — the model is schema-constrained) |
| `423` | Label is mid-generation (`status:"generating"`) — currently unreachable in practice, but code for it |
| `503` | The underlying AI call failed — safe to retry the whole request as-is |

---

## 5. Direct patch protocol — `PATCH /labels/{id}`

The non-AI equivalent of §4c/4d, for a UI that lets a human edit fields
directly without going through chat. `update_labels`.

```
{ changes: [{path, op, value?}], rationale?, expectedVersion }
```

`op` ∈ `replace | append | remove | insert`. `value` required for every op
except `remove`. There's a hard guard against accidental mass-replacement:
touching more than 60% of the label's top-level fields in one patch is
rejected with `422` — if you're building a "regenerate this section"
feature, that's a real limit, not a bug to route around; use the
generate-text-ai flow again instead for that case.

**Key difference from chat: no override escape hatch here.** A conflict
(`409`, same `{status:"conflict", wouldViolate, options}` shape as §4c
except there's no `proposedPatch` — you already know what you sent) must be
resolved by the human adjusting their own patch and resubmitting; there's no
`overrideAcknowledged` on this endpoint. If your UI wants "apply anyway"
for manual edits too, route that action through the chat endpoint instead
(describe the edit in `message`, set `overrideAcknowledged:true` on the
retry) rather than expecting this endpoint to support it.

**Version history & restore:**

- `GET /labels/{id}/versions/{n}` — one version.
- `POST /labels/{id}/versions/{n}/restore` (`update_labels`) — forward-only:
  creates a **new** version with `n`'s content; never rewrites `n`. Returns
  `{ version, report }` — the restored content is immediately re-validated,
  so you get a fresh `ValidationReport` in the same response, no extra poll
  needed.
- `GET /labels/{id}/versions/{a}/diff/{b}` — `{ diff: [{path, op, before,
  after}] }`, `op` here is `add|remove|replace` (a **different** enum than
  the patch protocol's `op` — don't conflate the two when rendering).

---

## 6. Assurance — audit, disagreements, golden runs, shadow, replay

Distinct from validation: this is *second-opinion* and *self-check* tooling,
not part of the main create→validate→approve path a normal user follows.
Likely an internal/QA-facing surface, not something you build into the
primary label-editing UI.

- `POST /labels/{id}/audit` (`update_labels`) — runs a second, independently
  modeled review; `201 { auditorVerdicts, disagreements, riskScore,
  autonomyTier }`. `400` if never validated first; `503` if the AI call
  fails. This is what actually **recomputes** `riskScore`/`autonomyTier`
  after generation — call it before approving a label whose risk tier
  matters to your gating UI.
- `GET /assurance/disagreements` / `PATCH .../{id}/resolve` (`read_assurance`
  for both — note the resolve endpoint is gated by the *read* permission,
  not a separate write one) — the human-in-the-loop queue for engine vs.
  auditor disagreements.
- `GET /assurance/golden-runs` (`read_assurance`) — accuracy-over-time,
  useful for an internal dashboard, not end-user facing.
- `GET /assurance/shadow` (`read_assurance`) — usually returns `{
  comparisons: [], message: "<explanation>" }` today (no live migration is
  being shadowed) — treat an empty array **with** a `message` as a normal,
  expected state, not an error state, and surface the message rather than a
  blank "no data" screen.
- `POST /labels/{id}/replay` (`read_labels`) — read-only, re-runs generation
  and diffs against the stored label. `422` if the label predates Phase 4
  (no stored `productProfile`). `promptHashMatches` is `null` (not `false`)
  when the label predates Phase 9 — render that as "not comparable", not as
  "prompt changed". `interpretation` is one of three fixed strings meant to
  be shown directly to the user, not re-derived from the boolean fields.

---

## 7. Approval — the six-gate human signature

`POST /labels/{id}/approve` (`approve_labels`, plus `publish_global_reference`
only for `scope:"global"`, which is **never** available to a
company-authenticated caller regardless of permissions) is the most
gate-heavy endpoint in this API. Build a pre-flight check in the UI — don't
just fire the request and react to whatever comes back, because several of
these gates are things you can and should show the user *before* they click
Approve (which fields need signing, which UNVERIFIABLE verdicts need
acknowledging).

**Request:**

```
{
  expectedVersion,
  signedEstimatedFields: string[],       // must cover every path in label.labelData.estimatedFields
  acknowledgedUnverifiable: string[],     // must cover every FieldVerdict.path with status UNVERIFIABLE
  scope?: "company"|"global",             // default "company"
  note?,
  secondApproverUserId?                    // required iff autonomyTier === "dual_review"
}
```

**Every refusal, in the order the server checks them:**

| # | Check | Status | How to preempt it in the UI |
|---|---|---|---|
| 0 | `scope:"global"` from a company caller, or a system user without `publish_global_reference` | **403** | Hide the "promote globally" option entirely unless the caller has that permission |
| — | Label not found / wrong tenant | **404** | n/a — shouldn't happen from a UI that only links to labels it already fetched |
| — | `expectedVersion` ≠ current version | **409** | Always re-fetch the label right before showing the approve dialog |
| — | Already `approved` | **409** | Hide "Approve" once `label.status === "approved"`; offer "Revoke" instead |
| — | No `ValidationReport` exists at all | **422** | Hide "Approve" until at least one validation has run |
| **Gate 1** | Existing report is stale vs. `currentVersion` | **409** | Re-run `POST /labels/{id}/validate` if `latestValidation` doesn't match `currentVersion` before opening the approve dialog |
| **Gate 2** | Report has any `FAIL` verdict | **422**, final, no override | Show the FAIL list; there is no path around this one |
| **Gate 3** | An `UNVERIFIABLE` verdict's `path` is missing from `acknowledgedUnverifiable` | **422** | Pre-fill the approve dialog with a checklist of every current `UNVERIFIABLE` path |
| **Gate 4** | A `labelData.estimatedFields` entry is missing from `signedEstimatedFields` | **422** | Same pattern — checklist from `label.labelData.estimatedFields` |
| **Gate 5a** | `riskScore > 50` and approver === the label's creator | **403**, final | Hide "Approve" for the creator on their own high-risk labels; someone else must sign |
| **Gate 5b** | `autonomyTier === "dual_review"` and no `secondApproverUserId` | **422** | Require a second-approver picker whenever `autonomyTier` is `dual_review` |
| **Gate 6** | Any regulatory document backing the report's `rulesetIds` isn't `approved` or has `coveragePercent < 95` | **422** ("weak backing documents") | Mostly a data-quality problem outside the approver's control — surface which document(s), link to the regulatory-document admin view (§9) |

**Success — `201`:** `{ approval: LabelApproval, reference: ReferenceLabel }`.
The label is simultaneously promoted to a reusable reference. Route the user
to a confirmation showing both — `reference.id` is what other generations
will cite going forward.

**Revoke — `POST /labels/{id}/approvals/{approvalId}/revoke`** (`approve_labels`,
body `{ reason }`): sets the label back to `status:"revoked"`, and — this is
the part your UI needs to react to — returns `affectedLabelIds`, the ids of
**every other label** that cited the now-revoked reference and has just been
flagged `needsReview: true`. Don't discard this array; it's the trigger for
a "these N labels need re-review" notification, probably feeding straight
into the review inbox (§8). `400` if the approval was already revoked.

---

## 8. Review inbox — the one queue

`GET /review-inbox` (`read_assurance`) is the single risk-sorted worklist:
every label with `status` in `validated`|`failed_validation`, sorted by
`riskScore` descending. This is almost certainly your reviewer landing page.
Entries are a narrow projection (`id, companyId, productId, country,
status, riskScore, autonomyTier, currentVersion, createdAt`) — clicking one
means fetching `GET /labels/{id}` for the rest.

---

## 9. Regulatory documents & rules — the admin/knowledge-base side

A separate workflow from label editing — this is where someone ingests and
curates the regulatory source material the validation engine (§3) and rule
compiler draw from. Likely a distinct "Regulatory Admin" section of the UI,
gated behind `read_regulatory`/`create_regulatory`/`approve_regulatory`.

**Ingestion → compile → audit → approve**, in that order — each step
requires the previous one:

1. `POST /regulatory-documents` (`create_regulatory`, multipart: `file`,
   `country`, `title?`, `authority?`, `productScope?`, `sourceUrl?`,
   `documentVersion?`) → `202 { taskId, documentId: null }`. Poll
   `GET /background-tasks/{taskId}` — on completion, `.result` is the
   **full document row**, so the real id is `.result.id`, not the initial
   (always-null) `documentId`. If the file is a byte-for-byte duplicate of
   an already-ingested document, the *task* fails (`.error` explains why) —
   the initial `202` still returns normally, so don't treat 202 as "no
   duplicate", check the polled result.
2. `POST /regulatory-documents/{id}/compile-rules` (`approve_regulatory`,
   no body) → `201 { rules: RegulatoryRule[] (pending_review), rejected:
   [{candidate, reason}] }`. Show the rejected list too — `reason` is
   specific enough to act on ("citation not found verbatim", "targets a
   path that isn't in labelSchema", etc.).
3. `POST /regulatory-documents/{id}/audit-coverage` (`approve_regulatory`,
   no body) → updated document with `clauseTotal/clauseCovered/
   coveragePercent/uncoveredClauses`.
4. Optionally `PATCH /regulatory-documents/{id}/clauses/clear` (body
   `{reference}`) to human-clear a false-positive uncovered clause — this
   does **not** change `coveragePercent`, only removes the clause from the
   "still needs attention" list.
5. `POST /regulatory-documents/{id}/approve` (`approve_regulatory`, no
   body). **400** if step 3 was never run. **422** only when coverage is
   under 95% **and** at least one clause is still uncleared — if every
   clause has been cleared via step 4, approval succeeds even under 95%.
   Design the approve button's enabled state around both conditions, not
   just the percentage.

**Individual rules:** `GET /regulatory-rules` (filters: `documentId`,
`ruleType`, `severity`, `status`), `PATCH /regulatory-rules/{id}` (edit —
**400** if already `approved`, edit `pending_review`/`rejected` only),
`PATCH /regulatory-rules/{id}/approve` / `.../reject` (no body, and — worth
noting in your UI logic — **no server-side guard against re-transitioning**
an already-decided rule; disable these buttons client-side once `status`
isn't `pending_review` rather than relying on the API to refuse a repeat
click).

**`POST /regulatory-rules/preview`** (`read_regulatory`, body `{labelId}`) —
a dry-run: shows what every approved, country-matching rule would say about
a label's *current* data without writing anything. Good for a "what would
this new document change" sanity check before publishing a label engine
change — the response reuses the same `FieldVerdict[]` shape as §3.

---

## 10. Reference labels — the knowledge base

The style/content grounding material the generator draws from
(`GET/POST /reference-labels`, `POST /reference-labels/manual`,
`POST /reference-labels/retry/{taskId}`, `GET/DELETE /reference-labels/{id}`).
Three ways a row gets created: AI extraction from an uploaded file (async,
202 + one `BackgroundTask` per file, duplicates-by-filename silently
skipped), manual entry (`POST .../manual`, synchronous, `201`), or promotion
from an approved label (§7, automatic, not a direct API call).

**Read the tenant-scoping warning in API-CHANGES.md's "Post-Phase 9" section
before building a browse/search UI here** — `GET /reference-labels` and
`GET /reference-labels/:id` are not tenant-scoped server-side today. Fine
for an internal admin tool where any staff member is expected to see
everything; not fine for an end-user-facing "your company's reference
library" feature yet.

---

## 11. Status-code cheat sheet

| Code | What it generally means in this API | Where it's distinctive |
|---|---|---|
| 202 | Queued as a `BackgroundTask` — poll for the result | Every generation/extraction/verification endpoint |
| 400 | Malformed request — a required field is missing or unusable | |
| 401 | No/invalid/expired token | |
| 403 | Permission denied, OR a business-rule authorization refusal (global-scope promotion, self-approval on a high-risk label) — read the message, not just the code | Approval Gate 0 and 5a |
| 404 | Not found, **or** belongs to a different tenant — indistinguishable by design | Almost every `:id` route under `/labels`, `/assurance` |
| 409 | Optimistic-concurrency conflict (stale `expectedVersion`, already-approved/revoked), or a chat/patch validation conflict (`data.status:"conflict"`, outer envelope may still say `"success"`) | §4c, §5, §7 |
| 422 | Well-formed but rejected by a business rule — structurally invalid patch, an approval gate, a coverage precondition | §5, §7, §9 step 5 |
| 423 | Label is mid-generation, not yet editable | §4d (currently unreachable in practice) |
| 503 | The underlying AI call failed — safe to retry as-is | §4d, §6 (audit) |

When in doubt about a specific endpoint's exact status-code set, check its
entry in `src/docs/swagger.yaml` (or the rendered `/api/v1/docs` UI) — this
guide explains the flows; the OpenAPI spec is the byte-for-byte contract.
