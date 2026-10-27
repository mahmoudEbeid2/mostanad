import { z } from "zod";

// Request schemas for the Certificates V2 API (CERTIFICATES_V2_PLAN.md §12).
// Multipart bodies arrive as strings — empty strings mean "not set".
// An ABSENT key stays undefined (PATCH = "leave unchanged"); "", "null" and
// null mean "clear it".

const uuid = z.string().uuid();
const unset = (v) => v === null || v === "" || v === "null";
const optionalUuid = z
  .union([uuid, z.literal(""), z.literal("null")])
  .optional()
  .nullable()
  .transform((v) => (v === undefined ? undefined : unset(v) ? null : v));
const optionalCountry = z
  .union([z.string().regex(/^[A-Za-z]{2}$/, "country must be an ISO-3166 alpha-2 code"), z.literal(""), z.literal("null")])
  .optional()
  .nullable()
  .transform((v) => (v === undefined ? undefined : unset(v) ? null : v.toUpperCase()));
const scope = z.enum(["per_product", "per_invoice"]);
const companyQuery = z.object({ companyId: uuid.optional() }).passthrough();
const idParams = z.object({ id: uuid });

export const typeSchemas = {
  list: { query: companyQuery.extend({ includeInactive: z.enum(["true", "false"]).optional() }) },
  create: {
    query: companyQuery,
    body: z.object({
      name: z.string().trim().min(2).max(120),
      code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, "code may contain letters, digits, - and _"),
      description: z.string().max(500).optional().nullable(),
      companyId: uuid.optional(),
    }),
  },
  update: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      name: z.string().trim().min(2).max(120).optional(),
      code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/).optional(),
      description: z.string().max(500).optional().nullable(),
      isActive: z.boolean().optional(),
    }),
  },
  byId: { params: idParams, query: companyQuery },
};

export const templateSchemas = {
  create: {
    query: companyQuery,
    body: z.object({
      name: z.string().trim().min(2).max(160),
      certificateTypeId: uuid,
      brandId: optionalUuid,
      country: optionalCountry,
      scope: scope.default("per_product"),
      companyId: uuid.optional(),
    }),
  },
  list: {
    query: companyQuery.extend({
      certificateTypeId: uuid.optional(),
      brandId: uuid.optional(),
      country: z.string().optional(),
      scope: scope.optional(),
      status: z.string().optional(),
      includeArchived: z.enum(["true", "false"]).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  byId: { params: idParams, query: companyQuery },
  update: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      name: z.string().trim().min(2).max(160).optional(),
      certificateTypeId: uuid.optional(),
      brandId: optionalUuid,
      country: optionalCountry,
      scope: scope.optional(),
    }),
  },
};

// Field drafts are validated in depth by fieldService (§8.2, against the
// version's lines and the real layout); this is the structural shape only.
const fieldDraft = z
  .object({
    key: z.string().max(60),
    label: z.string().max(120),
    lineId: z.string().max(40),
    charStart: z.number().int(),
    charEnd: z.number().int(),
    sampleValue: z.string().max(500),
    source: z.object({ kind: z.string().max(20) }).passthrough(),
    format: z.record(z.string(), z.any()).nullable().optional(),
    required: z.boolean().optional(),
    align: z.string().optional(),
    origin: z.string().optional(),
    confirmed: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    page: z.number().int().optional(),
    groupKey: z.string().max(60).nullable().optional(),
    isLabResult: z.boolean().optional(), // owner-set (Mark fields); omitted = keep the stored flag
    isBatchFact: z.boolean().optional(), // owner-set (Mark fields); omitted = keep the stored flag
  })
  .passthrough();

// Repeating groups (§7.8): structural shape; fieldService validates in depth
const groupDraft = z
  .object({
    key: z.string().max(60),
    label: z.string().max(120),
    mode: z.string().max(20).optional(),
    source: z.object({ kind: z.string().max(20) }).passthrough(),
    whenEmpty: z.string().max(10).optional(),
    required: z.boolean().optional(),
    sampleRows: z.number().int().nullable().optional(),
    footerY: z.number().nullable().optional(),
    minPitchRatio: z.number().nullable().optional(),
    sortOrder: z.number().int().optional(),
  })
  .passthrough();

const rowCells = z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.null()]));
const groupRows = z.array(rowCells).max(200);

// "Fix this template" (item 2): the owner's decision per checklist item; the service validates it against the plan
const repairDecision = z
  .object({
    id: z.string().max(120),
    apply: z.boolean().optional(),
    choice: z.enum(["keep_fixed", "lab_result_field", "show_specification"]).optional(),
    source: z.object({ kind: z.string().max(20) }).passthrough().optional(),
    format: z.record(z.string(), z.any()).nullable().optional(),
    category: z.string().max(30).optional(),
    isLabResult: z.boolean().optional(),
    isBatchFact: z.boolean().optional(),
  })
  .strict();

