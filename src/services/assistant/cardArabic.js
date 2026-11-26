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

// 28 Nov (Phase 7): the chips under an answer ("✓ Counting · …", "✓ Searching products") in Arabic —
// keyed by the tool's English label, which stays for English and the logs
const STEP_AR = {
  "Adding the brand": "بنضيف البراند", "Adding the category": "بنضيف الفئة", "Adding the certificate type": "بنضيف نوع الشهادة", "Adding the company": "بنضيف الشركة",
  "Adding the product": "بنضيف المنتج", "Adding the products": "بنضيف المنتجات", "Adding the reference label": "بنضيف الليبل المرجعي", "Adding the reference labels": "بنضيف الليبلات المرجعية",
  "Changing the label's size": "بنغيّر مقاس الليبل", "Checking product data": "بنراجع بيانات المنتج", "Checking the label": "بنراجع الليبل", "Comparing with the original": "بنقارن بالأصل",
  "Confirming the invoice": "بنأكّد الفاتورة", "Copying the product": "بننسخ المنتج", "Copying the products": "بننسخ المنتجات", "Counting": "بنعدّ",
  "Creating products from the lines": "بنعمل منتجات من السطور", "Creating the product": "بنعمل المنتج", "Filling the batch data": "بنملا بيانات التشغيلة", "Generating certificates": "بنطلّع الشهادات",
  "Laying out the label": "بنرتّب الليبل", "Listing brands": "البراندات", "Listing catalogues": "الكتالوجات", "Listing categories": "الفئات", "Listing certificate templates": "قوالب الشهادات",
  "Listing certificate types": "أنواع الشهادات", "Listing certificates": "الشهادات", "Listing companies": "الشركات", "Listing labels": "الليبلات", "Listing products": "المنتجات",
  "Listing reference labels": "الليبلات المرجعية", "Listing regulatory documents": "المستندات التنظيمية", "Listing roles": "الأدوار", "Listing users": "المستخدمين",
  "Looking at the file": "بنبص على الملف", "Making certificate templates": "بنعمل قوالب الشهادات", "Making templates from your certificates": "بنعمل قوالب من شهاداتك",
  "Making the certificate": "بنعمل الشهادة", "Making the certificates": "بنعمل الشهادات", "Matching the invoice lines": "بنطابق سطور الفاتورة", "Matching the line": "بنطابق السطر",
  "Preparing certificates": "بنجهّز الشهادات", "Reading AI costs": "تكلفة الذكاء الاصطناعي", "Reading certificate metrics": "أرقام الشهادات", "Reading certificate versions": "نسخ الشهادة",
  "Reading lab results": "نتايج التحليل", "Reading open operations": "العمليات المفتوحة", "Reading saved certificate values": "قيم الشهادات المحفوظة", "Reading template fields": "حقول القالب",
  "Reading the brand": "البراند", "Reading the catalogue": "الكتالوج", "Reading the catalogue edition": "نسخة الكتالوج", "Reading the certificate": "الشهادة", "Reading the company": "الشركة",
  "Reading the costliest AI operations": "أغلى عمليات الذكاء الاصطناعي", "Reading the dashboard": "لوحة التحكم", "Reading the data check": "مراجعة البيانات", "Reading the files": "بنقرا الملفات",
  "Reading the help": "المساعدة", "Reading the invoice": "الفاتورة", "Reading the label": "الليبل", "Reading the label sizes": "مقاسات الليبل", "Reading the label's layout": "ترتيب الليبل",
  "Reading the product": "المنتج", "Reading the regulation": "اللائحة", "Reading the regulatory document": "المستند التنظيمي", "Reading the requirements": "المتطلبات", "Reading the review inbox": "صندوق المراجعة",
  "Reading the supplier COA": "شهادة تحليل المورد", "Reading the task": "حالة المهمة", "Reading the template": "القالب", "Reading the uploaded label": "الليبل المرفوع", "Reading the validation": "نتيجة المراجعة",
  "Searching catalogues": "بندوّر في الكتالوجات", "Searching invoices": "بندوّر في الفواتير", "Searching products": "بندوّر على المنتج", "Sorting the files": "بنرتّب الملفات",
  "Starting the operation": "بنبدأ العملية", "Updating from the original": "بنحدّث من الأصل", "Updating the operation": "بنحدّث العملية", "Updating the product": "بنعدّل المنتج",
  "Uploading the catalogue": "بنرفع الكتالوج", "Uploading the invoice": "بنرفع الفاتورة", "Uploading the label": "بنرفع الليبل",
};
/** A step chip's Arabic label (null when there is none: the English one is shown) */
export const stepLabelAr = (label) => STEP_AR[label] || null;
