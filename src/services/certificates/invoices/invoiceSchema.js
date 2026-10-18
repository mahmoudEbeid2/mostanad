// The invoice header / item shapes (CERTIFICATES_V2_PLAN.md §9.1). One
// definition, used by the extractor's responseSchema (Phase 3), the review
// validators and the field-source catalogue (§8.2) — so the catalogue never
// drifts from what extraction actually produces.
//
// type: string | date | number — decides which `format` options a field may use.

export const INVOICE_HEADER_FIELDS = [
  { path: "invoiceNumber", label: "Invoice number", type: "string" },
  { path: "invoiceDate", label: "Invoice date", type: "date" },
  { path: "supplierName", label: "Supplier name", type: "string" },
  { path: "customerName", label: "Customer name", type: "string" },
  { path: "customerCountry", label: "Customer country", type: "string" },
  { path: "currency", label: "Currency", type: "string" },
];

export const INVOICE_ITEM_FIELDS = [
  { path: "lineNo", label: "Line number", type: "number" },
  { path: "name", label: "Product name (as invoiced)", type: "string" },
  { path: "code", label: "Product code (as invoiced)", type: "string" },
  { path: "batchNo", label: "Batch number", type: "string" },
  { path: "productionDate", label: "Production date", type: "date" },
  { path: "expiryDate", label: "Expiry date", type: "date" },
  { path: "quantity", label: "Quantity", type: "number" },
  { path: "unit", label: "Unit", type: "string" },
  { path: "packing", label: "Packing", type: "string" },
];

export const HEADER_KEYS = INVOICE_HEADER_FIELDS.map((f) => f.path);
export const ITEM_KEYS = INVOICE_ITEM_FIELDS.map((f) => f.path);
