# Certificates — AI Layers Plan (v1)

> **Status:** DRAFT for owner review · 2026-10-22 · Owner: Mahmoud Ebeid **Builds on:**`CERTIFICATES_V2_PLAN.md` (rev 2), now fully implemented (phases 0–8, single renderer service). Read `CLAUDE.md` first. Every invariant there applies, in particular: provenance on every value; no invented values; model IDs only in `modelRegistry.js`; every Gemini call through `geminiClient`; tenant-scoped queries. **Before coding:** verify every file/function name cited here against the real code. V2 was implemented by several sessions, so names may differ slightly from the V2 plan. Record any difference in PROGRESS.md, not by silently renaming things.

---

## ملخص للمالك (Arabic summary)

**الهدف:** نضيف طبقتين AI عشان الشغل اليدوي يقل جداً، من غير ما نكسر قاعدة "مفيش قيمة متألّفة".

**الطبقة الأولى — مع التمبليت:**

- إنت تحدد النص في الشهادة، وتكتب **اسم الحقل بس**، زي "Expiry date". ولو مكتبتش، الـ AI يقترحه من السطر نفسه، مثلاً من كلمة "Expiry Date:" اللي قبل القيمة.
- الـ AI يكتشف **مصدر البيانات** من schema المنتج كله، **ومعاه اللي جوه حقول الـ JSON**، زي `specifications` و`activeIngredients`. ويكتشف **الـ format** كمان، زي `MM/YYYY` من شكل القيمة.
- الـ AI **بيختار مسار بس، مبيكتبش أي قيمة.** الكود هو اللي بيجيب القيمة من المسار، فمستحيل يألّف رقم.
- أي اختيار تأكّده أو تصلّحه **بيتحفظ كذاكرة للشركة**. المرة الجاية نفس الاسم يتربط على طول من غير AI.

**الطبقة التانية — مع الفاتورة:**

- بعد ما الفاتورة تتقري والمنتجات تتطابق، السيستم يعرف **الشهادات اللي هتطلع وكل حقل محتاجينه فيها**، ويقول بالظبط إيه موجود وإيه ناقص.
- **الناقص** الـ AI يدوّر عليه في نص الفاتورة نفسها وفي بيانات المنتج. أي قيمة يلاقيها لازم يجيب **الدليل**، والكود يتأكد إن القيمة مكتوبة فعلاً في الدليل ده **حرف بحرف**. ولو ملقاش، الحقل يتعرض عليك تملاه قبل التوليد.
- **مطابقة المنتجات بقت أذكى:** الـ AI بيساعد في الأسماء اللي مش متطابقة بالظبط، زي "Doxypharma 1kg" و "DOXYPHARMA". وأي مطابقة تأكّدها **بتتحفظ كاسم بديل**، فالمرة الجاية تتطابق لوحدها.

**الـ AI بيقرا الـ JSON نفسه في حالتين:** لما المفتاح يبقى مكتوب بشكل مختلف (`"PH value"` بدل `"pH"`)، ولما القيمة تبقى جوه نص طويل (`"pH 3.0-5.0, assay..."`). في الحالتين لازم يرجّع الجملة اللي لقى فيها القيمة، والكود يتأكد إنها مكتوبة فعلاً في الـ JSON بتاع المنتج.

**مشكلة الـ JSON:** أول حاجة هنعملها "قاموس بيانات" لكل شركة، الكود بيبنيه أوتوماتيك من منتجاتها. بيقول جوه كل حقل JSON إيه المفاتيح اللي فيه، وكل مفتاح موجود في كام منتج بالنسبة، ومعاه أمثلة. وده الأساس اللي الطبقتين بيشتغلوا عليه.

**حماية إضافية:** القيمة اللي الـ AI بيلاقيها لأي منتج في الفاتورة لازم تكون من **سطر المنتج ده نفسه**، مش من سطر منتج تاني. كده لو الفاتورة فيها تاريخين، ميجيبش التاريخ الغلط.

**العلاج الحقيقي لمشكلة الـ JSON** (في المرحلة A4، ومتتأجلش كتير): فورم المنتج يبقى فيه خانات ثابتة للحاجات المهمة، زي مواصفة pH وAssay والمكوّنات كقايمة، بدل JSON حر. ساعتها الـ AI مش هيحتاج يقرا الـ JSON غير للمنتجات القديمة.

**إضافة A5 (استنتاج + بحث على النت):** لو قيمة لسه ناقصة بعد كل ده، الـ AI يحاول يستنتجها من **كل بيانات المنتج**، ولو ملقاش يدوّر عليها **على النت**. بس فيه قواعد:

- الاستنتاج لازم يبقى من بيانات مكتوبة فعلاً، أو تحويل بسيط ليها الكود يقدر يعيده ويطلّع نفس النتيجة، زي تحويل وحدة.
- أي قيمة من النت لازم يبقى معاها **لينك وجملة**. والسيرفر يفتح اللينك ويتأكد إن الجملة مكتوبة فيه فعلاً، وإن الصفحة عن **نفس المنتج**.
- **ممنوع نهائياً** لنتايج التحاليل والتشغيلة والتواريخ والكميات. دي قيم بتتقاس لكل تشغيلة، وجيبها من النت يبقى تزوير للشهادة.
- كل قيمة جاية من استنتاج أو من النت **لازم إنت تأكّدها بنفسك**. وتقدر تحفظها في بيانات المنتج، فمنحتاجش ندوّر تاني.

**إضافة A6 (الكتالوج كمرجع):** الكتالوج اللي إنتوا بترفعوه بيتحفظ كمستند رسمي للشركة، والمنتجات بتطلع منه **منتج منتج**، وكل قيمة بالجملة اللي جاية منها. الأرقام الملخبطة زي `200.000` بتتعلّم عشان تتأكّد منها. وكود المنتج (زي AKS012) بيتحفظ عشان مطابقة الفواتير تبقى دقيقة. ولو الكتالوج اتحدّث، بيطلعلك مقارنة توافق عليها. وفي الشهادات بقى فيه مصدر جديد بين الداتابيز والنت: **الكتالوج**. ومعاه بحث في الكتالوجات.

**الترتيب:**

1. الأساس: القاموس + طريقة كتابة المسارات + تسجيل كل طلب AI.
2. الطبقة الأولى.
3. الطبقة التانية.
4. المطابقة الذكية.
5. التحسينات المتقدمة.

**القرارات المحتاجة منك في §12.**

---

## 1. Goals & non-goals

**Goals**

