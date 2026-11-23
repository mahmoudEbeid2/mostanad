import { fold } from "./grounding.js";

// Which tool modules to offer the model for one message: the core tools always,
// plus the modules the message or the current page is about — not the whole
// registry (fewer declarations = fewer tokens on every call, and a model that
// picks the right tool more often). The agent loop adds the conversation's recent
// modules (sticky) and loads a module on the spot when the model calls one of its
// tools; load_tools still works.
//
// Words are matched on fold()ed text (أ/إ/آ → ا, ة → ه, ى → ي, no diacritics), so
// "المستندات الرقابية" and "الرقابيه" match the same keyword.

const KEYWORDS = {
  products: ["product", "products", "copy", "copied", "duplicate", "انسخ", "نسخ", "منسوخ", "نفس المنتج", "ingredient", "composition", "spec", "specification", "ph", "assay", "code", "brand", "category", "dosage", "withdrawal", "storage", "packaging", "missing", "منتج", "منتجات", "مكونات", "تركيب", "مواصف", "كود", "براند", "علامه", "فئه", "جرعه", "سحب", "تخزين", "تعبئه", "ناقص", "تركيبه", "صنف"],
  catalogues: ["catalogue", "catalog", "brochure", "كتالوج", "كاتالوج", "كتالوغ"],
  invoices: ["invoice", "invoices", "line", "lines", "batch", "lab result", "missing", "upload", "prepare", "match", "coa", "ارفع", "طابق", "جهز", "فاتوره", "فواتير", "تشغيله", "دفعه", "ناقص", "بند", "بنود", "سطر", "سطور"],
  certificates: ["certificate", "certificates", "template", "templates", "coa", "type", "lab", "generate", "metric", "metrics", "طلع", "شهاده", "شهادات", "قالب", "قوالب", "تحليل", "مختبر", "نوع", "مقاييس"],
  labels: ["label", "labels", "size", "resize", "dimension", " cm", "layout", "مقاس", "حجم", "ابعاد", "ليبل", "validation", "verdict", "reference", "ملصق", "ملصقات", "تحقق", "مرجع"],
  regulatory: ["regulatory", "regulation", "eda", "sfda", "requirement", "rule", "authority", "document", "documents", "لوائح", "تنظيم", "هيئه", "متطلبات", "قاعده", "قواعد", "مستند", "مستندات", "رقابي", "رقابيه", "تسجيل"],
  users: ["user", "users", "role", "roles", "permission", "staff", "مستخدم", "مستخدمين", "دور", "صلاحي"],
  dashboard: ["dashboard", "stats", "statistics", "revenue", "subscription", "لوحه", "داشبورد", "احصائ", "اشتراك", "ايراد"],
  ai_costs: ["cost", "costs", "spend", "tokens", " ai ", "gemini", "تكلفه", "تكاليف", "ذكاء"],
  tasks: ["task", "tasks", "status", "job", "progress", "running", "مهمه", "مهام", "حاله", "شغال", "تقدم"],
  companies: ["company", "companies", "شركه", "شركات"],
};
const FOLDED = Object.fromEntries(Object.entries(KEYWORDS).map(([m, words]) => [m, words.map((w) => (w.startsWith(" ") || w.endsWith(" ") ? ` ${fold(w)} ` : fold(w)))]));
const PAGE_MODULE = { product: "products", invoice: "invoices", certificate: "certificates", template: "certificates", label: "labels", catalogue: "catalogues", catalogue_version: "catalogues", regulatory: "regulatory" };
const DEFAULT_MODULES = ["products", "invoices", "certificates"];

export function selectModules(text, page = null, { files = false } = {}) {
  const t = ` ${fold(text)} `;
  const chosen = new Set(Object.entries(FOLDED).filter(([, words]) => words.some((w) => t.includes(w))).map(([m]) => m));
  if (page?.entityType && PAGE_MODULE[page.entityType]) chosen.add(PAGE_MODULE[page.entityType]);
  // a file in the message: whatever it turns out to be, the tools that act on files
  if (files) ["invoices", "certificates", "catalogues", "labels"].forEach((m) => chosen.add(m));
  if (!chosen.size) DEFAULT_MODULES.forEach((m) => chosen.add(m));
  if (chosen.has("invoices")) chosen.add("certificates"); // an invoice's open values are about its certificates
  return [...chosen].sort();
}
