// The app's flows and the assistant's capabilities, as a static, versioned source the
// assistant reads (help_topics) to answer "how do I…" questions — so the answer is
// grounded on this text, not on the model's memory. Change a flow → change it here and
// bump HELP_VERSION.

export const HELP_VERSION = "2026-11-23";

export const HELP_TOPICS = [
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
      ar: ["لليبل محفوظ: افتح صفحته ← تبويب «المقاس والتنسيق» واختر المقاس (مثل 10×12 سم).", "لملف ليبل عندك: «رفع ليبل لتغيير مقاسه» — إعادة بناء (يُقرأ النص وتراجعه) أو تكبير/تصغير التصميم كما هو.", "المعاينة توضّح ما يناسب المقاس وما يحتاج مساحة أكبر؛ ثم احفظ وحمّل PDF."],
      en: ["For a stored label: open it → the Layout & size tab, pick the size (e.g. 10×12 cm).", "For a label file you have: Upload label to resize — rebuild (its text is read and you check it) or scale the design as it is.", "The preview shows what fits and what needs more room; then save and download the PDF."],
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
