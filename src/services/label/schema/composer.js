// §3 — the OPEN discriminant-dictionary composer. This supersedes the earlier
// buildLabelSchema({ countryCode, authorityId, companyId }) instruction: that
// signature hardcoded one authority's structure by omitting discriminants
// entirely. Nothing here knows a discriminant or field NAME in advance —
// every one is discovered from whatever RegulatoryDocument.labelFieldSchema
// catalogs contributed (see catalogExtractor.js), which is how a second
// authority with a completely different taxonomy costs zero code changes.
import { z } from "zod";
import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { labelSchema, LocalizedText } from "./labelSchema.js";
import { readCatalogStripped } from "../regulatory/catalogReader.js";

const CORE_FIELD_KEYS = new Set(Object.keys(labelSchema.shape));
const REQUIREMENT_RANK = { required: 3, conditional: 2, optional: 1 };
const STRICTEST_REQUIREMENT = (a, b) => (REQUIREMENT_RANK[a] >= REQUIREMENT_RANK[b] ? a : b);

function catalogOnlyZodType(type, requiredLanguages) {
  if (Array.isArray(requiredLanguages) && requiredLanguages.length > 0) return LocalizedText;
  switch (type) {
    case "string": return z.string();
    case "string[]": return z.array(z.string());
    case "number": return z.number();
    case "object": return z.record(z.string(), z.any());
    default:
      throw new Error(`composer: catalog field declared an unsupported type "${type}".`);
  }
}

/**
 * §3. discriminants: an OPEN key -> value map, never named parameters — the
 * keys come from whatever the ingested documents declared; this function
 * never hardcodes one.
 *
 * Returns { fields, sourceDocumentIds, contributingDocuments,
 *           unrecognizedDiscriminantKeys }.
 */
// Tenant-scoped, per §3's own rule (Invariant #10's spirit extended to
// regulatory documents): a company-specific document is visible to that
// company and to every company via a global (companyId: null) document —
// never to an unrelated company. Shared by buildLabelSchema and
// getKnownDiscriminants so there's one query, not two copies to keep in sync.
async function loadCatalogDocuments({ countryCode, companyId, authorityId = null }) {
  const documents = await prisma.regulatoryDocument.findMany({
    where: {
      country: countryCode,
      status: "approved",
      ...(authorityId && { authority: authorityId }),
      OR: [{ companyId }, { companyId: null }],
    },
    orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
  });
  return documents
    .map((doc) => ({ doc, catalog: readCatalogStripped(doc.labelFieldSchema) }))
    .filter(({ catalog }) => catalog);
}

/**
 * The discriminant keys/values known for a country/company/authority, before
 * any caller-supplied discriminants map exists yet — deriveDiscriminants.js
 * needs this to attempt auto-matching against product data; buildLabelSchema
 * needs it (inline below) to validate the caller's map against reality.
 */
export async function getKnownDiscriminants({ countryCode, companyId, authorityId = null } = {}) {
  const catalogDocs = await loadCatalogDocuments({ countryCode, companyId, authorityId });
  const byKey = new Map();
  for (const { catalog } of catalogDocs) {
    for (const d of catalog.discriminants || []) if (!byKey.has(d.key)) byKey.set(d.key, d);
  }
  return [...byKey.values()];
}

