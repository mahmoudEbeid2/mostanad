# Certificates V2 — Master Plan

> **Status:** APPROVED DIRECTION, ready for phased implementation · **Revision 2** (2026-10-08) — supersedes revision 1 (2026-10-05).
> **Owner:** Mahmoud Ebeid · **Repos:** backend `D:\turk\dass\mostanad`, frontend `D:\turk\dass\mostanad_front`.
> Read `CLAUDE.md` first. Its conventions and invariants apply unless this file says otherwise. Where this file and older V1 code disagree, this file wins.

---

## ملخص للمالك (Arabic summary)

**الفكرة:**
- الشركة بترفع ملف التصميم بتاع الشهادة (`.ai` أو `.pdf` أو `.html`) **مرة واحدة**.
- السيستم بيحوّله HTML بنفس شكل التصميم بالظبط.
- المستخدم يحدد بالماوس القيم اللي بتتغيّر (رقم التشغيلة، الصلاحية، اسم المنتج…)، ويختار لكل حقل البيانات بتاعته جاية منين.
- **الباك إند** يفضّي الحقول دي ويحفظ التمبليت جاهز للملء.

**بعد كده:**
- المستخدم يرفع **فاتورة**، والسيستم يطلّع منها المنتجات ويطابقهم بالكتالوج.
- الباك يختار التمبليتات المناسبة ويملا الحقول أوتوماتيك، شهادة لكل منتج أو شهادة واحدة للفاتورة كلها.
- المستخدم يراجع ويعدّل، والسيستم يحفظ كل تعديل كنسخة جديدة.
- في الآخر يصدّر PDF بمقاس الشهادة الأصلي.

**مكان كل حاجة في الخطة:**
- **إيه اللي بيتخزّن وإزاي البيانات مربوطة ببعض:** §6.
- **المحرك اللي بيفضّي الحقول ويملاها بنفس الدقة اللي اتجربت:** §7. التجربة طلعت فرق 0.00 بكسل على شهادتين حقيقيتين.
- **الفرونت شاشة شاشة:** §13.
- **مراحل التنفيذ وشروط قبول كل مرحلة:** §17.

**تغيير مهم عن النسخة الأولى من الخطة:** تفضية الحقول هيعملها **الكود في الباك إند، مش الـ AI.** التجربة أثبتت إن الدقة الكاملة محتاجة **قياس** النص وهو معروض في متصفح. والـ AI مبيقدرش يقيس، فكان هيبقى مجرد طبقة إضافية الكود بيصحّحها. الـ AI دوره هنا قراءة الفاتورة بس (§9)، واقتراحات اختيارية (§8.3). التفاصيل في §2، D4.

---

## 1. Scope

**In scope**
- Template ingestion from `.ai` / `.pdf` / `.html`.
- Field definition.
- Backend field clearing.
- Invoice ingestion and product matching.
- Automatic certificate generation (per product / per invoice).
- Review and editing with versions.
- Server-side PDF export.
- Finalization.
- The complete frontend for all of the above.
- Safety fixes to V1 that block V2.

**Out of scope (tracked in §18)**
- Arabic/RTL certificate designs.
- Digital signatures and approval workflow.
- Uploading full font files for missing glyphs.
- Emailing certificates.
- Public verification links / QR.

---

## 2. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | Template sources: Illustrator `.ai` (a PDF inside when saved with *Create PDF Compatible File*), `.pdf`, and `.html`. | fixed |
| D2 | `.ai`/`.pdf` → HTML with **pdf2htmlEX**, self-hosted as the `pdf2htmlex` compose service. No paid converter. | fixed, service exists |
| D3 | **A human defines the fields**: they select the varying text in the preview, then name each field and choose its data source. AI never decides which fields exist. | fixed |
| D4 | **The backend clears the fields with deterministic code** running in a real layout engine (Puppeteer). This **replaces rev-1's "AI clears"**. Reason: the 2026-10-08 spike proved that exact fidelity requires measuring rendered text (width calibration, anchoring), and an LLM cannot measure layout. AI may still *suggest* things (§8.3), but it never writes template HTML. | **APPROVED by owner 2026-10-16** |
| D5 | Template settings: certificate type (company-scoped catalogue), company (required), brand (optional), country (optional), scope `per_product` \| `per_invoice`. | fixed |
| D6 | The invoice is uploaded → items are extracted (AI) → **a human reviews the extraction and the matching** → generation is fully automatic. | fixed |
| D7 | Field values come only from declared sources. **No model inference of values, no mock data, no silent fallbacks.** A missing value renders empty and is flagged. | fixed |
| D8 | Generated certificates are versioned. Edits never overwrite. Finalize freezes the certificate plus its PDF. | fixed |
| D9 | The stored template HTML is **static**: no runtime JS is needed to display it correctly. All layout compensation is baked into inline styles by the backend renderer. | fixed |
| D10 | **Field provenance.** Every `TemplateField` stores `origin: "manual" \| "detected" \| "ai_suggested"` and `confirmed: boolean`. Fields marked by hand are `manual` + `confirmed: true`. An accepted AI suggestion is `ai_suggested` + `confirmed: false` until the user confirms it. **A version cannot be activated while any field has `confirmed: false`.** Field marking is manual for now; automatic detection is the last phase (§17, Phase 9) and is not built. | owner decision 2026-10-16 |
| D11 | **One source of truth for measurement: the backend Puppeteer render.** Width calibration, alignment (left/center/right), `limits`, overflow shrink (to 80%, then flag) and the round-trip check are computed server-side in the same headless Chromium, with the same HTML and fonts as the PDF export. The frontend only **displays**; it never computes or saves geometry (the §13.4 "suggest center" heuristic runs on the server and is returned as a suggestion). Saved/exported output always comes from a server re-render. | owner decision 2026-10-16 |

---

## 3. Verified facts (spikes 2026-10-04 → 2026-10-08)

Every number below was measured. Do not "re-discover" these; build on them.

### 3.1 Input files
- `ADDVET_COA.ai`: Illustrator 30.6, 1.48 MB, begins with `%PDF-1.6`.
- `PHARMAVET` COA: 1.6 MB, contains Turkish glyphs (`İ Ç Ş`).
- Both convert in **0.3–0.5 s**.
- Reference implementation of the whole edit flow: `D:\turk\ai2html-test\public\index.html`, functions `makeField`, `applyLayout`, `cleanHTML`. **Port its logic — do not reinvent it.**

