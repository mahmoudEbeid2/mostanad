// The chat cards in Arabic (26 Nov: "Make a certificate for a product (no invoice)", "Certificate Type
// Id", "batchNo, productionDate, expiryDate" on an Arabic chat). Every card keeps its English text
// and gets an Arabic one next to it (titleAr, summaryAr, runLabelAr, labelAr per field / detail):
// the page shows the person's language. Data (names, values) is never translated.

const TITLES = {
  generate_certificate_for_product: "شهادة لمنتج (من غير فاتورة)",
  generate_certificates_for_products: "شهادات لكذا منتج (من غير فاتورة)",
  generate_certificates: "اعمل الشهادات من الفاتورة",
  create_certificate_templates: "اعمل قوالب شهادات من الملفات",
  use_files_as_templates: "اعمل قوالب من الشهادات اللي بعتها، وبعدين الشهادات",
  create_certificate_type: "اعمل نوع شهادة",
  create_company: "اعمل شركة جديدة",
  create_brand: "ضيف براند",
  create_category: "ضيف فئة",
  create_products: "ضيف منتجات",
  add_reference_labels: "ضيف ليبلات مرجعية",
  add_regulatory_rules: "اقرا لوايح البلد",
  upload_supplier_coa: "ارفع شهادة تحليل المورد",
  update_product_fields: "عدّل بيانات المنتج",
  upload_label: "ضيف ليبل مرجعي",
  verify_label: "افحص ليبل",
  resize_label: "غيّر مقاس الليبل",
};
const RUN = {
  generate_certificate_for_product: "اعمل الشهادة",
  generate_certificates_for_products: "اعمل الشهادات",
  generate_certificates: "اعمل الشهادات",
  create_certificate_templates: "اعمل القوالب",
  use_files_as_templates: "اعمل القوالب والشهادات",
};
export const LABELS_AR = {
  companyId: "الشركة",
  Company: "الشركة",
  productId: "المنتج",
  productIds: "المنتجات",
  Product: "المنتج",
  Products: "المنتجات",
  certificateTypeId: "نوع الشهادة",
  certificateTypeIds: "أنواع الشهادات",
  "Certificate type": "نوع الشهادة",
  "Certificate types": "أنواع الشهادات",
  "Certificate Type Id": "نوع الشهادة",
  batchNo: "رقم التشغيلة",
  "Batch no": "رقم التشغيلة",
  "Batch No": "رقم التشغيلة",
  productionDate: "تاريخ الإنتاج",
  "Production Date": "تاريخ الإنتاج",
  expiryDate: "تاريخ الانتهاء",
  "Expiry Date": "تاريخ الانتهاء",
  quantity: "الكمية",
  Quantity: "الكمية",
  unit: "الوحدة",
  Unit: "الوحدة",
  packing: "العبوة",
  Packing: "العبوة",
  country: "الدولة",
  Country: "الدولة",
  brandId: "البراند",
  Brand: "البراند",
  attachmentId: "الملف",
  attachmentIds: "الملفات",
  File: "الملف",
  Files: "الملفات",
  coaAttachmentIds: "شهادة تحليل المورد",
  "Coa Attachment Ids": "شهادة تحليل المورد",
  invoiceId: "الفاتورة",
  Invoice: "الفاتورة",
  batches: "التشغيلات",
  Batches: "التشغيلات",
  codes: "أنواع الملفات",
  name: "الاسم",
  Name: "الاسم",
  "Will make": "هيتعمل",
  "No template": "مفيش قالب",
  "Not made (no template)": "مش هيتعمل (مفيش قالب)",
  Templates: "القوالب",
  "Batch facts": "بيانات التشغيلة",
};
const FACTS = { batchNo: "رقم التشغيلة", productionDate: "تاريخ الإنتاج", expiryDate: "تاريخ الانتهاء", "batch number": "رقم التشغيلة", "production and expiry dates": "تاريخ الإنتاج والانتهاء" };

/** "batchNo, productionDate, expiryDate not given — empty and flagged on the draft" → Arabic */
export function missingAr(line) {
  const m = String(line).match(/^(.+?) not given — empty and flagged on the drafts?$/);
  if (!m) return null;
  const names = m[1].split(/,\s*|\s+and\s+/).map((n) => FACTS[n.trim()] || n.trim());
  return `${names.join("، ")} مش متكتبة — هتفضل فاضية ومتعلّم عليها في المسودة (مش هنملاها من عندنا)`;
}

/** A card preview → the same preview with its Arabic texts added */
export function withArabic(tool, preview) {
  if (!preview || typeof preview !== "object") return preview;
  const lab = (l) => LABELS_AR[l] || LABELS_AR[String(l || "").replace(/\s+/g, " ").trim()] || null;
  return {
    ...preview,
    titleAr: TITLES[tool] || null,
    runLabelAr: RUN[tool] || null,
    ...(Array.isArray(preview.fields) ? { fields: preview.fields.map((f) => ({ ...f, labelAr: lab(f.name) || lab(f.label) })) } : {}),
    ...(Array.isArray(preview.details) ? { details: preview.details.map((d) => ({ ...d, labelAr: lab(d.label) })) } : {}),
    ...(Array.isArray(preview.missing) ? { missingAr: preview.missing.map((x) => missingAr(x) || x) } : {}),
  };
}
