// Which tool modules to offer the model for one message: the core tools always,
// plus the modules the message or the current page is about — not the whole
// registry (fewer declarations = fewer tokens on every call, and a model that
// picks the right tool more often). The model can still ask for another module
// with load_tools.

const KEYWORDS = {
  products: ["product", "products", "ingredient", "composition", "spec", "specification", "ph", "assay", "code", "brand", "category", "dosage", "withdrawal", "storage", "packaging", "missing", "منتج", "منتجات", "مكونات", "تركيب", "مواصف", "كود", "براند", "علامة", "فئة", "جرعة", "سحب", "تخزين", "تعبئة", "ناقص", "تركيبة"],
  catalogues: ["catalogue", "catalog", "brochure", "كتالوج", "كاتالوج", "كتالوغ"],
  invoices: ["invoice", "invoices", "line", "batch", "lab result", "missing", "فاتورة", "فواتير", "الفاتوره", "تشغيلة", "دفعة", "ناقص"],
  certificates: ["certificate", "certificates", "template", "templates", "coa", "type", "lab", "شهادة", "شهادات", "قالب", "قوالب", "تحليل", "مختبر", "نوع"],
  labels: ["label", "labels", "validation", "verdict", "reference", "ملصق", "ملصقات", "ليبل", "تحقق", "مرجع"],
  regulatory: ["regulatory", "regulation", "eda", "sfda", "requirement", "rule", "authority", "لوائح", "تنظيم", "هيئة", "متطلبات", "قاعدة", "قواعد"],
  users: ["user", "users", "role", "roles", "permission", "staff", "مستخدم", "مستخدمين", "دور", "صلاحي"],
  dashboard: ["dashboard", "stats", "statistics", "revenue", "subscription", "لوحة", "إحصائ", "احصائ", "اشتراك", "إيراد"],
  ai_costs: ["cost", "costs", "spend", "tokens", " ai ", "gemini", "تكلفة", "تكاليف", "ذكاء"],
};
const PAGE_MODULE = { product: "products", invoice: "invoices", certificate: "certificates", template: "certificates", label: "labels", catalogue: "catalogues", catalogue_version: "catalogues", regulatory: "regulatory" };
const DEFAULT_MODULES = ["products", "invoices", "certificates"];

export function selectModules(text, page = null) {
  const t = ` ${String(text || "").toLowerCase()} `;
  const chosen = new Set(Object.entries(KEYWORDS).filter(([, words]) => words.some((w) => t.includes(w))).map(([m]) => m));
  if (page?.entityType && PAGE_MODULE[page.entityType]) chosen.add(PAGE_MODULE[page.entityType]);
  if (!chosen.size) DEFAULT_MODULES.forEach((m) => chosen.add(m));
  if (chosen.has("invoices")) chosen.add("certificates"); // an invoice's open values are about its certificates
  return [...chosen].sort();
}
