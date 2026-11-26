import crypto from "node:crypto";

// Table blocks: a list a tool returned goes to the UI as rows, not through the
// model's text. The model only writes a sentence around it; "Load more" calls
// the same tool with the cursor (the next page) without a model call. A model
// that types a list itself can invent rows — that is the bug this prevents.

export const COLUMNS = {
  search_products: [["name", "Product"], ["productCode", "Code"], ["brand", "Brand"], ["company", "Company"]],
  list_products: [["name", "Product"], ["productCode", "Code"], ["brand", "Brand"], ["company", "Company"]],
  list_products_missing_data: [["name", "Product"], ["productCode", "Code"], ["missing", "Missing"], ["company", "Company"]],
  list_brands: [["name", "Brand"], ["products", "Products"], ["isActive", "Active"], ["company", "Company"]],
  list_categories: [["name", "Category"]],
  search_invoices: [["invoiceNumber", "Invoice"], ["customer", "Customer"], ["date", "Date"], ["status", "Status"], ["lines", "Lines"], ["company", "Company"]],
  list_certificates: [["type", "Type"], ["product", "Product"], ["batchNo", "Batch"], ["invoiceNumber", "Invoice"], ["status", "Status"], ["flagCount", "Flags"]],
  list_templates: [["name", "Template"], ["type", "Type"], ["brand", "Brand"], ["country", "Country"], ["active", "Active"], ["fieldCount", "Fields"]],
  search_labels: [["country", "Country"], ["language", "Language"], ["status", "Status"], ["currentVersion", "Version"], ["riskScore", "Risk"]],
  get_label_review_inbox: [["country", "Country"], ["status", "Status"], ["riskScore", "Risk"], ["autonomyTier", "Tier"]],
  search_reference_labels: [["name", "Reference label"], ["country", "Country"], ["shared", "Shared"]],
  list_regulatory_documents: [["title", "Document"], ["authority", "Authority"], ["country", "Country"], ["status", "Status"], ["rules", "Rules"]],
  get_eda_requirements: [["ruleKey", "Rule"], ["ruleType", "Type"], ["severity", "Severity"], ["description", "Description"]],
  list_catalogues: [["manufacturer", "Catalogue"], ["brand", "Brand"], ["company", "Company"]],
  list_companies: [["name", "Company"], ["isActive", "Active"]],
  list_users: [["name", "Name"], ["username", "Username"], ["email", "Email"], ["isActive", "Active"]],
  list_roles: [["name", "Role"], ["description", "Description"]],
  count_records: [["label", "Group"], ["count", "Count"]],
  get_template_fields: [["label", "Field"], ["key", "Key"], ["required", "Required"], ["source", "Source"], ["dataCategory", "Category"], ["isLabResult", "Lab result"], ["isBatchFact", "Batch fact"]],
  get_ai_cost_top: [["label", "Item"], ["calls", "Calls"], ["costUsd", "Cost (USD)"]],
};
const MAX_CELL = 160;

const cell = (v) => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(cell).join(", ");
  if (typeof v === "object") return null;
  if (typeof v === "boolean") return v ? "أيوه" : "لأ";
  const s = String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
};

// the column headings in Arabic (the UI's language); the stored values in the cells are never translated
const COLUMN_AR = {
  Product: "المنتج", Code: "الكود", Brand: "البراند", Company: "الشركة", Missing: "الناقص", Products: "المنتجات", Active: "شغّال", Category: "الفئة",
  Invoice: "الفاتورة", Customer: "العميل", Date: "التاريخ", Status: "الحالة", Lines: "السطور", Type: "النوع", Batch: "التشغيلة", Flags: "ملاحظات",
  Template: "القالب", Country: "البلد", Fields: "الحقول", Language: "اللغة", Version: "النسخة", Risk: "الخطورة", Tier: "المستوى",
  "Reference label": "الليبل المرجعي", Shared: "مشترك", Document: "المستند", Authority: "الجهة", Rules: "القواعد", Rule: "القاعدة", Severity: "الأهمية",
  Description: "الوصف", Catalogue: "الكتالوج", Name: "الاسم", Username: "اسم المستخدم", Email: "الإيميل", Role: "الدور", Group: "المجموعة", Count: "العدد",
  Field: "الحقل", Key: "المفتاح", Required: "مطلوب", Source: "المصدر", "Lab result": "نتيجة تحليل", "Batch fact": "بيان تشغيلة", Item: "البند", Calls: "الطلبات", "Cost (USD)": "التكلفة (دولار)",
};
function columnsFor(tool, rows) {
  if (COLUMNS[tool]) return COLUMNS[tool].filter(([key]) => rows.some((r) => r[key] !== undefined && r[key] !== null)).map(([key, label]) => ({ key, label, labelAr: COLUMN_AR[label] || null }));
  const first = rows[0] || {};
  return Object.keys(first)
    .filter((k) => k !== "ref" && k !== "id" && !/Id$/.test(k) && ["string", "number", "boolean"].includes(typeof first[k]))
    .slice(0, 6)
    .map((key) => ({ key, label: key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()) }));
}

