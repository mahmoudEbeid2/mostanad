// Labels the assistant shows in Arabic and English: product / record field names
// (draft forms, record blocks, mapping an Arabic field name the model or the person
// used to its key) and the fixed texts of cards and errors. Stored DATA is never
// translated — only these labels.

export const FIELD_LABELS = {
  name: ["الاسم", "Name"],
  productCode: ["كود المنتج", "Product code"],
  description: ["الوصف", "Description"],
  indications: ["دواعي الاستعمال", "Indications"],
  targetSpecies: ["الأنواع المستهدفة", "Target species"],
  physicalForm: ["الشكل", "Physical form"],
  appearance: ["المظهر", "Appearance"],
  activeIngredients: ["المكونات النشطة", "Active ingredients"],
  dosage: ["الجرعة", "Dosage"],
  mixingInstructions: ["طريقة الخلط", "Mixing instructions"],
  withdrawalPeriod: ["فترة السحب", "Withdrawal period"],
  contraindications: ["موانع الاستعمال", "Contraindications"],
  userSafety: ["سلامة المستخدم", "User safety"],
  storage: ["التخزين", "Storage"],
  validity: ["الصلاحية", "Validity"],
  compositionBasis: ["أساس التركيب", "Composition basis"],
  packaging: ["التعبئة", "Packaging"],
  registrationNumber: ["رقم التسجيل", "Registration number"],
  origin: ["المنشأ", "Origin"],
  producer: ["المُنتِج", "Producer"],
  routeOfAdmin: ["طريقة الإعطاء", "Route of administration"],
  dosageForm: ["الشكل الصيدلاني", "Dosage form"],
  strength: ["التركيز", "Strength"],
  productType: ["نوع المنتج", "Product type"],
  prescriptionStatus: ["حالة الوصفة", "Prescription status"],
  specifications: ["المواصفات", "Specifications"],
  brand: ["البراند", "Brand"],
  category: ["الفئة", "Category"],
  company: ["الشركة", "Company"],
  isActive: ["نشط", "Active"],
  createdAt: ["تاريخ الإنشاء", "Created"],
  updatedAt: ["آخر تحديث", "Updated"],
  status: ["الحالة", "Status"],
  country: ["الدولة", "Country"],
  language: ["اللغة", "Language"],
  email: ["البريد", "Email"],
  phone: ["الهاتف", "Phone"],
  products: ["المنتجات", "Products"],
  invoiceNumber: ["رقم الفاتورة", "Invoice number"],
  batchNo: ["رقم التشغيلة", "Batch"],
  type: ["النوع", "Type"],
  product: ["المنتج", "Product"],
  version: ["الإصدار", "Version"],
  widthMm: ["العرض (مم)", "Width (mm)"],
  heightMm: ["الارتفاع (مم)", "Height (mm)"],
  preset: ["المقاس", "Size"],
  mode: ["الطريقة", "Mode"],
  attachmentId: ["الملف", "File"],
  labelId: ["الليبل", "Label"],
  invoiceId: ["الفاتورة", "Invoice"],
  lineNo: ["السطر", "Line"],
  productId: ["المنتج", "Product"],
  brandId: ["البراند", "Brand"],
  categoryId: ["الفئة", "Category"],
  certificateTypeIds: ["أنواع الشهادات", "Certificate types"],
  targetBrandId: ["البراند المستهدف", "Target brand"],
  changes: ["التعديلات", "Changes"],
};

const fold = (s) => String(s ?? "").toLowerCase().replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/[ً-ْـ]/g, "").replace(/\s+/g, " ").trim();

// the other ways people name a field ("مدة الصلاحية", "shelf life") — folded, without "ال"
const FIELD_ALIASES = {
  "مده صلاحيه": "validity", "صلاحيه": "validity", "shelf life": "validity", "shelf-life": "validity", "expiry period": "validity",
  "عبوه": "packaging", "حجم عبوه": "packaging", "pack": "packaging", "pack size": "packaging", "package": "packaging",
  "شكل": "physicalForm", "form": "physicalForm", "فئه": "productType", "category": "productType", "تصنيف": "productType",
  "مظهر": "appearance", "لون": "appearance", "طريقه استعمال": "dosage", "استعمال": "dosage", "طريقه اعطاء": "routeOfAdmin",
  "منتج": "producer", "شركه مصنعه": "producer", "manufacturer": "producer", "بلد منشا": "origin", "منشا": "origin", "country of origin": "origin",
  "اساس تركيب": "compositionBasis", "basis": "compositionBasis",
};

/** "فترة السحب" / "withdrawal period" / "withdrawalPeriod" → "withdrawalPeriod" (of `keys`), else null */
export function fieldKeyOf(name, keys = Object.keys(FIELD_LABELS)) {
  const n = fold(name).replace(/^ال(?=\S)/, "");
  const alias = FIELD_ALIASES[n.replace(/(^|\s)ال(?=\S)/g, "$1")] || FIELD_ALIASES[n];
  if (alias && keys.includes(alias)) return alias;
  for (const k of keys) {
    const [ar, en] = FIELD_LABELS[k] || [];
    if (fold(k) === n || (en && fold(en) === n) || (ar && (fold(ar) === n || fold(ar).replace(/^ال/, "") === n))) return k;
  }
  return null;
}

/** "فترة السحب / Withdrawal period" — both, for forms shown in either language. */
export const bilingual = (key) => (FIELD_LABELS[key] ? `${FIELD_LABELS[key][0]} / ${FIELD_LABELS[key][1]}` : key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()));
export const labelIn = (key, lang) => (FIELD_LABELS[key] ? FIELD_LABELS[key][lang === "ar" ? 0 : 1] : key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()));
export const langOf = (text) => (/[؀-ۿ]/.test(String(text || "")) ? "ar" : "en");
