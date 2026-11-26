// The app's flows and the assistant's capabilities, as a static, versioned source the
// assistant reads (help_topics) to answer "how do I…" questions — so the answer is
// grounded on this text, not on the model's memory. Change a flow → change it here and
// bump HELP_VERSION.

export const HELP_VERSION = "2026-11-28";

export const HELP_TOPICS = [
  // 28 Nov (Phase 7): every way to get certificates, not only the invoice path
  {
    key: "certificates_express",
    title: { ar: "الطريقة الأسرع: ارمي الملفات في الشات", en: "Fastest: drop the files in the chat" },
    steps: {
      ar: [
        "ارمي في المحادثة شهادات الشركة القديمة (COA / COC / HC / FSC) ومعاها أي ملفات منتجات: ليبلات، كتالوج، فاتورة، أمر تصنيع — من غير ما تكتب حاجة، أو قول «طلّعلي الشهادات».",
        "النظام بيقرا كل الملفات، ويعرف الشركة والمنتجات، وبيعرض كارت واحد بكل حاجة هتتعمل — دوس الزرار.",
        "الشهادات القديمة بتبقى قوالب لوحدها، وبيتعمل طلب شهادات واحد: كل منتج × كل نوع شهادة، وFSC/HC للمنتجات كلها في شهادة واحدة.",
        "كل اللي في الملفات بيتملى، واللي مش مكتوب في أي ملف بيتستنتج وعليه علامة «مستنتج».",
        "بيانات التشغيلة ونتايج التحليل بس هي اللي ناقصة: بتجيلك في رسالة واحدة، رد في سطر واحد زي «ADDHEPA باتش MADADD2610001 إنتاج 01/10/2026 — pH 6.4 assay 99%».",
        "نزّل ZIP أو PDF واحد من الكارت، أو افتح صفحة الطلب. ملفات تانية في نفس المحادثة بتتضاف لنفس الطلب (قول «طلب جديد» لو عايز طلب لوحده).",
      ],
      en: [
        "Drop the company's old certificates (COA / COC / HC / FSC) in the chat with any product files — labels, catalogue, invoice, manufacturing order — with no text, or say \"make the certificates\".",
        "Every file is read, the company and products recognised, and one card shows what will happen — press its button.",
        "The old certificates become templates and ONE certificate request is made: every product × every type, FSC/HC for all products in one certificate.",
        "Everything the files print is filled; what no file states is estimated and marked «مستنتج».",
        "Only batch data and lab results are missing: one message lists them — answer in one line, e.g. \"ADDHEPA batch MADADD2610001 production 01/10/2026 — pH 6.4 assay 99%\".",
        "Download the ZIP or one PDF from the card, or open the request page. More files in the same chat add to the same request (say \"new request\" for a separate one).",
      ],
    },
  },
  {
    key: "certificates_request",
    title: { ar: "طلب شهادات من أسامي المنتجات (من غير فاتورة)", en: "A certificate request from product names (no invoice)" },
    steps: {
      ar: [
        "من «الشهادات ← طلب جديد» الزق أسامي المنتجات (سطر لكل منتج، والعبوة لو تفرق: «OLIGOVET 1L»)، أو اختارهم من الكتالوج.",
        "كل سطر بيتربط بمنتجه وعبوته؛ لو العبوة مش موجودة دوس «أضف عبوة جديدة لنفس المنتج».",
        "اختار الأنواع (COA, COC, HC, FSC) ودوس «طلّع الشهادات» — بيظهر جدول المنتجات × الشهادات بحالة كل خانة.",
        "تقدر تحدد تاريخ إصدار واحد للطلب كله.",
      ],
      en: [
        "On Certificates → New request paste the product names (one a line, with the pack when it matters: \"OLIGOVET 1L\"), or pick them from the catalogue.",
        "Each line is matched to its product and pack; a pack that doesn't exist yet: «add a new pack of the same product».",
        "Pick the types (COA, COC, HC, FSC) and press Make the certificates — the product × certificate matrix shows each cell's status.",
        "You can set one issue date for the whole request.",
      ],
    },
  },
  {
    key: "certificates_structured",
    title: { ar: "الطريق المنظّم: شركة ← منتجات ← قوالب ← طلبات", en: "The structured path: company → products → templates → requests" },
    steps: {
      ar: [
        "أضف الشركة ومنتجاتها (من ملفات: كتالوج، ليبلات، شيت Excel).",
        "ارفع شهادة قديمة لكل نوع كقالب؛ «اقترح الحقول» ثم «أكّد كل الاقتراحات» — أو «قارن صفحات الملف» لو الملف فيه أكتر من منتج.",
        "فعّل القالب لما يبقى جاهز، وظبّط ترقيم الشهادات من صفحة أنواع الشهادات.",
        "اعمل الطلبات من الأسامي أو من فاتورة.",
      ],
      en: [
        "Add the company and its products (from files: catalogue, labels, an Excel sheet).",
        "Upload one old certificate per type as a template; Suggest fields, then Confirm all suggestions — or Compare the file's pages when the file has several products.",
        "Activate the template once it's ready, and set the certificate numbering on the certificate types page.",
        "Make requests from names or from an invoice.",
      ],
    },
  },
  {
    key: "certificates_after",
    title: { ar: "بعد الشهادات: المصمم، المراجعة، المراجعات، التصدير", en: "After the drafts: designer panel, review, revisions, export" },
    steps: {
      ar: [
        "لوحة المصمم: من خانة المنتج في الطلب — بيانات المنتج بترتيب Illustrator مع زرار نسخ لكل عمود (TSV)، و«ad 1 L» زي ما هي.",
        "المراجعة: ابعت للمراجعة ← عدّت ← اعتمدها. نتيجة برّه المواصفة محتاجة سبب مكتوب قبل الاعتماد.",
        "تعديل شهادة معتمدة بيعمل مراجعة جديدة (Revision 2) والقديمة بتفضل زي ما هي.",
        "التصدير: ZIP فيه كل الشهادات حسب النوع + المانيفست، وPDF واحد بترتيب منتجات العميل.",
      ],
      en: [
        "Designer panel: from a product's cell in the request — the product's data in Illustrator order with a copy button per column (TSV), \"ad 1 L\" kept.",
        "Review: submit → pass → approve. A result outside its specification needs a written reason before approval.",
        "Editing an approved certificate makes a new revision (revision 2); the approved one stays as it was.",
        "Export: a ZIP with every certificate by type + the manifest, and one PDF in the customer's product order.",
      ],
    },
  },
  {
    key: "certificates",
    title: { ar: "إصدار شهادة (COA وغيرها) من فاتورة", en: "Issue a certificate (COA etc.) from an invoice" },
    steps: {
      ar: [
        "ارفع الفاتورة (PDF أو صورة) من صفحة الفواتير أو أرفقها هنا في المحادثة — تُقرأ في الخلفية.",
        "طابق سطور الفاتورة بالمنتجات: بطاقة واحدة لكل السطور (ربط بمنتج / منتج جديد / تجاهل).",
        "أكّد الفاتورة بعد مطابقة كل السطور.",
        "جهّز الشهادات (Prepare): يُكمل البيانات الناقصة ويعرض ما يحتاج تأكيدك.",
        "ارفع شهادة تحليل المورد (Supplier COA) إن وُجدت لتعبئة نتائج المختبر وأرقام التشغيلات.",
        "أصدر الشهادات (Generate) واختر نوعها (مثل COA)؛ تظهر في صفحة الشهادات كمسودات.",
        "راجع كل شهادة واعتمدها نهائياً من صفحتها (Finalize).",
      ],
      en: [
        "Upload the invoice (PDF or image) on the Invoices page, or attach it here in the chat — it is read in the background.",
        "Match the invoice lines to products: one card for all lines (match to a product / new product / ignore).",
        "Confirm the invoice once every line is matched.",
        "Prepare the certificates: missing data is filled where it can be, and what needs your OK is listed.",
        "Upload the supplier COA, if you have one, to fill lab results and batch numbers.",
        "Generate the certificates and pick their type (e.g. COA); they appear on the Certificates page as drafts.",
        "Review each certificate and finalize it on its page.",
      ],
    },
  },
  {
    key: "label_check",
    title: { ar: "فحص ليبل", en: "Check a label" },
    steps: {
      ar: ["أرفق ملف الليبل (PDF أو صورة) واذكر البلد.", "يُقرأ الليبل ويُقارن بقواعد البلد وبيانات المنتج في الخلفية.", "النتيجة: الحكم (مطابق / غير مطابق / يحتاج مراجعة) وأهم الملاحظات ورابط الليبل."],
      en: ["Attach the label file (PDF or image) and say the country.", "The label is read and compared with the country's rules and the product's data in the background.", "Result: the verdict (pass / fail / needs review), the main issues and a link to the label."],
    },
  },
  {
    key: "label_generate",
    title: { ar: "إنشاء محتوى ليبل لمنتج", en: "Generate label content for a product" },
    steps: {
      ar: ["اختر المنتج والبلد (مثل مصر).", "يُولَّد محتوى الليبل من بيانات المنتج وقواعد البلد والمراجع.", "راجع الحقول وعدّلها، ثم شغّل التحقق، ثم الاعتماد."],
      en: ["Pick the product and the country (e.g. Egypt).", "The label content is generated from the product's data, the country's rules and references.", "Review and edit the fields, run validation, then approve."],
    },
  },
  {
    key: "label_resize",
    title: { ar: "تغيير مقاس ليبل", en: "Change a label's size" },
    steps: {
      ar: ["لليبل محفوظ: افتح صفحته ← تبويب «المقاس والتنسيق» واختر المقاس (مثل 10×12 سم).", "لملف ليبل عندك: «رفع ليبل لتغيير مقاسه» — الافتراضي تكبير/تصغير التصميم كما هو؛ أو «إعادة بناء» إذا اخترتها (يُقرأ النص ويُعاد كتابته بدون التصميم الأصلي).", "المعاينة توضّح ما يناسب المقاس وما يحتاج مساحة أكبر؛ ثم احفظ وحمّل PDF."],
      en: ["For a stored label: open it → the Layout & size tab, pick the size (e.g. 10×12 cm).", "For a label file you have: Upload label to resize — by default the design is scaled as it is; choose rebuild only to re-type the text without the original design.", "The preview shows what fits and what needs more room; then save and download the PDF."],
    },
  },
  {
    key: "supplier_coa",
    title: { ar: "رفع شهادة تحليل المورد", en: "Upload a supplier COA" },
    steps: {
      ar: ["يجب أن تكون الفاتورة تحت المراجعة أو مؤكدة.", "أرفق ملف شهادة المورد؛ تُقرأ النتائج لكل تشغيلة.", "يُحفظ فقط ما يطابق رقم تشغيلة على سطور الفاتورة؛ وتُذكر أسباب ما لم يُحفظ."],
      en: ["The invoice must be under review or confirmed.", "Attach the supplier's COA file; its results are read per batch.", "Only values matching a batch number on the invoice lines are kept; the reasons for the rest are listed."],
    },
  },
  {
    key: "catalogue",
    title: { ar: "رفع كتالوج منتجات", en: "Upload a product catalogue" },
    steps: {
      ar: ["ارفع ملف الكتالوج (PDF) واختر صفحاته.", "تُستخرج بيانات المنتجات مع اقتباس من الكتالوج لكل قيمة.", "راجع التغييرات وطبّقها من صفحة الكتالوج."],
      en: ["Upload the catalogue (PDF) and pick its pages.", "Product data is extracted with a quote from the catalogue for each value.", "Review the changes and apply them on the catalogue page."],
    },
  },
  {
    key: "copy_product",
    title: { ar: "نسخ منتج لبراند آخر", en: "Copy a product to another brand" },
    steps: {
      ar: ["افتح المنتج ← «نسخ لبراند آخر» واختر البراند والاسم الجديد.", "تُنسخ بيانات المنتج كلها ما عدا رقم التسجيل (لكل منتج رقمه).", "يمكن لاحقاً «تحديث من المصدر» لحقول تختارها."],
      en: ["Open the product → Copy to another brand, pick the brand and the new name.", "All product data is copied except the registration number (each product needs its own).", "Later, Update from source takes the fields you tick."],
    },
  },
];

/** What the assistant can do, from the tool registry itself (never a hand-written list that drifts). */
export function capabilities(tools) {
  const byModule = {};
  for (const t of tools) (byModule[t.module] ||= { reads: [], changes: [] })[t.risk === "read" ? "reads" : "changes"].push(t.label || t.name);
  return Object.entries(byModule).map(([module, v]) => ({ module, reads: v.reads, changes: v.changes }));
}