export const versionSchemas = {
  byId: { params: idParams, query: companyQuery },
  repair: { params: idParams, query: companyQuery, body: z.object({ decisions: z.array(repairDecision).max(300) }) },
  html: { params: idParams, query: companyQuery.extend({ variant: z.enum(["sanitized", "prepared", "sample"]).default("sanitized") }) },
  fields: { params: idParams, query: companyQuery, body: z.object({ fields: z.array(fieldDraft).max(200), groups: z.array(groupDraft).max(20).optional() }) },
  confirm: { params: idParams, query: companyQuery, body: z.object({ keys: z.array(z.string().max(60)).min(1).max(200) }) },
  diff: { params: idParams, query: companyQuery.extend({ page: z.coerce.number().int().min(1).default(1) }) },
  preview: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      values: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.null(), groupRows])).optional(),
      productId: uuid.optional().nullable(),
      invoiceItemId: uuid.optional().nullable(),
    }),
  },
};

export const productSearchSchema = {
  query: companyQuery.extend({ q: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }),
};

// ── invoices (§9, §12) ───────────────────────────────────────────────────────
const cell = z.union([z.string().max(500), z.number(), z.null()]);
const itemData = z.record(z.string(), cell);
const itemParams = z.object({ id: uuid, itemId: uuid });

export const invoiceSchemas = {
  upload: { query: companyQuery, body: z.object({ brandId: optionalUuid, country: optionalCountry, companyId: uuid.optional(), extract: z.enum(["true", "false"]).optional() }) },
  list: {
    query: companyQuery.extend({
      status: z.string().max(30).optional(),
      q: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  byId: { params: idParams, query: companyQuery },
  generate: { params: idParams, query: companyQuery, body: z.object({ force: z.boolean().optional() }).optional() },
  update: {
    params: idParams,
    query: companyQuery,
    body: z.object({ header: z.record(z.string(), cell).optional(), brandId: optionalUuid, country: optionalCountry }),
  },
  // rememberAlias: the person explicitly asks to learn "this line name is this product" (owner, 2026-10-27)
  addItem: { params: idParams, query: companyQuery, body: z.object({ data: itemData.optional(), productId: uuid.optional().nullable(), rememberAlias: z.boolean().optional() }) },
  updateItem: {
    params: itemParams,
    query: companyQuery,
    body: z.object({ data: itemData.optional(), productId: uuid.nullable().optional(), ignored: z.boolean().optional(), aiSuggestionId: uuid.optional(), rememberAlias: z.boolean().optional() }),
  },
  itemById: { params: itemParams, query: companyQuery },
};

// Item 4 — the results grid and supplier COAs
const gridRowKey = z.string().regex(/^(b:[0-9a-f-]{36}:[\p{L}\p{N}]{1,100}|l:[0-9a-f-]{36})$/u, "rowKey is one the grid gave");
export const labResultSchemas = {
  grid: { params: idParams, query: companyQuery },
  save: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      rows: z
        .array(
          z
            .object({
              rowKey: gridRowKey,
              batchNo: z.string().max(100).optional(), // a line without one: asked first; empty = this line only
              values: z.record(z.string().max(200), z.string().max(500).nullable()).optional(),
            })
            .strict()
        )
        .min(1)
        .max(200),
    }),
  },
  upload: { params: idParams, query: companyQuery },
  coaById: { params: z.object({ id: uuid, coaId: uuid }), query: companyQuery },
};

const expectedVersionBody = z.object({ expectedVersion: z.number().int().min(1) });