1. **Template mapping by label.** The user selects the value text and types (or accepts) a label; the system proposes key, source, format, required and align. Target: ≥ 90 % of fields need no manual source editing on the golden templates.
2. **Invoice intelligence.** After extraction and matching, the system computes the complete _data needs_ of the certificates about to be generated and resolves as many as possible with **verifiable evidence**. It asks the user only for what is genuinely missing, before generation.
3. **Make JSON product data usable** (`specifications`, `activeIngredients`, arrays): discoverable, addressable and explainable without anyone reading raw JSON.
4. **Learn from confirmations**, so the AI is called less over time and results become deterministic.

**Non-goals (this plan)**

- The AI never writes template HTML, never decides which fields exist (V2 D3), and never generates a value that cannot be traced to a stored source.
- No rewriting of product data. JSON normalisation is suggest-only (§9, A-4).
- No autonomous generation without a human confirming the invoice review.

---

## 2. Principles (non-negotiable)

| #   | Principle                                                                                                                        | How it's enforced                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| P1  | **AI chooses, code fetches.**For DB-backed values the model returns a*path*; it never returns the value.                         | `valueResolver`reads the value with the path; a model-supplied value for a DB source is discarded               |
| P2  | **Evidence or nothing.**Every AI-found value for a non-DB source (invoice text) carries evidence that code verifies**verbatim**. | `evidenceVerifier`: normalised substring check against the stored invoice text; failure → reject the suggestion |
| P3  | **Deterministic before AI.**Order: company mapping memory → dictionary synonyms → AI.                                            | resolvers short-circuit; AI calls are logged with a reason                                                      |
| P4  | **Human confirms below threshold.**                                                                                              | per-company`autoAcceptThreshold`(default 0.90)**and**P2 verified; otherwise "needs confirmation"                |
| P5  | **Schema-constrained output only.**                                                                                              | `geminiClient.generateJson`+`responseSchema`; any field outside the schema is dropped                           |
| P6  | **Tenant isolation.**Dictionaries, memory, aliases and prompts include only the caller's company data.                           | a test sends company A's request and asserts no company B data in the prompt payload                            |
| P7  | **Full provenance.**Each stored suggestion records`modelId, promptHash, inputHash, confidence, evidence, decidedBy, decidedAt`.  | `AiSuggestion`table (§4)                                                                                        |
| P8  | **Graceful degradation.**Gemini down or over quota → everything still works manually, with a visible "AI unavailable" note.      | no blocking dependency on the AI path; tests run with the AI stubbed to fail                                    |

---

## 3. Foundations (Phase A0)

### 3.1 Source path language (`sourcePath`)

Current sources (`product.name`, `item.batchNo` …) cannot address values _inside_ JSON. Define a small, safe path grammar. No evaluation, no code, and parsed by our own parser.

```
path      := root ("." key | "[" index "]" | "[" filter "]" | "[" quoted "]")*
root      := product | item | invoice | company | brand
key       := identifier                         e.g. specifications
quoted    := "\"" any-text "\""                 e.g. values["Assay %"]
index     := integer                            e.g. activeIngredients[1]
filter    := key "=" quoted                     e.g. activeIngredients[name="Vitamin E"]
```

**Examples**

- `product.name`
- `product.specifications.values["pH"]`
- `product.activeIngredients[name="Sodium selenite"].concentration`
- `product.activeIngredients[0].name`
- `item.batchNo`
- `invoice.header.invoiceDate`

**Rules**

- Matching for `filter` is **case- and space-insensitive**.
- The resolver returns `{ found, value, type }`, never throws, and records the concrete path it hit.
- It is backward compatible: existing `{ kind, path }` sources map 1:1 (`kind` = root).
- **Migration:** a read-time adapter, not a data migration.

**Implementation:**`src/services/certificates/paths/sourcePath.js` (`parse`, `resolve`, `toLabel`), with exhaustive unit tests (malformed input, deep arrays, missing keys, unicode keys).

### 3.2 Company data dictionary (the fix for "unclear JSON")

`src/services/certificates/dictionary/dataDictionary.js` builds, **per company**, a catalogue of every addressable path and what it actually contains:

```json
{
  "path": "product.specifications.values[\"pH\"]",
  "root": "product",
  "type": "string",
  "coverage": 0.83,
  "distinct": 41,
  "examples": ["3.0-5.0", "2.0 – 3.0", "6.5-7.5"],
  "labels": ["pH", "PH", "ph value"],
  "synonyms": ["acidity"],
  "source": "observed"
}
```

| Field      | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `coverage` | share of the company's products that have this path (0.83 = 83 %) |
| `distinct` | number of distinct values seen                                    |
| `examples` | up to 5, truncated to 60 characters each                          |
| `labels`   | key spellings seen across products                                |
| `synonyms` | added by the AI or the user (`source`:`observed`or`ai_synonym`)   |

**How it is built**

- **Static schema:** the Prisma `Product` model plus relations (`category.name`, `brand.name`), and the invoice header/item schemas.
- **Observed JSON shapes:** scan the company's products and walk the JSON columns (`specifications`, `activeIngredients`, any `Json` field). Collect key paths, types, coverage and up to 5 examples. Arrays of objects become a _collection_ path (`activeIngredients[]`) with child keys.
- **Key variants:** different spellings of the same key across products (`pH`, `PH`, `ph`) are grouped into one entry, with every spelling kept in `labels`.
- **Synonyms (AI, optional, cached):** one `CERT_DICTIONARY` call per rebuild proposes human labels/synonyms for opaque keys (`ws_period` → "Withdrawal period"). These are stored as `ai_synonym` and shown in the UI as suggestions.

**When it is rebuilt**

- Lazily on first use.
- After a catalog upload or product create/update, debounced to one rebuild per company per 10 min.
- Nightly.

It is stored in `DataDictionary` (§4). The source picker in the UI reads it, so JSON keys become pickable like normal columns ("Product › Specifications › pH").

**This alone fixes most of the JSON problem, without any AI at fill time.**

### 3.3 AI infrastructure

