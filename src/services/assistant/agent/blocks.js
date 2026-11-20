import crypto from "node:crypto";

// Table blocks: a list a tool returned goes to the UI as rows, not through the
// model's text. The model only writes a sentence around it; "Load more" calls
// the same tool with the cursor (the next page) without a model call. A model
// that types a list itself can invent rows — that is the bug this prevents.

const COLUMNS = {
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
};
const MAX_CELL = 160;

const cell = (v) => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(cell).join(", ");
  if (typeof v === "object") return null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const s = String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
};

function columnsFor(tool, rows) {
  if (COLUMNS[tool]) return COLUMNS[tool].filter(([key]) => rows.some((r) => r[key] !== undefined && r[key] !== null)).map(([key, label]) => ({ key, label }));
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
    total: data.total ?? rows.length,
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