/** The rows of a list result (page() shape or count groups), or null when it isn't a list. */
export function rowsOf(tool, data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.items) && data.items.every((r) => r && typeof r === "object")) return data.items;
  if (tool === "count_records" && Array.isArray(data.groups)) return data.groups.map((g) => ({ ...g, label: g.label ?? g.key ?? "—" }));
  if (tool === "get_template_fields" && Array.isArray(data.fields)) return data.fields;
  if (tool === "search_products" && Array.isArray(data.results)) return data.results; // every match, a table with «عرض المزيد»
  return null;
}

const toRow = (r, columns) => ({ cells: Object.fromEntries(columns.map(({ key }) => [key, cell(r[key])])), ref: r.ref && r.ref.id ? { type: r.ref.type, id: r.ref.id } : null });

/**
 * A table block for one list result, or null. args/companyId are what the tool ran with:
 * Load more re-runs it with page = nextPage.
 */
export function tableBlock(tool, args, companyId, data, label = null) {
  const rows = rowsOf(tool, data);
  if (!rows || !rows.length) return null;
  const columns = columnsFor(tool, rows);
  if (!columns.length) return null;
  const { companyId: _ignored, page: _p, ...rest } = args || {};
  return {
    id: crypto.randomUUID(),
    type: "table",
    tool,
    title: label,
    args: rest,
    companyId: companyId ?? null,
    columns,
    rows: rows.map((r) => toRow(r, columns)),
    // a count's rows are its groups: "shown / total" counts rows, never the sum of the counts ("2 of 90")
    total: tool === "count_records" ? rows.length : data.total ?? rows.length,
    more: data.more ?? 0,
    nextPage: data.nextPage ?? null,
    ...(tool === "count_records" ? { totalCount: data.total, from: data.from ?? null, to: data.to ?? null, timezone: data.timezone ?? null } : {}),
  };
}

/** The rows of the next page, in the block's columns. → { rows, more, nextPage, total } */
export function nextRows(block, data) {
  const rows = rowsOf(block.tool, data) || [];
  return { rows: rows.map((r) => toRow(r, block.columns)), more: data?.more ?? 0, nextPage: data?.nextPage ?? null, total: data?.total ?? block.total };
}

// ── record blocks: ONE record (a product, a company, a certificate, the dashboard numbers…) as a
// key/value card built by code from the stored values — full text, never translated, field names
// labelled in Arabic and English. The model writes one or two sentences around it. QA 2026-11-23:
// the model typed the fields itself; long values arrived cut ("… (85 more characters)") and a
// grounding check or the list stripper then hid the whole answer.
export const RECORD_TOOLS = new Set(["get_product", "get_company", "get_brand", "get_certificate", "get_dashboard_stats", "get_certificate_metrics", "get_template", "get_label", "get_regulatory_document", "get_catalogue", "get_ai_cost_summary"]);
const SKIP_KEY = (k) => k === "ref" || k === "id" || /Id$/.test(k) || /^(?:untrusted|note)$/.test(k);
const MAX_RECORD_FIELDS = 60;

function recordValue(v) {
  if (v === null || v === undefined || v === "") return null;
  if (["string", "number", "boolean"].includes(typeof v)) return v;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (x && typeof x === "object" ? Object.entries(x).filter(([k, y]) => !SKIP_KEY(k) && y !== null && y !== undefined && y !== "" && typeof y !== "object").map(([, y]) => String(y)).join(" ") : String(x))).filter(Boolean);
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof v === "object" && v.name && Object.keys(v).length <= 3) return String(v.name);
  return undefined; // an object: flattened one level by the caller
}

/** A record block for one record result, or null. labelOf(key) → { ar, en } */
export function recordBlock(tool, data, title, labelOf) {
  if (!RECORD_TOOLS.has(tool) || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = [];
  const add = (path, label, v) => {
    const value = recordValue(v);
    if (value !== undefined && fields.length < MAX_RECORD_FIELDS) fields.push({ key: path, label, value });
    return value !== undefined;
  };
  for (const [k, v] of Object.entries(data)) {
    if (SKIP_KEY(k)) continue;
    if (add(k, labelOf(k), v)) continue;
    // an object (growth: { products, users }, specifications: { values: {…} }): one level down, "growth · products"
    const inner = v.values && typeof v.values === "object" && !Array.isArray(v.values) ? v.values : v;
    for (const [k2, v2] of Object.entries(inner)) {
      if (SKIP_KEY(k2) || (v2 && typeof v2 === "object" && !Array.isArray(v2))) continue;
      const l1 = labelOf(k);
      const l2 = labelOf(k2);
      add(`${k}.${k2}`, { ar: `${l1.ar} · ${l2.ar}`, en: `${l1.en} · ${l2.en}` }, v2);
    }
  }
  if (!fields.length) return null;
  return { id: crypto.randomUUID(), type: "record", tool, title, ref: data.ref && data.ref.id ? { type: data.ref.type, id: data.ref.id } : null, fields };
}

/** Every value a block shows (for the typed-list check: a list the block already shows is removed). */
export function blockValues(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === "table") for (const r of b.rows) for (const v of Object.values(r.cells)) if (v !== null && v !== undefined) out.push(String(v));
    if (b.type === "record") for (const f of b.fields) if (f.value !== null) out.push(...String(f.value).split("\n"));
  }
  return out;
}