export const certificateSchemas = {
  metrics: { query: companyQuery.extend({ days: z.coerce.number().int().min(1).max(365).optional() }) },
  byId: { params: idParams, query: companyQuery },
  html: { params: idParams, query: companyQuery.extend({ version: z.coerce.number().int().min(1).optional() }) },
  values: {
    params: idParams,
    query: companyQuery,
    // a repeating group's change is its full list of rows (add / remove / reorder / edit, §7.8)
    body: z.object({ expectedVersion: z.number().int().min(1), changes: z.record(z.string().max(60), z.union([z.string().max(2000), z.number(), z.null(), groupRows])) }),
  },
  // review #8: every state change on a certificate names the version it was made on
  field: { params: idParams.extend({ key: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/) }), query: companyQuery, body: expectedVersionBody },
  restore: { params: idParams.extend({ n: z.coerce.number().int().min(1) }), query: companyQuery, body: expectedVersionBody },
  action: { params: idParams, query: companyQuery, body: expectedVersionBody },
  list: {
    query: companyQuery.extend({
      invoiceId: uuid.optional(),
      batchId: uuid.optional(),
      status: z.enum(["pending", "draft", "final", "failed"]).optional(),
      certificateTypeId: uuid.optional(),
      flagged: z.enum(["true", "false"]).optional(),
      q: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
};

// ── certificate AI layers, A0 (plan.md §3) ───────────────────────────────────
export const aiSchemas = {
  company: { query: companyQuery },
  updateSettings: {
    query: companyQuery,
    body: z
      .object({
        enabled: z.boolean().optional(),
        autoAccept: z.boolean().optional(),
        autoAcceptThreshold: z.number().min(0.5).max(1).optional(),
        allowSynonyms: z.boolean().optional(),
        allowInvoiceGapFill: z.boolean().optional(),
        allowAiMatching: z.boolean().optional(),
        allowProductInference: z.boolean().optional(),
        allowWebLookup: z.boolean().optional(),
        fillVerifiedDirectly: z.boolean().optional(),
        rememberProductValues: z.boolean().optional(),
        webLookupMaxProductsPerCheck: z.number().int().min(0).max(100).optional(),
        webLookupDailyLimit: z.number().int().min(0).max(1000).optional(),
        webDomainAllowList: z.array(z.string().max(260)).max(50).optional(),
        companyId: uuid.optional(),
      })
      .strict(),
  },
};

// ── certificate AI layers, A1 — template field mapping (plan.md §5) ─────────
const probe = z.object({ lineId: z.string().max(40), charStart: z.number().int().min(0), charEnd: z.number().int().min(1), sampleValue: z.string().min(1).max(500) });
const labelContext = z
  .object({ columnHeader: z.string().max(200).nullable().optional(), rowCells: z.array(z.string().max(500)).max(30).optional(), rowIndex: z.number().int().optional() })
  .nullable()
  .optional();
export const mappingSchemas = {
  labelProposals: { params: idParams, query: companyQuery, body: z.object({ fields: z.array(probe).min(1).max(100) }) },
  mapFields: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      fields: z
        .array(
          z.object({
            key: z.string().max(60),
            label: z.string().max(120),
            lineId: z.string().max(40),
            sampleValue: z.string().max(500),
            groupKey: z.string().max(60).nullable().optional(),
            labelContext,
          })
        )
        .min(1)
        .max(200),
      groups: z.array(z.object({ key: z.string().max(60), label: z.string().max(120) })).max(20).optional(),
      keys: z.array(z.string().max(60)).max(200).optional(),
      sampleProductId: uuid.optional().nullable(),
    }),
  },
  suggestion: { params: idParams, query: companyQuery },
};

// Certificate AI layers A2 — the certificate data check (plan.md §6)
export const dataNeedSchemas = {
  compute: { params: idParams, query: companyQuery, body: z.object({ ai: z.boolean().optional() }).optional() },
  decide: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      decisions: z
        .array(
          z
            .object({
              // confirm_all (item 3): every estimated value of the invoice at once — no needId
              needId: uuid.optional(),
              action: z.enum(["accept", "edit", "reject", "reset", "confirm_all"]),
              value: z.string().max(500).nullable().optional(),
              applyTo: z.enum(["need", "line"]).optional(),
              saveToProduct: z.boolean().optional(),
            })
            .refine((d) => d.action === "confirm_all" || !!d.needId, { message: "needId is required", path: ["needId"] })
        )
        .min(1)
        .max(200),
    }),
  },
  synonym: {
    query: companyQuery,
    body: z.object({ canonical: z.string().min(3).max(300), alternative: z.string().min(3).max(300), companyId: uuid.optional() }),
  },
};

// Certificate AI layers A4 (plan.md §9)
const textOrNull = z.string().max(1000).nullable();
export const insightSchemas = {
  decideSynonym: {
    params: idParams,
    query: companyQuery,
    body: z.object({ decision: z.enum(["accept", "reject"]), synonyms: z.array(z.string().min(1).max(60)).max(8).optional(), companyId: uuid.optional() }),
  },
  productById: { params: idParams, query: companyQuery },
  saveProductData: {
    params: idParams,
    query: companyQuery,
    body: z.object({
      values: z.record(z.string().max(300), textOrNull).optional(),
      lists: z.record(z.string().max(300), z.array(z.record(z.string().max(100), textOrNull)).max(200)).optional(),
      companyId: uuid.optional(),
    }),
  },
  stats: { query: companyQuery.extend({ days: z.coerce.number().int().min(1).max(730).optional() }) },
};

// AI cost ledger reports (Certificates → AI). Dates are YYYY-MM-DD (UTC days).
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const costRange = companyQuery.extend({ from: day.optional(), to: day.optional() });
export const aiCostSchemas = {
  summary: { query: costRange },
  top: { query: costRange.extend({ limit: z.coerce.number().int().min(1).max(100).optional() }) },
  entity: { query: companyQuery.extend({ type: z.enum(["invoice", "template", "catalogue", "label"]), id: uuid }) },
  reconciliation: { query: z.object({ months: z.coerce.number().int().min(1).max(36).optional() }).passthrough() },
  setBilled: {
    params: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "use YYYY-MM") }),
    body: z.object({ billedUsd: z.coerce.number().min(0).max(1e9), note: z.string().trim().max(500).nullable().optional() }),
  },
};
