// The invoice header / item shapes (CERTIFICATES_V2_PLAN.md §9.1). One
// definition, used by the extractor's responseSchema (Phase 3), the review
// validators and the field-source catalogue (§8.2) — so the catalogue never
// drifts from what extraction actually produces.
//
// type: string | date | number — decides which `format` options a field may use.
// synonyms: other printed labels for the same value — the code step of template
// field mapping (plan.md §5.2 step 2) matches them before any AI is asked.

export const INVOICE_HEADER_FIELDS = [
  { path: "invoiceNumber", label: "Invoice number", type: "string", synonyms: ["invoice no", "invoice #", "inv no", "commercial invoice no"] },
  { path: "invoiceDate", label: "Invoice date", type: "date", synonyms: ["date of invoice", "inv date"] },
  { path: "supplierName", label: "Supplier name", type: "string", synonyms: ["supplier", "seller", "exporter", "exporter company", "shipper"] },
  { path: "customerName", label: "Customer name", type: "string", synonyms: ["customer", "buyer", "consignee", "importer", "importer company"] },
  { path: "customerCountry", label: "Customer country", type: "string", synonyms: ["destination", "country of destination", "destination country"] },
  { path: "currency", label: "Currency", type: "string" },
];

export const INVOICE_ITEM_FIELDS = [
  { path: "lineNo", label: "Line number", type: "number" },
  { path: "name", label: "Product name (as invoiced)", type: "string" },
  { path: "code", label: "Product code (as invoiced)", type: "string" },
  { path: "batchNo", label: "Batch number", type: "string", synonyms: ["batch", "batch no", "lot", "lot no", "lot number", "batch lot"] },
  { path: "productionDate", label: "Production date", type: "date", synonyms: ["manufacturing date", "manufacture date", "date of manufacture", "mfg date", "mfg", "mfd", "prod date"] },
  { path: "expiryDate", label: "Expiry date", type: "date", synonyms: ["expiration date", "exp date", "exp", "expiry", "best before", "use before", "valid until"] },
  { path: "quantity", label: "Quantity", type: "number" },
  { path: "unit", label: "Unit", type: "string" },
  { path: "packing", label: "Packing", type: "string" },
];

export const HEADER_KEYS = INVOICE_HEADER_FIELDS.map((f) => f.path);
export const ITEM_KEYS = INVOICE_ITEM_FIELDS.map((f) => f.path);
