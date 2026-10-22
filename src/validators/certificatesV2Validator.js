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

export const versionSchemas = {
  byId: { params: idParams, query: companyQuery },
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
  upload: { query: companyQuery, body: z.object({ brandId: optionalUuid, country: optionalCountry, companyId: uuid.optional() }) },
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
  addItem: { params: idParams, query: companyQuery, body: z.object({ data: itemData.optional(), productId: uuid.optional().nullable() }) },
  updateItem: {
    params: itemParams,
    query: companyQuery,
    body: z.object({ data: itemData.optional(), productId: uuid.nullable().optional(), ignored: z.boolean().optional(), aiSuggestionId: uuid.optional() }),
  },
  itemById: { params: itemParams, query: companyQuery },
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
          z.object({
            needId: uuid,
            action: z.enum(["accept", "edit", "reject", "reset"]),
            value: z.string().max(500).nullable().optional(),
            applyTo: z.enum(["need", "line"]).optional(),
          })
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
