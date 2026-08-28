# Mostanad — Label Engine: Architecture & Implementation

> **المصدر الوحيد للحقيقة.** الملف ده بيدمج ويحل محل `MOSTANAD_LABEL_ENGINE_PLAN.md` (v1) و `MOSTANAD_ARCHITECTURE_V2.md` (v2). **امسح الاتنين.**
>
> v1 كانت "إزاي أخلي النظام يشتغل صح؟" · v2 كانت "إزاي أعرف إنه صح وأثبته؟"
> الملف ده الاتنين مع بعض، من غير إحالات ناقصة.

**Repo:** `D:\turk\mostanad` · **Stack:** Node 20 ESM · Express 5 · Prisma 7 + PostgreSQL · BullMQ + Redis · Socket.IO · Gemini via `@google/genai` · Zod 4
**Scope:** Backend فقط. `src/views/index.html` فاضي — مفيش UI هنا. كل بند "UI" بيتحول لـ **API contract**.
**قدرات Gemini متحققة:** أغسطس ٢٠٢٦

---

## المحتويات

**الجزء الأول — السياق**
[١. الحالة الحالية المتحققة](#١-الحالة-الحالية-المتحققة) ·
[٢. سجل الثغرات](#٢-سجل-الثغرات) ·
[٣. المبادئ الحاكمة](#٣-المبادئ-الحاكمة)

**الجزء الثاني — المعمارية**
[٤. شكل النظام](#٤-شكل-النظام) ·
[٥. نموذج البيانات](#٥-نموذج-البيانات) ·
[٦. الـ Label Schema](#٦-الـ-label-schema) ·
[٧. الطبقة التنظيمية](#٧-الطبقة-التنظيمية) ·
[٨. الاسترجاع والتشابه](#٨-الاسترجاع-والتشابه) ·
[٩. التوليد وطبقة Gemini](#٩-التوليد-وطبقة-gemini) ·
[١٠. محرك التحقق](#١٠-محرك-التحقق) ·
[١١. الشات والتعديل المهيكل](#١١-الشات-والتعديل-المهيكل) ·
[١٢. الاعتماد والدولاب](#١٢-الاعتماد-والدولاب) ·
[١٣. النسخ والاستعادة](#١٣-النسخ-والاستعادة) ·
[١٤. طبقة الضمان](#١٤-طبقة-الضمان) ·
[١٥. واجهة الـ API](#١٥-واجهة-الـ-api)

**الجزء الثالث — التنفيذ**
[١٦. المراحل](#١٦-المراحل) ·
[١٧. مصفوفة الاختبارات](#١٧-مصفوفة-الاختبارات) ·
[١٨. البرومبت الرئيسي](#١٨-البرومبت-الرئيسي) ·
[١٩. برومبت لكل مرحلة](#١٩-برومبت-لكل-مرحلة) ·
[٢٠. تدقيق نهائي](#٢٠-تدقيق-نهائي) ·
[٢١. المصادر](#٢١-المصادر)

---
---

# الجزء الأول — السياق

## ١. الحالة الحالية المتحققة

اللي **موجود وشغال** ومينفعش يترمي:

| المكوّن | الملف | الحالة |
|---|---|---|
| استيعاب المراجع | `src/workers/referenceLabelWorker.js` | ✅ بيستخرج `full_text`, `sections`, `style_guide`, `regulatory_notes`, `active_ingredients[]`, `target_animal_species[]` |
| CRUD المراجع | `referenceLabelService.js` / `Controller.js` | ✅ شغال |
| توليد الليبل | `src/workers/labelGeneratorWorker.js` | ⚠️ شغال، بس معمارياً غلط |
| مصالحة الأنواع المستهدفة | `labelGeneratorWorker.js:190-213` | ✅ **شغل كويس فعلاً** — اتحاد حتمي عبر المراجع المطابقة + `targetAnimalsSource` محسوبة في الكود |
| فحص الليبل (مسار منفصل) | `src/services/labelService.js` | ✅ رفع ليبل → تقرير امتثال |
| استيعاب المستند التنظيمي | `src/workers/edaRequirementWorker.js` | ⚠️ بيخزن `extractedData: []` دايماً |
| عميل Gemini المهيكل | `src/services/ai/geminiClient.js` | ✅ بيدعم `responseSchema` + `temperature: 0` — **بس الـ label worker مش بيستخدمه** |
| البنية التحتية | `lib/queue.js`, `lib/socket.js`, `lib/redis.js` | ✅ شغالة |
| المصادقة والصلاحيات وتعدد المستأجرين | `middleware/authMiddleware.js` | ✅ شغالة |

> **قاعدة للمنفّذ:** حافظ على الأربعة دول — workers + BullMQ + تقدّم Socket.IO + Prisma. ممنوع استبدال البنية التحتية دي.

## ٢. سجل الثغرات

كل صف متحقق منه من الكود مباشرة.

### G1 — مفيش كيان `GeneratedLabel` (حاجب)
الليبل بيتخزن في `BackgroundTask.result` (Json) والـ job عليه `removeOnComplete: true`.
**النتيجة:** مفيش `labelId` → الشات والنسخ والاستعادة وإعادة التحقق **مستحيلة بنيوياً**، مش ناقصة. **كل باقي الخطة متوقفة على ده.**

### G2 — الأنواع المستهدفة: بتتولّد وبتضيع

| الطبقة | الحالة | الدليل |
|---|---|---|
| `Product.targetSpecies String[]` | ✅ موجود | `schema.prisma:126` |
| استخراج المراجع | ✅ موجود | `referenceLabelWorker.js:81` |
| مصالحة التوليد | ✅ موجود | `labelGeneratorWorker.js:195-208` |
| **مدخل التوليد** | ❌ | الـ worker بياخد `formulationText` نص حر + `targetSpeciesHint` بس. **عمره ما بيقرا صف `Product`** |
| **الحفظ** | ❌ | جوه `BackgroundTask.result` بس |
| **API** | ❌ | مفيش endpoint بيرجّعه أو يعدّله |
| **التحقق** | ❌ | مفيش قاعدة بتفحصه |
| **التعديل** | ❌ | مفيش مسار |

**التشخيص: مشكلة حفظ وتوصيل، مش مشكلة prompt.**

### G3 — "التحقق" في الحقيقة تمريرة توليد تانية
`labelGeneratorWorker.js:470-569` — Steps 3.5 و 3.6 بيطلبوا من Gemini **الليبل مصحّح**.
مفيش pass/fail بيتولّد ولا يتخزن · نفس الموديل بيصحح لنفسه · الاتنين `try/catch` بيبلعوا الخطأ (`:507`, `:567`) · والتمريرة **تقدر تخرّب** ليبل صح من غير تتبّع.

### G4 — الطبقة التنظيمية ناقصة وبها عطل
- `eda_requirements` أعمدته: `extractedText`, `extractedData`, `country`, `company_id` بس. **مفيش** `title` / `sourceUrl` / `version` / `effectiveDate` / `isOfficial` / `documentHash`
- 🐛 `edaRequirementService.processAndCreate` بيكتب `title:` — **العمود مش موجود في أي migration** → `PrismaClientValidationError`
- 🐛 `edaRequirementWorker.js:82` بيخزن `extractedData: []` دايماً → فرع "STRICT VALIDATION RULES" في `labelService.js:279-293` **كود ميت**
- ⚠️ الـ web-search fallback (`labelGeneratorWorker.js:231-291`) بيخزن ناتج grounding **من غير URL ولا فحص نطاق ولا مراجعة**، ويكاشه للأبد كأنه مرجعي
- ⚠️ قواعد hardcoded في الـ prompts: SFDA (`labelGeneratorWorker.js:394-398`)، `MINIMUM BASELINE REQUIREMENTS` (`labelService.js:302-313`)

### G5 — الاسترجاع: بلا فلترة، بلا نطاق، بسمة واحدة
```js
// labelGeneratorWorker.js:142  ← مفيش where
const allRefs = await prisma.referenceLabel.findMany({ orderBy: { createdAt: 'desc' } });
```
🔴 **تسريب بيانات بين المستأجرين** — مراجع شركة A بتغذّي توليد شركة B
🔴 تحميل الجدول كله في ذاكرة Node مع كل job
المطابقة overlap نصّي على أسماء المكوّنات بس (3/2/0). مفيش تركيز ولا شكل ولا مسار إعطاء ولا دواعي ولا أنواع. والـ fallback بياخد `[0]`.

### G6 — التوليد غير مقيّد بـ schema
`labelGeneratorWorker.js:458` → `responseMimeType: "application/json"` **بدون `responseSchema`**. الـ schema نص جوه prompt ~٤٠٠ سطر. ومفيش `temperature` (الافتراضي ~1.0) لمهمة عايزة حتمية.

### G7 — الـ schema بتاع أعلاف مش دواء
موجود: `productName, feedClassification, ingredients[], analysis, aimOfUse, targetAnimalSpecies, directionOfUse, storage, netWeight, usageDeclaration, mandatoryFields, estimatedFields`
ناقص: `withdrawalPeriod, contraindications, warnings, sideEffects, routeOfAdministration, pharmaceuticalForm, strength, registrationNumber, marketingAuthorisationHolder, manufacturer(قيمة), importer(قيمة), batchNo, productionDate, expiryDate, shelfLifeAfterOpening, disposal, keepOutOfReachOfChildren, prescriptionStatus`
🐛 `mandatoryFields` عبارة عن `{manufacturer: true, ...}` — **flags بتقول الحقل إجباري، مش بتحمل قيمة**
🐛 `labelService.js:399` بيقرا `dbProduct.routeOfAdmin` — **مش موجود في `Product`**

### G8 — مفيش شات ولا patches ولا نسخ ولا كشف تعارض
صفر.

### G9 — التخمين الداخلي بدل البحث الموثّق
`labelGeneratorWorker.js:338, 343` بيقولوا للموديل *"determine your best answer using standard veterinary knowledge"* — من غير مصدر، استشهاد، كاش، وسم، ولا استثناء لفترة السحب.

### G10 — مفيش خط استيعاب تنظيمي
مفيش حاجة بتحوّل مستند الهيئة لقواعد قابلة للفحص، ولا بتراجعها، ولا بتعتمدها، ولا بتؤرّخها. فمستند العميل الرسمي **بيتبعت للموديل كنص خام مع كل توليد**.

### G11 — كفاءة Gemini
- كل حاجة على `gemini-2.5-flash` بما فيها التفكير التنظيمي
- 🐛 `geminiClient.js:23-26` بيحسب `currentModel` عند 404 و**مابيستخدمهاش**
- ٤ نداءات متتالية لكل ليبل (+٥ للبحث)
- مفيش context caching رغم إعادة إرسال نفس البلوكات
- `README_AI_COSTS.md` موجود بس مفيش token accounting
- ⚠️ **`@google/generative-ai` deprecated رسمياً** — البديل `@google/genai`

## ٣. المبادئ الحاكمة

> **كل ادعاء بيطلع من النظام لازم يكون قابل للتتبع لمصدر، وقابل للتكرار، وقابل للقياس.**
>
> - **قابل للتتبع:** أي قيمة ترجع لـ (مصدر، درجة، استشهاد، وقت، موديل، هاش برومبت)
> - **قابل للتكرار:** أي ليبل يتولّد تاني بنفس المدخلات ويتقارن
> - **قابل للقياس:** أي تغيير في برومبت أو موديل يتقاس على مجموعة ذهبية قبل ما يشحن

اللي مش مستوفي التلاتة **مش feature — ده دَين**.

**الفصل الخماسي:**

```
┌──────────────────┐   ┌────────────────────┐   ┌──────────────────────┐
│ بيانات المنتج    │   │ المراجع المعتمدة   │   │ المعرفة التنظيمية    │
│ Product +        │   │ ReferenceLabel     │   │ RegulatoryDocument + │
│ ProductProfile   │   │ (بنية وأسلوب)      │   │ RegulatoryRule       │
│ (حقائق)          │   │                    │   │ (مصدر الحقيقة)       │
└────────┬─────────┘   └─────────┬──────────┘   └──────────┬───────────┘
         └───────────┬───────────┴─────────────┬───────────┘
                     ▼                         ▼
            ┌─────────────────┐      ┌──────────────────────┐
            │ التوليد         │─────▶│ محرك التحقق          │
            │ (Gemini مقيّد)  │      │ حتمي + AI للفجوات    │
            └────────┬────────┘      └──────────┬───────────┘
                     ▼                          ▼
            ┌─────────────────┐      ┌──────────────────────┐
            │ GeneratedLabel  │◀────▶│ ValidationReport     │
            │ + LabelVersion  │      │ FieldVerdict[]       │
            └────────┬────────┘      └──────────────────────┘
                     ▼
              الشات → Patch → تطبيق → إعادة تحقق → نسخة جديدة
                     ▼
              اعتماد بشري → ترقية لمرجع (الدولاب)
```

**القاعدة:** التوليد **مايقدرش** يكتب حكم. التحقق **مايقدرش** يكتب محتوى. الاسترجاع **مايقدرش** يقدّم دليل امتثال. كل سهم اتجاه واحد.

---
---

# الجزء الثاني — المعمارية

## ٤. شكل النظام

### ٤.١ تخطيط الوحدات

```
src/services/label/
├── schema/
│   ├── labelSchema.js          # Zod — المصدر الوحيد
│   ├── geminiSchema.js         # zod → responseSchema (مشتق، ممنوع يتكتب بإيد)
│   └── fieldCatalog.js         # بيانات الحقول: الانطباق، الخطورة، الترتيب
├── retrieval/
│   ├── productProfile.js       # Product/formulationText → ProductProfile موحّد
│   ├── similarity.js           # ترتيب بأوزان متعددة السمات
│   └── referenceSelector.js    # استعلام مقيّد بالمستأجر + ترتيب + top-K
├── knowledge/
│   ├── authoritativeSources.js # قائمة النطاقات المسموحة للمنتجات
│   └── knowledgeResolver.js    # ExternalKnowledgeCache + بحث مُستشهد
├── regulatory/
│   ├── requirementResolver.js  # DB أولاً → مصدر رسمي → pending_review
│   ├── officialSources.js      # سجل الهيئات + نطاقاتها
│   ├── ruleCompiler.js         # نص المستند → RegulatoryRule[]
│   └── coverageAuditor.js      # تمريرة عكسية — أي فقرة مطلّعتش قاعدة
├── generation/
│   ├── contextBuilder.js       # البلوكات الأربعة المعزولة، مرتّبة للتخزين المؤقت
│   └── labelGenerator.js       # نداء واحد مقيّد بـ schema
├── validation/
│   ├── validationEngine.js     # المنسّق → ValidationReport
│   ├── schemaValidator.js      # حتمي: Zod
│   ├── ruleValidator.js        # حتمي: مشغّل RegulatoryRule[]
│   ├── coherenceValidator.js   # حتمي: اتساق متقاطع
│   ├── aiValidator.js          # AI للقواعد الدلالية فقط
│   ├── adversarialAuditor.js   # مدقق مستقل من عائلة موديلات مختلفة
│   └── selfConsistency.js      # ×٣ للحقول الرقمية الخطرة
├── editing/
│   ├── patchProtocol.js        # شكل الـ patch، قائمة المسارات، الأمان
│   ├── patchApplier.js         # تطبيق → ليبل مرشّح
│   └── chatAgent.js            # وكيل بأدوات
├── approval/
│   ├── approvalService.js      # البوابات الست + سجل التوقيع
│   └── promotionService.js     # الترقية لمرجع + السحب
├── versioning/
│   └── versionService.js       # لقطة، فرق، استعادة
├── assurance/
│   ├── goldenSet.js            # harness التقييم
│   ├── shadowRunner.js         # تشغيل مزدوج
│   ├── riskScorer.js           # درجة المخاطر → مستوى الاستقلالية
│   └── replayService.js        # إعادة تشغيل حتمية
└── labelOrchestrator.js        # نقطة الدخول الوحيدة اللي الـ worker بينادينها
```

**الأعراف:** ESM + named exports · services ترمي `AppError` · controllers بـ `catchAsync` · البزنس لوجيك في services مش workers · الـ worker thin: يقرا الـ job، ينادي المنسّق، يبعت progress.

### ٤.٢ توحيد محرك التحقق

```
                     ┌──────────────────────┐
ليبل مرفوع (PDF) ───▶│  labelExtractor      │───┐
                     │  (كان verifyProduct- │   │
                     │   Label — استخراج بس)│   │    ┌────────────────────┐
                     └──────────────────────┘   ├───▶│  validationEngine  │
                                                 │    │  (محرك واحد وحيد)  │
                     ┌──────────────────────┐   │    └────────────────────┘
بيانات منتج ────────▶│  labelGenerator      │───┘              │
                     └──────────────────────┘                  ▼
                                                       ValidationReport
```

نفس المنتج + نفس الدولة = **نفس الحكم**، سواء الليبل اتولّد عندنا أو اترفع من برّه.

---

## ٥. نموذج البيانات

### ٥.١ `GeneratedLabel` — يصلح G1

```prisma
model GeneratedLabel {
  id                String   @id @default(uuid())

  companyId         String   @map("company_id")
  company           Company  @relation(fields: [companyId], references: [id], onDelete: Cascade)
  productId         String?  @map("product_id")
  product           Product? @relation(fields: [productId], references: [id], onDelete: SetNull)
  createdByUserId   String?  @map("created_by_user_id")

  inputPayload      Json     @map("input_payload")      // لقطة ثابتة للمدخل
  productProfile    Json     @map("product_profile")    // ProductProfile الموحّد

  labelData         Json     @map("label_data")         // الليبل الحالي
  labelProvenance   Json     @map("label_provenance")   // مسار → نسب (§14.4)
  schemaVersion     String   @map("schema_version")     // "vet-label@2.0.0"

  country           String
  language          String
  status            String   @default("draft")          // draft|validated|failed_validation|approved|revoked|archived

  referenceLabelIds String[] @map("reference_label_ids")
  regulatoryDocIds  String[] @map("regulatory_doc_ids")
  matchTier         String?  @map("match_tier")
  generationMeta    Json?    @map("generation_meta")

  riskScore         Int      @default(0) @map("risk_score")
  autonomyTier      String   @default("mandatory") @map("autonomy_tier")
  shadowRunId       String?  @map("shadow_run_id")
  promotedToReferenceId String? @map("promoted_to_reference_id")

  currentVersion    Int      @default(1) @map("current_version")

  versions          LabelVersion[]
  validations       ValidationReport[]
  chatMessages      LabelChatMessage[]
  approvals         LabelApproval[]

  createdAt         DateTime @default(now()) @map("created_at")
  updatedAt         DateTime @updatedAt @map("updated_at")

  @@index([companyId, createdAt])
  @@index([productId])
  @@map("generated_labels")
}
```

### ٥.٢ `LabelVersion`

```prisma
model LabelVersion {
  id             String   @id @default(uuid())
  labelId        String   @map("label_id")
  label          GeneratedLabel @relation(fields: [labelId], references: [id], onDelete: Cascade)

  versionNumber  Int      @map("version_number")
  labelData      Json     @map("label_data")       // لقطة كاملة ثابتة

  changeSource   String   @map("change_source")    // ai_generation|ai_chat_edit|manual_edit|restore
  changedByUserId String? @map("changed_by_user_id")
  changeSummary  String?  @map("change_summary") @db.Text
  diff           Json?                             // [{ path, op, before, after }]
  restoredFrom   Int?     @map("restored_from")
  overrideAcknowledged Boolean @default(false) @map("override_acknowledged")

  validationReportId String? @map("validation_report_id")
  createdAt      DateTime @default(now()) @map("created_at")

  @@unique([labelId, versionNumber])
  @@map("label_versions")
}
```

> **الاستعادة أمامية فقط.** استعادة النسخة `K` بتعمل نسخة `N+1` بمحتوى `K`. التاريخ append-only دايماً.

### ٥.٣ `ValidationReport` — يصلح G3

```prisma
model ValidationReport {
  id            String   @id @default(uuid())
  labelId       String   @map("label_id")
  label         GeneratedLabel @relation(fields: [labelId], references: [id], onDelete: Cascade)
  versionNumber Int      @map("version_number")

  passed        Boolean
  errorCount    Int      @default(0) @map("error_count")
  warningCount  Int      @default(0) @map("warning_count")

  verdicts      Json                                  // FieldVerdict[] — §10.2
  auditorVerdicts Json?  @map("auditor_verdicts")     // §14.1
  disagreementCount Int  @default(0) @map("disagreement_count")
  selfConsistency Json?  @map("self_consistency")     // §14.2
  coveragePercent Float? @map("coverage_percent")     // §7.5 منسوخ وقت التحقق

  engineVersion String   @map("engine_version")
  rulesetIds    String[] @map("ruleset_ids")
  aiAssisted    Boolean  @default(false) @map("ai_assisted")

  createdAt     DateTime @default(now()) @map("created_at")
  @@index([labelId, versionNumber])
  @@map("validation_reports")
}
```

### ٥.٤ `LabelChatMessage` — يصلح G8

```prisma
model LabelChatMessage {
  id             String   @id @default(uuid())
  labelId        String   @map("label_id")
  label          GeneratedLabel @relation(fields: [labelId], references: [id], onDelete: Cascade)

  role           String                              // user | assistant | system | tool
  content        String   @db.Text
  intent         String?                             // edit | question | explain_validation
  toolCalls      Json?    @map("tool_calls")         // أدوات الوكيل اللي اتنادت
  proposedPatch  Json?    @map("proposed_patch")
  appliedPatch   Json?    @map("applied_patch")
  resultVersion  Int?     @map("result_version")
  conflicts      Json?
  userId         String?  @map("user_id")
  tokenUsage     Json?    @map("token_usage")

  createdAt      DateTime @default(now()) @map("created_at")
  @@index([labelId, createdAt])
  @@map("label_chat_messages")
}
```

### ٥.٥ `LabelApproval` — التوقيع البشري

```prisma
model LabelApproval {
  id                String   @id @default(uuid())
  labelId           String   @map("label_id")
  label             GeneratedLabel @relation(fields: [labelId], references: [id], onDelete: Cascade)

  approvedVersion   Int      @map("approved_version")
  labelSnapshot     Json     @map("label_snapshot")   // نسخة كاملة، مش pointer
  validationReportId String  @map("validation_report_id")

  approvedByUserId  String   @map("approved_by_user_id")
  approverName      String   @map("approver_name")    // منسوخ وقت التوقيع
  approverRole      String?  @map("approver_role")
  approvedAt        DateTime @default(now()) @map("approved_at")

  signedEstimatedFields    String[] @map("signed_estimated_fields")
  acknowledgedUnverifiable String[] @map("acknowledged_unverifiable")
  riskScoreAtApproval      Int      @map("risk_score_at_approval")
  autonomyTier             String   @map("autonomy_tier")
  coveragePercentAtApproval Float?  @map("coverage_percent_at_approval")
  rulesetSnapshot          String[] @map("ruleset_snapshot")
  note                     String?  @db.Text

  secondApproverUserId String?  @map("second_approver_user_id")
  secondApprovedAt     DateTime? @map("second_approved_at")
  promotedReferenceId  String?  @map("promoted_reference_id")

  revokedAt         DateTime? @map("revoked_at")
  revokedByUserId   String?   @map("revoked_by_user_id")
  revocationReason  String?   @db.Text

  @@index([labelId, approvedVersion])
  @@index([approvedByUserId, approvedAt])
  @@map("label_approvals")
}
```

### ٥.٦ `RegulatoryDocument` — يحل محل `EdaRequirement`

> اعمل migration يعيد التسمية ويضيف الأعمدة، **من غير كسر**. سيب service shim للاستدعاءات القديمة فترة انتقالية.

```prisma
model RegulatoryDocument {
  id              String   @id @default(uuid())

  title           String                              // 🐛 يصلح عمود مفقود
  authority       String                              // "EDA" | "SFDA" | "MOHAP"
  country         String
  productScope    String[] @map("product_scope")

  sourceType      String   @map("source_type")        // official_upload|official_url|ai_web_search|manual
  sourceUrl       String?  @map("source_url")
  sourceIsOfficial Boolean @default(false) @map("source_is_official")
  documentVersion String?  @map("document_version")
  effectiveDate   DateTime? @map("effective_date")
  supersededById  String?  @map("superseded_by_id")
  retrievedAt     DateTime? @map("retrieved_at")
  documentHash    String?  @map("document_hash")      // sha256 — إزالة تكرار وكشف تغيير

  status          String   @default("pending_review") // pending_review|approved|rejected|superseded
  reviewedByUserId String? @map("reviewed_by_user_id")
  reviewedAt      DateTime? @map("reviewed_at")

  // ── تغطية (§7.5)
  clauseTotal       Int?     @map("clause_total")
  clauseCovered     Int?     @map("clause_covered")
  coveragePercent   Float?   @map("coverage_percent")
  uncoveredClauses  Json?    @map("uncovered_clauses")
  coverageAuditedAt DateTime? @map("coverage_audited_at")

  extractedText   String?  @map("extracted_text") @db.Text
  extractedData   Json?    @map("extracted_data")

  companyId       String?  @map("company_id")
  company         Company? @relation(fields: [companyId], references: [id], onDelete: Cascade)
  rules           RegulatoryRule[]

  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@index([country, authority, status])
  @@map("regulatory_documents")
}
```

### ٥.٧ `RegulatoryRule` — المفتاح الحقيقي

> **مش في الـ spec الأصلي.** الـ deterministic validation بتحتاج **قواعد مقروءة آلياً**، مش prose. من غير الجدول ده، `Target Animals: MISSING → FAIL` مستحيلة حتمياً.

```prisma
model RegulatoryRule {
  id            String   @id @default(uuid())
  documentId    String   @map("document_id")
  document      RegulatoryDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  ruleKey       String   @map("rule_key")        // "EG.VET.TARGET_SPECIES.REQUIRED"
  ruleType      String   @map("rule_type")       // required_field|forbidden_content|format|conditional|value_constraint|language|semantic
  severity      String                            // error | warning | info

  targetPath    String?  @map("target_path")     // مسار في labelData
  appliesWhen   Json?    @map("applies_when")    // شرط — null = دايماً
  constraint    Json                              // مُحمول قابل للفحص — §7.3

  description   String   @db.Text
  citation      String?  @db.Text                 // نص مقتبس حرفياً من المستند
  status        String   @default("pending_review") // pending_review|approved|rejected
  autoFixable   Boolean  @default(false) @map("auto_fixable")

  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@unique([documentId, ruleKey])
  @@index([ruleType, severity, status])
  @@map("regulatory_rules")
}
```

### ٥.٨ `ExternalKnowledgeCache` — بديل التخمين (يصلح G9)

```prisma
model ExternalKnowledgeCache {
  id              String   @id @default(uuid())

  kind            String                                // ingredient_monograph|product_dossier|species_norm
  lookupKey       String   @map("lookup_key")           // "amoxicillin_trihydrate|oral_powder|poultry"

  payload         Json
  summary         String?  @db.Text

  sourceType      String   @map("source_type")
  sourceUrls      String[] @map("source_urls")
  sourceIsAuthoritative Boolean @default(false) @map("source_is_authoritative")
  citations       Json?                                  // [{ claim, url, quotedText }]

  confidence      String                                 // high | medium | low
  status          String   @default("unreviewed")        // unreviewed | approved | rejected
  reviewedByUserId String? @map("reviewed_by_user_id")

  retrievedAt     DateTime @map("retrieved_at")
  expiresAt       DateTime? @map("expires_at")

  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  @@unique([kind, lookupKey])
  @@index([kind, status])
  @@map("external_knowledge_cache")
}
```

### ٥.٩ توسيع `ReferenceLabel` — يصلح G5

```prisma
// أضف إلى model ReferenceLabel
  activeIngredients   Json?    @map("active_ingredients")
  targetSpecies       String[] @map("target_species")
  dosageForm          String?  @map("dosage_form")
  routeOfAdministration String? @map("route_of_administration")
  indicationTags      String[] @map("indication_tags")
  strengthSummary     String?  @map("strength_summary")
  productType         String?  @map("product_type")
  isApproved          Boolean  @default(true) @map("is_approved")

  // الدولاب (§12)
  qualityWeight       Float    @default(0.7) @map("quality_weight")
  originLabelId       String?  @map("origin_label_id")
  approvalId          String?  @map("approval_id")
  fingerprint         String?
  supersededById      String?  @map("superseded_by_id")
  needsReview         Boolean  @default(false) @map("needs_review")

  embedding           Unsupported("vector(768)")?   // اختياري

  @@index([country, productType])
  @@index([fingerprint, companyId])
```

> **ليه أعمدة منفصلة والداتا في `extractedData`؟** عشان الفلترة والفهرسة في SQL بدل تحميل الجدول (G5). الـ backfill بيقرا من `extractedData` — **مفيش نداءات AI**.

### ٥.١٠ توسيع `Product` — يصلح G7

```prisma
  routeOfAdmin       String?  @map("route_of_admin")   // 🐛 مُشار إليه في labelService.js:399
  dosageForm         String?  @map("dosage_form")
  strength           String?
  productType        String?  @map("product_type")
  prescriptionStatus String?  @map("prescription_status")   // POM|OTC|VFD
```

### ٥.١١ موديلات الضمان

```prisma
model AuditDisagreement {                       // §14.1
  id, labelId, versionNumber, fieldPath,
  deterministicVerdict, auditorVerdict, auditorReasoning,
  resolution String?,        // human_agreed_engine|human_agreed_auditor|new_rule_created
  becameRuleId String?, createdAt
  @@map("audit_disagreements")
}

model ShadowComparison {                        // §14.5
  id, labelId, oldEngineResult Json, newEngineResult Json,
  fieldsDiffered String[], verdictDiffered Boolean,
  latencyDeltaMs Int, costDelta Float, createdAt
  @@map("shadow_comparisons")
}

model GoldenEvalRun {                           // §14.3
  id, runAt, engineVersion, modelId, promptHash,
  fieldAccuracy Json, overallAccuracy Float,
  baselineAccuracy Float, regressed Boolean, blockedDeploy Boolean
  @@map("golden_eval_runs")
}
```

### ٥.١٢ ترتيب الـ migrations

```
1. add_generated_label_core       → GeneratedLabel, LabelVersion, ValidationReport, LabelChatMessage
2. add_label_approval             → LabelApproval
3. regulatory_documents_and_rules → rename eda_requirements, add columns, add regulatory_rules
4. reference_label_attributes     → أعمدة مهيكلة + الدولاب (nullable)
5. external_knowledge_cache
6. product_missing_fields         → routeOfAdmin, dosageForm, strength, productType, prescriptionStatus
7. assurance_models               → AuditDisagreement, ShadowComparison, GoldenEvalRun
8. backfill: scripts/backfillReferenceAttributes.js   (من extractedData، بلا AI، idempotent)
9. [اختياري] enable_pgvector
```

⚠️ **كل الأعمدة nullable أو لها default. ممنوع أي migration مدمّر.**

---

## ٦. الـ Label Schema

### ٦.١ القاعدة

`src/services/label/schema/labelSchema.js` هو **المصدر الوحيد**. منه يُشتق:
الـ Gemini `responseSchema` · التحقق الحتمي · قائمة مسارات الـ patch · تنميط الـ API · كتالوج الحقول.

لو حقل اتضاف في مكان واحد بس، دي بالظبط الـ bug اللي عملت G2. الاشتقاق بيمنعها بنيوياً.

### ٦.٢ الـ primitive اللغوي

```js
// ❌ يثبّت لغتين، ويسمي واحدة "target"
const Bilingual = z.object({ en: z.string(), target: z.string() });

// ✅ مفتوح، واللغات الإجبارية شرط تنظيمي
const LocalizedText = z.object({
  translations: z.record(z.string().min(2).max(5), z.string().min(1)),  // "ar","en","fr"
  primary: z.string(),
});
// اللغات الإجبارية تيجي من قاعدة:
// { ruleKey: "EG.VET.LANGUAGES.REQUIRED",
//   constraint: { kind: "language_set", required: ["ar","en"], appliesTo: "*" } }
```

> **ليه دلوقتي:** ده أعمق primitive في النظام. تغييره وإنت عند صفر ليبل = خمس دقايق. عند ٥٠٠ = هجرة مؤلمة.

### ٦.٣ الـ Schema

```js
export const labelSchema = z.object({
  schemaVersion: z.literal("vet-label@2.0.0"),
  productType: z.enum(["veterinary_drug","feed_additive","premix","supplement","compound_feed"]),

  // ── الهوية
  productName:            LocalizedText,
  pharmaceuticalForm:     LocalizedText.nullable(),   // إجباري لو vet drug
  strength:               LocalizedText.nullable(),   // إجباري لو vet drug
  feedClassification:     LocalizedText.nullable(),   // إجباري لأنواع الأعلاف

  // ── التركيب
  activeIngredients: z.array(z.object({
    translations: z.record(z.string(), z.string()),
    primary: z.string(),
    amount: z.string().min(1),                        // ممنوع فاضي — "q.s." لو بلا كمية
    unit: z.string().nullable(),
    normalizedName: z.string().nullable(),
  })).min(1),
  excipients: z.array(LocalizedText).default([]),
  analysis: z.object({                                // إنجليزي فقط
    basis: z.string(),                                // "per 1 kg" | "per 1 L"
    items: z.array(z.object({ name: z.string(), value: z.string() })),
  }).nullable(),

  // ── الاستعمال  ★ الأنواع المستهدفة من الدرجة الأولى
  targetAnimalSpecies: z.object({
    translations: z.record(z.string(), z.string()),
    primary: z.string(),
    list: z.array(z.string().min(1)).min(1),          // ★ قائمة قابلة للقراءة آلياً
    source: z.enum(["confirmed","reference","inferred"]),  // ★ محسوبة في الكود
  }),
  aimOfUse:               LocalizedText,
  indications:            z.array(LocalizedText).default([]),
  routeOfAdministration:  LocalizedText.nullable(),   // إجباري لو vet drug
  directionOfUse:         LocalizedText,
  contraindications:      LocalizedText.nullable(),
  warnings:               z.array(LocalizedText).default([]),
  sideEffects:            LocalizedText.nullable(),
  withdrawalPeriod:       LocalizedText.nullable(),   // إجباري لو نوع منتج للغذاء
  userSafety:             z.array(LocalizedText).default([]),

  // ── التداول
  storage:                LocalizedText,
  shelfLifeAfterOpening:  LocalizedText.nullable(),
  disposal:               LocalizedText.nullable(),
  netWeight:              LocalizedText,
  packaging:              LocalizedText.nullable(),

  // ── الهوية التنظيمية  🐛 قيم حقيقية، مش booleans
  registrationNumber:     z.string().nullable(),
  marketingAuthorisationHolder: LocalizedText.nullable(),
  manufacturer:           LocalizedText.nullable(),
  importer:               LocalizedText.nullable(),
  countryOfProduction:    LocalizedText.nullable(),
  batchNo:                z.string().nullable(),
  productionDate:         z.string().nullable(),
  expiryDate:             z.string().nullable(),
  prescriptionStatus:     z.enum(["POM","OTC","VFD","NA"]).default("NA"),

  // ── الإقرارات
  usageDeclaration:       z.array(LocalizedText).default([]),
  keepOutOfReachOfChildren: z.boolean().default(true),

  estimatedFields:        z.array(z.string()).default([]),
});
```

### ٦.٤ الانطباق الشرطي

يتعرّف في `fieldCatalog.js` — مش بـ `if` مبعثرة:

```js
export const fieldCatalog = {
  withdrawalPeriod: {
    severity: "error",
    appliesWhen: (l) => l.targetAnimalSpecies.list.some(isFoodProducingSpecies),
    reason: "فترة السحب إلزامية للأنواع المنتجة للغذاء.",
  },
  routeOfAdministration: {
    severity: "error",
    appliesWhen: (l) => l.productType === "veterinary_drug",
  },
  analysis: {
    severity: "warning",
    appliesWhen: (l) => ["feed_additive","premix","compound_feed"].includes(l.productType),
  },
  shelfLifeAfterOpening: {
    severity: "warning",
    appliesWhen: (l) => isMultiDose(l.packaging),
  },
};
```

> ده اللي بيحقق "متفرضش حقول غير ذات صلة" — الانطباق بيتحسب من محتوى الليبل نفسه.

### ٦.٥ جدول التغطية

| الحقل | اليوم | الهدف | شرطي |
|---|---|---|---|
| productName | ✅ | إبقاء | — |
| feedClassification | ✅ | إبقاء | أعلاف |
| pharmaceuticalForm | ❌ | **إضافة** | vet drug |
| strength | ❌ | **إضافة** | vet drug |
| activeIngredients[] | ⚠️ `ingredients[]` بلا تطبيع | **إعادة تسمية + تطبيع** | — |
| excipients[] | ❌ | **إضافة** | — |
| analysis | ✅ | إبقاء | أعلاف |
| **targetAnimalSpecies** | ⚠️ بتتولّد ومابتتحفظش | **`.list` + `.source` + حفظ + تحقق + تعديل** | — |
| aimOfUse | ✅ | إبقاء | — |
| indications[] | ❌ | **إضافة** | — |
| routeOfAdministration | ❌ | **إضافة** | vet drug |
| directionOfUse | ✅ | إبقاء | — |
| contraindications | ❌ | **إضافة** | — |
| warnings[] | ❌ | **إضافة** | — |
| sideEffects | ❌ | **إضافة** | vet drug |
| withdrawalPeriod | ❌ | **إضافة** | أنواع غذائية |
| userSafety[] | ❌ | **إضافة** | — |
| storage | ✅ | إبقاء | — |
| shelfLifeAfterOpening | ❌ | **إضافة** | متعدد الجرعات |
| disposal | ❌ | **إضافة** | — |
| netWeight | ✅ | إبقاء | — |
| registrationNumber | 🐛 boolean | **تحويل لقيمة** | — |
| marketingAuthorisationHolder | ❌ | **إضافة** | vet drug |
| manufacturer | 🐛 boolean | **تحويل لقيمة** | — |
| importer | 🐛 boolean | **تحويل لقيمة** | مستورد |
| countryOfProduction | 🐛 boolean | **تحويل لقيمة** | — |
| batchNo / productionDate / expiryDate | 🐛 booleans | **تحويل لقيم** | — |
| prescriptionStatus | ❌ | **إضافة** | vet drug |
| usageDeclaration[] | ✅ | إبقاء | — |
| keepOutOfReachOfChildren | ❌ | **إضافة** | — |
| estimatedFields[] | ✅ | إبقاء | — |

---

## ٧. الطبقة التنظيمية

### ٧.١ ترتيب الحل

```
1. RegulatoryDocument معتمد خاص بالشركة لـ (دولة، نطاق منتج)   → استخدم
2. نفسه عام                                                     → استخدم
3. جلب من مصدر رسمي (نطاقات مسموحة فقط)
     → ✅ يُجلب ويُستخدم في التوليد فوراً، نفس الـ job
     → يتخزن status="pending_review", sourceIsOfficial=true, sourceUrl, documentHash
     → القواعد منه provisional
     → ❌ ممكن ترفع WARN أو UNVERIFIABLE، لكن مش PASS ولا FAIL قاطعة قبل المراجعة
     → المستخدم يتقاله: "requirements retrieved from <authority>, awaiting review"
4. مفيش
     → علّم NO_AUTHORITATIVE_REQUIREMENTS
     → الحكم UNVERIFIABLE — لا PASS ولا FAIL — وظاهر للمستخدم، مش صامت
```

> **اختلاف مقصود مع الطلب الأصلي:** حفظ نص استخرجه LLM من الويب كـ authoritative في دومين منظّم = مسؤولية قانونية. البوابة إجبارية. `UNVERIFIABLE` أهم حالة تالتة في النظام — من غيرها بتكدب على المستخدم.

### ٧.٢ سجل المصادر الرسمية

```js
// src/services/label/regulatory/officialSources.js
export const AUTHORITIES = {
  EG: { code: "EDA",   name: "Egyptian Drug Authority",  domains: ["edaegypt.gov.eg"] },
  SA: { code: "SFDA",  name: "Saudi Food and Drug Authority", domains: ["sfda.gov.sa"] },
  AE: { code: "MOHAP", name: "UAE Ministry of Health and Prevention", domains: ["mohap.gov.ae"] },
};
```

**الإلزام:** أي جلب **لازم** يرجّع `sourceUrl`. host مش في `domains` → `sourceIsOfficial=false` و**المستند مايتخزنش كمعرفة تنظيمية**. ده بيقتل سلوك `ai_web_search` الحالي.

### ٧.٣ صيغة القيود

```jsonc
{ "kind": "required_field", "path": "targetAnimalSpecies.list", "minLength": 1 }

{ "kind": "forbidden_content", "path": "aimOfUse",
  "patterns": ["\\btreats?\\b","\\bcures?\\b","يعالج"], "flags": "i" }

{ "kind": "format", "path": "storage",
  "regex": "\\d+\\s*°?\\s*C", "message": "التخزين لازم يذكر حد حرارة رقمي." }

{ "kind": "conditional",
  "when": { "path": "targetAnimalSpecies.list", "anyOf": ["Cattle","Sheep","Goat","Camel","Poultry"] },
  "then": { "kind": "required_field", "path": "withdrawalPeriod" } }

{ "kind": "language_set", "required": ["ar","en"], "appliesTo": "*" }
{ "kind": "language", "path": "analysis", "mustBe": "en_only" }

{ "kind": "value_constraint", "path": "activeIngredients[*].amount", "notEmpty": true }

{ "kind": "semantic", "path": "aimOfUse",
  "question": "هل النص ده بيدّعي علاج أو شفاء مرض؟" }   // ← الوحيد اللي بيروح للـ AI
```

> **الـ `appliesWhen` / `constraint` DSL لازم يتعرّف بقواعد صريحة ومُقيّم مختبَر.** معامل غير مدعوم = خطأ صريح، مش تجاهل. DSL نصف معرّف أسوأ من عدمه.

### ٧.٤ رحلة الاستيعاب — من ملف الهيئة لقواعد فعّالة

> بيحصل **مرة لكل مستند**، مش مع كل توليد. **لازم يتنفذ الأول** — من غيره كل توليد هيروح على fallback.

```
[1] رفع المستند
    POST /regulatory-documents   (multipart: file, title, authority, country,
                                  productScope[], documentVersion?, effectiveDate?, sourceUrl?)
    → BackgroundTask + queue  (إعادة استخدام edaRequirementQueue)
    → status = "uploaded"
         │
[2] استخراج النص  ── worker
    ✅ إدي الـ PDF للموديل مباشرة (§9.6) — مش pdf-parse
    documentHash = sha256(text)
    ⚠️ الهاش موجود قبل كده → توقف: "المستند مرفوع بالفعل كـ vX"
    → status = "extracted"
         │
[3] تجميع القواعد  ── ruleCompiler · موديل تفكير عالي · responseSchema صارم
    ✅ المستند كامل في السياق — ممنوع التقطيع (§9.4)
    المخرج: RegulatoryRule[] وكل قاعدة فيها:
       ruleKey · ruleType · severity · targetPath · appliesWhen · constraint
       · description · citation ← نص مقتبس حرفياً
    🚫 قاعدة استشهادها مش متحقق منه حرفياً في النص → REJECT (مش warning)
    🚫 قاعدة targetPath بتاعها مش في labelSchema → REJECT
    → كل القواعد status = "pending_review"
         │
[4] تدقيق التغطية (§7.5)  ── تمريرة عكسية إلزامية
         │
[5] المراجعة البشرية  ← البوابة الإلزامية
    GET   /regulatory-rules?documentId=…&status=pending_review
    PATCH /regulatory-rules/:id            تعديل constraint أو severity
    PATCH /regulatory-rules/:id/approve
    POST  /regulatory-documents/:id/approve
    → المراجع بيشوف: القاعدة، الاستشهاد، ومعاينة إيه اللي هتفشل
         │
[6] التفعيل
    document.status = "approved" · effectiveDate · documentVersion
    → من دلوقتي القواعد دي بتدي PASS/FAIL حقيقية
         │
[7] الإصدار الجديد
    رفع نسخة أحدث → supersededById على القديمة, status="superseded"
    → الليبلات القديمة تفضل مربوطة بالـ rulesetIds اللي اتحققت بيها فعلاً
    → إعادة التحقق بالقواعد الجديدة قرار صريح، مش تلقائي
```

**الحالة الحالية:** الخطوتين ١ و٢ موجودتين (`edaRequirementWorker`) — بس بتخزن `extractedData: []`، والخطوات ٣–٧ **مش موجودة خالص**. عشان كده مستند الهيئة بيتبعت كنص خام كل مرة.

### ٧.٥ مدقق التغطية — يمنع الـ PASS الكاذبة

**المشكلة:** المُجمِّع بيطلّع ٥٠ قاعدة من مستند فيه ١٨٠ شرط، والنظام يقول `PASS` بثقة.

```
تمريرة أمامية:  المستند ──▶ RegulatoryRule[]     (٥٠ قاعدة)
تمريرة عكسية:  المستند + الـ ٥٠ ──▶ "أنهي فقرات مطلّعتش قاعدة؟ وليه؟"
                                    ▼
              ┌──────────────────────────────────────────┐
              │ الفقرة ٤.٣  → مغطاة بـ EG.VET.STORAGE... │
              │ الفقرة ٧.١  → ❌ مش مغطاة — شرط حقيقي   │ → مراجعة
              │ الملحق ب   → ❌ مش مغطى — جدول شروط     │ → مراجعة
              │ الفقرة ١.١  → ⚪ ليست شرطاً (مقدمة)     │ → مقبول
              └──────────────────────────────────────────┘
                                    ▼
                coverage = 50 / 52 = 96%
```

**القاعدة الحاكمة:**

```
❌ ممنوع مستند يبقى approved و coveragePercent < 95%
   إلا لو مراجع بشري صنّف كل فقرة غير مغطاة صراحةً كـ "ليست شرطاً"

✅ كل ValidationReport بيعرض التغطية جنب النتيجة:
   passed: true · قواعد: 50/50 · تغطية المستند: 96% (فقرتان قيد المراجعة)
```

**من غير الرقم ده، `PASS` مش معناها حاجة.**

> ⚠️ **حد الطريقة:** التمريرة العكسية دي **برضه LLM**. بنفحص LLM بـ LLM. أحسن من لا حاجة، **مش برهان**. لو التمريرتين شايلين نفس العمى، التغطية هتقول ٩٨٪ وتكون غلط.

---

## ٨. الاسترجاع والتشابه

### ٨.١ `ProductProfile` — المدخل الموحّد

```js
{
  productType, activeIngredients: [{ normalizedName, amount, unit, strengthMgPerUnit }],
  dosageForm, routeOfAdministration, targetSpecies: [], indicationTags: [],
  country, language, netWeight, packaging,
  confirmedFacts: { aimOfUse?, targetSpecies?, directionOfUse? },
  provenance: { fromProductRow, fromFreeText, fromUserHints }
}
```

> **ده اللي بيصلح G2.** لو `productId` موجود → **اقرا الصف** وادمج `targetSpecies`, `activeIngredients`, `routeOfAdmin`, `dosageForm`. النص الحر **مكمّل مش بديل**. البيانات المؤكدة أقوى من استنتاج الـ AI.

### ٨.٢ سُلّم حل المنتج — لما المنتج مش موجود

> بيشتغل **حقل بحقل**. ممكن `activeIngredients` تكون Tier 1 و`routeOfAdministration` تكون Tier 5 في نفس الليبل.

| Tier | المصدر | الثقة | الوسم | الاعتماد |
|---|---|---|---|---|
| **1** | صف `Product` (بـ `productId`) | مؤكد | `confirmed` | يعدّي |
| **2** | `hints` من المستخدم (هو المصنّع) | مؤكد | `confirmed` | يعدّي |
| **3** | مستخرج من `formulationText` | متوسط | `extracted` | يعدّي + WARN |
| **4** | مرجع معتمد مطابق | متوسط-عالي | `reference` | يعدّي + تسجيل المرجع |
| **5** | `ExternalKnowledgeCache` — بحث مُستشهد | منخفض | `external` | **حاجز — توقيع** |
| **6** | مش موجود | — | `unknown` | `null` → FAIL / UNVERIFIABLE |

```
[أ] productId موجود؟
      نعم → اقرا الصف. كل حقل مليان = Tier 1. اقفل عليه.
      لأ  → كمّل
[ب] دوّر على المنتج بالاسم/المكوّنات (tenant-scoped)
      لقيته؟ → ⚠️ ده **مش نفس المنتج**، ده شبهه.
                يتعامل كـ reference (Tier 4)، مش كحقيقة (Tier 1).
[ج] استخرج من formulationText → Tier 3
[د] حقول مطلوبة لسه فاضية؟
      → استعلم ExternalKnowledgeCache بـ lookupKey
      → hit صالح ومعتمد؟ استخدمه (Tier 5)
      → miss → ابحث في PRODUCT_KNOWLEDGE_SOURCES فقط:
           · النتيجة لازم ترجع sourceUrls + citations بنص مقتبس (§9.5)
           · host مش في allowlist → ترمى بالكامل
           · ادعاء من غير استشهاد → يترمى
      → خزّن في الكاش، وسم provenance="external"، وحطه في estimatedFields → حاجز
[هـ] لسه فاضي؟ → سيبه null. ممنوع تخترع. التحقق يقرر FAIL ولا NOT_APPLICABLE.
```

**المصادر المسموحة:**

```js
export const PRODUCT_KNOWLEDGE_SOURCES = [
  { id: "ema_vet",   domains: ["ema.europa.eu"],        weight: "high" },
  { id: "fda_anada", domains: ["animaldrugsatfda.fda.gov","fda.gov"], weight: "high" },
  { id: "eda",       domains: ["edaegypt.gov.eg"],      weight: "high" },
  { id: "sfda",      domains: ["sfda.gov.sa"],          weight: "high" },
  { id: "vich",      domains: ["vichsec.org"],          weight: "high" },
  { id: "who_woah",  domains: ["who.int","woah.org"],   weight: "medium" },
  { id: "pharmacop", domains: ["usp.org","pheur.edqm.eu"], weight: "medium" },
];
```

**🚫 الاستثناءات المطلقة — ممنوع تتملى من Tier 5 أو 6 نهائياً:**

| الحقل | السبب |
|---|---|
| `withdrawalPeriod` | متبقيات في لحم/لبن/بيض — خطر مباشر على صحة الإنسان |
| `strength` | جرعة زايدة أو ناقصة |
| `activeIngredients[].amount` | نفس السبب |
| `registrationNumber` | رقم مختلق = تزوير مستند رسمي |
| `batchNo` / `expiryDate` | بيانات تصنيع — بتتطبع مش بتتولّد |

دول Tier 1/2/4 — أو فاضيين و`FAIL`. **النظام يرفض أحسن ما يخمّن.**

### ٨.٣ استعلام المرشحين — مقيّد بالمستأجر

```js
prisma.referenceLabel.findMany({
  where: {
    isApproved: true,
    OR: [{ companyId: profile.companyId }, { companyId: null }],   // 🔴 يقفل التسريب
    ...(profile.productType && { productType: profile.productType }),
  },
  take: 200,
  orderBy: { createdAt: "desc" },
});
```

### ٨.٤ الترتيب بالأوزان

```
score = 0.40 · ingredientMatch      // Jaccard على الأسماء المطبّعة؛ 1.0 للتطابق التام فقط
      + 0.15 · strengthProximity    // |log(a/b)| بعد تطبيع الوحدات
      + 0.12 · dosageFormMatch      // تام 1.0 / نفس العائلة 0.6 / غير ذلك 0
      + 0.12 · speciesOverlap       // Jaccard على الأنواع القياسية
      + 0.10 · indicationOverlap
      + 0.07 · routeMatch
      + 0.04 · countryMatch

finalScore = score × qualityWeight   // §12.4 — الدولاب
```

**تحديد الـ tier:**

| Tier | الشرط | الاستخدام المسموح |
|---|---|---|
| `exact_combo` | ingredientMatch = 1.0 و strengthProximity ≥ 0.9 | تأريض حقائق مسموح |
| `ingredient` | ingredientMatch ≥ 0.5 | تأريض مسموح، مع تعليم الفروق |
| `attribute` | ingredientMatch < 0.5، الإجمالي ≥ 0.45 | **أسلوب وبنية فقط** |
| `style_only` | تطابق دولة فقط | **أسلوب وبنية فقط** |
| `none` | لا شيء | مفيش مراجع |

> ⚠️ **الـ tier بيتحدد في الكود، والـ prompt بيتبنى منه. الموديل عمره ما يقرر إزاي يستخدم المرجع.** ده اللي بيمنع "التشابه = امتثال".

### ٨.٥ pgvector (اختياري)

`embedding vector(768)` على نص مركّب (مكوّنات + أنواع + دواعي + شكل). يُستخدم **كمرشِّح مرشحين فقط** (`ORDER BY embedding <=> query LIMIT 50`) وبعدين الترتيب بالأوزان. الـ embedding **مايحددش tier أبداً** — النص القريب مش دليل تكافؤ دوائي.

> **قبل ما تبني الطبقة دي:** عُدّ مراجعك. أقل من ٣٠؟ **اشطبها.** دي حل لمشكلة استرجاع مش موجودة عندك.

---

## ٩. التوليد وطبقة Gemini

### ٩.١ الـ SDK

```json
"@google/generative-ai": "^0.24.1"   ❌ deprecated رسمياً
```

```bash
npm remove @google/generative-ai && npm i @google/genai
```

📍 **Phase 0، مش Phase 5.** كل حاجة تحت متوقفة عليها.

### ٩.٢ سجل الموديلات — نقطة تحكم واحدة

```js
// src/services/ai/modelRegistry.js — المكان الوحيد اللي فيه أسماء موديلات
export const MODELS = {
  BULK_EXTRACT:   { id: "gemini-3.5-flash-lite",  thinking: "minimal", temperature: 0 },
  INGEST_BATCH:   { id: "gemini-3.5-flash",       thinking: "low",     temperature: 0 },
  RULE_COMPILE:   { id: "gemini-3.1-pro-preview", thinking: "high",    temperature: 0 },
  LABEL_GENERATE: { id: "gemini-3.7-flash",       thinking: "high",    temperature: 0.1 },
  AUDITOR:        { id: "gemini-3.1-pro-preview", thinking: "high",    temperature: 0 },
  CHAT_AGENT:     { id: "gemini-3.7-flash",       thinking: "medium",  temperature: 0.2 },
  EMBEDDING:      { id: "gemini-embedding-2-preview" },
};
```

> ⚠️ متحققة أغسطس ٢٠٢٦. راجعها عند التنفيذ — الفكرة إنك تراجع **ملف واحد**.

**قرار مقصود:** `LABEL_GENERATE` و `AUDITOR` **عيلتين مختلفتين**. مدقق بيشارك المولّد نفس التحيزات مش مدقق — ده صدى.

### ٩.٣ مستويات التفكير

| المهمة | المستوى | ليه |
|---|---|---|
| استخراج نص من PDF | `minimal` | نقل ميكانيكي |
| استيعاب مرجع | `low` | استخراج منظّم |
| **تجميع القواعد** | `high` | ترجمة نص قانوني لمنطق — أصعب مهمة |
| **توليد الليبل** | `high` | موازنة ٣ سياقات متعارضة |
| **التدقيق المضاد** | `high` | يلاقي اللي المولّد فاته |
| تصنيف نية الشات | `minimal` | تصنيف بسيط |

**الغلطة الشائعة:** سيبان `medium` (الافتراضي) في كل حاجة.

### ٩.٤ السياق الطويل

`gemini-3.5-flash` وما بعده: **مليون توكن**. مستند تنظيمي نموذجي ٤٠–١٢٠ ألف → **يدخل كامل**.

```
❌ التقطيع → استرجاع → تجميع
   بيضيّع: الجداول المقسّمة، الإحالات المتبادلة، الشروط الفرعية،
   والفقرة اللي بتقول "ما لم ينص القسم ٧ على خلاف ذلك"
✅ المستند كامل
   القاعدة في القسم ٧ والاستثناء في الملحق ب بيتشافوا مع بعض
```

**مهم بشكل خاص لتجميع القواعد** — أغلب الشروط شرطية ومترابطة.

### ٩.٥ التأريض والاستشهادات

الرد المؤرَّض بيرجع `annotations` وكل واحدة `url_citation`:

```jsonc
{ "url": "https://www.edaegypt.gov.eg/...", "title": "edaegypt.gov.eg",
  "start_index": 142, "end_index": 318 }
```

```js
function acceptGroundedClaim(annotation, text, allowlist) {
  const host = new URL(annotation.url).hostname;
  if (!allowlist.some(d => host === d || host.endsWith("." + d))) return null;
  const quoted = text.slice(annotation.start_index, annotation.end_index);
  if (!quoted || quoted.length < 40) return null;
  return { url: annotation.url, quotedText: quoted, host };
}
```

**ادعاء مالوش annotation ناجية = يترمى.** مش تحذير — يترمى.

### ٩.٦ الفهم متعدد الوسائط

```js
// ❌ pdf-parse — بيدمّر الجداول، بيخلط الأعمدة، بيفقد التخطيط
// ✅ إدي الـ PDF للموديل مباشرة
{ inlineData: { data: base64, mimeType: "application/pdf" } }
```

المستندات التنظيمية **مليانة جداول** — فترات سحب، مصفوفات أنواع، حدود تركيز. `pdf-parse` بيحوّلهم لعصيدة.

### ٩.٧ التخزين المؤقت — ترتيب البرومبت قرار معماري

ضمني ومفعّل افتراضياً على 2.5+. الحد الأدنى **٤٠٩٦ توكن** للموديلات 3.5+.

```
┌─ ثابت لكل دولة، يتكاش ─────────────────┐
│ 1. القواعد التنظيمية المعتمدة (~15k)    │  ← أول حاجة
│ 2. تعريف الـ label schema (~3k)         │
├─ شبه ثابت ─────────────────────────────┤
│ 3. المراجع المعتمدة المختارة (~8k)      │
├─ متغيّر لكل طلب ────────────────────────┤
│ 4. بيانات المنتج (~1k)                  │  ← آخر حاجة
└─────────────────────────────────────────┘
```

شركة بتولّد ٥٠ ليبل مصري في اليوم بتدفع الـ ١٨ ألف الأولى **مرة واحدة** بدل ٥٠.
راقب `usage.total_cached_tokens` في `generationMeta` — **صفر = الترتيب غلط**.

### ٩.٨ الـ Batch API — نصف التكلفة

خصم **٥٠٪**، الهدف ٢٤ ساعة (غالباً أسرع).

| المهمة | الوفر |
|---|---|
| استيعاب ٢٠٠ مرجع | 50% |
| إعادة بناء الـ embeddings | 50% |
| تجميع القواعد | 50% |
| إعادة تحقق شاملة بعد تحديث قواعد | 50% |
| المجموعة الذهبية ليلياً | 50% |

**الحدود:** ٢٠MB مضمّن · ٢GB ملف · نتائج ٦ أسابيع · **الوظايف مش idempotent** — احرس ضد التكرار.

> `referenceLabelWorker` فيه `await sleep(6000)` لتفادي حد المعدل. الـ Batch بيحل ده **وبيوفر نص الفلوس**.

### ٩.٩ البلوكات الأربعة المعزولة

| البلوك | المحتوى | الصلاحية |
|---|---|---|
| `<REGULATORY>` | القواعد + الاستشهادات + الإصدار — أو `NO_AUTHORITATIVE_REQUIREMENTS` | ملزم |
| `<OUTPUT_SCHEMA>` | مفروض عبر `responseSchema` | لا نقاش |
| `<REFERENCE_LABELS>` | top-K + tier + بيان الصلاحية لكل tier | حسب الـ tier |
| `<PRODUCT_DATA>` | ProductProfile + الحقائق المؤكدة + النسب | الحقيقة المطلقة |

**ممنوعات صريحة:**
- ممنوع تخترع شرط تنظيمي. `<REGULATORY>` فاضي؟ قول كده — متملاش من معرفتك
- استخدام المراجع محكوم بالـ tier المكتوب، مش بحكمك
- **ممنوع تصدر حكم امتثال.** مهمتك محتوى بس

### ٩.١٠ سياسة عدم الابتلاع

`labelGeneratorWorker.js:507, :567` بيبلعوا الأخطاء ويكملوا بالـ draft القديم. **يتشال.**

- فشل التوليد → الـ task تفشل بسبب واضح
- فشل التحقق الدلالي → الحقول `UNVERIFIABLE` **مش PASS**، والتقرير يحمل `aiAssisted: false` + السبب
- **ممنوع أي `catch {}` فاضية في مسار الليبل**

---

## ١٠. محرك التحقق

### ١٠.١ خمس طبقات

```
labelData
  ├─▶ ١. Schema (Zod)          — حتمي — أنواع، مطلوب، enums، غير فاضي
  ├─▶ ٢. الانطباق              — حتمي — fieldCatalog الشرطي
  ├─▶ ٣. القواعد التنظيمية      — حتمي — مشغّل RegulatoryRule[]
  ├─▶ ٤. الاتساق المتقاطع       — حتمي — analysis مقابل amounts،
  │                                كل الترجمات موجودة، مفيش "x"،
  │                                targetAnimalSpecies.list ↔ الترجمات
  └─▶ ٥. الدلالي                — AI، ضيق — القواعد kind="semantic" فقط
                        │
                        ├─▶ التدقيق المضاد (§14.1) — موازي، مستقل
                        └─▶ الاتساق الذاتي (§14.2) — للحقول الرقمية الخطرة
                        ▼
                 ValidationReport { passed, verdicts[], coveragePercent }
```

**الطبقات ١–٤ هي ٩٠٪ من التحقق وكلها كود.** الـ AI في الطبقة ٥ بأسئلة yes/no ضيقة، **وبيرجع حكم مش ليبل**.

### ١٠.٢ شكل الـ FieldVerdict

```jsonc
{
  "path": "targetAnimalSpecies.list",
  "label": { "ar": "الحيوانات المستهدفة", "en": "Target Animals" },
  "status": "FAIL",            // PASS | FAIL | WARN | NOT_APPLICABLE | UNVERIFIABLE
  "presence": "MISSING",       // PRESENT | MISSING | EMPTY | INVALID
  "severity": "error",
  "layer": "regulatory_rule",  // schema|applicability|regulatory_rule|coherence|semantic
  "ruleKey": "EG.VET.TARGET_SPECIES.REQUIRED",
  "message": "يجب ذكر الأنواع الحيوانية المستهدفة على الليبل.",
  "citation": "دليل الترخيص البيطري v3، §4.2",
  "sourceDocumentId": "…",
  "autoFixable": false,
  "suggestion": null
}
```

**شكل التقرير:**

```
Target Animals:      MISSING   → FAIL   [EG.VET.TARGET_SPECIES.REQUIRED]
Active Ingredient:   PRESENT   → PASS
Dosage:              PRESENT   → PASS
Withdrawal Period:   MISSING   → FAIL   (شرطي: أنواع منتجة للغذاء)
Required Warning:    MISSING   → FAIL
Shelf Life:          —         → NOT_APPLICABLE (عبوة أحادية)
Therapeutic Claim:   —         → UNVERIFIABLE (الفحص الدلالي غير متاح)

passed: false · أخطاء: 3 · تحذيرات: 0 · تغطية المستند: 96%
```

`passed = verdicts.every(v => v.status !== "FAIL")`. **`UNVERIFIABLE` مش PASS.**

### ١٠.٣ ضمان الحتمية

نفس `labelData` + نفس `rulesetIds` + نفس `engineVersion` **لازم** ينتجوا نفس الـ verdicts للطبقات ١–٤. **اكتب اختبار يثبت ده.** من غيره التحقق مش تحقق.

---

## ١١. الشات والتعديل المهيكل

### ١١.١ الشات وكيل بأدوات

```js
const LABEL_AGENT_TOOLS = [
  { name: "getLabel",            desc: "الليبل الحالي كامل" },
  { name: "getValidationReport", desc: "آخر تقرير بكل الأحكام والاستشهادات" },
  { name: "getRule",             desc: "نص قاعدة + استشهادها + مستندها", params: { ruleKey } },
  { name: "searchReferences",    desc: "بحث في المراجع المطابقة", params: { query, field } },
  { name: "getProvenance",       desc: "مصدر حقل ودرجة ثقته", params: { path } },
  { name: "getVersionHistory",   desc: "تاريخ التغييرات على حقل", params: { path } },
  { name: "dryRunPatch",         desc: "جرّب تعديل وشوف التقرير — بلا حفظ", params: { changes } },
  { name: "proposePatch",        desc: "قدّم التعديل النهائي", params: { changes, rationale } },
];
```

**مفروض في المنسّق:** الوكيل **مايقدرش** ينادي `proposePatch` من غير ما ينادي `dryRunPatch` الأول. ده قيد كود، مش رجاء في البرومبت.

### ١١.٢ توجيه النية

```
رسالة المستخدم
  ├─ question            → إجابة من الليبل + التقرير. بلا patch. قراءة فقط
  ├─ explain_validation  → شرح أحكام FAIL + الاستشهادات. بلا patch
  └─ edit                → إصدار LabelPatch (مش ليبل كامل أبداً)
```

النية تتحدد بنداء واحد بـ `responseSchema`، مش بـ regex.

### ١١.٣ بروتوكول الـ Patch

```jsonc
{
  "rationale": "المستخدم طلب إضافة الأبقار والأغنام كأنواع مستهدفة.",
  "changes": [
    { "path": "targetAnimalSpecies.list", "op": "replace", "value": ["Cattle","Sheep"] },
    { "path": "targetAnimalSpecies.translations.en", "op": "replace", "value": "Cattle - Sheep" },
    { "path": "targetAnimalSpecies.translations.ar", "op": "replace", "value": "الأبقار - الأغنام" },
    { "path": "activeIngredients[1].amount", "op": "replace", "value": "500 mg" },
    { "path": "warnings", "op": "append", "value": { "translations": {...}, "primary": "ar" } },
    { "path": "indications[2]", "op": "remove" }
  ]
}
```

**العمليات:** `replace` · `append` · `remove` · `insert`

> **الـ patch بيخاطب `path` مش `field`** — عشان التعديلات المتداخلة والمصفوفات (`activeIngredients[2].amount`).

### ١١.٤ الأسوار — كلها إجبارية

1. **قائمة مسارات مسموحة** — كل `path` لازم يتحل داخل `labelSchema`. مسار مجهول → **reject** بخطأ واضح، مش تجاهل صامت
2. **ممنوع الاستبدال الشامل** — patch بيمس > ٦٠٪ من الحقول العليا يترفض ويتحوّل لإعادة توليد صريحة بموافقة
3. **تشغيل تجريبي أولاً** — طبّق على نسخة → تحقق → قارن بالتقرير الحالي
4. **كشف التعارض** — لو الـ patch بيدخّل `FAIL` جديدة:
```jsonc
{ "status": "conflict",
  "requested": {...},
  "wouldViolate": [{ "ruleKey":"EG.VET.WITHDRAWAL.REQUIRED_IF_FOOD",
                     "message":"إضافة الأبقار تجعل فترة السحب إلزامية، وهي فاضية.",
                     "citation":"…" }],
  "options": ["cancel", "apply_and_fix:withdrawalPeriod", "apply_anyway_with_override"] }
```
   `apply_anyway_with_override` بيتسجّل على النسخة `overrideAcknowledged: true` بهوية المستخدم. **ممنوع التطبيق الصامت.**
5. **إعادة كتابة قسم** — "أعد كتابة القسم ده حسب المرجع" = توليد مُقيَّد على مسار واحد، بيرجع كـ patch. مش إعادة توليد للكل
6. **قفل تفاؤلي** — كل edit بيبعت `expectedVersion`. مش مطابق → `409`
7. **قفل حالة** — الليبل في حالة `generating` مايقبلش تعديل (يمنع سباق الـ worker مع الشات)

### ١١.٥ الدورة

```
POST /labels/:id/chat  { message, expectedVersion }
  → حمّل labelData الحالي + آخر ValidationReport + آخر N جولة
  → صنّف النية
  → question/explain → أجب من الأدوات، احفظ الرسالة، انتهى (بلا نسخة جديدة)
  → edit → الوكيل يستدعي الأدوات → dryRunPatch (إلزامي) → proposePatch
        → تحقق من الشكل + قائمة المسارات
        → تطبيق تجريبي → إعادة تحقق
        → تعارض؟ → ارجع التعارض، احفظ كـ proposedPatch، **متطبّقش**
        → نظيف؟  → طبّق، اعمل LabelVersion N+1، احفظ التقرير، ارجع الاتنين
```

### ١١.٦ الفرق العملي

**"ليه الليبل ده فاشل؟"**

```
getValidationReport() → FAIL على withdrawalPeriod
getRule("EG.VET.WITHDRAWAL.REQUIRED_IF_FOOD") → نص القاعدة + استشهادها
getProvenance("targetAnimalSpecies.list") → Tier 1، مؤكدة من صف المنتج
searchReferences({ query: "withdrawal amoxicillin poultry" }) → مرجع فيه ٧/٣

"فاشل لأن الدواجن والعجول منتجة للغذاء، ففترة السحب إلزامية
 (دليل الترخيص البيطري §6.1 — المستند اللي حضرتك رفعته في يوليو).
 الأنواع دي مؤكدة من بيانات المنتج نفسه مش استنتاج، فمينفعش نشيلها.
 في مرجع معتمد عندنا لنفس المكوّن بيقول: لحم ٧ أيام، بيض ٣ أيام.
 أطبّقها؟"
```

**"غيّر الجرعة لـ ١٠ مل"**

```
getProvenance("directionOfUse") → Tier 4، من مرجع معتمد، اتفاق ذاتي ٣/٣
dryRunPatch({ directionOfUse: "10 ml" }) → PASS، بس تحذير جديد

"التعديل هيعدّي التحقق. بس خليني أنبّه: الجرعة الحالية (٥ مل)
 جاية من مرجع معتمد لنفس المكوّن والتركيز، والموديل اتفق عليها ٣ من ٣.
 تغييرها لـ ١٠ مل هيخلي الحقل provenance=manual وهيحتاج توقيعك. أكمّل؟"
```

**ده مش شات بيطبّق أوامر — ده مراجع بيشتغل معاك.**

---

## ١٢. الاعتماد والدولاب

### ١٢.١ نقطة الاعتماد

```
POST /labels/:id/approve
{
  expectedVersion: 4,
  signedEstimatedFields: ["directionOfUse"],
  acknowledgedUnverifiable: [],
  scope: "company",                 // "company" (افتراضي) | "global"
  note: "روجعت مقابل ملف تسجيل المنتج"
}
```

الاعتماد **مش زرار بيغيّر حالة** — ده **توقيع بشري على مخرج منظّم**، بيتسجّل في `LabelApproval` (§5.5).

> **ليه `labelSnapshot` نسخة كاملة مش مرجع؟** بعد سنة، لو حد سأل "على إيه بالظبط وقّع فلان؟" — لازم تجاوب من غير ما تعيد بناء الحالة. الاعتماد مستند مستقل بذاته.

### ١٢.٢ ست بوابات قبل الحفظ

```js
async function assertApprovable(label, body, actor) {
  const report = await latestReport(label.id);

  // ١ — التقرير للنسخة الحالية بالظبط
  if (report.versionNumber !== label.currentVersion)
    throw new AppError("التحقق قديم — أعد التحقق قبل الاعتماد.", 409);

  // ٢ — مفيش FAIL. نهائي.
  if (!report.passed)
    throw new AppError("لا يمكن اعتماد ليبل فيه أخطاء تحقق.", 422);

  // ٣ — كل UNVERIFIABLE مُقَر به صراحةً
  const unack = report.verdicts.filter(v => v.status === "UNVERIFIABLE")
    .filter(v => !body.acknowledgedUnverifiable?.includes(v.path));
  if (unack.length) throw new AppError(`أحكام غير متحقق منها بلا إقرار: ${unack.map(v=>v.path).join(", ")}`, 422);

  // ٤ — كل حقل مُقدَّر عليه توقيع
  const unsigned = label.labelData.estimatedFields
    .filter(f => !body.signedEstimatedFields?.includes(f));
  if (unsigned.length) throw new AppError(`حقول مُقدَّرة بلا توقيع: ${unsigned.join(", ")}`, 422);

  // ٥ — فصل المهام
  if (label.riskScore > 50 && actor.id === label.createdByUserId)
    throw new AppError("مخاطر عالية: لا يمكن اعتماد ليبل أنشأته بنفسك.", 403);
  if (label.autonomyTier === "dual" && !body.secondApproverUserId)
    throw new AppError("هذا الليبل يتطلب مراجعَين مستقلَّين.", 422);

  // ٦ — القواعد من مستند معتمد بتغطية كافية
  const docs = await docsFor(report.rulesetIds);
  const weak = docs.filter(d => d.status !== "approved" || (d.coveragePercent ?? 0) < 95);
  if (weak.length) throw new AppError(`تحقق مبني على مستندات ضعيفة: ${weak.map(d=>d.title).join(", ")}`, 422);
}
```

### ١٢.٣ الحفظ — معاملة واحدة

```js
export const approveLabel = async (labelId, body, actor) =>
  prisma.$transaction(async (tx) => {
    const label = await tx.generatedLabel.findUniqueOrThrow({ where: { id: labelId } });
    if (label.currentVersion !== body.expectedVersion) throw new AppError("النسخة تغيّرت.", 409);
    await assertApprovable(label, body, actor);

    const approval = await tx.labelApproval.create({ data: { /* §5.5 */ } });
    await tx.generatedLabel.update({ where: { id: labelId }, data: { status: "approved" } });
    const reference = await promoteToReference(tx, label, approval, body.scope);
    await tx.labelApproval.update({ where: { id: approval.id }, data: { promotedReferenceId: reference.id } });

    return { approval, reference };
  });
```

**الترقية:**

```js
async function promoteToReference(tx, label, approval, scope) {
  const d = label.labelData;

  // إزالة التكرار: نفس المكوّنات + التركيز + الشكل + الأنواع + الدولة
  const fingerprint = sha256([
    d.activeIngredients.map(i => `${i.normalizedName}:${i.amount}`).sort().join("|"),
    d.pharmaceuticalForm?.translations?.en ?? "",
    d.targetAnimalSpecies.list.slice().sort().join(","),
    label.country,
  ].join("::"));

  const existing = await tx.referenceLabel.findFirst({
    where: { fingerprint, companyId: label.companyId, isApproved: true },
  });
  if (existing) await tx.referenceLabel.update({ where: { id: existing.id }, data: { isApproved: false } });

  return tx.referenceLabel.create({ data: {
    name: `${d.productName.translations[d.productName.primary]} — معتمد ${approval.approvedAt.toISOString().slice(0,10)}`,
    sourceType: "approved_output",
    originLabelId: label.id,
    approvalId: approval.id,
    qualityWeight: 1.0,
    isApproved: true,
    fingerprint,

    // 🔒 النطاق: الشركة افتراضياً
    companyId: scope === "global" ? null : label.companyId,
    brandId: label.brandId ?? null,
    country: label.country,

    // ── مهيكل بالكامل — صفر استخراج AI
    fullText: renderPlainText(d),
    extractedData: d,
    activeIngredients: d.activeIngredients,
    targetSpecies: d.targetAnimalSpecies.list,
    dosageForm: d.pharmaceuticalForm?.translations?.en ?? null,
    routeOfAdministration: d.routeOfAdministration?.translations?.en ?? null,
    strengthSummary: d.strength?.translations?.en ?? null,
    indicationTags: extractIndicationTags(d),
    productType: d.productType,
    embedding: await embed(d),
  }});
}
```

> 🔒 **`scope: "global"` صلاحية منفصلة (`publish_global_reference`).** الافتراضي **دايماً** شركة. الترقية العامة تلقائياً **بترجّع تسريب البيانات من الباب الخلفي** — نفس عيب G5.

### ١٢.٤ الاستعمال بعد كده

```
finalScore = similarityScore × qualityWeight

مُخرَج معتمد   1.0   ← اتراجع، اتوقّع عليه، اتشحن
مرفوع          0.7   ← معتمد برّه، استخراجه ممكن يكون ناقص
مُدخل يدوياً   0.5   ← نص حر، أقل ثقة
```

وبيدخل مسار **الأنواع المستهدفة الحتمي** — الليبل الجاي لنفس المكوّن هياخد الأنواع من ليبل **انت** اعتمدته، مش من استنتاج.

**ليه ده أقوى مما يبدو:**
١. صفر تكلفة استخراج — مهيكل أصلاً
٢. جودة معروفة — بني آدم وقّع
٣. مركّب — الليبل رقم ١٠٠ بمراجع أحسن من رقم ١
٤. متوافق تنظيمياً — عدّى القواعد المعتمدة
٥. بيتعلم أسلوب العميل — بعد ٢٠ ليبل بيبقى عارف صياغتهم

### ١٢.٥ السحب

```
POST /labels/:id/approvals/:approvalId/revoke   { reason }
  → approval.revokedAt / revokedByUserId / revocationReason
  → label.status = "revoked"
  → المرجع المرقّى: isApproved = false  (مش delete — التاريخ يفضل)
  → استعلم رسم النسب:
        SELECT labelId FROM label_provenance WHERE sourceRef->>'id' = :referenceId
  → كل الليبلات دي: needsReview = true
  → إشعار للمراجعين بقايمة المتأثرين
```

**السحب لازم يكون بنفس قوة الاعتماد.** ليبل غلط اتعتمد وبقى مرجع **بيسمّم كل اللي بعده**.

### ١٢.٦ لوحة الأثر

```
مراجع من مخرجات معتمدة:        47 / 112  (42%)
ليبلات اتولدت بمرجع معتمد:     73%
متوسط درجة التطابق:            0.61 → 0.88   ⬆
حقول مُقدَّرة لكل ليبل:          4.2 → 1.1     ⬇
معدّل النجاح من أول مرة:        38% → 79%     ⬆
```

**لو مش بتتحسن، الدولاب مش شغال** — وده سؤال يستاهل تحقيق.

---

## ١٣. النسخ والاستعادة

- **v1** = التوليد الأصلي. append-only للأبد
- كل تغيير = نسخة كاملة جديدة (مش deltas — التخزين رخيص والتدقيق أهم)
- الـ `diff` محسوب في الكود: `[{ path, op, before, after }]`
- كل نسخة بتحمل: `changeSource`, `changedByUserId`, `changeSummary`, `createdAt`, `validationReportId`, `overrideAcknowledged`
- **الاستعادة أمامية فقط:** استعادة `K` بتعمل `N+1` بمحتوى `K`, `changeSource="restore"`, `restoredFrom=K`
- ✅ **ومعاها تحقق جديد** — القواعد ممكن تكون اتغيرت من وقت `K`
- `GET /labels/:id/versions/:a/diff/:b` للمقارنة

---

## ١٤. طبقة الضمان

### ١٤.١ التدقيق المضاد

```
labelData ──┬──▶ المحرك الحتمي (طبقات ١-٤)  ──▶ verdicts_deterministic
            └──▶ المدقق المضاد (عائلة مختلفة) ──▶ verdicts_auditor
                    │ بياخد: labelData + القواعد + حقائق المنتج
                    │ مابياخدش: برومبت المولّد، تفكيره، المراجع اللي شافها
                    │ مهمته: "لاقي سبب يخلي الليبل ده يفشل"
                    ▼
            اتفقوا PASS → PASS · اتفقوا FAIL → FAIL · اختلفوا → ESCALATE 🔺
```

**الاختلاف مش فشل — ده أثمن إشارة في النظام.** كل اختلاف اتحل لصالح المدقق = **قاعدة كانت ناقصة** → `AuditDisagreement.becameRuleId`.

### ١٤.٢ الاتساق الذاتي

للحقول الرقمية الخطرة: **ولّد ٣ مرات** بحرارة ٠٫٦ وترتيب سياق مختلف.

```
اتفقوا  → ثقة عالية → عدّي
اختلفوا → الموديل بيخمّن → BLOCK + اعرض التلاتة على المراجع
```

```js
const AGREEMENT = {
  numeric:     (v) => spread(v) <= 0.05,
  set:         (v) => jaccard(v) >= 0.9,
  categorical: (v) => new Set(v).size === 1,
};
```

ينطبق على: `directionOfUse` (أرقام)، `analysis.items[].value`، `strength`، وأي حقل موسوم `external`.
**مش على:** الحقول المؤكدة، ولا النصوص الوصفية.

> ⚠️ **حد الطريقة:** ده بيقيس **الثقة** مش **الصح**. موديل واثق وغلطان بيتفق مع نفسه ٣ من ٣. بيمسك عدم اليقين، **مابيمسكش الخطأ المنهجي**.

### ١٤.٣ المجموعة الذهبية

**٣٠ ليبل حقيقي معتمد** إنت متأكد منهم. سجّل مدخلاتهم. شغّل الـ pipeline. قيس **حقل بحقل**.

```
golden/
├── 001-amoxicillin-poultry-eg/
│   ├── input.json        // بالظبط اللي المستخدم كان هيكتبه
│   ├── expected.json     // الليبل المعتمد الحقيقي
│   └── tolerances.json   // إيه اللي يعتبر صح (مرادفات، صيغ)
└── ...×30
```

```
$ npm run eval:golden

  الحقل                     دقيقة   جزئية   غلط   ن/م
  ──────────────────────────────────────────────────
  targetAnimalSpecies         27      1      2     0     90%   ⚠️
  directionOfUse              19      8      3     0     63%   🔴
  withdrawalPeriod            22      0      1     7     96%
  ──────────────────────────────────────────────────
  دقة إجمالية:  91.2%    الأساس: 89.7%   (+1.5 ✅)
```

**قواعد غير قابلة للتفاوض:**
١. أي تغيير في برومبت/موديل/قاعدة **لازم** يشغّلها
٢. **انحدار > ٢٪ في أي حقل = المنع**
٣. الـ CI بيشغّلها ليلياً على الـ Batch API
٤. أي فشل حقيقي في الإنتاج بيتضاف للمجموعة

> ⚠️ **حدودها:** لو اعتماداتك التاريخية كانت متضاربة، أرض الحقيقة مشوّشة. و٣٠ عيّنة **رفيعة إحصائياً** — عتبة ٢٪ على ٣٠ جوه الضوضاء لبعض الحقول. برغم كده: **من غيرها كل كلام عن تحسّن تخمين.**

### ١٤.٤ رسم النسب

```jsonc
{
  "targetAnimalSpecies.list": {
    "value": ["Poultry","Calves"], "tier": 1, "provenance": "confirmed",
    "sourceRef": { "kind": "product_row", "id": "prod_abc", "field": "targetSpecies" },
    "at": "2026-08-27T09:14:22Z"
  },
  "directionOfUse.translations.en": {
    "value": "1 g per 10 kg body weight, in drinking water for 5 days",
    "tier": 4, "provenance": "reference",
    "sourceRef": { "kind": "reference_label", "id": "ref_xyz", "matchTier": "exact_combo", "score": 0.94 },
    "modelId": "gemini-3.7-flash", "promptHash": "sha256:9f2c…",
    "selfConsistency": { "runs": 3, "agreed": true },
    "at": "2026-08-27T09:14:31Z"
  }
}
```

**اللي بيتيحه:** المستخدم يدوس على حقل يشوف إزاي وصل · المفتش يطلب مصدر أي جملة → عندك إجابة · مرجع اتبيّن غلط → تعرف **بالظبط** أنهي ليبلات اتأثرت (§12.5) · إحصائيات: "٤٠٪ من حقول الجرعة Tier 5" → أولوية شغل.

### ١٤.٥ وضع الظل

```
                    ┌──▶ المسار القديم ──▶ للمستخدم ✅
طلب توليد ──────────┤
                    └──▶ المسار الجديد ──▶ ShadowComparison 📊
```

| البوابة | الشرط |
|---|---|
| ١ | ١٠٠ توليد في الظل بلا أعطال |
| ٢ | تطابق الأحكام ≥ ٩٥٪ (والاختلافات مراجَعة) |
| ٣ | دقة المجموعة الذهبية ≥ الأساس |
| ٤ | زمن p95 داخل الميزانية |

**الرجوع = تبديل feature flag، مش rollback نشر.**

### ١٤.٦ الاستقلالية المتدرجة بالمخاطر

```js
function riskScore(label, report, doc) {
  let r = 0;
  if (label.targetAnimalSpecies.list.some(isFoodProducing))     r += 30;
  if (isAntimicrobial(label.activeIngredients))                 r += 25;
  if (label.productType === "veterinary_drug")                  r += 15;
  if (report.verdicts.some(v => v.status === "UNVERIFIABLE"))   r += 20;
  r += 10 * label.estimatedFields.length;
  if (hasExternalProvenance(label, HIGH_RISK_FIELDS))           r += 25;
  if ((doc?.coveragePercent ?? 100) < 95)                       r += 15;
  if (report.disagreementCount > 0)                             r += 20;
  return Math.min(r, 100);
}
```

| المخاطر | الاستقلالية | المراجعة |
|---|---|---|
| **٠–٢٠** 🟢 | اعتماد تلقائي | تسجيل + عيّنة ٥٪ |
| **٢١–٥٠** 🟡 | مراجعة دفعية | ١٠ مع بعض |
| **٥١–٧٥** 🟠 | مراجعة إلزامية | حقل بحقل، توقيع بالاسم |
| **٧٦–١٠٠** 🔴 | مراجعة مزدوجة | مراجعان مستقلان |

**صندوق واحد** مرتّب تنازلياً. تصميم بيفترض مراجع يفحص كل حاجة = تصميم بيتجاهل.

### ١٤.٧ إعادة التشغيل الحتمية

```js
generationMeta: {
  modelId, thinkingLevel, temperature, promptHash,
  schemaVersion, engineVersion,
  rulesetSnapshot: ["rule_a@v3","rule_b@v1"],
  referenceSnapshot: ["ref_x@2026-07-01"],
  cachedTokens, usage: { input, output, thinking }, latencyMs,
}
```

```
POST /labels/:id/replay
→ متطابق؟ ✅ النظام حتمي كما هو مُدّعى
→ مختلف؟  🔺 انجراف موديل — أخطر عطل صامت في أنظمة AI الإنتاجية
```

شغّله أسبوعياً على عيّنة.

---

## ١٥. واجهة الـ API

```
# التوليد
POST   /labels/generate            { productId? | formulationText, country, language, hints? }
                                   → 202 { taskId, labelId }
GET    /labels                     قائمة مقيّدة بالمستأجر
GET    /labels/:id                 { label, currentVersion, latestValidation, provenance }
DELETE /labels/:id                 أرشفة

# التحقق
POST   /labels/:id/validate        إعادة تشغيل المحرك → ValidationReport
GET    /labels/:id/validation      آخر تقرير
POST   /labels/:id/replay          §14.7

# الشات والتعديل
POST   /labels/:id/chat            { message, expectedVersion } → answer | applied | conflict
GET    /labels/:id/chat            تاريخ المحادثة
PATCH  /labels/:id                 { changes[], expectedVersion } — تعديل مباشر بلا AI

# النسخ
GET    /labels/:id/versions
GET    /labels/:id/versions/:n
POST   /labels/:id/versions/:n/restore
GET    /labels/:id/versions/:a/diff/:b

# الاعتماد والدولاب
POST   /labels/:id/approve                        §12.1
GET    /labels/:id/approvals
POST   /labels/:id/approvals/:approvalId/revoke   §12.5

# التنظيم — رحلة الاستيعاب (§7.4)
GET    /regulatory-documents                filters: country, authority, status
POST   /regulatory-documents                رفع PDF/DOCX → 202 { taskId, documentId }
GET    /regulatory-documents/:id            النص، الهاش، المصدر، الإصدار، التغطية
POST   /regulatory-documents/:id/compile-rules   → RegulatoryRule[] (pending_review)
POST   /regulatory-documents/:id/audit-coverage  → §7.5
POST   /regulatory-documents/:id/approve         ← البوابة
POST   /regulatory-documents/:id/supersede       { newDocumentId }
GET    /regulatory-rules                    filters: documentId, ruleType, severity, status
PATCH  /regulatory-rules/:id                تعديل قبل الاعتماد
PATCH  /regulatory-rules/:id/approve
POST   /regulatory-rules/preview            { labelId } → أي قواعد هتشتغل، تجريبي

# المعرفة الخارجية (§8.2)
GET    /knowledge                  filters: kind, status, confidence
GET    /knowledge/:id              payload + citations + sourceUrls
PATCH  /knowledge/:id/approve
DELETE /knowledge/:id              إبطال

# المراجع — الموجود + إضافة
GET    /reference-labels/match     debug: profile → مرشحين مرتّبين + الدرجات + الـ tier

# الضمان
GET    /assurance/disagreements    §14.1
GET    /assurance/golden-runs      §14.3
GET    /assurance/shadow           §14.5
GET    /review-inbox               §14.6 — الصندوق الواحد، مرتّب بالمخاطر
```

**الأعراف:** كل مسار جديد بـ `protect` + `restrictToPermission`. صلاحيات جديدة في `prisma/seed.js`:
`read_labels`, `create_labels`, `update_labels`, `delete_labels`, `approve_labels`,
`approve_regulatory`, `publish_global_reference`, `read_assurance`.

---
---

# الجزء الثالث — التنفيذ

## ١٦. المراحل

| المرحلة | المحتوى | مدة | ليه بالترتيب ده |
|---|---|---|---|
| **0** | 🔴 قفل تسريب المستأجرين · **هجرة `@google/genai`** · `modelRegistry.js` · إصلاح `title` · إصلاح `currentModel` · إصلاح `routeOfAdmin` · `temperature` صريحة | ١ يوم | التسريب مش مستني خطة |
| **0.5** | 🔥 **المجموعة الذهبية أولاً** — ٣٠ ليبل + harness + **قياس النظام الحالي** كأساس | ٢ يوم | من غير أساس مسجّل، كل تحسين ادعاء |
| **1** | الحفظ: `GeneratedLabel` + `LabelVersion` + `ValidationReport` + `LabelChatMessage` + `labelProvenance` + `versionService` | ٣ يوم | بيفك الحظر عن كل حاجة |
| **2** | `labelSchema` (بـ `translations{}`) + `fieldCatalog` + `geminiSchema` مشتق + المحرك الحتمي (طبقات ١–٤) + **توحيد المحركين** + 🔥 مسح Steps 3.5/3.6 | ٤ يوم | الأساس |
| **3** | `RegulatoryDocument` + `RegulatoryRule` + **رحلة الاستيعاب ٧ خطوات** + **مدقق التغطية** + شغّلها على مستند الهيئة الحقيقي | ٣ يوم | القواعد قبل الاعتماد على القواعد |
| **4** | `productProfile` (بيقرا صف Product) + **سُلّم المنتج** + `ExternalKnowledgeCache` + الترتيب بالأوزان + `contextBuilder` + `labelGenerator` مقيّد + التخزين المؤقت + 🔥 مسح "standard veterinary knowledge" | ٤ يوم | جودة المحتوى |
| **5** | **التدقيق المضاد + الاتساق الذاتي + `riskScorer` + صندوق المراجعة** | ٣ يوم | طبقة الضمان |
| **6** | الشات كوكيل بأدوات + `patchProtocol` + كشف التعارض + الاستعادة | ٤ يوم | تجربة المستخدم |
| **7** | **الاعتماد + `LabelApproval` + الترقية + السحب (الدولاب)** | ٢ يوم | متوقف على ٢ و٥ |
| **8** | **وضع الظل → الترقية بالبوابات** | ٢ يوم | تبديل آمن |
| **9** | إعادة التشغيل الحتمية + الـ Batch + pgvector (لو مبرر) | ٢ يوم | التركيب |

**~٣٠ يوم عمل.**

> 🔥 **أهم تغيير في الترتيب: 0.5.** قِس **قبل** ما تغيّر. يومين هنا بيوفروا أسابيع تخمين.
>
> ⚠️ **قبل المرحلة ٤:** عُدّ مراجعك. أقل من ٣٠؟ اشطب الترتيب بالأوزان و pgvector — دول حل لمشكلة مش موجودة عندك.

## ١٧. مصفوفة الاختبارات

`tests/` بيستخدم runner مخصص (`tests/runAll.js`). **التزم بالنمط — متضيفش Jest.**

| # | الملف | يثبت |
|---|---|---|
| T1 | `label.targetAnimals.test.js` | `Product.targetSpecies` → `labelData.targetAnimalSpecies.list`؛ متخزّن؛ يرجع من API؛ يتعدّل بالشات؛ `source` صح |
| T2 | `label.validation.missing.test.js` | بلا target animals → `FAIL` بـ ruleKey + citation؛ `passed=false` |
| T3 | `label.validation.conditional.test.js` | أنواع غذائية → `withdrawalPeriod` مطلوب؛ غير غذائية → `NOT_APPLICABLE` |
| T4 | `label.retrieval.test.js` | نفس المكوّن+التركيز يترتب فوق؛ **مراجع مستأجر تاني مستبعدة**؛ الـ tier صح |
| T5 | `label.generation.schema.test.js` | المخرج يعدّي Zod؛ مفيش `"x"`؛ كل الترجمات المطلوبة موجودة |
| T6 | `label.chat.edit.test.js` | "أضف أبقار وأغنام" → patch → مطبّق → نسخة جديدة → إعادة تحقق |
| T7 | `label.chat.conflict.test.js` | تعديل بيسبب مخالفة → conflict مرجّع؛ **الليبل مش متغيّر** |
| T8 | `label.versioning.test.js` | v1 محفوظة؛ restore بيعمل N+1؛ diff صح؛ مفيش مسح؛ إعادة تحقق بعد الاستعادة |
| T9 | `regulatory.resolution.test.js` | DB أولاً؛ مصدر غير رسمي مرفوض؛ مفيش قواعد → `UNVERIFIABLE` مش `PASS` |
| T10 | `label.determinism.test.js` | نفس المدخل + نفس القواعد → verdicts متطابقة (طبقات ١–٤) |
| T11 | `regulatory.ingestion.test.js` | مستند → قواعد؛ بلا citation مرفوضة؛ targetPath مجهول مرفوض؛ نفس الهاش → توقف؛ **بلا اعتماد مفيش PASS** |
| T12 | `regulatory.coverage.test.js` | التغطية محسوبة؛ **< 95% يمنع الاعتماد**؛ الفقرات غير المغطاة معروضة |
| T13 | `product.notfound.test.js` | بلا `productId` وبلا مرجع → وسم `external`/`unknown`؛ مصدر خارج allowlist مرفوض؛ **`withdrawalPeriod` مايتملاش أبداً** → `FAIL` |
| T14 | `knowledge.cache.test.js` | نفس `lookupKey` مابيبحثش تاني؛ منتهي يتجدد؛ حذف يبطّل |
| T15 | `label.approval.test.js` | البوابات الست؛ تقرير قديم → 409؛ حقل مُقدَّر بلا توقيع → 422؛ فصل المهام؛ **الترقية company-scoped بالافتراضي** |
| T16 | `label.revocation.test.js` | السحب يعطّل المرجع؛ الليبلات المتأثرة `needsReview`؛ مفيش حذف |
| T17 | `assurance.audit.test.js` | المدقق مابيشوفش سياق المولّد؛ الاختلاف بيتسجّل مش بيتبلع |
| T18 | `label.e2e.test.js` | product → generate → validate → chat edit → re-validate → restore → approve → المرجع موجود |

## ١٨. البرومبت الرئيسي

```
You are building the Mostanad veterinary/feed label engine at D:\turk\mostanad.
Node 20 ESM · Express 5 · Prisma 7 + PostgreSQL · BullMQ + Redis · Socket.IO ·
Gemini via @google/genai · Zod 4. Backend only — no UI in this repo.

MOSTANAD_ARCHITECTURE.md is the single source of truth. Any earlier plan file
(MOSTANAD_LABEL_ENGINE_PLAN.md, MOSTANAD_ARCHITECTURE_V2.md) is obsolete and
must be deleted, not consulted.

═══════════════════════════════════════════════════════════════════
THE ONE PRINCIPLE
═══════════════════════════════════════════════════════════════════
Every claim the system emits must be TRACEABLE to a source, REPRODUCIBLE from
stored inputs, and MEASURABLE against a golden set. Anything failing all three
is technical debt, not a feature.

═══════════════════════════════════════════════════════════════════
NON-NEGOTIABLE INVARIANTS
═══════════════════════════════════════════════════════════════════
1.  Generation writes content, never a verdict. Validation writes verdicts,
    never content.
2.  Reference match tier is computed in CODE and stated in the prompt. The model
    never decides how much to trust a reference. Similarity is never evidence
    of regulatory compliance.
3.  Every field value carries provenance: tier, source, citation, modelId,
    promptHash, timestamp. No untraceable values.
4.  A regulatory rule whose citation is not verifiable verbatim in its source
    document is REJECTED — not warned, not downgraded.
5.  withdrawalPeriod, strength, ingredient amounts and registrationNumber may
    NEVER be filled from external lookup or model knowledge. Confirmed source
    or matched reference, or they stay empty and FAIL. Refusing beats guessing.
6.  UNVERIFIABLE is a first-class verdict. Never coerced to PASS.
7.  No empty catch blocks in the label pipeline.
8.  Regulatory requirements live in the database, never hardcoded in prompts.
9.  Model IDs live in exactly one file: src/services/ai/modelRegistry.js.
10. Every reference-label query is tenant-scoped:
    where: { OR: [{ companyId }, { companyId: null }] } — always.
11. A regulatory document may not be approved with coveragePercent < 95%
    unless every uncovered clause was explicitly classified by a human as
    non-normative.
12. Approval is a human signature on regulated output, not a status toggle.
    It records who signed, which version, which estimated fields they signed
    for, which UNVERIFIABLE verdicts they acknowledged, and a frozen snapshot.
13. A promoted approved label is company-scoped by default. Making one global
    is a separate action behind a separate permission — defaulting to global
    reintroduces the cross-tenant leak through the back door.
14. A golden-set regression greater than 2% on any field BLOCKS the change.

═══════════════════════════════════════════════════════════════════
GEMINI PLATFORM — USE IT PROPERLY (§9)
═══════════════════════════════════════════════════════════════════
· Migrate off deprecated @google/generative-ai to @google/genai FIRST.
· Thinking levels: minimal for mechanical extraction, high for rule
  compilation, generation and auditing. Never leave it at the default.
· Long context: feed WHOLE regulatory documents. Never chunk them —
  conditional clauses and cross-references break when chunked.
· Implicit caching: order every prompt
  [regulatory rules] → [schema] → [references] → [product data].
  Record usage.total_cached_tokens; a zero means the ordering is wrong.
· Batch API (50% cost) for all non-interactive work.
· Grounding: verify url_citation host against the allowlist and slice the
  quoted text via start_index/end_index. A claim whose annotation fails that
  check is discarded.
· Feed PDFs and label images natively. pdf-parse destroys the tables that
  carry withdrawal periods and species matrices.
· Generator and auditor MUST be different model families.

═══════════════════════════════════════════════════════════════════
BUILD ORDER — DO NOT REORDER
═══════════════════════════════════════════════════════════════════
Phase 0    Tenant-leak fix + SDK migration + modelRegistry + defect fixes
Phase 0.5  GOLDEN SET FIRST. 30 real approved labels, an eval harness, and a
           recorded baseline of the CURRENT system, before changing generation
           behaviour. Highest-leverage two days in the project.
Phase 1-9  As specified in §16.

═══════════════════════════════════════════════════════════════════
DEFINITION OF DONE — PER PHASE
═══════════════════════════════════════════════════════════════════
· Migration applies cleanly over existing production data; additive only
· node tests/runAll.js passes; new tests in the existing runner style, no Jest
· Golden set run, accuracy reported, no field regressed more than 2%
· Every new field traced end to end:
  input → profile → prompt → responseSchema → labelData → column → provenance
  → API → validation rule → patch allowlist → chat tool
  A field present in only some of those is the bug class that caused the
  Target Animals gap.
· Report: what changed, what you verified, what you deferred, and anything you
  found that contradicts this document.

Start with Phase 0. Show me the tenant-scoping fix and the @google/genai
migration diff before touching anything else.
```

## ١٩. برومبت لكل مرحلة

### Phase 0
```
Execute Phase 0 only. No migrations, no new behaviour.
1. 🔴 labelGeneratorWorker.js:142 — add tenant scoping and DB-side filtering:
   where { isApproved:true, OR:[{companyId},{companyId:null}], productType }, take 200.
   companyId is not currently in the job payload — add it at
   referenceLabelController.generateLabelAi and thread it through. This closes
   a live cross-tenant data leak. Treat as urgent.
2. Migrate @google/generative-ai → @google/genai across geminiClient.js,
   labelService.js, labelGeneratorWorker.js, referenceLabelWorker.js,
   edaRequirementWorker.js, productAiWorker.js, pipeline.js.
3. Create src/services/ai/modelRegistry.js as the ONLY place model IDs appear.
4. edaRequirementService.processAndCreate writes `title:` to a column that
   exists in no migration. Confirm against every migration, then remove the
   dead function or make it correct. State which and why.
5. geminiClient.js:23-26 — currentModel is computed then discarded. Make the
   fallback take effect or remove it. No dead code.
6. labelService.js:399 — remove the dbProduct.routeOfAdmin reference (the
   column arrives in a later migration).
7. Set explicit temperature and thinking level on every Gemini call.
Run node tests/runAll.js. Show the diff and confirm each fix.
```

### Phase 0.5
```
Execute Phase 0.5: the golden set. Do NOT change generation behaviour.
Create golden/ with 30 cases, each: input.json (exactly what a user would
submit), expected.json (the real approved label), tolerances.json (synonyms
and acceptable format variants per field).
Build scripts/evalGolden.js + an `eval:golden` npm script that runs every case
through the CURRENT pipeline and scores field by field:
exact / partial / wrong / not-applicable, per field and overall.
Persist each run to GoldenEvalRun. Print the table and the delta vs baseline.
Record today's numbers as the baseline. That baseline is the reference point
for every later phase — without it, no later improvement claim is measurable.
I will supply the 30 labels; ask me for them.
```

### Phase 1
```
Execute Phase 1: persistence foundation.
Add GeneratedLabel, LabelVersion, ValidationReport, LabelChatMessage exactly as
in §5.1-5.4, plus labelProvenance (§14.4) and the Product columns in §5.10.
Additive migrations in the order given in §5.12.
Create versioning/versionService.js: createInitial, createVersion(labelId,
labelData, meta), diff(a,b), restore(labelId, n). Restore is forward-only:
version K restored becomes version N+1.
Rewrite labelGeneratorWorker to persist into GeneratedLabel + LabelVersion v1
plus a provenance entry per field. Keep BackgroundTask for progress — the
frontend polls it. The worker returns { taskId, labelId }.
Add GET /labels, GET /labels/:id, GET /labels/:id/versions with protect +
restrictToPermission; seed the new permissions in prisma/seed.js.
Exit criteria: every generated label has a stable ID, an append-only version
history, and targetAnimalSpecies stored in a real persisted structure.
```

### Phase 2
```
Execute Phase 2: schema + deterministic validation + engine unification.
Build schema/{labelSchema.js, geminiSchema.js, fieldCatalog.js} per §6.
labelSchema is the single source of truth; geminiSchema DERIVES the Gemini
responseSchema programmatically — if you type the field list twice, stop and
fix the derivation. Use LocalizedText (§6.2), not a two-language pair.
Build validation/{validationEngine, schemaValidator, ruleValidator,
coherenceValidator} implementing layers 1-4 (§10.1) emitting FieldVerdict[]
exactly as shaped in §10.2.
Convert labelService.verifyProductLabel into labelExtractor — extraction only,
no judgements — and route it through the same validationEngine (§4.2).
Delete Steps 3.5 and 3.6 from labelGeneratorWorker.
Add POST /labels/:id/validate, GET /labels/:id/validation.
Add the determinism test (T10) proving layers 1-4 are reproducible.
Run the golden set; report the delta.
```

### Phase 3
```
Execute Phase 3: regulatory ingestion + coverage auditing.
Add RegulatoryDocument + RegulatoryRule per §5.6-5.7 (rename eda_requirements,
keep a service shim so existing callers keep working).
Implement the seven-step ingestion journey in §7.4, extending
edaRequirementWorker: feed the PDF to the model natively, store real text plus
documentHash, refuse a duplicate hash.
Implement ruleCompiler: whole document in context, no chunking, high thinking,
strict responseSchema, and REJECT any rule whose citation cannot be found
verbatim in the source text or whose targetPath is not in labelSchema.
Implement coverageAuditor (§7.5): the reverse pass, clause accounting, and the
hard gate blocking approval below 95%.
Add the review and approval endpoints from §15.
Run the whole journey on the customer's REAL authority document for ONE
country — not a web search. Report the coverage number.
```

### Phase 4
```
Execute Phase 4: retrieval, product ladder, structured generation.
FIRST: report how many reference labels exist and inspect five extractedData
records. If there are fewer than 30 and extraction quality is poor, say so and
recommend cutting the weighted-scoring and pgvector work — do not build a
retrieval layer for a problem that does not exist at this data scale.
Add the ReferenceLabel structured columns (§5.9) and
scripts/backfillReferenceAttributes.js — from existing extractedData, no AI
calls, idempotent.
Build retrieval/{productProfile, similarity, referenceSelector} per §8.
productProfile MUST read the Product row when productId is supplied and merge
Product.targetSpecies / activeIngredients / routeOfAdmin / dosageForm as
higher-confidence facts than anything inferred from free text.
Build the product resolution ladder (§8.2) + ExternalKnowledgeCache (§5.8) +
authoritativeSources, enforcing the absolute exclusions.
Delete "determine your best answer using standard veterinary knowledge" from
labelGeneratorWorker.js:338 and :343.
Build generation/{contextBuilder, labelGenerator} per §9.9, with the caching
prompt order (§9.7) and usageMetadata recorded.
Confirm targetAnimalSpecies now flows Product → profile → prompt →
responseSchema → labelData → column → provenance → API. Run the golden set.
```

### Phase 5
```
Execute Phase 5: the assurance layer.
Build validation/adversarialAuditor.js (§14.1). The auditor receives ONLY
labelData + the applicable rules + product facts. It must NOT receive the
generator's prompt, its reasoning, or the references it saw. Different model
family from the generator. Persist every disagreement to AuditDisagreement —
never silently resolve one.
Build validation/selfConsistency.js (§14.2) for the high-risk numeric fields
only, with the agreement predicates given. Divergence blocks the field and
surfaces all runs to the reviewer.
Build assurance/riskScorer.js (§14.6) and the single risk-ranked review inbox
at GET /review-inbox. Four queues become one ordered list.
Run the golden set; report whether the auditor caught anything the
deterministic engine missed.
```

### Phase 6
```
Execute Phase 6: chat agent, patches, restore.
Build editing/{patchProtocol, patchApplier, chatAgent} per §11.
The agent gets the eight tools in §11.1. Enforce in the orchestrator that
proposePatch cannot be called before dryRunPatch — a code constraint, not a
prompt request.
Patches address paths, not field names. Every path is validated against
labelSchema; unknown paths are rejected with a clear error, never ignored.
Implement all seven guardrails in §11.4 including the state lock preventing a
chat edit while the label is generating.
Implement conflict detection per §11.4.4 with the three options and the
override audit trail on the version record.
Add the chat, patch, restore and diff endpoints from §15.
Exit criteria: all seven example utterances work end to end — including
"What fields are still missing?" and "Why is this label failing regulatory
validation?" answered from the stored report with citations, producing no
patch and no version bump.
```

### Phase 7
```
Execute Phase 7: approval, promotion, revocation — the flywheel.
Add LabelApproval (§5.5) and the ReferenceLabel flywheel columns (§5.9).
Implement approvalService with all six gates in §12.2 — the stale-report 409,
the unacknowledged-UNVERIFIABLE 422, the unsigned-estimated-field 422, the
separation-of-duties 403, the dual-approver requirement, and the weak-document
refusal.
Implement promoteToReference (§12.3) inside the same transaction, with the
fingerprint dedup and — critically — companyId defaulting to the label's
company. scope:"global" requires the publish_global_reference permission.
Implement revocation (§12.5): deactivate the promoted reference, query the
provenance map for every label that used it, flag them needsReview.
Wire qualityWeight into the ranking (§12.4).
Add the approval endpoints from §15. Tests T15 and T16.
```

### Phases 8-9
```
Phase 8: shadow mode (§14.5). Run both engines, persist ShadowComparison,
implement the four promotion gates and the feature flag. Do not switch until
all four gates pass.
Phase 9: replay (§14.7), Batch API for all non-interactive work (§9.8), and
pgvector ONLY if the Phase 4 reference count justified it.
```

## ٢٠. تدقيق نهائي

قبل ما تقول خلصت، عدّي حقل حقل:

- [ ] كل حقل في `labelSchema` ليه: مسار تخزين، تمثيل API، مدخل نسب، قاعدة تحقق أو `NOT_APPLICABLE` صريحة، ومدخل في قائمة الـ patch
- [ ] مفيش خاصية schema مش بتتولّد ولا بتترندر
- [ ] مفيش حقل API مش مدعوم بداتا متخزنة
- [ ] `targetAnimalSpecies` متتبّع كامل: `Product.targetSpecies` → profile → prompt → responseSchema → `labelData` → عمود → نسب → API → قاعدة → patch path → أداة شات → فرق النسخ
- [ ] كل استعلام `referenceLabel` مقيّد بالمستأجر
- [ ] مفيش نص تنظيمي hardcoded في أي prompt
- [ ] مفيش `catch` فاضية في مسار الليبل
- [ ] `UNVERIFIABLE` بيوصل للمستخدم، مش بيتحول لـ `PASS`
- [ ] كل قاعدة فعّالة من مستند معتمد ومعاها استشهاد متحقق منه
- [ ] مفيش حقل بيتملى من معرفة الموديل الداخلية — إما مصدر مُستشهد أو `null`
- [ ] `withdrawalPeriod` / `strength` / `amount` / `registrationNumber` مستحيل يتملوا من Tier 5 أو 6
- [ ] كل قيمة في `labelData` بتحمل `provenance`
- [ ] الاستعادة بتعمل نسخة جديدة، مابتمسحش، وبتعيد التحقق
- [ ] الترقية بعد الاعتماد **company-scoped بالافتراضي**
- [ ] المجموعة الذهبية شغالة ومفيش حقل انحدر > ٢٪
- [ ] `node tests/runAll.js` أخضر

## ٢١. المصادر

- [What's new in Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5)
- [Gemini API models](https://ai.google.dev/gemini-api/docs/models)
- [Context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Batch API](https://ai.google.dev/gemini-api/docs/batch-api)
- [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)
- [Migrate to the Google GenAI SDK](https://ai.google.dev/gemini-api/docs/migrate)
- [google-gemini/deprecated-generative-ai-js](https://github.com/google-gemini/deprecated-generative-ai-js)
- [Gemini API libraries](https://ai.google.dev/gemini-api/docs/libraries)