### 3.2 pdf2htmlEX output structure
- Each page is `.pf`, and each visual text line is `div.t`, absolutely positioned and scaled with a CSS `transform` (class `m0`).
- Characters are separated by kerning spans `<span class="_ _N">` with **uneven negative `margin-left`** values.
- Spacer spans (`._`) are `color: transparent`. Some lines carry a negative `word-spacing` class.
- Fonts are embedded **subset** WOFF data URIs; they contain only the glyphs the design used. The ADDVET regular font lacks `B X j x`.
- Table rules, logo, signature, stamp and watermark are a single background image **with the default `--bg-format png`**. *(Corrected 2026-10-20, Phase 7 spike.)* With `--bg-format svg` they are separate vector elements of one SVG, which pdf2htmlEX embeds as a base64 `<img>` (`.bi`/`.bf`) — this is what makes repeating groups possible (§7.8). Two cairo artefacts come with it and are normalised at convert time (§20 I26): the page is drawn inside ONE page-wide filter (a blend layer emulated with `feImage`/`feBlend`/`feComposite`), which Chrome prints as a raster with a **hairline box** around the blended stamp/signature; and a constant alpha (a 8–10 % watermark) is written as a full-page luminance mask. Very thin strokes (PHARMAVET's 0.25 pt header brackets) look faint on screen but print at the viewer's 1-device-pixel minimum — exactly like the original PDF does, so that is not a defect.
- `--embed-javascript 0` still leaves `<script src>` references, which must be stripped.

### 3.3 Pitfalls (all reproduced)

| # | Pitfall | Result | Fix |
|---|---|---|---|
| P1 | Typing into raw output | The text lands in a transparent spacer and is **invisible**. | Insert a clean field span, never inside `._`. |
| P2 | Removing kerning spans, then using the **average** margin as letter-spacing | Up to **6.09 px** too wide (e.g. `AVVS1122005`, because of the uneven `AV` kerning). | **Calibrate by measurement**: `ls = (originalWidth − naturalWidth) / scale / charCount`. Result: **0.00 px** on 12/12 fields across both certificates. |
| P3 | Negative `word-spacing` on the line | Spaces in the new value collapse (`ADD-ZINCE150`). | Set `word-spacing: 0` on the field span. |
| P4 | Longer value | Pushes the following text on the same line (`TURKEY` moved). | Compensate with margins so the rest of the line stays fixed. Measured drift ≤ **0.1 px**. |
| P5 | Centered table cells | A left-anchored value drifts off-centre. | Per-field anchor `left \| center \| right`. Center drift measured at **0.09 px**. |
| P6 | Round-trip (fields cleared, refilled with the original values) | **0.018 %** of page pixels differ. All of them sit inside one value and are sub-pixel glyph shifts from uniform vs. uneven kerning. | Acceptance threshold ≤ 0.05 %. |
| P7 | PDF export with default print media | Content is printed **scaled ×1.33** across **3 pages** (pdf2htmlEX's print CSS). | Emulate `screen` media + `@page{size:<.pf w>px <.pf h>px; margin:0}` + `preferCSSPageSize`. |
| P8 | PDF export with P7's fix, converted at zoom **4/3** | Source page 595.28×841.89 pt → export 594.96×841.92 pt (Δ < 0.35 pt), **1 page**, the text stays real and selectable, and visually identical. | **Always convert at `--zoom 1.3333333333`**, so that 1 CSS px = 1/96 in = the true physical size. |

---

## 4. Concepts & lifecycles

```
CertificateType        company-scoped catalogue ("COA", "Free Sale", …)
CertificateTemplate    a design slot: type + brand? + country? + scope  (has many versions, ≤1 active)
TemplateVersion        an immutable design artifact: source file, HTML, fields, geometry
TemplateField          one replaceable value inside a TemplateVersion
Invoice / InvoiceItem  an uploaded invoice and its extracted lines (+ product match)
CertificateBatch       one generation run for one invoice
Certificate            one generated document (per product, or per invoice)
CertificateVersion     an immutable snapshot of a certificate's values + its rendered HTML
StoredFile             every binary/HTML artifact on disk, referenced by id
```

**TemplateVersion.status**
```
uploaded → converting → draft ──(user marks fields)──► preparing → ready ──(activate)──► active ──► superseded
              │                                            │
              └──► failed (no PDF content / no live text)  └──► failed (validation gate, §7.6)
```

**Invoice.status**
```
uploaded → extracting → review ──(user confirms extraction + matches)──► ready → generating → generated
              └──► failed                                                              └──► partially_failed
```

**Certificate.status**
```
draft (has flags?) ──edit──► draft (vN+1) ──finalize──► final (immutable; PDF frozen)
   └──── regenerate (new batch) creates new certificates, never mutates final ones
```

---

## 5. Architecture

```
mostanad_front (React 19 + Vite + Tailwind 4)
   │  REST (axios apiClient)  ·  polling + socket hints
   ▼
mostanad-app (Express 5)  ── controllers (thin) ── services/certificates/** ── Prisma/Postgres
   │ enqueue (BullMQ/Redis)                                       │ StoredFile → uploads/ volume
   ▼                                                              │
certificate-template-worker ─┐                                    │
invoice-worker ──────────────┼── services/certificates/** ────────┘
certificate-render-worker ───┘        │                 │
                                      ▼                 ▼
                         pdf2htmlex (HTTP, internal)   Puppeteer (one browser per worker, page pool)
                                                        Gemini via geminiClient (invoice extraction only)
```

### 5.1 Backend module layout (new — `src/services/certificates/`)

```
storage/fileStore.js            put/get/stream/delete StoredFile, sha256, tenant path rules
conversion/pdf2htmlexClient.js  POST /convert?zoom=1.3333333333, timeouts, error mapping (422 NO_PDF_CONTENT, 503 busy → retry)
sanitize/htmlSanitizer.js       allowlist sanitizer (§8.1), adds data-line / data-page ids
analysis/lineExtractor.js       lines[] with text + geometry (via renderer), fontCoverage (fontkit on embedded WOFF)
engine/fieldEngine.browser.js   THE field engine: runs INSIDE the Puppeteer page (clear, fill, layout, measure) — §7
engine/renderer.js              Puppeteer pool: load sanitized HTML, inject fieldEngine, run ops, serialize, export PDF
templates/templateService.js    CRUD, versioning, activation rules, uniqueness
templates/fieldService.js       field definitions, validation, source catalogue
templates/prepareService.js     orchestrates clearing + validation gate (§7.6)
invoices/invoiceService.js      upload, status, review edits
invoices/invoiceExtractor.js    Gemini extraction (INVOICE_EXTRACT), responseSchema, provenance
matching/productMatcher.js      tenant-scoped matching + candidates
generation/templateSelector.js  pure function: (invoice, items, activeTemplates) → plan
generation/valueResolver.js     pure function: (field, context) → { value, provenance, flags }
generation/batchService.js      creates batch + certificates, enqueues renders
certificates/certificateService.js  read, edit (new version), restore, finalize
certificates/exportService.js   PDF (single), ZIP (batch)
```

**Rules**
- **Controllers stay thin and workers stay thin.** Workers read the job, call a service and emit progress.
- **Every Gemini call goes through `geminiClient`.** Add `INVOICE_EXTRACT` (thinkingBudget 0, temperature 0) and `CERT_ASSIST` (optional suggestions, §8.3) to `modelRegistry.js`.
- **Field engine source of truth:** `fieldEngine.browser.js` is a single plain-JS file with no imports. The renderer injects it with `page.addScriptTag({ content })`. Its unit tests run it in Puppeteer against the fixtures. The frontend does **not** duplicate it (§13.6).

### 5.2 Workers & queues (BullMQ; reuse `lib/queue.js` patterns + `BackgroundTask` + socket `job_status_update`)

| Queue | Worker file | Jobs |
|---|---|---|
| `certificateTemplateQueue` | `src/workers/certificateTemplateWorker.js` | `convert` (upload → sanitize → analyse), `prepare` (clear fields + gate) |
| `invoiceQueue` | `src/workers/invoiceWorker.js` | `extract`, `match` |
| `certificateRenderQueue` | `src/workers/certificateRenderWorker.js` | `generateBatch`, `renderVersion`, `exportPdf`, `exportZip` |

**Compose.** Add the three workers to `docker-compose.yml` / `.prod.yml` / `.dev.yml`, each with:
- `PDF2HTMLEX_URL`
- the `uploads` volume
- `internal` network in prod

Add them to `scripts/runDev.js` too. **Rendering is not done in these workers** (2026-10-22, §20 I30): the template and render workers and the API call the `cert-renderer` service (`CERT_RENDERER_URL`), the only container with Chromium; the app image ships no browser.

**Concurrency**
- Template worker: 2 (`CERT_TEMPLATE_CONCURRENCY`). Render worker: 1 (`CERT_RENDER_CONCURRENCY`). Renders from all callers share the renderer's page pool (`CERT_RENDER_PAGES`, 1 in production) and wait for a page there.
- Invoice worker: 1 — the free-tier Gemini RPM is shared across the whole app.
- Every job is **idempotent by entity id**. A retried job never creates duplicate rows; use upserts keyed by `(batchId, templateVersionId, productId)`.

### 5.3 Renderer (Puppeteer) — non-negotiables
- **One browser for the whole system, in the `cert-renderer` service** (`src/services/certificates/renderService/server.js`, image `docker/cert-renderer/Dockerfile`, port 5070, internal network only; §20 I30). It owns `engine/renderer.js` + `fieldEngine.browser.js` unchanged: a page pool (`CERT_RENDER_PAGES`, 1 in production, 2 elsewhere), the browser restarted after N=200 renders (even under load) or on crash, launched on the first request and closed after `CERT_BROWSER_IDLE_MS` (default 5 min) without one — an idle Chromium holds ~290 MB. Do not launch a browser per call, and **no other process may import puppeteer** (`renderer.isolation.test.js`).
- **Callers** (API, template worker, render worker) use `engine/rendererClient.js`: same function names and result shapes as the in-process renderer; the multi-step operations that used to be `withDocument` closures are named operations (`engine/renderOps.js`: `prepareClear`, `prepareRoundTrip`, `fill`, `inspect`). JSON in/out (Buffers as `{ $b64 }`), PDFs streamed as `application/pdf`. Shared secret `CERT_RENDERER_TOKEN` (header `X-Renderer-Token`), required in production — the service refuses to start without it. Request limit `CERT_RENDERER_MAX_BYTES` (50 MB); more than `CERT_RENDERER_MAX_PENDING` (16) waiting → `503 RENDERER_BUSY`, retried by the client (3×, backoff), whole-exchange timeout `CERT_RENDERER_TIMEOUT_MS` (120 s). Errors reach tasks as `RENDERER_UNREACHABLE` (503), `RENDERER_BUSY` (503), `RENDER_FAILED` (502, the renderer's message). The service logs operation, status, sizes and time — never HTML or values.
- Before loading **any** template or certificate HTML:
  - `page.setRequestInterception(true)` and **abort every request** except `data:`/`about:`.
  - `page.setJavaScriptEnabled(true)` is allowed **only** because sanitized HTML contains no scripts. Only `fieldEngine` is injected.
- Load with `page.setContent(html, { waitUntil: "load" })`, then `await document.fonts.ready`.
- **PDF (P7/P8):**
  1. `emulateMediaType("screen")`.
  2. Inject `@page{size:${w}px ${h}px;margin:0}` plus the page-container reset, using the `.pf` rect.
  3. `page.pdf({ preferCSSPageSize: true, printBackground: true })`.
  4. Multi-page templates: one `.pf` per PDF page, using the same rules.

---

## 6. Data model (Prisma; additive migrations only)

V1 tables (`Template`, `TemplateImage`) stay untouched until Phase 8.

### 6.1 Models

```prisma
// ---------- files ----------
model StoredFile {
  id          String   @id @default(uuid())
  companyId   String?  @map("company_id")          // null only for system assets
  kind        String                               // template_source | template_sanitized | template_prepared | template_thumb
                                                   // | invoice_source | certificate_html | certificate_pdf | batch_zip
  path        String                               // relative to uploads/, e.g. certificates/{companyId}/{uuid}.html
  mimeType    String   @map("mime_type")
  sizeBytes   Int      @map("size_bytes")
  sha256      String
  originalName String? @map("original_name")
  createdAt   DateTime @default(now()) @map("created_at")
  @@index([companyId, kind])
  @@map("stored_files")
}

// ---------- catalogue ----------
model CertificateType {
  id          String   @id @default(uuid())
  companyId   String   @map("company_id")
  name        String                               // "Certificate of Analysis"
  code        String                               // "COA" — unique per company
  description String?
  isActive    Boolean  @default(true) @map("is_active")
  templates   CertificateTemplate[]
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  @@unique([companyId, code])
  @@map("certificate_types")
}

// ---------- templates ----------
model CertificateTemplate {
  id              String   @id @default(uuid())
  companyId       String   @map("company_id")
  certificateTypeId String @map("certificate_type_id")
  brandId         String?  @map("brand_id")
  country         String?                          // ISO-3166 alpha-2, e.g. "SA", "EG"
  scope           String   @default("per_product") // per_product | per_invoice
  name            String
  activeVersionId String?  @unique @map("active_version_id")
  archivedAt      DateTime? @map("archived_at")
  createdByUserId String?  @map("created_by_user_id")
  versions        TemplateVersion[]
  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")
  @@index([companyId, certificateTypeId])
  @@map("certificate_templates")
}
// Uniqueness (enforced in templateService inside a transaction, plus a partial unique index in SQL):
//   at most ONE non-archived template per (companyId, certificateTypeId, brandId, country, scope).

model TemplateVersion {
  id               String   @id @default(uuid())
  templateId       String   @map("template_id")
  versionNumber    Int      @map("version_number")
  status           String   @default("uploaded")   // uploaded|converting|draft|preparing|ready|active|superseded|failed
  sourceFormat     String   @map("source_format")  // ai | pdf | html
  sourceFileId     String   @map("source_file_id")
  sanitizedFileId  String?  @map("sanitized_file_id")  // converted + sanitized, fields NOT cleared (kept forever)
  preparedFileId   String?  @map("prepared_file_id")   // fields cleared → what generation renders
  thumbnailFileId  String?  @map("thumbnail_file_id")
  pages            Json?                            // [{ page, widthPx, heightPx, widthPt, heightPt }]
  lines            Json?                            // [{ id, page, text, box:{x,y,w,h}, fontClass }]  (CSS px, page-relative)
  fontCoverage     Json?    @map("font_coverage")   // { "ff1": "ACDEF…0123…", "ff2": "…" }
  conversion       Json?                            // { tool:"pdf2htmlEX", version, zoom, background, ms, warnings[], svg? }
  backgroundFormat String   @default("png") @map("background_format") // png | svg — svg only for versions with a repeating group (§7.8)
  prepareReport    Json?    @map("prepare_report")  // §7.6 gate results per field + round-trip diff %
  error            String?
  basedOnVersionId String?  @map("based_on_version_id") // "new version from this one"
  fields           TemplateField[]
  groups           TemplateGroup[]                  // repeating groups (§7.8)
  createdByUserId  String?  @map("created_by_user_id")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")
  @@unique([templateId, versionNumber])
  @@map("template_versions")
}

model TemplateField {
  id            String  @id @default(uuid())
  versionId     String  @map("version_id")
  key           String                       // snake_case, unique per version: "batch_no"
  label         String                       // "Batch number"
  page          Int     @default(1)
  lineId        String  @map("line_id")      // data-line id assigned at sanitize
  origin        String  @default("manual")   // manual | detected | ai_suggested (D10)
  confirmed     Boolean @default(true)       // activation refused while any field is unconfirmed (D10)
  charStart     Int     @map("char_start")   // offsets in the line's textContent (sanitized HTML)
  charEnd       Int     @map("char_end")
  sampleValue   String  @map("sample_value") // exact original text — used for previews + round-trip gate
  source        Json                         // §10.3 — { kind, path?, text?, template? }
  format        Json?                        // { date?: "MM/YYYY", case?: "upper"|"lower"|"title", number?: {...}, prefix?, suffix? }
  required      Boolean @default(true)
  align         String  @default("left")     // left | center | right — anchor inside the original box
  // geometry & calibration, written by prepare (§7.3):
  box           Json?                        // { x, y, w, h } CSS px, page-relative, of the original value
  limits        Json?                        // { minX, maxX } free space on the baseline before neighbours/page edge
  letterSpacing Float?  @map("letter_spacing") // calibrated CSS px
  fontClass     String? @map("font_class")
  scale         Float?                       // line transform scale (screen px per CSS px)
  groupKey      String? @map("group_key")    // a cell of this repeating group's sample row (§7.8); its source is a cell source (§10.3)
  sortOrder     Int     @default(0) @map("sort_order")
  @@unique([versionId, key])
  @@map("template_fields")
}

model TemplateGroup {                           // §7.8 — draft-only, like fields
  id            String  @id @default(uuid())
  versionId     String  @map("version_id")      // cascade with the version
  key           String                          // snake_case, unique per version, never a field key
  label         String
  mode          String  @default("repeat")      // repeat | fixed_rows
  source        Json                            // { kind: "product_list", path } | { kind: "invoice_lines" } | { kind: "manual" }
  whenEmpty     String  @default("dash") @map("when_empty") // dash | hide
  required      Boolean @default(true)          // 0 rows → `missing`
  sampleRows    Int?    @map("sample_rows")     // full table rows: how many rows the design shows (default 1)
  footerY       Float?  @map("footer_y")        // CSS px from the page top; null = the engine's proposal
  minPitchRatio Float   @default(0.85) @map("min_pitch_ratio")
  geometry      Json?                           // written by prepare: shape, band, pitch, frame, footer, capacity, sample rows…
  sortOrder     Int     @default(0) @map("sort_order")
  @@unique([versionId, key])
  @@map("template_groups")
}

// ---------- invoices ----------
model Invoice {
  id             String   @id @default(uuid())
  companyId      String   @map("company_id")
  brandId        String?  @map("brand_id")         // optional hint chosen at upload
  country        String?                            // chosen at upload, else extracted destination
  status         String   @default("uploaded")     // uploaded|extracting|review|ready|generating|generated|partially_failed|failed
  sourceFileId   String   @map("source_file_id")
  header         Json?                              // reviewed header (what generation uses)
  headerExtracted Json?   @map("header_extracted")  // raw AI output, never edited (audit)
  extraction     Json?                              // { modelId, promptHash, ms, tokens, warnings[] }
  error          String?
  reviewedAt     DateTime? @map("reviewed_at")
  reviewedByUserId String? @map("reviewed_by_user_id")
  uploadedByUserId String? @map("uploaded_by_user_id")
  items          InvoiceItem[]
  batches        CertificateBatch[]
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")
  @@index([companyId, createdAt])
  @@map("invoices")
}

model InvoiceItem {
  id              String  @id @default(uuid())
  invoiceId       String  @map("invoice_id")
  lineNo          Int     @map("line_no")
  data            Json                              // reviewed: { name, code, batchNo, productionDate, expiryDate, quantity, unit, packing, … }
  dataExtracted   Json    @map("data_extracted")    // raw AI output (audit)
  productId       String? @map("product_id")
  matchStatus     String  @default("needs_match") @map("match_status") // matched | needs_match | ignored
  matchMethod     String? @map("match_method")      // exact_code | exact_name | user
  matchCandidates Json?   @map("match_candidates")  // [{ productId, name, code, score, reasons[] }]
  @@unique([invoiceId, lineNo])
  @@map("invoice_items")
}

// ---------- generation ----------
model CertificateBatch {
  id            String   @id @default(uuid())
  companyId     String   @map("company_id")
  invoiceId     String   @map("invoice_id")
  status        String   @default("queued")        // queued|running|done|partially_failed|failed
  plan          Json                                // templateSelector output (frozen): which template versions for which items
  counts        Json?                               // { planned, rendered, failed, flagged }
  zipFileId     String?  @map("zip_file_id")
  startedByUserId String? @map("started_by_user_id")
  certificates  Certificate[]
  createdAt     DateTime @default(now()) @map("created_at")
  finishedAt    DateTime? @map("finished_at")
  @@map("certificate_batches")
}

model Certificate {
  id                String   @id @default(uuid())
  companyId         String   @map("company_id")
  batchId           String   @map("batch_id")
  invoiceId         String   @map("invoice_id")
  templateVersionId String   @map("template_version_id")  // exact design used → reproducible forever
  certificateTypeId String   @map("certificate_type_id")
  scope             String                                  // copied from template at generation
  productId         String?  @map("product_id")             // per_product only
  status            String   @default("draft")              // draft | final | failed
  currentVersion    Int      @default(1) @map("current_version")
  flagCount         Int      @default(0) @map("flag_count") // denormalised for list badges
  search            String?                                  // denormalised "productName batchNo invoiceNo" for filtering
  error             String?
  finalizedAt       DateTime? @map("finalized_at")
  finalizedByUserId String?  @map("finalized_by_user_id")
  finalPdfFileId    String?  @map("final_pdf_file_id")
  items             CertificateItem[]
  versions          CertificateVersion[]
  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")
  @@unique([batchId, templateVersionId, productId])
  @@index([companyId, invoiceId])
  @@index([companyId, status])
  @@map("certificates")
}

model CertificateItem {                 // which invoice lines a certificate covers (1 for per_product, n for per_invoice)
  certificateId String @map("certificate_id")
  invoiceItemId String @map("invoice_item_id")
  position      Int
  @@id([certificateId, invoiceItemId])
  @@map("certificate_items")
}

model CertificateVersion {
  id              String   @id @default(uuid())
  certificateId   String   @map("certificate_id")
  versionNumber   Int      @map("version_number")
  values          Json                               // { [fieldKey]: FieldValue }  (§10.4)
  htmlFileId      String?  @map("html_file_id")      // rendered, static HTML (D9)
  pdfFileId       String?  @map("pdf_file_id")       // created on export; frozen on finalize
  changeSource    String   @map("change_source")     // generation | user_edit | restore | regenerate_field
  changedByUserId String?  @map("changed_by_user_id")
  changeSummary   String?  @map("change_summary")    // "batch_no: AVVS1122005 → AVVS1124011"
  createdAt       DateTime @default(now()) @map("created_at")
  @@unique([certificateId, versionNumber])
  @@map("certificate_versions")
}
```

Add the matching relations, plus `Company`/`Brand`/`Product` back-relations.
- **`onDelete` rules:**
  - Certificates and versions are never cascade-deleted.
  - Deleting a product sets `Certificate.productId` / `InvoiceItem.productId` to null.
  - Deleting a template is only allowed when no certificate references any of its versions; otherwise archive it.
- **Partial unique index (raw SQL in the migration):** `UNIQUE (company_id, certificate_type_id, coalesce(brand_id,''), coalesce(country,''), scope) WHERE archived_at IS NULL` on `certificate_templates`.

### 6.2 What is stored with what

| Thing | Row | Files (StoredFile.kind) | Linked to |
|---|---|---|---|
| Uploaded design | `TemplateVersion` | `template_source` (.ai/.pdf/.html as uploaded) | → `CertificateTemplate` → `CertificateType`, `Company`, `Brand?` |
| Converted design | `TemplateVersion.sanitizedFileId`, `.lines`, `.pages`, `.fontCoverage` | `template_sanitized` (HTML, fields **not** cleared) | same version |
| Ready template | `TemplateVersion.preparedFileId`, `TemplateField[]` (+ geometry) | `template_prepared` (HTML with empty `<span data-field>`), `template_thumb` (PNG) | same version; `CertificateTemplate.activeVersionId` |
| Invoice | `Invoice` (+ `header`, `headerExtracted`) | `invoice_source` (kept) | → `Company`, `Brand?` |
| Invoice lines | `InvoiceItem` (+ `data`, `dataExtracted`, match) | — | → `Invoice`, `Product?` |
| Generation run | `CertificateBatch.plan` (frozen) | `batch_zip` (optional) | → `Invoice` |
| Certificate | `Certificate` | — | → `CertificateBatch`, `TemplateVersion`, `Product?`, `InvoiceItem[]` via `CertificateItem` |
| Each edit | `CertificateVersion.values` | `certificate_html` (static), `certificate_pdf` (on export) | → `Certificate` |
| Final document | `Certificate.status=final`, `finalPdfFileId` | `certificate_pdf` (frozen) | → the version it was finalized from |

**Retention (defaults; configurable later)**
- Everything is kept.
- Orphan files (no row references them for 24 h) are deleted by a daily job.
- Old `CertificateVersion` HTML files are never deleted, because they are the audit trail.

---

## 7. The field engine (core spec)

`fieldEngine.browser.js` exposes one global, `window.__certEngine`, whose pure functions operate on the loaded document. Every geometry value is in **CSS px relative to the `.pf` page** (it does not depend on zoom).

### 7.1 Line identity (at sanitize time)
- Every `div.t` gets `data-line="p{page}-l{index}"` (e.g. `p1-l11`) and every `.pf` gets `data-page="{n}"`.
- Field definitions reference `lineId`, plus `charStart`/`charEnd` offsets into that line's `textContent`. This is stable because the sanitized file never changes after conversion.

### 7.2 `analyse()` → lines, pages
Returns:
- **lines**: `{ id, page, text, box, fontClass }`, where `box` is the line rect relative to its `.pf`.
- **pages**: `{ widthPx, heightPx }` from the `.pf` rect.

`fontCoverage` is computed in Node with `fontkit` on each `@font-face` data URI (class → string of covered characters).

### 7.3 `clear(fields[])` — performed by `prepare`, on a copy of the sanitized HTML
For each field, grouped by line and processed **right-to-left within a line** so earlier offsets stay valid:

1. **Build a Range** from `(lineId, charStart, charEnd)`. Trim surrounding whitespace. Assert that `range.toString() === sampleValue`; otherwise fail that field with `OFFSET_MISMATCH`.
2. **Measure the original value box:** `before = range.getBoundingClientRect()`, converted to page-relative CSS px.
3. **Remove the value:** `range.deleteContents()`, which removes the characters plus the kerning spans fully inside the range.
4. **Insert** `<span data-field="{key}" style="word-spacing:0;letter-spacing:0">{sampleValue}</span>`. If any ancestor up to the line has class `_`, move the span to just after that ancestor (P1).
5. **Calibrate (P2):**
   - `scale = rect.width / offsetWidth`
   - `w0 = span rect width`
   - `ls = (before.w − w0) / scale / sampleValue.length`
   - set `letter-spacing: ls px`
   - **assert** that `|span rect width − before.w| ≤ 0.5px` and `|span rect left − before.x| ≤ 0.5px`
6. **Limits:** scan the other text runs on the same line and on lines whose vertical box overlaps the field's baseline. `limits.minX` is the nearest run edge to the left (or the page margin, 0), and `limits.maxX` the nearest on the right (or the page width). These bound how far a value may grow.
7. **Persist on the field:** `box`, `limits`, `letterSpacing`, `fontClass` (the effective `ff*` class at the span), `scale`.
8. **Empty the span** (`textContent = ""`), and remove `contenteditable`/editor attributes.

The serialized document is saved as `template_prepared`.

**Multi-line selection (UI convenience, §13.4):** a selection that crosses lines is split by the frontend into one field per line segment before saving. The engine always receives single-line fields.

### 7.4 `fill(values{ key → string }, fieldDefs)` → layout pass
For each field span:
1. Set `textContent = value`, which is escaped by definition. Reset `margin-left`, `margin-right` and `font-size`.
2. Measure `w`, then compute `d = (w − box.w) / scale` (growth in CSS px).
3. **Anchor (P4/P5):**
   - `left`: `ml = 0`
   - `center`: `ml = −d/2`
   - `right`: `ml = −d`
   - in every case set `margin-left: ml` and `margin-right: −d − ml`, so the rest of the line keeps its position.
4. **Overflow:**
   - Compute the value's resulting extent `[x0, x1]`. If it exceeds `limits`, shrink `font-size` in 2% steps, down to 80% minimum, recomputing steps 2–3.
   - If it still overflows, keep the 80% size and add the flag `overflow`.
   - If the size shrank but now fits, add the flag `shrunk`.
5. **Glyph check:** any character not in `fontCoverage[fontClass]` adds the flag `glyph` with the offending characters. Rendering continues; the browser falls back to another font.
6. **Empty value:** an empty value still applies step 3 (`d = −box.w/scale`), so neighbours never move. A required field gets the flag `missing`.

It returns `{ flags: { [key]: [...] } }`. The caller then serializes `document.documentElement.outerHTML` into **static HTML (D9)**, removing any engine-only attributes.

### 7.5 `measureRoundTrip()` — used by the gate
It fills every field with its own `sampleValue` and returns the per-field position/width deltas. Pixel comparison is done by the renderer (screenshot of sanitized vs. refilled-prepared, using `pixelmatch`).

### 7.6 Prepare gate (template becomes `ready` only if all pass)

| Check | Threshold |
|---|---|
| every field `OFFSET_MISMATCH`-free | 0 failures |
| calibration per field (step 5) | ≤ 0.5 px |
| round-trip per field (position, width) | ≤ 0.5 px |
| round-trip page pixel diff (each page) | ≤ 0.05 % |
| no field inside a transparent ancestor | 0 |
| no two fields overlapping | 0 |
| at least one field defined | ≥ 1 |

The report is stored in `TemplateVersion.prepareReport` and shown in the UI with a diff image. A failure lists the exact fields and reasons; the template stays `draft` and is editable.

### 7.7 Engine invariants
- The engine never touches anything outside the field spans. The only exception is during `clear`, which modifies characters inside a field's own range.
- No `innerHTML` is ever written with a value; values only ever go through `textContent`.
- Output HTML contains **no** `<script>`, **no** `contenteditable`, and **no** editor classes.
- Exception for repeating groups (§7.8): `fill` also edits the SVG background of a version with a group — row rules are cloned or stretched, and content between the group and the footer line moves. Text outside the group still only moves as a whole line.

### 7.8 Repeating groups (Phase 7; owner decisions 2026-10-20)

A **group** is one sample row of the design whose cells are ordinary fields (character ranges within a line, §7.1) with `groupKey`. At fill time the row is repeated once per item of a list (`values[groupKey] = [{ cellKey: text }]`) and the content below moves. The engine functions are `inspectGroups` (detection, no mutation), `removeGroupPlaceholders` (prepare) and `fill(…, groups)`.

**Background (decision 3, 8).** Groups need the table rules as separate shapes, so only versions with a group use `--bg-format svg` (`TemplateVersion.backgroundFormat`). Defining the first group on a PNG version is refused (`409 GROUP_NEEDS_SVG`); `POST /template-versions/:id/enable-groups` re-converts the same source file into a **new draft version** (fields copied, its own prepare gate and baseline; a `LINES_CHANGED` warning if the text layer differs). The SVG stays a base64 `<img>` — never inlined — and the engine decodes, edits and re-encodes it. At convert time it is normalised (§20 I26): defence-in-depth cleaning (no script/foreignObject/handlers, only `#id`/`data:image` references), cairo's page-wide blend filter → the destination drawn, then the source with `mix-blend-mode` (removes the printed hairline box, decision 8), constant luminance masks → `opacity`.

**Detection (`inspectGroups`).** From the cells' boxes: the row's columns; text rows below at a regular pitch inside those columns; horizontal rule *levels* covering ≥ 50 % of the columns. Two shapes (decision 6):
- `cell_list` — the list sits inside one table cell (ADDVET): the band runs from the rule above the sample row to the next rule; the further text rows in it are placeholder rows (2..k) and are removed by prepare; the pitch is the text pitch; `pad` is the band height not taken by rows.
- `table_rows` — every item is a full table row with its own rule segments (PHARMAVET): the band is k rows (`sampleRows`, default 1) between rule levels; the pitch is the row height.
The table's **frame** is the horizontal extent of the rule above the band (segments chained to the columns). Every background element is classified once — `above`, `faint` (watermark: low opacity or a mask whose content is < 50 %), `margin` (entirely outside the frame, e.g. a vertical side band drawn letter by letter), `pinned` (starts below the footer line), `below` (between band and footer — moves), `band` (inside the band), `crosser` (crosses the band — never touched). A crossing group is opened only when it is a page-sized/compositing layer or covers the table's columns.

**Refusals (decision 7).** No vector background → `GROUP_NEEDS_SVG`; a raster image behind the row → `GROUP_TABLE_RASTER`; no rules above/below → `GROUP_RULES_NOT_FOUND`; a rule that belongs to the table and crosses the band (one combined path, e.g. a single vertical stroke through every row) → `GROUP_RULES_COMBINED`. `PUT …/fields` answers 422 with `{ problems, fallback: "fixed_rows" }` and the UI offers the fallback.

**Fixed rows (`mode: "fixed_rows"`, decision 7).** For designs whose rules can't be told apart, the designer draws the **maximum** number of rows; the engine needs no rules (it works on PNG backgrounds too, but a group still needs an SVG version — decision 3). Unused rows are hidden and the gap is closed: text below moves up by `(k − N) × pitch` and the background is cut inside the frame (`clip-path` on the background `<img>` plus a shifted copy for the part below the cut). More rows than drawn → `overflow`, `rowsFit = k`.

**Footer line (decision 1).** The engine proposes the line: the start of the largest vertical whitespace (≥ 24 px) below the group, measured over text and moving drawings inside the frame; if the page bottom is the largest gap, the page bottom. Everything starting below it is pinned and never moves. The user confirms it or drags it (`TemplateGroup.footerY`); only content between the band and the line moves.

**Fill (decisions 2, 4, 5).**
- *Rows:* row 1 is the cells themselves; rows 2..N are clones of row 1's lines with only the cell spans kept, shifted by `i × pitch`. Each cell goes through §7.4 (anchoring, shrink/overflow per value, glyph check). `glyph:` flags of all cells merge into one flag on the group.
- *Height:* `cell_list` — `max(minRowHeight, pad + N × pitch)`, where `minRowHeight` is a normal one-line row of the same table, so **N = 1 looks exactly like one normal row** (height and text offset); `table_rows` — `N × pitch`. Never smaller than the sample row.
- *Fit:* the free space is `footerY − 8 px − bottom of the movable content`. Full pitch first; if N rows don't fit, the pitch shrinks to what fits but never below `minPitchRatio` (85 %) → `shrunk`; still too long → `overflow` (blocks finalize) and `rowsFit` = how many rows fit at 85 %. The rows are still drawn (the preview shows the problem); continuation pages are a follow-up (§17).
- *Background:* `below` elements move by Δ; `cell_list` — vertical rules (and tall cell fills) inside the band are **stretched** by Δ; `table_rows` — row 1's elements are **cloned** per row (its vertical segments stretched/shrunk with the pitch), the band's bottom rule is repeated per row, placeholder rows' drawings are removed. `above`, `faint`, `pinned`, `margin`, `crosser` are never touched (decision 6).
- *Empty (decision 2):* `whenEmpty: "dash"` keeps one row at the sample row's height showing "—"; `"hide"` removes the whole row including its label and closes the gap (band drawings and its bottom rule removed, content below moves up by the band height). A required group with 0 rows is flagged `missing` either way.
`fill` returns `geometry[groupKey] = { rows, rendered, pitch, delta, rowsFit }`.

**Prepare gate.** Groups are detected on the untouched document, every field (cells included) is cleared, placeholder rows are removed, and the round trip refills the group with its **original rows** (row 1 = the cells' samples; rows 2..k read from the placeholder text, split per column). Extra check `groups`: every group detected and all its cells cleared. The round-trip pixel diff (≤ 0.05 %) therefore covers the group. The detected geometry is stored in `TemplateGroup.geometry`.

**Measured (2026-10-21, `p7.groups.golden.test.js`, 136 checks).** ADDVET (`cell_list`, 3 sample rows, pitch 16 px, footer proposed at 802.8 px, 10 rows at full pitch / 12 at 85 %) and PHARMAVET (`table_rows`, 1 sample row, pitch 23.6 px, 12 rows): gate passes, round-trip 0 % / ≤ 0.01 %; N = 0 (dash, hide), 1, sample count, 2×, overflow: rows in order at the expected pitch, content below moved by exactly Δ, text below the footer line and the watermark / footer drawings / side band unmoved, N = 1 = a normal row (ADDVET), the original rows render like the design (0 %), PDF 1 page A4 with the row text extractable and no hairline in Chrome's PDF viewer.

---

## 8. Template pipeline

### 8.1 Upload → convert → sanitize → analyse (`convert` job)

**Request.** `POST /certificate-templates` (multipart `file`, plus `name`, `certificateTypeId`, `brandId?`, `country?`, `scope`). It creates the `CertificateTemplate` (if new) and `TemplateVersion v1` with status `converting`, then returns `202 { templateId, versionId, taskId }`.

**Validation**
- Extension in {ai, pdf, html}; size ≤ 60 MB.
- `.ai`/`.pdf` must start with `%PDF-`, otherwise 422 `NO_PDF_CONTENT`.
- `.html` must parse.

**Conversion.** `pdf2htmlexClient.convert(buffer, { zoom: 4/3 })`. If it returns zero lines, the version fails with `NO_LIVE_TEXT` ("text was converted to outlines").

**Sanitizer** (allowlist; `sanitize-html` configured explicitly — justify any change)
- **Keep:** `html, head, body, style, div, span, img, br, p, svg` and its shape children; attributes `class, id, style, src (data: only), width, height, alt, data-*`; `@font-face` with `data:` src.
- **Drop:** `script, iframe, object, embed, form, input, link, base, meta[http-equiv], noscript`; every `on*` attribute; `javascript:`; any non-`data:` URL inside `src`, `url()` or `@import`; `<a href>` (the tag is kept, `href` removed).
- **Add:** `data-page` / `data-line` ids (§7.1).

**Analyse** with the renderer: `lines`, `pages`, thumbnail PNG at 25% scale, `fontCoverage`. The status becomes `draft`.

**Non-pdf2htmlEX `.html` uploads.** If there is no `.pf`/`div.t`, treat the `body` as page 1, and treat every element whose own text is non-empty as a "line" (it gets `data-line`). §7 applies unchanged; calibration still works because it is measurement-based.

### 8.2 Field definition (draft only)
- `PUT /template-versions/:id/fields` replaces the full field list (it is idempotent). Validation:
  - `key` is snake_case and unique.
  - `lineId` exists.
  - The offsets are inside the line, and `line.text.slice(charStart, charEnd) === sampleValue`.
  - No overlapping ranges.
  - `source` is valid against the source catalogue (§10.3).
  - `format` is valid for the source type.
- `GET /certificate-field-sources` returns the catalogue the UI uses for its source picker. It is generated from the Prisma `Product` model plus the invoice header/item schemas, so it never drifts. Its `groups` part lists the group sources (with each product list's and the invoice lines' row paths), the cell source kinds, the modes and the `whenEmpty` options.

**Repeating groups (§7.8).** The same `PUT` takes `groups: [{ key, label, mode, source, whenEmpty, required, sampleRows?, footerY?, minPitchRatio? }]` (omitted = the stored groups are kept; `[]` removes them). Validation, on top of the field rules:
- the version has an SVG background (`409 GROUP_NEEDS_SVG` otherwise — create one with `POST …/enable-groups`);
- group keys are snake_case, unique, and never a field key; every group has at least one cell (a field with its `groupKey`), and every `groupKey` names a group; a group's cells are on one page, one group per page;
- `source`: `product_list` (a list on the product, e.g. `activeIngredients`) only on `per_product` templates; `invoice_lines` only on `per_invoice` templates; `manual` on both;
- a cell's source is `{ kind: "row", path }` (a path of its group's row), `static` or `manual`; `format` is checked against that path's type;
- `mode` ∈ `repeat | fixed_rows`, `whenEmpty` ∈ `dash | hide`, `sampleRows` 1–50, `footerY` > 0, `minPitchRatio` 0.85–1 (decision 4: 85 % is the floor; a group may only shrink less);
- the group is found in the real layout (§7.8 detection) — otherwise 422 with the reason and `fallback: "fixed_rows"`.
The response adds `groups` and `groupDetection: { [key]: { ok, shape, sampleRowCount, sampleRows, pitch, band, frame, footerY, footerProposal, capacity: { full, min }, page } | { ok: false, error, message } }` — the UI draws the band and the footer line from it. Group settings that change the prepared document (key, mode, sample rows, footer line, pitch ratio) are part of `fieldsHash`; label/source/whenEmpty/required are not.

### 8.3 Optional AI assistance (never writes HTML; can be disabled per company)
`POST /template-versions/:id/suggest` (`CERT_ASSIST`). It receives the **line texts only** and returns suggestions the user accepts or rejects one by one:
- probable variable values (dates, codes, numbers),
- a `key`/`label` name for each,
- a likely `source` mapping (e.g. `"Expiry Date:"` → `item.expiryDate`, format `MM/YYYY`).

### 8.4 Prepare → ready → activate
- `POST /template-versions/:id/prepare` → `preparing` → job runs §7.3 and §7.6 → `ready` or back to `draft` with a report.
- `POST /template-versions/:id/activate` requires `ready`. In one transaction it sets the template's `activeVersionId`, marks the previous active version `superseded`, and enforces template-slot uniqueness.
- `POST /template-versions/:id/new-version` clones the version (same sanitized file and fields) as `draft vN+1`, which allows fixing fields without re-uploading. `POST /certificate-templates/:id/versions` uploads a new design file as `vN+1`.
- Old versions remain readable forever. Certificates pin the exact version they used.

---

## 9. Invoice pipeline

### 9.1 Upload & extraction
`POST /invoices` (multipart `invoice` PDF/PNG/JPEG/WebP ≤ 15 MB; `brandId?`, `country?`). The company comes from `scopeFor`. It stores the file, creates the `Invoice` and enqueues `extract`.

**Extractor** (`INVOICE_EXTRACT`, native file input like `labelExtractor.js`, `responseSchema`)
- **header:** `{ invoiceNumber, invoiceDate, supplierName, customerName, customerCountry, currency }`
- **items[]:** `{ lineNo, name, code, batchNo, productionDate, expiryDate, quantity, unit, packing, extra{} }`
- Every field is nullable. Each value keeps a raw string; dates are additionally normalised to ISO only when unambiguous. Quantities likewise (review #4): a lone `.` or `,` followed by exactly three digits ("1.250", "1,250") is 1250 or 1.25 → `quantity: null`, `quantityRaw` kept, `quantityAmbiguous: true` and an extraction warning; the reviewer types the number (which clears the flag). Two separators, a repeated separator, or a group that cannot be thousands ("0,250", "1250.500") are decided.

**Failure → `failed`** with Google's real message. No retry with a different model, no fallback.

**Raw output is frozen** into `headerExtracted` / `dataExtracted`. `header` / `data` start as copies of it, and the user edits those.

### 9.2 Matching (`match` job, also re-run on demand)
1. An exact, case-insensitive `productCode` match within the company → `matched` (`exact_code`).
2. Otherwise an exact normalised `name` match (trimmed, case-folded, whitespace-collapsed, punctuation-stripped) with a single hit → `matched` (`exact_name`).
3. Otherwise compute ranked `matchCandidates` (top 5: name trigram similarity, code similarity, same brand bonus) → `needs_match`.
4. Everything is tenant-scoped: `where: { companyId }`, never a global product.

### 9.3 Review (status `review`)
The user can:
- edit header fields and item fields,
- add/remove items,
- pick a product per item from the candidates or by searching the catalogue,
- mark an item `ignored`.

`POST /invoices/:id/confirm` requires no item in `needs_match`, and moves the invoice to `ready`.

---

## 10. Generation

### 10.1 Template selection (`templateSelector`, a pure function with exhaustive tests)

**Input**
- the invoice (country, brandId),
- its items (with product → brand),
- the company's **active** templates.

**Per certificate type, per item, choose the most specific template**
1. Brand: brand-specific (= the product's brand, else the invoice's `brandId`) wins over brandless.
2. Country: country-specific (= `invoice.country`) wins over countryless. A template with a country is never used for a different country.
3. Ties are impossible (uniqueness rule).

**Output plan** (frozen into `CertificateBatch.plan`)
- `per_product`: one certificate per (item, templateVersion).
- `per_invoice`: items grouped by the template version they resolve to → one certificate per group (**assumption A2**).
- Items with no applicable template are listed in `plan.unassigned`, so the UI shows "no template for X".

### 10.2 Batch
`POST /invoices/:id/generate` (requires `ready`):
- It creates a `CertificateBatch`, then one `Certificate` + `CertificateItem` rows per plan entry, in a single transaction.
- It enqueues `generateBatch`. The worker renders each certificate as version 1: values → `fill` → static HTML.
- Progress is sent through `job_status_update` (`{ batchId, done, total }`). One certificate failing does not stop the batch; it ends `partially_failed`, and the failure is visible per certificate.
- Re-running generation creates a **new batch**. Existing `final` certificates are never touched.

### 10.3 Source catalogue (`source.kind`)

| kind | Shape | Resolves from |
|---|---|---|
| `invoice` | `{ kind, path }` e.g. `invoiceNumber` | `Invoice.header` |
| `item` | `{ kind, path }` e.g. `batchNo`, `expiryDate` | the certificate's item (`per_product`) |
| `product` | `{ kind, path }` e.g. `name`, `origin`, `packaging`, `category.name`, `activeIngredients[0].concentration` | matched `Product` (+ relations) |
| `company` | `{ kind, path }` e.g. `name`, `address`, `phone` | `Company` |
| `brand` | `{ kind, path }` e.g. `name` | the product's brand |
| `static` | `{ kind, text }` | constant |
| `manual` | `{ kind }` | empty at generation; filled in the editor |
| `today` | `{ kind }` | generation date |
| `template` | `{ kind, template: "COA{{item.batchNo}}" }` | mustache-style interpolation of the other kinds — **no expressions, no code** |

**Repeating groups (§7.8).** A group's `source` says where its rows come from; each cell's `source` reads its own row:

| Group `source` | Rows | Template scope |
|---|---|---|
| `{ kind: "product_list", path: "activeIngredients" }` | one row per entry of that list on the matched product, in order (e.g. `[{ name, concentration }]`) | `per_product` |
| `{ kind: "invoice_lines" }` | one row per invoice line of the certificate, in line order; each row is the line's data plus its matched product as `product` (tenant-scoped) | `per_invoice` |
| `{ kind: "manual" }` | none at generation; typed in the editor | both |

| Cell `source` | Value |
|---|---|
| `{ kind: "row", path }` e.g. `name`, `concentration`, `batchNo`, `product.name` | that path of the row (row paths are listed per group source in the catalogue) |
| `{ kind: "static", text }` | the same text in every row |
| `{ kind: "manual" }` | empty; typed in the editor |

Values only ever come from the declared list (D7); at most 200 rows. A collective certificate's `brand` stays as in I25 — rows never change it.

`format` is applied after resolution:
- `date` uses tokens `DD MM MMM YYYY YY`; the input must be a date or an ISO string, otherwise the raw value is kept and flagged `format`.
- `case`: `upper | lower | title`.
- `number`: `{ decimals, thousands }`.
- `prefix` / `suffix`.

### 10.4 Stored value shape (`CertificateVersion.values[key]`)

```json
{
  "value": "AVVS1124011",
  "source": { "kind": "item", "path": "batchNo" },
  "resolved": "AVVS1124011",
  "origin": "auto",
  "flags": ["shrunk"],
  "editedByUserId": null,
  "editedAt": null
}
```

- `origin` is one of `auto`, `manual` or `restored`.
- `flags` may contain `missing`, `overflow`, `shrunk`, `glyph:BX` or `format`.

A repeating group's value (§7.8):

```json
{
  "kind": "group",
  "rows": [{ "name": "Vitamin E", "amount": "120000 mg" }],
  "resolvedRows": [{ "name": "Vitamin E", "amount": "120000 mg" }],
  "source": { "kind": "product_list", "path": "activeIngredients" },
  "origin": "auto",
  "flags": ["shrunk", "glyph:B"],
  "rowsFit": 12,
  "editedByUserId": null,
  "editedAt": null
}
```

`flags` on a group: `missing` (required and 0 rows), `overflow` (more rows than fit; `rowsFit` says how many fit), `shrunk` (pitch reduced, ≥ 85 %), one merged `glyph:` for all cells, `format`.

`Certificate.flagCount` = the number of values with blocking flags (`missing` on a required field, `overflow`, `glyph`).

---

## 11. Editing, versions, export, finalize

**Edit**
- `PATCH /certificates/:id/values` with `{ expectedVersion, changes: { key: value } }`. For a repeating group the value is its **full list of rows** (`[{ cellKey: text }]`): adding, removing, reordering and editing rows are all one change → a new version, summarised as "rows: 5 rows → 6 rows" / "rows reordered" / "1 row edited". A group sent as text → 422 `INVALID_ROWS`, an unknown cell → 422 `UNKNOWN_FIELD`, rows sent for a plain field → 422 `INVALID_VALUE`. `POST …/fields/:groupKey/reset` puts back the rows of the declared list.
- A `409` is returned if the version is stale.
- Otherwise it creates version N+1 by re-running `fill` and storing the new static HTML. `changeSummary` is generated as `key: old → new`.

**Other version actions**
- **Re-resolve one field from its source:** `POST /certificates/:id/fields/:key/reset` (`changeSource: regenerate_field`).
- **Versions:** `GET /certificates/:id/versions`, and `POST /certificates/:id/versions/:n/restore`, which is forward-only (it creates N+1).

**Export**
- `POST /certificates/:id/export-pdf` → job → `pdfFileId` on the current version, then `GET /certificates/:id/pdf` (streams; `Content-Disposition` with `{type}-{product}-{batch}.pdf`).
- **Batch ZIP:** `POST /certificate-batches/:id/export` → `batch_zip` file.

**Finalize** — `POST /certificates/:id/finalize`
- It refuses while `flagCount > 0`; the error lists the flags.
- It exports the PDF if missing, freezes it (`finalPdfFileId`), and sets `status=final`, `finalizedAt` and `finalizedByUserId`.
- A final certificate rejects edits with 409 `CERTIFICATE_FINAL`. To change one, regenerate (new batch) or use `POST /certificates/:id/duplicate` → a new draft.

---

## 12. API contract

All routes use `protect` + `restrictToPermission` and are tenant-scoped via `scopeFor(req)`: a company caller is forced to its own id; a system user must pass `?companyId=`.
- Resources from another tenant return **404**, never 403, so their existence isn't leaked.
- Responses follow the house style `{ status, data, results?, total? }`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET/POST | `/certificate-types` | `read_/create_certificate_types` | catalogue |
| PATCH/DELETE | `/certificate-types/:id` | `update_/delete_certificate_types` | delete only if unused |
| POST | `/certificate-templates` | `create_certificate_templates` | multipart; 202 |
| GET | `/certificate-templates` | `read_certificate_templates` | filters: type, brand, country, scope, status |
| GET | `/certificate-templates/:id` | read | includes versions summary |
| PATCH | `/certificate-templates/:id` | `update_certificate_templates` | name, brand, country, scope (re-checks uniqueness) |
| POST | `/certificate-templates/:id/versions` | update | upload a new design → new draft version |
| POST | `/certificate-templates/:id/archive` | update | |
| GET | `/template-versions/:id` | read | lines, pages, fields, prepareReport |
| GET | `/template-versions/:id/html?variant=sanitized\|prepared\|sample` | read | `text/html`, CSP `script-src 'none'`, `X-Content-Type-Options: nosniff` |
| GET | `/template-versions/:id/thumbnail` | read | PNG |
| PUT | `/template-versions/:id/fields` | update | draft only; `groups` optional (§8.2) |
| POST | `/template-versions/:id/enable-groups` | update | 202 → a new SVG-background draft version (§7.8) |
| POST | `/template-versions/:id/suggest` | update | optional AI |
| POST | `/template-versions/:id/prepare` | update | 202 |
| POST | `/template-versions/:id/preview` | read | body `{ values }` or `{ invoiceItemId }` → rendered HTML (not stored) |
| POST | `/template-versions/:id/activate` | update | |
| POST | `/template-versions/:id/new-version` | update | clone as draft |
| GET | `/certificate-field-sources` | read | source catalogue |
| POST | `/invoices` | `create_invoices` | multipart; 202 |
| GET | `/invoices` · `/invoices/:id` | `read_invoices` | `:id` includes items + candidates + batches |
| PATCH | `/invoices/:id` | `update_invoices` | header edits (review only) |
| POST/PATCH/DELETE | `/invoices/:id/items[/:itemId]` | update | item edits, match `{ productId }` / `{ ignored: true }` |
| POST | `/invoices/:id/rematch` | update | |
| POST | `/invoices/:id/confirm` | update | → ready |
| POST | `/invoices/:id/generate` | `create_certificates` | 202 → batch |
| GET | `/certificate-batches/:id` | `read_certificates` | progress + certificates |
| POST | `/certificate-batches/:id/export` | `export_certificates` | ZIP |
| GET | `/certificates` | read | filters: invoiceId, batchId, status, type, flagged, q |
| GET | `/certificates/:id` | read | current values + flags + template field defs |
| GET | `/certificates/:id/html?version=n` | read | static HTML, CSP as above |
| PATCH | `/certificates/:id/values` | `update_certificates` | optimistic concurrency |
| POST | `/certificates/:id/fields/:key/reset` | update | |
| GET | `/certificates/:id/versions` · POST `/:id/versions/:n/restore` | read / update | |
| POST | `/certificates/:id/export-pdf` · GET `/:id/pdf` | `export_certificates` | |
| POST | `/certificates/:id/finalize` · `/:id/duplicate` | `update_certificates` | |
| GET | `/background-tasks/:id` | (scoped) | **tenant-scoped in Phase 0** |

**Permissions to seed:** `create/read/update/delete` for `certificate_types`, `certificate_templates` and `invoices`, plus `export_certificates`. The existing `*_certificates` permissions are reused.

**Middleware fix (blocking).** `authMiddleware.restrictToPermission` derives a company's module from `slug.split("_")[1]`. That turns `create_certificate_templates` into `"certificate"`, so **every company would be blocked**. Replace it with a lookup of `Permission.module` (seeded), or `slug.split("_").slice(1).join("_")`, against an explicit company allowlist that adds `certificate_types`, `certificate_templates` and `invoices`. Cover it with tests.

### 12.1 Key payloads

`POST /certificate-templates` → `202`
```json
{ "status": "accepted", "data": { "templateId": "…", "versionId": "…", "taskId": "…" } }
```

`PUT /template-versions/:id/fields`
```json
{ "fields": [
  { "key": "batch_no", "label": "Batch number", "page": 1, "lineId": "p1-l11",
    "charStart": 12, "charEnd": 23, "sampleValue": "AVVS1122005",
    "source": { "kind": "item", "path": "batchNo" }, "format": null, "required": true, "align": "left" },
  { "key": "document_no", "label": "Document #", "page": 1, "lineId": "p1-l9",
    "charStart": 12, "charEnd": 26, "sampleValue": "COAAVVS1122005",
    "source": { "kind": "template", "template": "COA{{item.batchNo}}" }, "required": true, "align": "left" },
  { "key": "expiry", "label": "Expiry date", "page": 1, "lineId": "p1-l13",
    "charStart": 14, "charEnd": 21, "sampleValue": "11/2025",
    "source": { "kind": "item", "path": "expiryDate" }, "format": { "date": "MM/YYYY" }, "required": true, "align": "left" }
] }
```

`GET /template-versions/:id` (excerpt)
```json
{ "status": "success", "data": { "version": {
  "id": "…", "status": "ready", "versionNumber": 1,
  "pages": [{ "page": 1, "widthPx": 793.69, "heightPx": 1122.52, "widthPt": 595.28, "heightPt": 841.89 }],
  "lines": [{ "id": "p1-l11", "page": 1, "text": "Batch No.:  AVVS1122005", "box": { "x": 409.1, "y": 291.7, "w": 140.2, "h": 14.8 }, "fontClass": "ff2" }],
  "fields": [{ "key": "batch_no", "align": "left", "box": { "x": 518.3, "y": 292.1, "w": 68.9, "h": 11.1 }, "limits": { "minX": 512.0, "maxX": 760.0 } }],
  "prepareReport": { "passed": true, "pixelDiffPct": 0.018, "fields": { "batch_no": { "dx": 0.0, "dw": 0.0 } } }
} } }
```

`PATCH /certificates/:id/values`
```json
{ "expectedVersion": 3, "changes": { "batch_no": "AVVS1124011", "expiry": "06/2027" } }
```
→ `200 { data: { version: 4, values: {…}, flags: {…} } }` · `409 { code: "VERSION_CONFLICT", currentVersion: 4 }` · `409 { code: "CERTIFICATE_FINAL" }`

Document every endpoint in `src/docs/paths/…`, `FRONTEND-GUIDE.md` and `API-CHANGES.md`, then run `npm run docs:export`.

---

## 13. Frontend (`mostanad_front`)

**Stack (keep):** React 19, Vite, Tailwind 4, axios `apiClient`, react-router 7, react-hot-toast, lucide-react, react-select, socket.io-client. **No new UI framework.**

House patterns to follow:
- `services/apiX.js` with the `unwrap` helper (see `apiGeneratedLabels.js`).
- Pages in `src/pages`, page-specific components in `src/components/<feature>/`.
- `RequirePermission` on routes; Sidebar entries gated by permission.

### 13.1 Routes & navigation

| Route | Page | Permission |
|---|---|---|
| `/certificates/templates` | `CertificateTemplates.jsx` — list | `read_certificate_templates` |
| `/certificates/templates/new` | `CertificateTemplateWizard.jsx` — upload → fields → settings → prepare → activate | `create_certificate_templates` |
| `/certificates/templates/:templateId/versions/:versionId` | same wizard, opened on an existing version | `update_certificate_templates` |
| `/certificates/types` | `CertificateTypes.jsx` | `read_certificate_types` |
| `/invoices` | `Invoices.jsx` — list | `read_invoices` |
| `/invoices/new` | `InvoiceUpload.jsx` | `create_invoices` |
| `/invoices/:id` | `InvoiceReview.jsx` — extraction review + matching + generate + batches | `read_invoices` |
| `/certificates` | `CertificatesList.jsx` — all generated, filters | `read_certificates` |
| `/certificates/:id` | `CertificateEditor.jsx` | `read_certificates` |

Sidebar group **"Certificates"**: Templates · Types · Invoices · Generated certificates.
- The V1 entries (`/templates`, `/templates/editor`, `/templates/ai`, `/certificates/generate`) are hidden behind a "Legacy" sub-item until Phase 8 removes them.
- System users get a **company picker** at the top of each page (same pattern as the existing pages), and every call adds `?companyId=`.

### 13.2 Files

```
src/services/apiCertificateTypes.js
src/services/apiCertificateTemplates.js      (templates + versions + fields + prepare + preview + sources)
src/services/apiInvoices.js
src/services/apiCertificatesV2.js            (certificates, batches, versions, export, finalize)
src/hooks/useTaskProgress.js                 (poll GET /background-tasks/:id every 2s + socket hint; stops on terminal state)
src/hooks/useCompanyScope.js                 (company picker state for system users)
src/components/certificates/DocumentFrame.jsx          (sandboxed iframe viewer; zoom-to-fit; page nav)
src/components/certificates/FieldMarker.jsx            (selection → field drafts; highlights; multi-line split)
src/components/certificates/FieldPanel.jsx             (field list + editor: key, label, source picker, format, required, align)
src/components/certificates/SourcePicker.jsx           (grouped react-select from /certificate-field-sources)
src/components/certificates/PrepareReport.jsx          (gate results, diff image, per-field deltas)
src/components/certificates/StatusBadge.jsx
src/components/certificates/FlagBadges.jsx             (missing / overflow / shrunk / glyph / format)
src/components/certificates/InvoiceItemsTable.jsx      (editable grid + match column)
src/components/certificates/ProductMatchSelect.jsx     (candidates + catalogue search)
src/components/certificates/CertificateValuesForm.jsx
src/components/certificates/VersionsDrawer.jsx
src/utils/certificateFieldSources.js                   (labels/grouping for the picker)
```

### 13.3 `DocumentFrame` — the one way to show certificate HTML
- It loads the HTML **by URL** from the API (`/template-versions/:id/html`, `/certificates/:id/html`), using the token-authorised fetch → blob URL. It never uses `srcDoc` with raw strings or `dangerouslySetInnerHTML`.
- It uses `<iframe sandbox="allow-same-origin">`, with no `allow-scripts`. The parent may read the DOM (selection, highlighting); the document can execute nothing.
- On load it applies only **viewer-only** CSS (page container reset, white background) through a `<style data-viewer>` it injects. The document itself is never mutated for viewing.
- Zoom-to-fit uses a CSS `transform: scale()` on the iframe wrapper. Selection still works under the transform.
- Multi-page documents get page navigation and lazy scroll.

### 13.4 Template wizard (one page, five steps, URL-addressable)

1. **Upload**
   - Inputs: drop zone for `.ai/.pdf/.html`, name, certificate type (create inline), brand (optional), country (optional, react-select-country-list), scope (radio with explanation).
   - Submit → progress via `useTaskProgress`.
   - Errors map to human messages: `NO_PDF_CONTENT` → "re-save with Create PDF Compatible File"; `NO_LIVE_TEXT` → "text was converted to outlines".
2. **Mark fields**
   - **Layout:** left is the `DocumentFrame` (sanitized variant); right is the `FieldPanel`.
   - **Selecting:** select text → a floating "Make field" button next to the selection (also `Enter`). A selection spanning several lines makes **one draft field per line**. **Ctrl/⌘-select** adds to a pending multi-selection, and "Make fields (n)" converts them all.
   - **Highlighting:** each field is shown with the CSS Custom Highlight API (fallback: overlay boxes positioned from `lines[].box`). **Nothing is written into the document.**
   - **FieldPanel:** a list of fields with key (auto-slug from the label), label, `SourcePicker`, format (only options valid for the source type), required, align. Align is suggested as `center` when the original value's center is within 2 px of the column header's center on the line above.
   - **Other actions:** "Suggest fields (AI)" — optional, accept/reject chips. Delete. Reorder.
   - **Saving:** autosave (debounced 800 ms) → `PUT …/fields`. Unsaved/invalid state is shown in the step header.
3. **Settings** — review name/type/brand/country/scope. If another active template occupies the same slot, a warning says which template will be superseded.
4. **Prepare & test**
   - "Prepare" runs the job, then shows the `PrepareReport` with pass/fail per check, the diff image and per-field deltas.
   - **Test fill:**
     - pick a product (and optionally an invoice item), or type ad-hoc values;
     - `POST …/preview` renders it on the server;
     - flags are shown inline.
   - This is the owner's "100%" check before go-live.
5. **Activate** — a confirmation listing what changes (supersedes vN). After it: "Generate certificates from an invoice" CTA.

### 13.5 Invoice flow
- **InvoiceUpload:** a drop zone, brand/country (optional), then a redirect to `InvoiceReview` while extraction runs. The skeleton shows the "Extracting…" progress.
- **InvoiceReview:**
  - **Header card:** invoice no., date, customer, country. These are editable, with "AI extracted" vs "edited" markers.
  - **`InvoiceItemsTable`:** columns are line, name, code, batch, production, expiry, qty/unit, packing, **product match**. Each cell is editable. The match column shows ✓ matched (method), a ⚠ select from candidates, or ignored. You can add or remove rows.
  - **Original invoice:** shown side by side (PDF/image viewer) so the user can check values against it.
  - **"Confirm"** is enabled when nothing is `needs_match`.
  - **"Generate"** shows the **plan preview** first: which certificates will be produced, per type/template, plus the `unassigned` items with a link to create the missing template.
  - **Batches section:** progress bar, then a grid of certificate cards (thumbnail, type, product, flags, status), plus "Download all (ZIP)".

### 13.6 Certificate editor
- **Layout:** left is the `DocumentFrame` (current version HTML); right is the `CertificateValuesForm`.
- **`CertificateValuesForm`:** one row per field, with label, value input, source chip (e.g. "Invoice · batchNo"), flag badges and a "reset to source" action.
- **Instant feedback:** while typing, the frontend updates the field span's `textContent` inside the frame for **instant visual feedback only**. This is an optimistic preview: no layout compensation, and it is clearly ephemeral.
- **Save:** on save (or 1 s idle) it sends `PATCH …/values` with `expectedVersion`. The server's re-rendered static HTML replaces the frame, so the server is always the source of truth.
- **Conflicts:** on 409 `VERSION_CONFLICT`, show a dialog with "reload" vs "overwrite with mine" (re-PATCH with the new `expectedVersion`).
- **Header:** status, version, "Versions" drawer (list, view, restore), "Export PDF", "Finalize" (disabled while flags remain; a tooltip lists them).
- **Final certificates** are read-only, with "Download PDF" and "Duplicate as draft".
- **Keyboard:** `Tab` moves through fields, `Ctrl+S` saves, `Esc` reverts the current input.

### 13.7 UX & quality rules
- Every async action shows progress. Every failure shows the backend `message`; never a generic "failed".
- Empty states always say what to do next: no types → create a type, no templates → upload one, no invoices → upload one.
- Flags use consistent colours and copy:
  - `missing` red "Required value missing"
  - `overflow` red "Doesn't fit — shorten or change"
  - `shrunk` amber "Shrunk to fit"
  - `glyph` amber "Character not in the design font: B, X"
  - `format` amber "Couldn't format as date"
- English UI (matches the app). All strings live in one place per page, so they are easy to translate later.
- No certificate HTML is ever injected into the app DOM (no XSS vector).
- Lint clean (`oxlint`); no console errors; lists paginate (default 20).

---

## 14. Security & tenancy (checklist)
- [ ] `scopeFor` on every new route; cross-tenant access → 404 (with tests per resource).
- [ ] Permissions middleware module parsing fixed (§12) + tests for company callers.
- [ ] Upload limits and magic-byte checks; filenames never reach a shell or a path (UUID file names only).
- [ ] Sanitizer allowlist + tests with a malicious corpus (script, `onerror`, `javascript:`, remote `url()`, `@import`, `<base>`, SVG `<script>`, `<foreignObject>`).
- [ ] HTML endpoints serve `Content-Security-Policy: default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'`, plus `X-Content-Type-Options: nosniff`.
- [ ] Puppeteer: network blocked, no file:// access, page timeout 30 s, browser recycled.
- [ ] Gemini receives invoice files only; template HTML never leaves the server (the AI assist receives line text only).
- [ ] An audit trail exists for every state change (who, when): it lives in the version tables and the `reviewedBy`/`finalizedBy` columns.
- [ ] Separate track (not in this plan, but schedule it): Socket.IO auth, removal of the `x-test-bypass` header, JWT in `localStorage`.

---

## 15. Observability & operations
- Every job logs `{ entity, id, companyId, ms, outcome }`. Gemini calls go through `generationMetrics`.
- `GET /health` on pdf2htmlex. The app health endpoint reports converter reachability.
- Metrics: conversion ms, prepare pass rate, render ms per certificate, flags per batch, extraction failures by reason.
- **Daily cleanup job:** orphan `StoredFile`s older than 24 h, and stuck tasks (> 30 min `running` → `failed` with a reason).

---

## 16. Testing & acceptance

**Runner:** `npm test` (the custom runner, no Jest). Suites live in `tests/certificates-v2/`.

### 16.1 Fixtures (`fixtures/certificates/`)

| File | Purpose |
|---|---|
| `ADDVET_COA.ai` | main golden template (Latin) |
| `PHARMAVET_COA.pdf` | second golden (Turkish glyphs, centered cells) — the file is in `D:\turk\ai2html-test\jobs\7ba0749b…\input.pdf` |
| `no_pdf_content.ai` | Illustrator file without PDF content |
| `outlined_text.pdf` | text converted to outlines |
| `malicious.html` | sanitizer corpus |
| `invoice_*.pdf` (2–3, anonymised) + `invoice_*.expected.json` | extraction expectations |

### 16.2 Golden field sets (must pass in CI)
- **ADDVET:** `batch_no`, `product_name`, `expiry`, `production`, `ph_result`, `constituent_2_name`, `constituent_2_amount`, `document_no`.
- **PHARMAVET:** `expiry` (center), `production` (center), `batch_no` (center), `ph_result`, `constituent_amount`, `producer`.

For each set:
- **Calibration:** every field ≤ 0.5 px.
- **Round-trip pixel diff:** ≤ 0.05 % (the 2026-10-08 measurement was 0.018 %).
- **Anchoring:** fill longer/shorter values; neighbour text drift ≤ 0.5 px; the center anchor stays within ≤ 0.5 px of the original center.
- **Overflow:** a value 3× longer → `shrunk` or `overflow` flag; neighbours unmoved.
- **Glyph:** a value containing `B`/`X` on ADDVET → `glyph:BX`.
- **PDF:** 1 page per `.pf`; page size equals the source ±0.5 pt; the text is extractable; visual diff vs source ≤ 3 % at 100 dpi (anti-aliasing).

### 16.3 Other required tests
- `templateSelector`: brand/country specificity matrix, unassigned items, per_invoice grouping.
- `valueResolver`: every source kind, `template` interpolation (it must not evaluate code), formats, missing.
- **Extraction failure:** `failed`, zero items, zero certificates.
- **Matching:** exact code, exact name, ambiguous → candidates, tenant isolation.
- **Concurrency:** a stale `expectedVersion` → 409; a final certificate → 409.
- **Idempotency:** re-running `generateBatch` for the same batch creates no duplicates.
- **Frontend:** a manual QA script per screen (in `mostanad_front/FRONTEND-STATUS.md`), plus a Playwright smoke run of the wizard and the editor against the dev stack (optional, recommended).
- Repeating groups (Phase 7): `p7.groups.golden.test.js` — both goldens, N = 0 (dash, hide), 1, sample count, 2×, overflow; round trip with the original rows ≤ 0.05 %; PDF 1 page / A4 / extractable text / **no hairline** (Chrome's PDF viewer, PDFium, compared with the original PDF; the un-normalised SVG export is the negative control); fixed rows on SVG and PNG; refusals. `p7.groups.api.test.js` — enable-groups, validation, footer line, prepare/activate, generation from a product list and from invoice lines, row edits as versions, overflow blocks finalize, tenancy. UI smoke phase 7 — marking a group, choosing the source, the footer line, editing rows.

---

## 17. Phases (each a vertical slice; demo + owner sign-off before the next)

| Phase | Content | Exit criteria |
|---|---|---|
| **0 · Safety** | Tenant-scope `GET /background-tasks/:id`; enforce ownership on V1 certificate/template routes; remove V1 mock fallbacks (fail loudly); disable `generate-ai` + remove the `execSync` filename injection; fix the permission middleware module parsing (§12) | tests: cross-tenant 404, Gemini failure → `failed`, company caller allowed on new modules |
| **1 · Foundations** | `StoredFile` + `fileStore`; `pdf2htmlexClient` (zoom 4/3); sanitizer; renderer pool + `fieldEngine.analyse`; models `CertificateType`, `CertificateTemplate`, `TemplateVersion`; upload → `draft`; HTML/thumbnail endpoints. **FE:** Types page, Templates list, wizard step 1 + `DocumentFrame` | owner uploads ADDVET + PHARMAVET and sees pixel-identical previews; malicious HTML is neutralised |
| **2 · Fields & prepare** | `TemplateField`; fields API + source catalogue; `fieldEngine.clear` + gate; activate / new-version; optional suggest. **FE:** wizard steps 2–5 (marking incl. multi-line & Ctrl-select, FieldPanel, PrepareReport, test fill, activate) | both golden field sets pass the gate; owner marks and activates both templates in the UI |
| **3 · Invoices** | `Invoice`, `InvoiceItem`; extraction; matching; review edits; confirm. **FE:** upload, review page, items table, match select, side-by-side original | real invoices extracted; every line resolvable; failures are explicit |
| **4 · Generation** | `templateSelector`, `valueResolver`, `fieldEngine.fill`; `CertificateBatch`, `Certificate`, `CertificateItem`, `CertificateVersion`; batch job; flags. **FE:** generate plan preview, batch grid | invoice → correct set of certificates with correct values and flags |
| **5 · Edit, export, finalize** | values PATCH + versions + restore + reset-field; PDF export (P7/P8 rules); ZIP; finalize/duplicate. **FE:** `CertificateEditor`, VersionsDrawer, export, finalize | full loop on both goldens; PDF acceptance (§16.2) passes |
| **6 · Hardening** | idempotency audit, cleanup job, metrics, load test (20 templates, invoice with 50 items < 3 min on free-tier RPM), docs | load test passes; docs updated; zero console errors |
| **7 · Repeating groups** | Spike (2026-10-20) → Step 2 (owner decisions 2026-10-20, §7.8): SVG background for versions with a group (`enable-groups`), detection of both row shapes, footer line, fill with pitch down to 85 %, `whenEmpty`, overflow, fixed rows fallback, hairline fix; sources product list / invoice lines / manual; row editing in the editor. **FE:** group card + footer line on the marking screen, rows table in the editor | both goldens render N = 0…overflow correctly with the PDF checks; owner marks a group and edits rows in the UI |
| **7b · Continuation pages** (follow-up, not built) | a group longer than the free space continues on extra pages: page template = the design with the group region cleared, header/footer repeated, "continued" marker, page numbering; `overflow` then no longer blocks for lists that fit on N pages | owner decides the continuation layout (which parts repeat, max pages) |
| **8 · Retire V1** | remove V1 routes/workers/services/pages, the `aiTemplate*` pipeline and Inkscape from the Dockerfile; remove Legacy nav. V1 DB tables/columns stay (additive rule) | no V1 code paths remain; tests green |
| **9 · Field detection** (last; not built) | automatic detection of variable values → fields with `origin: "detected"`, `confirmed: false` (D10); never activatable until a human confirms each one | detected fields never reach an active version unconfirmed |

---

## 18. Open questions (assumptions in force until answered)

| # | Question | Assumption |
|---|---|---|
| A1 | What does a collective (per-invoice) certificate look like? How many items per page? | **Answered by the Phase 7 decisions (2026-10-20):** a `per_invoice` template may have an `invoice_lines` group; as many lines as fit above the footer line (pitch down to 85 %), beyond that `overflow`. Continuation pages: §17 7b |
| A2 | An invoice with several brands → one collective certificate, or one per brand/template? | One per resolved template version (i.e. per brand when brand templates exist) |
| A3 | Who finalizes? Is a second person required? | Any user with `update_certificates`; no dual control yet |
| A4 | Invoice country: chosen or extracted? | Chosen at upload if given, else the extracted `customerCountry` |
| A5 | Missing glyphs: will designers provide full font files? | Flag only (`glyph` flag per field; one merged flag per group). Full-font upload is **out of scope** for this build (owner, 2026-10-16). Lists hit it more often ("B" in Biotin on ADDVET; "F", "4", "Z" on PHARMAVET); estimate in `PROGRESS.md` (Phase 7) for scheduling next |
| A6 | Retention of invoices and PDFs? | Keep everything; policy later |
| A7 | Arabic/RTL certificate designs? | Out of scope; pdf2htmlEX positions LTR |
| A8 | Should D4 (code clears, not AI) stand? | Yes — §2 explains why; the owner confirms |

---

## 19. Risks

| Risk | Mitigation |
|---|---|
| pdf2htmlEX lightly maintained (last release 2020) | pinned version + checksum, isolated service, golden tests catch regressions, HTML upload as an escape hatch |
| Font subsets miss glyphs | `glyph` flag at fill time; full-font upload later |
| Free-tier Gemini limits (8 RPM, daily caps) | extraction is the only AI call per invoice; invoice worker concurrency 1; enable billing (pending owner action) |
| Puppeteer memory/leaks | pooled browser, recycle after N renders, per-page timeout |
| Untrusted HTML | sanitizer allowlist, CSP, sandboxed iframes, network-blocked renderer, no DOM injection in the app |
| Chromium runs with `--no-sandbox` (review #16; not changed yet) | Today the renderer's own isolation is: sanitized HTML only (no scripts of its own — the only JavaScript that runs is the injected field engine), every non-data:/about: request blocked, a pooled browser recycled after N renders, per-page timeouts — but a Chromium exploit would land as root in the `certificate-render-worker` container. **Recommendation:** run that worker as a non-root user (`USER node` in the Dockerfile, `uploads/` owned by it), drop `--no-sandbox`/`--disable-setuid-sandbox` and give the container Chromium's seccomp profile (or `cap_add: SYS_ADMIN` only on that service if user namespaces are unavailable); verify with the golden + render tests in the container before enabling in production. Owner decision pending. |
| Template drift (re-uploaded design breaks fields) | immutable versions; certificates pin a version; new design = new version with its own gate |
| GPL (pdf2htmlEX) | separate program over HTTP, never linked; confirm with counsel if distributing |
| Repeating groups on designs other than the two goldens (Phase 7) | detection is geometric (rule levels, text pitch, frame) and was proven on ADDVET and PHARMAVET only. A design it can't read is refused with the reason (never guessed) and offered fixed rows; the prepare gate's round trip with the original rows catches a wrong detection before activation |
| SVG backgrounds are bigger and slower than PNG | only versions with a group use them (decision 3); ADDVET 0.95 MB / PHARMAVET 1.5 MB base64; a filled render edits the SVG in the browser (~0.5–1 s) |
| A list longer than the free space | `overflow` (blocks finalize) with `rowsFit`; continuation pages are §17 7b |
| Arabic / RTL designs (A7) | not built; pdf2htmlEX positions glyphs LTR. A later phase |
| Automatic field detection (Phase 9) | not built; manual marking only (D10) |

---

## 20. Implementation decisions log (2026-10-16 →)

Decisions taken while implementing, where the plan was silent or had to bend. Each is also noted in `PROGRESS.md`.

| # | Decision | Why |
|---|---|---|
| I1 | `docker/pdf2htmlex/` gets a 4-line `package.json` with `"type": "module"`. | The image's apt Node 18 parsed the ESM `server.js` as CommonJS and the container crash-looped; nothing else in the service changed. |
| I2 | New dependencies: `sanitize-html@2.13.0` (§8.1), `pixelmatch@5.3.0` (§7.5), `jszip@3.10.1` (batch ZIP). Reused already-installed `@pdf-lib/fontkit` (font coverage), `pdfjs-dist` + `@napi-rs/canvas` (PDF acceptance checks, PNG decoding). | The plan names the first two; ZIP needs a library; the rest were already in `package.json`. |
| I3 | Coded errors (`NO_PDF_CONTENT`, `VERSION_CONFLICT`, …) are returned by a router-level error handler inside the certificates router: `{ status, code, message, …extra }`. | Keeps the shared `errorMiddleware.js` untouched. |
| I4 | The field engine is injected with `page.evaluate(source)` rather than `addScriptTag`. | Same code, but leaves no `<script>` node in the DOM that serialization would have to strip (§7.7). |
| I5 | `DocumentFrame` writes the fetched HTML into a sandboxed `about:blank` iframe with `document.open/write`, instead of a `blob:` URL (§13.3). Still `sandbox="allow-same-origin"` without `allow-scripts`, no `srcDoc`, nothing injected into the app DOM. | Verified in Chrome 150: a `blob:` iframe is treated as cross-origin by its parent (`Blocked a frame … from accessing a cross-origin frame`) with or without a sandbox, so the parent could not read the DOM for selection/highlighting. In the written frame a `<script>` provably does not run (tested). |
| I6 | Renderer: Chromium launched with background-throttling disabled, and screenshots serialised with `bringToFront()`; a broken page is closed without awaiting, and a timeout recycles the browser. | Pooled pages are background tabs; a screenshot on one waited indefinitely for a frame (reproduced: convert job hung at "Creating thumbnail"). |
| I7 | "Suggest center" (§13.4, computed server-side by the engine's `inspect`, D11): tolerance is max(2 px, 10 % of the header segment's width), and a value that is also left/right-edge-aligned with the header (≤ 1 px) is not suggested center. | Measured: PHARMAVET's centered cells sit 2.9–5.5 px off their header's exact center, so the literal 2 px never fired; and ADDVET's stacked same-width dates (`11/2022` over `11/2025`) matched center *and* left, a false positive. With I7 all 14 golden fields get their golden anchor. |
| I8 | Extra route `POST /template-versions/:id/fields/confirm { keys }` (allowed on draft and ready). | D10 needs a way to confirm `ai_suggested` fields; `PUT …/fields` is draft-only, and confirming changes no geometry, so a ready version needn't be re-prepared. |
| I9 | AI assist is switched off with `CERT_ASSIST_ENABLED=false` (→ 403 `ASSIST_DISABLED`), process-wide, not per company. | §8.3 says "can be disabled per company", but there is no company-settings model; a per-company flag would need a new column. Revisit when company settings exist. |
| I10 | `limits` (§7.3 step 6): with no text on the field's baseline, a value may grow to the design's **text margins** (left-/right-most visible text on the page), not to the physical page edge. §16.2's overflow test reads: a 3× value beyond its limits → `shrunk`/`overflow`; within them → no size flag; neighbours never move. | **Owner decision 2026-10-17.** §7.3 (page edge) and §16.2 ("3× → flagged") contradicted each other: only 2 of 14 golden fields flagged. Table rules live in the background image, so text-based limits can't see cell borders; values crossing a rule are shown by the preview, not flagged. |
| I11 | The engine measures the line scale with a 1000 px probe and stores it at full precision. | `offsetWidth` is rounded to whole px; the margin compensation drifted by 0.1–0.2 % of the growth (0.71 px on a 60-character value, breaking "neighbours ≤ 0.5 px"). Now ≤ 0.011 px at any length / font scale. |
| I12 | Prepare stores one diff PNG per page as `StoredFile.kind = template_diff`, served by `GET /template-versions/:id/prepare-diff?page=n`. The report carries `fieldsHash`; `GET /template-versions/:id` returns `prepareReportStale`. | §7.6 shows "a diff image" but names no route; the stale flag stops a report for an older field list from being read as current. |
| I14 | New route `GET /certificate-products?q=&limit=` (`read_products`, always `where: { companyId }`), used by the test fill and manual matching. | The V1 `GET /products` filters by query string only, so a company caller could list other tenants' products — the V2 screens must not depend on it. |
| I13 | `valueResolver` (§10.3, a Phase 4 item) was built in Phase 2, with a tenant-scoped `contextLoader`. | The Phase 2 test fill (`POST …/preview` from a product) needs it. Pure function; the same code serves generation. |
| I15 | `Certificate` is unique on `(batchId, planKey)`, `planKey = "{templateVersionId}:{invoiceItemId}"` (per_product) or `"{templateVersionId}:invoice"` (per_invoice); the §6.1 `@@unique([batchId, templateVersionId, productId])` is not created, and §5.2's idempotent upserts key on `planKey`. | **Owner decision 2026-10-18.** §6.1/§5.2 contradicted §10.1 ("one certificate per (item, templateVersion)"): two lines of the same product with different batches need two COAs, which the §6.1 key rejects. |
| I16 | `templateSelector` chooses the most specific template per **(certificate type, scope)**, so an active per_product and an active per_invoice template of the same type both produce certificates. | **Owner decision 2026-10-18.** §10.1 says ties are impossible because of slot uniqueness, but the slot includes `scope`; per (type, scope) is the only reading under which that holds. |
| I17 | `POST /invoices/:id/retry` (`update_invoices`): a `failed` invoice is extracted again with the same model and prompt; any other status → 409 `INVOICE_NOT_FAILED`. `GET /invoices` takes `q` (invoice number / customer). | Mockups B1/B2 ("Try again", search box); §9.1 forbids a *different* model or a fallback, not a user-triggered re-attempt (e.g. after a quota error). |
| I18 | `Certificate.status` adds `pending` (planned, not yet rendered — B4's "rendering…" card) and `currentVersion` is 0 until version 1 exists; `CertificateVersion.thumbnailFileId` (`StoredFile.kind = certificate_thumb`) holds a 25 % page-1 PNG taken in the same render, for the cards. | §6.1 had no state for a planned certificate and no thumbnail, but §13.5/B4 show both. Additive. |
| I19 | `GET /invoices/:id/generation-plan` (`read_invoices`) returns the `templateSelector` output (`entries`, `summary`, `unassigned`, `gaps`) without creating anything; `gaps` lists each (line, type) no active template covers. | §13.5 / B3 show the plan before "Generate", and B3/B4 name the missing template per type — §12 had no route and `unassigned` alone can't say which type is missing. |
| I20 | `POST /certificates/:id/duplicate` copies the current version into a new draft in the same batch (`planKey` + `#copy-…`, `changeSource: "duplicate"`, the render reused). `GET /certificate-batches/:id/zip` downloads the ZIP made by `POST …/export`. | §11 names duplicate and the batch ZIP but no change source / download route. |
| I21 | Value edits, field reset and restore re-render **inline** in the API process (like the Phase 2 preview), not via a `renderVersion` job; PDF and ZIP exports are jobs. Restore reuses the restored version's stored HTML (same template version + same values = same document). Finalize renders the PDF inline when it is missing. | The editor needs the re-rendered HTML and the 409 in the PATCH response (§13.6); a render is ~0.5 s. |
| I22 | `DocumentFrame` keeps its iframe mounted across reloads and rewrites the document once if Chrome's initial `about:blank` navigation replaced it. | Reproduced intermittently blank frames after a save (Phase 5). |
| I23 | `GET /certificate-metrics` (`read_certificates`, company-scoped) serves the §15 metrics; `GET /api/v1/health` is public and reports converter reachability (no URLs). The daily maintenance is a BullMQ job scheduler on the render queue (`CERT_MAINTENANCE_CRON`, default `0 3 * * *`); maintenance functions accept an optional `companyId` (tests) and run unscoped in production. | §15 names the metrics, the health report and the job but no routes or scheduling mechanism. |
| I24 | A **system user may open any company's resource by id** without `?companyId=` (`scopeFor` → unscoped `findFirst({ id })`); **lists** still require `?companyId=` (400 without it). A company caller is always forced to its own company (another tenant's id → 404). | **Owner decision 2026-10-19** (review #11): kept as built. System users already have the cross-tenant view by role; a list without a company would mix tenants, a by-id call names exactly one resource. |
| I25 | A collective (`per_invoice`) certificate takes `brand` from the **template's brand**, else the **invoice's brand hint** (`Invoice.brandId`), else empty (a required brand field is then flagged `missing`). There is no per-line product brand on a collective certificate. | **Owner decision 2026-10-19** (review #19): kept as built (`batchService`, per_invoice context). Logged so Phase 7 (repeating product rows) does not change it silently. |
| I26 | SVG backgrounds are normalised once at convert time (`fieldEngine.normalizeBackground`, after sanitizing, then sanitized again): (1) defence in depth — `script`, `foreignObject`, `iframe`, `object`, `embed`, `a` removed, `on*` attributes removed, `href` only `#id` or `data:image/`; (2) cairo's page-wide arithmetic `feComposite` over an `feBlend` (`k2 = k3 = 1`) → a group drawing the destination, then the source with `mix-blend-mode`; (3) a mask that is one page-covering white rect (directly or through the "remove color" filter) → `opacity` on the masked element. | Verified 2026-10-21 in Chrome's PDF viewer (PDFium): the raw SVG export prints the page as a raster with a **hairline box** around ADDVET's signature block and PHARMAVET's stamp; after (2) the box is gone and the PDF is vector. (3) because some viewers draw a printed soft mask at full strength. A mask-filter rewrite for PHARMAVET's faint header brackets was tried and dropped: they are 0.25 pt strokes that print at the 1-device-pixel minimum in the **original** PDF too. |
| I27 | The "no hairline" check rasterises the exported PDF **and the original PDF** in Chrome's own viewer (PDFium, headless Chrome at 100 %) and counts ink the export adds on paper that is blank in the original (luminance ≥ 230 within 1 px, darker by > 12); a straight run ≥ 30 px is a hairline. | pdf.js does not show the box at all, so it can't be the reference; comparing with the screen render flags every rule antialiased differently. Calibrated: raw SVG exports 244 px (ADDVET) / 46 px (PHARMAVET), normalised ≤ 23 px. |
| I28 | A group's list must exist for the template's certificates: `invoice_lines` only on `per_invoice`, `product_list` only on `per_product` (`manual` on both). Fixed rows need an SVG version like every group, although the engine itself could cut a PNG. | A collective certificate has no single product; a per-product certificate has one line. Decision 3 keeps groups and PNG apart. |
| I29 | The combined-rule refusal tests a crossing element's horizontal extent **inclusively**. | A perfectly vertical stroke has a zero-width box; the old `overlap > 0` test never refused one, so a single stroke through every row was accepted and would not have been stretched. |
| I30 | All Chromium work runs in ONE service, `cert-renderer` (§5.3); the API and the certificate workers call it over HTTP. The code stays in the backend repo (`renderService/`, `engine/renderOps.js`, `engine/rendererClient.js`) and the image is built from the repo root, so the service runs the very `renderer.js`/`fieldEngine.browser.js` the goldens test — a copy under `docker/` would drift. | Measured 2026-10-22: production ran three Chromiums (API, template worker, render worker), ~290–310 MiB each when warm; one browser serves all three. Output unchanged: the exact-number golden snapshot (calibration, round trip, gate pixel diffs, fill/screenshot/PDF hashes and sizes, SVG normalisation) is identical in-process vs through the service, on Windows Chrome and on the Alpine images. Port 5070, not 5060: `fetch()` refuses 5060/5061 (Fetch "bad ports"). |