export async function buildLabelSchema({ countryCode, companyId, authorityId = null, discriminants = {} } = {}) {
  if (!countryCode) throw new AppError("buildLabelSchema requires countryCode.", 400);

  const catalogDocs = await loadCatalogDocuments({ countryCode, companyId, authorityId });

  // Discriminants are DISCOVERED, not enumerated by us. Zero contributing
  // catalogs (or catalogs with zero discriminants) is a valid result.
  const knownDiscriminantKeys = new Set();
  for (const { catalog } of catalogDocs) {
    for (const d of catalog.discriminants || []) knownDiscriminantKeys.add(d.key);
  }
  const unrecognizedDiscriminantKeys = Object.keys(discriminants).filter((k) => !knownDiscriminantKeys.has(k));

  const satisfiesDiscriminants = (appliesToDiscriminants) => {
    if (!appliesToDiscriminants) return true;
    return Object.entries(appliesToDiscriminants).every(([dKey, allowedValues]) => {
      const suppliedValue = discriminants[dKey];
      return suppliedValue !== undefined && allowedValues.includes(suppliedValue);
    });
  };

  // Collect every satisfied field entry, per document, keyed by composed key.
  const byKey = new Map(); // key -> { entries: [{doc, field}], }
  for (const { doc, catalog } of catalogDocs) {
    for (const field of catalog.fields || []) {
      if (!satisfiesDiscriminants(field.appliesToDiscriminants)) continue;
      if (!byKey.has(field.key)) byKey.set(field.key, []);
      byKey.get(field.key).push({ doc, field });
    }
  }

  const composedFields = [];
  for (const [key, entries] of byKey) {
    const isCore = entries.some((e) => e.field.mapsToCoreField) || CORE_FIELD_KEYS.has(key);

    // §3 collision rule: type mismatch is NOT resolvable for catalog-only
    // fields (a core field's type is fixed by labelSchema.js and never
    // overridden here — see the module header on why refinement stops short
    // of rewriting zod internals).
    if (!isCore) {
      const types = new Set(entries.map((e) => e.field.type));
      if (types.size > 1) {
        const offenders = entries.map((e) => `${e.doc.id} (${e.field.type})`).join(" vs. ");
        throw new AppError(`buildLabelSchema: field "${key}" is declared with conflicting types across documents: ${offenders}.`, 409);
      }
    }

    const requirement = entries.map((e) => e.field.requirement).reduce(STRICTEST_REQUIREMENT);
    const appliesWhen = [...new Set(entries.map((e) => e.field.appliesWhen).filter(Boolean))]; // OR'd — any one condition being true satisfies the field
    const requiredLanguages = [...new Set(entries.flatMap((e) => e.field.requiredLanguages || []))];
    const formatSpec = entries.filter((e) => e.field.formatSpec).map((e) => ({ value: e.field.formatSpec, documentId: e.doc.id }));

    const zodType = isCore
      ? labelSchema.shape[key] || catalogOnlyZodType(entries[0].field.type, requiredLanguages) // a core-mapped key not in labelSchema.shape is a bug in the mapping validation upstream — fall back rather than throw mid-composition
      : catalogOnlyZodType(entries[0].field.type, requiredLanguages);

    composedFields.push({
      key,
      isCore,
      requirement,
      appliesWhen,
      requiredLanguages,
      formatSpec,
      zodType,
      contributedBy: entries.map((e) => ({
        documentId: e.doc.id,
        section: e.field.citation?.section ?? null,
        quote: e.field.citation?.quote ?? null,
        confidence: e.field.confidence ?? null,
      })),
      // For the strictest-requirement/most-recent-approval tie-break note in
      // §3 (example survives nowhere here — stripped at the catalog reader —
      // this timestamp is only used internally to pick a deterministic sort
      // order, never surfaced).
      _latestContributingDate: entries.reduce((max, e) => {
        const t = (e.doc.reviewedAt || e.doc.createdAt).getTime();
        return t > max ? t : max;
      }, 0),
    });
  }

  // Every CORE field is always in the composed list, even with zero catalog
  // contributions — it's already mandatory-by-construction in labelSchema.js.
  for (const key of CORE_FIELD_KEYS) {
    if (byKey.has(key)) continue;
    composedFields.push({
      key,
      isCore: true,
      requirement: "required",
      appliesWhen: [],
      requiredLanguages: [],
      formatSpec: [],
      zodType: labelSchema.shape[key],
      contributedBy: [],
      _latestContributingDate: 0,
    });
  }

  // Deterministic output: sort by key, then by contributing document date —
  // same inputs must always produce the same list (and therefore promptHash).
  composedFields.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a._latestContributingDate - b._latestContributingDate));
  for (const f of composedFields) delete f._latestContributingDate;

  const contributingDocuments = catalogDocs
    .filter(({ doc }) => composedFields.some((f) => f.contributedBy.some((c) => c.documentId === doc.id)))
    .map(({ doc }) => ({ id: doc.id, authority: doc.authority, effectiveDate: doc.effectiveDate }));

  return {
    fields: composedFields,
    sourceDocumentIds: catalogDocs.map(({ doc }) => doc.id),
    contributingDocuments,
    unrecognizedDiscriminantKeys,
  };
}

/**
 * Derives ONE Zod object from the composed field list — the single source
 * §3 requires. Never hand-write a second definition alongside this.
 */
export function toZodSchema(composedFields) {
  const shape = {};
  for (const f of composedFields) shape[f.key] = f.zodType;
  return z.object(shape);
}

/**
 * Derives the Gemini responseSchema from the SAME zod object toZodSchema
 * just built — mirrors schema/geminiSchema.js's own derivation for the
 * static labelSchema, so a composed schema is enforced exactly as strictly.
 */
export function toGeminiSchema(composedFields) {
  const jsonSchema = z.toJSONSchema(toZodSchema(composedFields));
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * §3's closed-schema enforcement: a key the model produced that is in
 * neither the core schema nor the composed catalog fields is REJECTED and
 * logged — never silently dropped, never silently kept (Invariant #7).
 */
export function rejectUnknownKeys(labelData, composedFields) {
  const known = new Set(composedFields.map((f) => f.key));
  const cleaned = {};
  const rejectedKeys = [];
  for (const [key, value] of Object.entries(labelData || {})) {
    if (known.has(key)) cleaned[key] = value;
    else rejectedKeys.push(key);
  }
  if (rejectedKeys.length > 0) {
    console.warn(`[composer] Rejected unknown key(s) from generated label data: ${rejectedKeys.join(", ")}`);
  }
  return { cleaned, rejectedKeys };
}
