# Mostanad — Project Memory

Veterinary / animal-feed **label generation** backend.

**`MOSTANAD_ARCHITECTURE.md` is the single source of truth.** Read it before any
work on the label pipeline. Earlier plan files (`MOSTANAD_LABEL_ENGINE_PLAN.md`,
`MOSTANAD_ARCHITECTURE_V2.md`) are obsolete — delete them, do not consult them.

---

## Stack

Node 20 (ESM) · Express 5 · Prisma 7 + PostgreSQL · BullMQ + Redis · Socket.IO ·
Gemini via `@google/genai` · Zod 4 · Puppeteer

**Backend only.** `src/views/index.html` is empty — there is no UI in this repo.
Anything the frontend needs is delivered as an **API contract**, never as a UI change.

## Commands

```bash
npm run dev            # nodemon, API only
npm run dev:all         # API + all 9 workers in one command (plain node, no watch — see below)
npm test               # node tests/runAll.js  (custom runner — do NOT add Jest)
npx prisma migrate dev # local only
npm run eval:golden    # golden-set accuracy (once Phase 0.5 exists)
```

Postgres + Redis: `docker-compose.dev.yml` is an override file only (ports/volumes/env
for services already defined in `docker-compose.yml`) — it has no `image`/`build` of its
own, so running it alone errors ("service ... has neither an image nor a build
context"). Always layer it on top of the base file:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
```

Tests need both running. `npm run dev:all` (`scripts/runDev.js`) starts the API plus
every worker `docker-compose.yml` runs as its own container (`catalogWorker`,
`labelWorker`, `edaRequirementWorker`, `referenceLabelWorker`, `emailWorker`,
`labelGeneratorWorker`, and Certificates V2's `certificateTemplateWorker`,
`invoiceWorker`, `certificateRenderWorker`) as plain `node` child
processes, each with a colored `[name]` log prefix — no new dependency, just
`child_process`. It does not use `node --watch`: watch mode was tried and reverted —
verified live that all 9 processes restarted in lockstep on unrelated filesystem
activity anywhere under the project root (a test run writing to `uploads/temp_jobs/`,
a doc edit), not just on changes to files they actually import, which bounced the API
mid-test-run and produced real ECONNREFUSED failures. Restart `npm run dev:all`
yourself after editing worker code.

---

## Conventions — follow, don't reinvent

- **ESM + named exports.** No CommonJS, no default-export services.
- **Layering:** controllers are thin (`catchAsync`) → services hold business logic
  and throw `AppError` → workers are thin (read job → call service → emit socket
  progress). Never put business logic in a worker.
- **Prisma:** camelCase fields, `@map("snake_case")` columns, `@@map` on models.
- **Queues:** BullMQ. Long work goes through a `BackgroundTask` row + a queue +
  Socket.IO `job_status_update` events. Keep that pattern.
- **Auth:** every route gets `protect` + `restrictToPermission("…")`.
  New permissions must be seeded in `prisma/seed.js`.
- **Migrations are additive only.** Every new column is nullable or has a default.
  Never write a destructive migration. Backfill scripts must be idempotent.

---

## Invariants — these are not negotiable

1. **Generation writes content. It never writes a verdict.**
   **Validation writes verdicts. It never writes content.**
2. **Reference match tier is computed in code**, stated in the prompt. The model
   never decides how much to trust a reference. Similarity is never evidence of
   regulatory compliance.
3. **Every field value carries provenance**: tier, source, citation, modelId,
   promptHash, timestamp. No untraceable values.
4. **A regulatory rule with no citation verifiable verbatim in its source document
   is rejected** — not warned, not downgraded.
5. **Every field is generated — none render blank.** `withdrawalPeriod`, `strength`,
   ingredient `amount`, `registrationNumber`, `batchNo`, `expiryDate`, and
   `shelfLifeAfterOpening` resolve through the same Tier 1-6 ladder as every other
   field: confirmed source/reference/cited-external first, model inference (Tier 6)
   as the last resort — never a null or a refusal placeholder. A Tier 6 value on one
   of these is marked `estimated: true` with `estimateBasis` in provenance, is not
   auto-PASS (a targeted regulatory rule downgrades it to `NEEDS_REVIEW` at minimum),
   and must be explicitly signed for at approval (invariant 12). **Product owner
   decision, superseding the original "refuse rather than guess" policy** — the risk
   of a blank regulated field outweighed the risk of a flagged, reviewable estimate.
6. **`UNVERIFIABLE` is a real verdict.** Never coerce it to `PASS`.
7. **No empty catch blocks in the label pipeline.** A failed AI call fails the task
   or downgrades a verdict — it never silently keeps a previous draft.
8. **Regulatory requirements live in the database**, never hardcoded in prompts.
9. **Model IDs live in exactly one file:** `src/services/ai/modelRegistry.js`.
10. **Every reference-label query is tenant-scoped.**
    `where: { OR: [{ companyId }, { companyId: null }] }` — always.
11. **A golden-set regression > 2% on any field blocks the change.**
12. **Approval is a human signature on regulated output, not a status toggle.**
    It records who signed, which version, which estimated fields they signed for,
    which UNVERIFIABLE verdicts they acknowledged, and a frozen snapshot of the
    label. It is refused unless validation passed on the *current* version.
13. **A promoted approved label is company-scoped by default.** Making one global
    is a separate action behind a separate permission. Defaulting promotion to
    global reintroduces the cross-tenant leak through the back door.

---

## Known defects (verified — don't re-litigate)

| Where | Problem |
|---|---|
| `labelGeneratorWorker.js:142` | `referenceLabel.findMany()` with no `where` → full table load **and cross-tenant data leak** |
| `package.json` | `@google/generative-ai` is deprecated — migrate to `@google/genai` |
| `edaRequirementService.js` | `processAndCreate` writes `title:` — that column exists in no migration; it will throw |
| `edaRequirementWorker.js:82` | always stores `extractedData: []` → the rules branch in `labelService.js:279-293` is dead code |
| `labelGeneratorWorker.js:470-569` | Steps 3.5/3.6 ask Gemini to rewrite the label; no pass/fail is ever produced; both swallow errors |
| `labelGeneratorWorker.js:338,343` | instructs the model to "use standard veterinary knowledge" — ungrounded guessing, no citation |
| `labelService.js:399` | reads `dbProduct.routeOfAdmin` — not a field on `Product` |
| schema-wide | generated labels are stored only in `BackgroundTask.result` with `removeOnComplete: true` — no `GeneratedLabel` entity exists |

---

## Gemini usage rules

- **Thinking levels:** `minimal` for mechanical extraction · `high` for rule
  compilation, label generation, and auditing. Never leave it at the default.
- **Prompt order matters** (implicit caching, ≥4096 tokens):
  `[regulatory rules] → [schema] → [references] → [product data]`.
  Large shared content first. Record `usage.total_cached_tokens` — a zero means
  the ordering is wrong.
- **Never chunk regulatory documents.** They fit in context whole; chunking breaks
  conditional clauses and cross-references.
- **Batch API (50% cost)** for everything non-interactive: reference ingestion,
  embeddings, rule compilation, nightly golden runs, bulk re-validation.
- **Grounding:** verify `url_citation` host against the allowlist and slice the
  quoted text via `start_index`/`end_index`. A claim whose annotation fails that
  check is discarded.
- **Feed PDFs and label images natively.** `pdf-parse` destroys the tables that
  carry withdrawal periods and species matrices.
- **Generator and auditor must be different model families.**
- **Every Gemini call goes through `geminiClient.js` — never `new GoogleGenAI(...)`
  anywhere else.** It is the only rate-limited, retry-handled choke point in the
  process; a per-file client bypasses both and is how a single-key quota gets
  blown by callers that each think they're behaving. The Batch API
  (`batchClient.js`, `geminiClient.ai.batches.*`) is the one legitimate
  exception — it's a different quota surface, not the interactive
  `generateContent` path the limiter guards.
- **Rate limiting:** `geminiClient` holds one process-wide token bucket
  (`GEMINI_RPM`, default 8) plus a concurrency cap (`GEMINI_MAX_CONCURRENT`,
  default 2) — conservative defaults sized for a free-tier key shared across
  every worker `dev:all` runs, not a paid key's real ceiling. Calls queue
  instead of failing when the process is over budget. Raise both via env for a
  paid project; check the account's actual quota first.
- **429 vs 503:** treated differently, on purpose. 503 (server busy) gets
  exponential backoff. 429 (a quota decision) honours Google's own
  `RetryInfo.retryDelay` when given, and if the violation is a daily/project
  quota rather than per-minute, `geminiClient` fails the call immediately
  instead of burning retries — that quota will not recover by waiting. Every
  failed attempt logs Google's real status/message/retry metadata
  (`geminiErrors.js`); nothing collapses to a generic "API busy" string
  anymore, and the final error reaches `BackgroundTask.error` verbatim.
- **Dev flags to cut Gemini call count** on a constrained key:
  `ENABLE_ADVERSARIAL_AUDIT` (guards `generatedLabelService.runAudit`) and
  `ENABLE_SELF_CONSISTENCY` (guards `selfConsistency.runSelfConsistency`), both
  default `true` unless explicitly set to `"false"`. Note: as of this writing,
  neither is wired into the automatic `labelGeneratorWorker` flow yet — audit
  is a separate `POST /labels/:id/audit` call, and self-consistency has no
  caller at all. A single label generation today is 1-2 Gemini calls
  (ingredient extraction + generation), not seven; the flags are ready for
  whichever phase wires audit/self-consistency into the main flow.
- **Cost visibility:** `generationMetrics.js` (AsyncLocalStorage) tallies every
  `geminiClient` call made during a tracked job — call count, input/output/
  thinking/cached tokens, wall-clock time. `labelGeneratorWorker` wraps its job
  handler in `withGenerationMetrics()` and writes the snapshot to
  `generationMeta.geminiUsage` before persisting.

---

## Working agreement

- Work **one phase at a time** (see V2 Part 6). Do not run ahead.
- Before finishing a phase, trace every new field end to end:
  `input → profile → prompt → responseSchema → labelData → column → provenance
  → API → validation rule → patch allowlist → chat tool`.
  A field present in only some of those is the bug class that caused the
  Target Animals gap.
- Run `npm test` before reporting done.
- **Ask before running `prisma migrate` against anything that isn't local.**
- Report what you changed, what you verified, what you deferred, and anything you
  found that contradicts `MOSTANAD_ARCHITECTURE_V2.md`.