- **`modelRegistry.js` new entries:**
  - `CERT_FIELD_MAP`: thinkingBudget 1024, temperature 0
  - `CERT_INVOICE_GAPS`: 1024, 0
  - `CERT_PRODUCT_MATCH`: 0, 0
  - `CERT_DICTIONARY`: 0, 0
  - (Use `gemini-2.5-flash` unless a better model is verified reachable on the key; follow the registry's comment convention.)
- **`aiRunLog`:** every call records kind, companyId, entity, `inputHash`, `promptHash`, modelId, tokens, ms, outcome, through `generationMetrics`.
- **Per-company settings** (`Company.aiSettings` Json, nullable):
  - `{ enabled, autoAcceptThreshold, allowSynonyms, allowInvoiceGapFill, allowAiMatching }`
  - Defaults: all on, threshold 0.90.
- **Prompt hygiene:** prompts are built from structured data only (dictionary entries, line text, invoice text). Template HTML, other tenants' data and personal data beyond what the invoice contains are never sent.

---

## 4. Data model (additive migrations only)

```prisma
model DataDictionary {
  id          String   @id @default(uuid())
  companyId   String   @unique @map("company_id")
  entries     Json                               // [DictionaryEntry] (§3.2)
  productCount Int     @map("product_count")
  builtAt     DateTime @map("built_at")
  version     Int      @default(1)               // bumps on every rebuild; suggestions record the version they used
  @@map("data_dictionaries")
}

model FieldMappingMemory {                       // learned label → source, per company
  id          String   @id @default(uuid())
  companyId   String   @map("company_id")
  labelNorm   String   @map("label_norm")        // normalised label: lowercase, no punctuation, collapsed spaces
  certificateTypeId String? @map("certificate_type_id") // null = applies to all types
  source      Json                               // { kind/path… } as stored on TemplateField
  format      Json?
  timesUsed   Int      @default(1) @map("times_used")
  lastUsedAt  DateTime @map("last_used_at")
  createdByUserId String? @map("created_by_user_id")
  @@unique([companyId, labelNorm, certificateTypeId])
  @@map("field_mapping_memory")
}

model ProductAlias {                             // learned invoice-name → product
  id          String   @id @default(uuid())
  companyId   String   @map("company_id")
  aliasNorm   String   @map("alias_norm")        // normalised invoice text
  productId   String   @map("product_id")
  origin      String                             // user_confirmed | ai_confirmed
  timesUsed   Int      @default(1) @map("times_used")
  createdAt   DateTime @default(now()) @map("created_at")
  @@unique([companyId, aliasNorm])
  @@map("product_aliases")
}

model AiSuggestion {                             // every AI proposal, accepted or not (audit + evaluation)
  id          String   @id @default(uuid())
  companyId   String   @map("company_id")
  kind        String                             // field_map | field_label | invoice_gap | product_match | dictionary_synonym | group_binding
  entityType  String   @map("entity_type")       // template_field | invoice_item | certificate_field | product
  entityId    String   @map("entity_id")
  proposal    Json                               // schema-validated model output
  evidence    Json?                              // [{ type: invoice_text|product_path, ref, quote, page? }]
  evidenceVerified Boolean? @map("evidence_verified")
  confidence  Float
  status      String   @default("pending")       // pending | auto_accepted | accepted | edited | rejected | expired
  decidedByUserId String? @map("decided_by_user_id")
  decidedAt   DateTime? @map("decided_at")
  finalValue  Json?    @map("final_value")       // what was actually stored after accept/edit
  modelId     String   @map("model_id")
  promptHash  String   @map("prompt_hash")
  inputHash   String   @map("input_hash")
  dictionaryVersion Int? @map("dictionary_version")
  createdAt   DateTime @default(now()) @map("created_at")
  @@index([companyId, kind, status])
  @@index([entityType, entityId])
  @@map("ai_suggestions")
}

model CertificateDataNeed {                      // per planned certificate × field, computed before generation
  id            String  @id @default(uuid())
  companyId     String  @map("company_id")
  invoiceId     String  @map("invoice_id")
  planKey       String  @map("plan_key")         // stable key of the plan entry (templateVersionId + item ids)
  fieldKey      String  @map("field_key")
  required      Boolean
  status        String                          // resolved | resolved_ai | needs_confirmation | missing | provided | not_applicable
  value         String?
  provenance    Json?                           // { kind: path|invoice_text|manual, path?, quote?, page?, suggestionId? }
  decidedByUserId String? @map("decided_by_user_id")
  @@unique([invoiceId, planKey, fieldKey])
  @@map("certificate_data_needs")
}
```

**Changes to existing models**

- `TemplateField`: add `mappingOrigin` (`manual | memory | dictionary | ai`) and `mappingSuggestionId?`.
- `InvoiceItem.matchMethod`: add the values `alias`, `ai_confirmed`.
- `Company`: add `aiSettings Json?`.

**Generation:**`valueResolver` must consult `CertificateDataNeed` first for `provided` / `resolved_ai` values, so what the user confirmed is exactly what gets rendered. Store that provenance in `CertificateVersion.values[key].source`.

---

## 5. Layer 1 — Template field mapping (Phase A1)

### 5.1 User flow (wizard step "Mark fields")

1. The user selects the value text (unchanged).
2. **Label:**
   - The label box is pre-filled with a **label proposal**. Code takes it from the text left of the value on the same line, with trailing `:`/`#` stripped (`"Batch No.:"` → `"Batch No."`).
   - If the line has no such text, the label comes from the column header above it (geometry: the nearest line above whose x-range overlaps). This is the PHARMAVET case: header "EXPIRATION DATE" above "09/2028".
   - **AI is used only if both fail.**
3. **Key:** auto-slug from the label (`batch_no`), editable. This is code, not AI.
4. **Mapping runs automatically** on label blur, or "Map all" in bulk, using the chain in §5.2. It fills:
   - **Value comes from:** source path.
   - **Format:** e.g. a date pattern inferred from the sample (`11/2025` → `MM/YYYY`, `05/02/2023` → `DD/MM/YYYY` vs `MM/DD/YYYY` disambiguated by values > 12, otherwise flagged as ambiguous for the user), plus letter case from the sample (`SUPPLEMENT` → upper).
   - **Required:** default true; false for fields whose source coverage is < 50 % in the dictionary.
   - **Align:** from geometry (V2 rule), not AI.
5. **Each field card shows the mapping origin:**`Memory ✓`, `Dictionary ✓`, `AI 0.94 ✓` (auto-accepted) or `AI 0.71 — confirm`.
   - A "Why?" link shows the evidence: the dictionary entry with its examples, and the match rationale.
   - Below-threshold suggestions keep the card amber until confirmed or edited.
6. **Unmappable fields** (e.g. lab results such as `pH: 4.0`, `Assay: 102.7 %`, which are per-batch values not stored anywhere today) are classified as **`batch_data`**. They default to `manual`, with a note: "This value changes per batch and isn't in your data. It will be asked during invoice review."
7. On save, every confirmed mapping is written to `FieldMappingMemory` (label → source/format).

### 5.2 Resolution chain (per field)

1. **Memory:**`FieldMappingMemory` hit for (company, labelNorm, type) → use it (`mappingOrigin=memory`). No AI.
2. **Dictionary match (code):** normalised label equals a dictionary `labels`/`synonyms` entry, or a key segment, with a single best hit **and** the sample value is plausible for that entry (type check; date-like for date paths; and when the template's sample product is known, its value equals the sample). Then use it (`dictionary`).
3. **AI (`CERT_FIELD_MAP`), batched:** one call per template for all still-unmapped fields.
   - **Input:** for each field, `{ key, label, sampleValue, lineText, neighbourLabels }`, plus the dictionary entries (paths, types, coverage, examples, labels; trimmed to the top 200 by coverage) and the allowed roots (`product`, `item`, `invoice`, `company`, `brand`, `static`, `manual`, `today`, `template`).
   - **Raw JSON samples:** the call also receives the **raw JSON** of up to 5 of the company's products (`specifications`, `activeIngredients`, and any other `Json` column, each truncated to 4 KB). This lets the model understand keys whose meaning isn't clear from their name, and values buried inside free-text strings.
   - **Text-extract sources:** when the value lives inside a longer string (e.g. `description: "pH 3.0-5.0, assay not less than 98%"`), the model may return `sourceKind: "product_text"` with `{ path, extract: { label: "pH" } }`. At fill time the value is extracted per product (§6.1, product JSON reading) and verified verbatim against that string.
   - **Output schema per field:**
     - `{ sourceKind, path?, template?, format?, category: product_data|invoice_line|invoice_header|company|constant|batch_data|unknown, confidence, rationale }`
     - `path` must be chosen **from the provided dictionary paths**; a free-text path is rejected by validation.
4. **Code validation** of each AI answer:
   - the path parses and exists in the dictionary;
   - the format is compatible with the type;
   - for `template` kind, every placeholder is a valid path;
   - `confidence` is clamped to [0,1].
   - An invalid answer becomes an `unknown` suggestion with the reason shown.
5. **Plausibility boost/penalty (code):** if a reference product is known (optional "sample product" picker in the wizard), resolve the path on it and compare with `sampleValue`.
   - Exact match: confidence := max(confidence, 0.97) and evidence = "matches sample product".
   - Mismatch: confidence × 0.6.
6. Store an `AiSuggestion` for every AI result. Auto-accept iff `confidence ≥ threshold`.

### 5.3 Repeating groups (V2 phase 7) — binding suggestion

When the user marks a repeating group (e.g. the constituents rows), the AI (same call, `group_binding`) proposes:

- the **collection path** (`product.activeIngredients[]`),
- the child path for each row field (`name`, `concentration`).

Code validates that the collection exists and that its children cover the row fields. This removes positional hacks like `activeIngredients[1].name`.

### 5.4 Acceptance (Phase A1)

- **Golden mapping sets.** Commit the expected mappings for ADDVET (8 fields) and PHARMAVET (6 fields) to `fixtures/certificates/mapping/*.json`. Run against a seeded company whose products include the fixture products with realistic JSON.
  - ≥ 90 % exact source match.
  - 100 % of `batch_data` fields classified correctly (pH result, Assay result).
  - 0 invalid paths reaching the DB.
- **Memory:** on a second template with the same labels, 0 AI calls.
- **AI disabled:** the wizard still works; the label proposal and dictionary matching still run (code).
- **Cost:** one AI call per template regardless of field count (batched).

---

## 6. Layer 2 — Invoice intelligence (Phase A2)

### 6.1 Flow

```
upload → extract (existing) → match (§7) → PLAN (templateSelector) → DATA NEEDS → resolve → REVIEW (user) → generate
```

- **Data needs (code).** For each plan entry (certificate) and each template field, `valueResolver` attempts resolution with the field's source → a `CertificateDataNeed` row: `resolved` (value + path provenance), `missing`, or `not_applicable` (optional + empty).
- **Gap resolution (AI, `CERT_INVOICE_GAPS`).** One call per invoice, for all `missing` needs.
  - **Input:**
    - the stored **invoice text**: the extraction step must now also persist `Invoice.textContent`, the full text Gemini read, with page markers;
    - the extracted header/items;
    - for each gap: `{ planKey, fieldKey, label, category, expectedType/format, itemLineNo? }`;
    - the matched products' dictionary paths that have **no value** for this product, plus near-miss keys (e.g. the product has `specifications.values["PH value"]` but the template maps `["pH"]`);
    - **the matched product's full raw JSON columns** (truncated to 8 KB per product). The model can then point to a differently named key, or to a value inside a free-text string.
  - **Output per gap:**
    - `{ found: bool, value?, evidence: [{ type: "invoice_text", quote, page } | { type: "product_path", path } | { type: "product_json_text", path, quote }], confidence, note }`
- **Evidence verification (code, P2).**
  - `invoice_text`: the normalised `quote` must appear in `Invoice.textContent`, **and** the normalised `value` must appear inside `quote`.
  - **Row scope (prevents a real value from the wrong line):** for item-level fields (`item.*`, `batch_data`), the quote must also lie inside **that item's row** of the invoice text. The extractor must therefore persist each item's text span (`InvoiceItem.textSpan`: page + start/end offsets in `textContent`); a quote found only in another item's row is rejected. Header-level fields may come from anywhere outside the item rows.
  - `product_path`: code resolves the path on the matched product. The value must be non-empty, and the code's value **replaces** whatever the model said.
  - `product_json_text`: code resolves `path` to a string on the matched product. The normalised `quote` must be a substring of that string, and the normalised `value` must be inside `quote`.
  - Anything unverified → rejected (the suggestion is logged with `evidenceVerified=false`).
- **Status assignment:**
  - verified and ≥ threshold → `resolved_ai`;
  - verified but below threshold → `needs_confirmation`;
  - not found → stays `missing`.
- **Near-miss learning:** when a product-path near-miss is accepted (`["PH value"]` used for `["pH"]`), offer **"Add as synonym for all products"**, which writes a dictionary synonym and, from then on, the resolver tries synonyms too. Product data itself is never changed.

### 6.2 Review UI (new panel in `InvoiceReview`: "Certificate data check")

- **Summary bar:** "12 certificates · 140 values · 131 ready · 6 need confirmation · 3 missing".
- **Grouped by certificate:** a row per field with value, a source chip, and evidence:
  - `Product · Specifications · pH`;
  - `Invoice p.1: "Batch: HSPhar02509001"`, with the quote highlighted in the side-by-side invoice viewer;
  - `Manual`.
- **Actions per row:**
  - accept;
  - edit, which becomes `provided` with manual provenance;
  - "use for all certificates of this product", for batch data shared across certificate types.
- **Missing `batch_data` fields** (lab results) are presented as a compact **form per product/batch**, so the user types pH/Assay once per batch even if three certificate types need them.
- **Generate:** disabled while required needs are `missing` or `needs_confirmation`. An explicit "Generate anyway (leave empty, flagged)" exists for users with `update_certificates`.
- **Re-runs:** editing an invoice line or match recomputes the affected needs, without calling the AI again unless new gaps appear.

### 6.3 Extraction improvements (same phase)

- **Persist `Invoice.textContent`** (needed for P2), plus per-item `extra` columns that the model saw but couldn't map (e.g. "Lot", "Mfg", "Exp", "Analysis No").
- **Teach the extractor the company's data needs:** pass the union of the active templates' `item.*` / `invoice.*` paths, so it looks specifically for those columns (e.g. if a template needs `item.productionDate`, it searches for Mfg/Prod/Manufacture date). This is still a single extraction call.

### 6.4 Acceptance (Phase A2)

- **Golden invoices:** 3 anonymised invoices with expected needs/resolutions (`fixtures/certificates/invoices/*.expected.json`).
- **Gap fill:** ≥ 80 % of invoice-resolvable gaps filled with verified evidence; **0 unverified values** ever reach `resolved_ai`.
- **Adversarial tests:**
  - a model stub that returns a plausible value not present in the text → rejected;
  - a quote present but the value absent from it → rejected;
  - a product-path value differing from the DB → the DB value wins;
  - a `product_json_text` quote that isn't in the product's string → rejected;
  - an invoice with two items: a batch number quoted from item 2's row for item 1 → rejected.
- **AI disabled:** needs are still computed (code); gaps are just all `missing`.
- **Cost:** ≤ 1 gap call per invoice; 0 when there are no gaps.

---

## 7. Product matching upgrade (Phase A3)

**Order (each step stops on a single confident hit)**

1. `ProductAlias` exact (normalised).
2. Exact code.
3. Exact normalised name.
4. Existing ranked candidates (trigram/code/brand).
5. **AI (`CERT_PRODUCT_MATCH`), only for items still ambiguous.** One call per invoice.
   - **Input:** the item `{ name, code, packing, extra }` + the top 10 candidates `{ id, name, code, packaging, brand, keyFacts }` (from the dictionary: form, strength, species).
   - **Output:**`{ productId | null, confidence, reasons[] }`, and `productId` must be one of the given candidates.

**Code checks**

- The id is in the candidate list.
- The candidate belongs to the tenant.
- The packing/strength mentioned in the invoice is not contradicted by the product (e.g. invoice "1KG" vs product packaging "500 G" → penalty).

**Confirmation and learning**

- Below threshold → "AI suggests X (0.78) — confirm".
- Every confirmation (user, or auto ≥ threshold) writes a `ProductAlias`, so the next invoice matches at step 1.

**Acceptance**

- On the golden invoices: ≥ 95 % of items correctly matched or correctly left for the user.
- 0 cross-tenant candidates.
- The second upload of the same supplier's invoice → 0 AI match calls.

---

## 8. Frontend changes (summary)

| Screen                              | Change                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wizard · Mark fields (`FieldPanel`) | Label proposal pre-filled; key auto-slug; origin badge + confidence; "Why?" popover; "Map all";`batch_data`explanation; optional "sample product" picker for plausibility |
| Source picker (`SourcePicker`)      | Reads the dictionary: JSON keys appear as nested options ("Product › Specifications › pH", with coverage % and examples); collection paths for groups                     |
| Invoice review                      | New "Certificate data check" panel (§6.2); evidence chips that highlight the quote in the invoice viewer; batch-data form; AI match suggestions in the match column       |
| Settings (company)                  | AI settings: enable/disable each layer, auto-accept threshold                                                                                                             |
| Products (optional, A4)             | "Data dictionary" view: what keys exist across products, coverage, synonyms; accept/reject AI synonyms                                                                    |

All AI UI states must handle: loading, unavailable (quota/outage → "Continue manually"), and low confidence.

---

## 9. Phase A4 — Advanced (after A1–A3 are measured)

- **Dictionary health report:** keys with low coverage, conflicting types and near-duplicates. It suggests merges as synonyms; it **never rewrites products**.
- **Template-driven product completeness:** "these 14 products are missing `specifications.pH`, which 3 active templates need", with a link to the products. This prevents gaps before invoices arrive.
- **Evaluation dashboard:** per kind, suggestion acceptance rate, edit rate, average confidence vs. correctness (calibration), AI calls per template/invoice over time (should fall as memory grows), cost.
- **Structured product data entry (the real cure for messy JSON):** the product form gets fixed inputs for the keys the active templates need (taken from the dictionary and the templates' sources, e.g. pH spec, Assay spec, constituents as a proper list of name + amount), instead of free JSON. Old products are untouched; the completeness view lists what each product is missing. Once this exists, the AI reading raw JSON (§5.2, §6.1) becomes a fallback for legacy products only. **Do not postpone this long after A2.**
- **Batch data store (optional):** if lab results (pH, Assay…) are entered repeatedly, add a `Batch` entity (product, batchNo, values Json) so they're entered once per batch and reused across invoices. Decide after A2 shows how often this happens.

---

## 10. Testing strategy (additions)

- **Unit:**`sourcePath` (parser + resolver), `dataDictionary` (shapes, coverage, key-variant grouping), the label proposal (same-line and column-header cases from both goldens), date-format inference, `evidenceVerifier` (normalisation: whitespace, case, unicode dashes `–` vs `-`, Turkish `İ`).
- **AI tests with stubs** (deterministic, run in `npm test`): valid answers, invalid paths, out-of-candidate ids, fabricated values, timeouts, quota errors (P8).
- **Live evals (opt-in `RUN_LIVE_GEMINI=1`)** against the golden sets, with a scorecard written to `golden/ai-eval-<date>.json`. A drop of > 2 % on any metric blocks the change (matches the `CLAUDE.md` invariant 11 spirit).
- **Tenant isolation:** assert the prompt payloads contain only the caller company's dictionary/products/aliases.

---

## 11. Phases

| Phase                         | Content                                                                                                                                                                                                   | Exit criteria                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A0 · Foundations**          | `sourcePath`,`DataDictionary`+ builder + rebuild triggers, the source picker reading the dictionary, model registry entries,`AiSuggestion`,`aiRunLog`,`Company.aiSettings`,`Invoice.textContent`persisted | the owner can pick`Specifications › pH`and`Active ingredients › [Vitamin E] › concentration`in the wizard by hand, and the render shows the right values |
| **A1 · Template mapping**     | label proposal, memory, dictionary match,`CERT_FIELD_MAP`, plausibility, group binding, UI badges/"Why?"                                                                                                  | §5.4 met on both goldens                                                                                                                                 |
| **A2 · Invoice intelligence** | data needs, gap resolution with evidence, review panel, batch-data form, extractor guided by data needs, synonym learning                                                                                 | §6.4 met on 3 golden invoices                                                                                                                            |
| **A3 · Matching**             | aliases, AI matching for ambiguous items, contradiction checks, UI                                                                                                                                        | §7 acceptance met                                                                                                                                        |
| **A4 · Advanced**             | dictionary health, completeness,**structured product data entry**, eval dashboard, optional`Batch`entity                                                                                                  | owner sign-off per item                                                                                                                                  |
| **A5 · Inference & web**      | §14: inference policy per field, tier I (product data) and tier W (web with verified citations), cache, save-to-product, toggles, UI badges                                                               | §14.6 met                                                                                                                                                |
| **A6 · Catalogue as source**  | §15: block extraction with verified quotes, number normalisation, product codes, versioned catalogues + diff, tier C in certificates, catalogue search; replaces V1 catalog upload                        | §15.9 met                                                                                                                                                |

Each phase: backend + frontend + tests + PROGRESS.md entry + demo. **Do not start a phase before the previous is approved.**

---

## 12. Decisions needed from the owner

| #   | Question                                                                                                   | Default if unanswered                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Q1  | Auto-accept threshold — 0.90, or require confirmation for every AI suggestion at first?                    | **Confirm everything for the first 2 weeks**, then 0.90                                                               |
| Q2  | Lab results (pH, Assay, …): enter per invoice review (A2), or build the`Batch`entity now?                  | Per invoice review now; decide on`Batch`after A2                                                                      |
| Q3  | May the AI propose synonyms that then apply company-wide automatically, or only after a user accepts each? | User accepts each                                                                                                     |
| Q4  | Can the invoice text (supplier/customer names, prices) be sent to Gemini? (It already is for extraction.)  | Yes, same as today                                                                                                    |
| Q6  | Enable tier I (inference from product data) and tier W (web lookup)?                                       | Built, both**off**by default; the owner enables them per company                                                      |
| Q7  | Which web sources count as trusted?                                                                        | manufacturer and official registry accepted, distributor with a warning, everything else rejected unless allow-listed |
| Q8  | Do invoices carry the catalogue product code (e.g. AKS012)?                                                | Assumed sometimes; code match is tried first, then name                                                               |
| Q9  | Can one manufacturer catalogue serve several client companies?                                             | Each upload targets one company; a "copy to company" action can come later                                            |
| Q5  | Gemini billing: the free tier (8 RPM, daily caps) will limit A1–A3. Enable billing?                        | Plan works on the free tier through batching, but enabling billing is recommended before A2                           |

---

## 13. Risks

| Risk                                              | Mitigation                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The model "finds" a value that isn't really there | P1 (paths only for DB data) + P2 (verbatim evidence) + adversarial tests                              |
| Dictionary too large for the prompt               | trim by coverage, send only roots relevant to the field category; cache by`inputHash`                 |
| Wrong mapping auto-accepted silently              | Q1 default (confirm all initially), plausibility check against a sample product, evaluation dashboard |
| Quota / outage                                    | P8: everything degrades to manual; no hard dependency                                                 |
| Messy product JSON keeps growing                  | dictionary synonyms + health report (A4) + completeness view; never mutate data automatically         |

---

## 14. Phase A5 — Inference from product data & web lookup (added 2026-10-22)

**Owner request:** when a value a certificate needs is still missing after A2 (no DB path, not in the invoice), the system should try to **infer it from everything we know about the product**, and if that fails, **look it up on the web**.

This deliberately extends principle P1/P2, so it gets its own rules. It follows the same idea the label engine already uses, a tier ladder where every value carries its tier and evidence, and reuses its parts where they fit: `ExternalKnowledgeCache`, the `WEB_SEARCH` registry entry, and `services/label/knowledge/*`. Verify those against the code before reusing them.

### 14.1 Hard line: what may NEVER be inferred or fetched

A certificate of analysis states **measured, batch-specific facts**. Filling any of these from inference or the internet would make the certificate false, so they are **blocked in code, not by prompt**:

- lab/analysis **results** (pH result, assay %, appearance result, sterility/pyrogen results, any field the template classifies as `batch_data`);
- batch number, production date, expiry date, quantities, invoice/document numbers;
- registration numbers, **unless** they come from an official registry page (§14.3, tier W) and the user confirms them.

**Enforcement**

- Each `TemplateField` gets `inferencePolicy`, with the values `never | product_facts | product_facts_and_web`.
- Its default is derived from the field's category:
  - `batch_data`, `invoice_line` and `invoice_header` → `never`;
  - `product_data` → `product_facts_and_web`;
  - `company` / `constant` → `never`.
- The user can tighten a field's policy but cannot loosen one that defaults to `never`.
- A test proves that a `never` field can't reach tiers I/W even if the model returns a value for it.

### 14.2 Tier I — inference from the product's own data

For missing `product_data` fields:

1. **Call `CERT_PRODUCT_INFER`**, one call per invoice, batched with the A2 gap call when possible.
   - **Input:** the product's **complete** record: every column, every JSON column (≤ 16 KB), category, brand, plus the field's label and expected format.
   - **Output per field:**`{ found, value, derivation: "quoted" | "derived", evidence: [{ path, quote }], reasoning, confidence }`.
     - `quoted`: the value appears verbatim in a product field. It is verified exactly like `product_json_text` (P2).
     - `derived`: the value is a **deterministic transformation** of quoted facts. Only an allow-listed set of derivations is accepted:
       - unit / format conversion (e.g. "120 g/L" → "120000 mg per litre");
       - selecting one item from a list (e.g. the target species from `targetSpecies[]`);
       - joining listed values (e.g. active ingredients as "A 10 %, B 5 %");
       - case / format normalisation.
     - Free-form reasoning ("this kind of product is usually stored at…") is **not** an accepted derivation.
2. **Code checks**
   - Every evidence quote must be verbatim in the stated product path.
   - For `derived`, code re-runs the named derivation on the quoted inputs and must reproduce the value **exactly**. Otherwise the value is rejected.
3. **Status:**`inferred`, with tier `I`, evidence and derivation stored in provenance.

### 14.3 Tier W — web lookup with citations

Only for fields whose policy is `product_facts_and_web`, and only if tier I found nothing.

1. **Call `CERT_WEB_LOOKUP`** with Gemini Google-Search grounding, through the `WEB_SEARCH` entry or a new registry entry. One call per product, covering all its missing web-eligible fields at once.
   - **Query input:** product name, manufacturer, brand, origin, the active ingredients if known, and the field labels.
   - **Never sent:** the invoice, customer data, prices or other tenant data.
2. **Output per field:**`{ found, value, citations: [{ url, title, quote }], sourceType: manufacturer | official_registry | distributor | other }`.
3. **Code verification (the key safeguard)**
   - **Fetch each cited URL server-side**: through the existing outbound path, with a timeout, size cap and `text/html|pdf` only.
   - **Check that the quote appears verbatim** in the fetched page text (normalised), **and that the value appears inside the quote**. No verifiable citation means the value is rejected.
   - **Source ranking:**`manufacturer` and `official_registry` are accepted; `distributor` is accepted with a warning badge; `other` (blogs, marketplaces, forums) is rejected unless the company allow-lists the domain.
   - **Product identity check:** the page must also mention the product name (or a confirmed alias) **and** the manufacturer or brand. This prevents a correct fact being taken from a _different_ product.
4. **Cache** in `ExternalKnowledgeCache`:
   - `kind`: `cert_product_fact`
   - `lookupKey`: `companyId|productId|fieldLabelNorm`, scoped per company so one tenant's lookups never reveal another's products
   - expiry: 90 days
   - `status`: `unreviewed` until a user confirms
5. **Status:**`web_found`, tier `W`, with citations.

### 14.4 How tiers I/W values are treated

- **Always confirmed by a human**, whatever the auto-accept setting or confidence. They show in the "Certificate data check" panel:
  - an `Inferred from product data` badge, with the quotes and the derivation;
  - or a `From web` badge, with clickable source links, the quote, and the domain's source type.
- **The PDF never shows the tier;** the certificate prints the value. But `CertificateVersion.values[key].provenance` keeps the tier, evidence and citations forever, and finalize records who confirmed each one.
- **"Save to product" on confirm** (off by default): writes the confirmed value into a proper product field (A4 structured inputs), recording that it came from tier I/W and who approved it. The next invoice then finds it at tier 1 with no AI and no web. This is the long-term fix: every web lookup should happen **once per product**.
- **Settings:** per-company toggles `allowProductInference`, `allowWebLookup` (both default **off** until the owner enables them), plus the domain allow-list.
- **Cost / limits:** at most 1 inference call per invoice and 1 web call per product per 90 days. Web lookup runs only after the user opens the data check, never during upload.

### 14.5 Data model additions

- `TemplateField.inferencePolicy String @default("never")`, back-filled from the category by the migration.
- `CertificateDataNeed.status` gains the values `inferred` and `web_found`; `provenance.tier` is one of `path | invoice | I | W | manual`.
- `Company.aiSettings` gains `allowProductInference`, `allowWebLookup` and `webDomainAllowList[]`.
- `modelRegistry.js`: `CERT_PRODUCT_INFER` (thinkingBudget 1024, temperature 0), and reuse or add `CERT_WEB_LOOKUP` (grounded search).
- `AiSuggestion.kind` gains the values `product_infer` and `web_lookup`.

### 14.6 Acceptance (Phase A5)

- **Blocking:**
  - a stub model returning values for `batch_data` / `never` fields → 0 reach a certificate;
  - a citation whose page lacks the quote → rejected;
  - a page about a different product → rejected;
  - a `derived` value that the code can't reproduce → rejected;
  - a blocked domain → rejected.
- **Golden set:** 10 product-fact gaps (storage conditions, indications, packaging, target species, manufacturer address…) on seeded products with incomplete data.
  - Live eval (opt-in): ≥ 70 % filled with verified evidence.
  - 0 unverified or false values.
- **Second run:** the same invoice → 0 web calls (cache), and 0 AI calls for fields saved to the product.
- **Toggles off:** behaviour is identical to A2.
- **Tenant isolation:** web query payloads contain no invoice or customer data; the cache keys are company-scoped.

---

## 15. Phase A6 — The product catalogue as a source document (added 2026-10-22)

**Context.** The platform team (admins, not the companies) uploads manufacturer catalogues, such as `Agrikima_Catalogue_2022-new_-_feed.pdf`, and products are created from them.

What the sample shows:

- **Live text** (InDesign → PDF, 18 pages). Every word can be verified verbatim, like invoices.
- **Two products per page** (left/right halves of a spread), about 30 products.
- **A consistent section set per product:** name, form ("Liquid Oral Solution"), subtitle, BENEFITS, ACTIVE INGREDIENTS, COMPOSITION ("Each 1 Litre contains: …"), DOSAGE, WITHDRAWAL TIMES, PRECAUTIONS, STORAGE, PACKING, FORM, **CODE** (`AKS012`), and sometimes a **SPECIFICATIONS** table (Betaine 50 %: `Assay, % ≥ 50`, `Loss on drying, % ≤ 2.0`).
- **Inconsistent number formats:**`200.000 mg` (European thousands), `2300 mg`, `70.000 mg`, `1.000 mL`, `100 000 000 I.U.`

### 15.1 Goals

1. Products are extracted **per product block**, with every value verified against that block's text, ambiguous numbers flagged, and the product code captured.
2. The catalogue is **kept as an authoritative source** (versioned, with page/position citations). Certificates can then resolve missing product facts from it at a new tier **C (catalogue)**, placed between the DB and the web:
   - **Order:** DB path → invoice → **catalogue (C)** → product inference (I) → web (W).
   - Tier C needs no web call and no reasoning: it's the company's own supplier document.
3. Re-uploading a newer catalogue produces a **reviewable diff**, never a silent overwrite.
4. Catalogue content is **searchable** (products, ingredients, sections).

### 15.2 Upload & ownership

- **Who uploads:** an admin, who picks the target **company** (required), plus a brand and manufacturer name (optional). This uses the existing system-user company picker pattern.
- **Access:**
  - The catalogue file and its extracted blocks belong to that company (tenant-scoped like everything else).
  - A company user can view their catalogues and search them.
  - Upload, re-extraction and applying a diff need a new permission `manage_catalogues` (system users only by default).
- **One company can have several catalogues** (one per manufacturer/year). Each upload is a `CatalogueVersion` under a `Catalogue` (manufacturer + company).

### 15.3 Extraction pipeline

1. **Text with positions.** Read the text layer with coordinates (pdf.js or the renderer). Reject or flag pages without a text layer (scanned catalogues → OCR is out of scope; show a warning).
2. **Block segmentation (code).**
   - Split each page into product blocks: spread halves, then large-font product titles as block starts. The sample's titles are ≥ 2× body size.
   - Each block keeps `{ page, bbox, text }`.
   - The admin can fix the segmentation in the review screen: merge or split blocks.
3. **Structuring (AI, `CATALOGUE_EXTRACT`, one call per block, batched where the RPM allows).**
   - **Output:** a schema-constrained product record mapped to the Product model and the A4 structured certificate inputs:
     - `name`, `productCode`, `physicalForm`, `subtitle/category`
     - `indications` ← BENEFITS
     - `activeIngredients[] {name, amountRaw, amount, unit, basis}`, where basis comes from "Each 1 Litre contains"
     - `dosage`, `withdrawalPeriod`, `userSafety` ← PRECAUTIONS
     - `storage`, `packaging`
     - `specifications[] {item, specRaw}`
     - `producer` / `origin` (from the cover/back page, applied to every block)
   - **Evidence per value:** a `quote` from the block.
4. **Verification (code, same rule as P2).**
   - Every quote must appear verbatim in **that block's** text; the value must appear inside its quote. Anything unverified is dropped and listed as "needs manual entry".
   - Values are never taken from a neighbouring block.
5. **Number normalisation (code, not AI).**
   - Keep `amountRaw` always. Parse with explicit rules:
     - a space or `,` before three digits, or `.` before exactly three digits, means a **thousands separator**;
     - a single `.` followed by 1–2 digits means a decimal.
   - Patterns that can be read both ways (`70.000 mg`, `1.000 mL`) are parsed with the catalogue-level majority convention **and flagged `ambiguous_number`**. The admin confirms once per catalogue ("in this catalogue `.` is a thousands separator"), and the choice re-parses every flagged value.
   - Unit sanity check: an amount larger than its basis (`70,000 mg` per 1 L is plausible, but `70,000 g` per 1 L is not) is flagged.
6. **Review screen (admin).**
   - The PDF page sits beside the extracted record, and every field highlights its quote on the page.
   - The admin accepts per product or in bulk. A product with no flags can be bulk-accepted.
7. **Apply.**
   - Products are created or updated. Matching is by `productCode` first, then normalised name, within the company.
   - Each product stores `catalogueRef {catalogueVersionId, blockId}`, and every field written from the catalogue stores its provenance: tier `C`, page and quote.
   - Product codes from the catalogue become the primary invoice-matching key (A3 step 2), so invoices that carry the code need no AI matching.

### 15.4 Re-upload → diff

- A newer version of the same catalogue is extracted the same way, then compared with the products currently linked to the previous version:
  - **new products;**
  - **removed products** (never auto-deleted, only flagged);
  - **changed fields**, with old → new values side by side and the quotes.
- Fields a user edited by hand after the import are shown as **conflicts**. They are never overwritten without an explicit choice.
- Nothing is applied until the admin approves the diff, per product or per field.

### 15.5 Tier C in certificates (extends A2/A5)

- When a `product_data` field is still missing after the DB path, the resolver looks in the product's linked catalogue block with code-only matching: the section heading plus the field label or synonyms. Example: field "Storage conditions" → STORAGE section.
- If code can't decide, the A2 gap call also receives the block text, with evidence type `catalogue_text {catalogueVersionId, blockId, quote}`, verified verbatim against the block.
- **SPECIFICATIONS rows** feed template fields of the specification kind (e.g. "Assay ≥ 50"). This fills specification columns legitimately. **Results columns stay `batch_data` and are never filled from the catalogue (§14.1).**
- A catalogue value used in a certificate can be saved to the product with one click, which promotes it to the DB path. It needs confirmation like tier I/W unless it was already applied in §15.3 step 7.

### 15.6 Search

- **Full-text search over catalogue blocks.** Postgres FTS plus `pg_trgm` for fuzzy product names, scoped per company.
- **UI:** "Search catalogues" on the Products page, with results showing the product, page and highlighted snippet, linked to the PDF page. Examples: "Vitamin E", "withdrawal none", "AKS0".
- **Invoice matching (A3)** uses the same index as an extra candidate source, so invoice names that differ from the DB product name but match catalogue text become candidates.
- **Semantic search** (embeddings) is **out of scope**; reconsider it if FTS proves insufficient.

### 15.7 Data model (additive)

```prisma
model Catalogue {
  id            String  @id @default(uuid())
  companyId     String  @map("company_id")
  manufacturer  String
  brandId       String? @map("brand_id")
  versions      CatalogueVersion[]
  createdAt     DateTime @default(now()) @map("created_at")
  @@unique([companyId, manufacturer])
  @@map("catalogues")
}

model CatalogueVersion {
  id            String   @id @default(uuid())
  catalogueId   String   @map("catalogue_id")
  label         String                         // "2025–2026"
  sourceFileId  String   @map("source_file_id") // StoredFile (kept forever)
  status        String   @default("uploaded")  // uploaded|extracting|review|applied|failed
  numberConvention Json? @map("number_convention") // { thousands: ".", decimal: "," } confirmed by admin
  pages         Int
  blocks        CatalogueBlock[]
  uploadedByUserId String? @map("uploaded_by_user_id")
  appliedAt     DateTime? @map("applied_at")
  createdAt     DateTime @default(now()) @map("created_at")
  @@map("catalogue_versions")
}

model CatalogueBlock {
  id            String  @id @default(uuid())
  versionId     String  @map("version_id")
  page          Int
  bbox          Json
  text          String  @db.Text
  extracted     Json?                          // structured record + per-field quotes + flags
  status        String  @default("pending")    // pending|accepted|rejected|applied
  productId     String? @map("product_id")
  // + tsvector column for FTS, created in raw SQL with a GIN index; trigram index on the extracted name
  @@index([versionId])
  @@map("catalogue_blocks")
}
```

Further additions:

- `Product.catalogueRef Json?`.
- Provenance values gain tier `C`.
- `modelRegistry.js`: `CATALOGUE_EXTRACT` (thinkingBudget 0, temperature 0).
- Permission: `manage_catalogues`.

### 15.8 Replaces V1 catalog upload

The current `catalogService.js` / `catalogWorker.js` use the deprecated SDK and a hardcoded model (V1 audit). A6 replaces them:

- the old route keeps working until A6 is live, then it is retired;
- existing products are untouched, and they can be linked to a catalogue retroactively with the §15.4 diff flow.

### 15.9 Acceptance (Phase A6)

- **On `Agrikima_Catalogue_2022-new_-_feed.pdf`** (add it to `fixtures/catalogues/`):
  - Every product block is found, with segmentation errors ≤ 1, fixable in the UI.
  - Every `productCode` is captured.
  - For every active ingredient, `amountRaw` equals the catalogue text, and every ambiguous number is flagged; none is silently mis-parsed.
  - 0 values without a verified quote.
- **Diff:** re-uploading the same file gives 0 changes. A copy with one edited composition line gives exactly 1 changed field.
- **Tier C:** a certificate field "Storage conditions" for an Agrikima product with empty `storage` in the DB resolves from the catalogue with a page-cited quote. A results field never resolves from the catalogue.
- **Search:** "Vitamin E" returns every block containing it, company-scoped.
- **Live eval** (opt-in): `npm run eval:catalogue` scores the extraction against a hand-checked golden JSON for the sample.
