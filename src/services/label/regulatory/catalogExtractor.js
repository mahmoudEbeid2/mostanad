// Ingestion overhaul §2 — the one-pass extraction call: a regulatory document
// (PDF, fed natively, whole document, never chunked) produces BOTH its full
// text and its label-field catalog (discriminants + fields) in a single Gemini
// call. Mechanisms live here in code; content (discriminant names, field
// wording, thresholds) lives entirely in what the model reads off THIS
// document — nothing authority-specific is hardcoded below.
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { labelSchema } from "../schema/labelSchema.js";

export const CATALOG_VERSION = 1;

// The composer (schema/composer.js) needs to know WHICH core field a catalog
// entry refines, not just that it does — `mapsToCoreField: true` alone
// doesn't say which one. The model names it directly (mapsToCoreFieldKey);
// this is the same closed set ruleCompiler.js validates targetPath against.
const CORE_FIELD_KEYS = new Set(Object.keys(labelSchema.shape));

// Deterministic, script-agnostic (Unicode letters/numbers survive; everything
// else becomes "_") — a slug is a pure function of the document's own wording,
// never of the model's output ORDER, so the same document text always yields
// the same slug regardless of which run produced it. This is deliberately NOT
// asked of the model: an LLM's own "give me a stable slug" is not guaranteed
// byte-identical across two extraction runs of the same document, and §2
// requires stability across re-ingestion.
export function slugify(text) {
  const base = (text || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return base.slice(0, 64) || "field";
}

// Resolves slug collisions deterministically by citation position (startIndex
// in the persisted text) rather than by array order — array order is the
// model's, which is not guaranteed stable across two runs of the same
// document; character offsets into a fixed, already-verified text are.
function assignStableSlugs(entries, getLabel, getStartIndex) {
  const withBase = entries.map((e, i) => ({ e, base: slugify(getLabel(e)), start: getStartIndex(e), i }));
  const byBase = new Map();
  for (const item of withBase) {
    if (!byBase.has(item.base)) byBase.set(item.base, []);
    byBase.get(item.base).push(item);
  }
  // Keyed by the original entry object reference (each is unique) — set once
  // here per collision group, read back below for every entry.
  const slugOf = new Map();
  for (const [base, items] of byBase) {
    items.sort((a, b) => a.start - b.start || a.i - b.i);
    items.forEach((item, idx) => {
      slugOf.set(item.e, idx === 0 ? base : `${base}_${idx + 1}`);
    });
  }
  const result = new Map();
  for (const item of withBase) result.set(item.e, slugOf.get(item.e));
  return result;
}

// §2 hard rule, as originally specified: the citation's SELF-REPORTED
// startIndex/endIndex slice of the persisted text must equal its quote
// exactly. Kept and exported/tested as a strict, standalone check — it is
// correct on any citation whose indices are actually trustworthy (e.g. a
// hand-built test fixture). It is NOT what the live pipeline uses to verify
// a model's citation — see locateCitation below and the comment there for
// why.
export function citationSliceMatches(text, citation) {
  if (!citation || typeof citation.startIndex !== "number" || typeof citation.endIndex !== "number" || typeof citation.quote !== "string") {
    return false;
  }
  if (citation.startIndex < 0 || citation.endIndex > text.length || citation.startIndex >= citation.endIndex) return false;
  return text.slice(citation.startIndex, citation.endIndex) === citation.quote;
}

// Live-verified against a real 18-page bilingual SFDA document (2026-09-13):
// Gemini's self-reported startIndex/endIndex on its own ~18k-character output
// are NOT trustworthy — every single citation's claimed offset was wrong, by
// a delta that GREW through the document (≈250 chars early, ≈2900 chars by
// the end), while 36/38 quotes were still byte-for-byte correct substrings of
// the text at their ACTUAL (different) position. LLMs estimate character
// positions in their own long output; they don't measure them. Trusting the
// self-reported index (citationSliceMatches above) would have discarded a
// real, usable catalog entirely.
//
// This still enforces invariant 4 in full — "a citation not verifiable
// verbatim in its source is rejected" — it just verifies the QUOTE, and
// computes the index itself instead of trusting the model's arithmetic. A
// citation whose quote doesn't appear verbatim anywhere in `text` is still
// discarded, never repaired past that.
//
// Known limitation: if the exact same quote string appears more than once in
// the document, this attaches it to the FIRST occurrence — the model rarely
// names which one it meant, and there is no reliable way to recover that
// without the offsets we just established we can't trust. A field/discriminant
// citation this ambiguous is a real (rare) accuracy gap, not a crash risk.
export function locateCitation(text, citation) {
  if (!citation || typeof citation.quote !== "string" || !citation.quote.trim()) return null;
  const startIndex = text.indexOf(citation.quote);
  if (startIndex === -1) return null;
  return { ...citation, startIndex, endIndex: startIndex + citation.quote.length };
}

// Gemini's responseSchema is a JSON-Schema SUBSET that does not support
// $ref/$defs (unlike RULE_SCHEMA/AUDIT_SCHEMA elsewhere in this codebase,
// every field below is inlined for the same reason) — CITATION_SCHEMA is
// spread into every place a citation is needed rather than referenced.
const CITATION_SCHEMA = {
  type: "object",
  properties: {
    section: { type: "string" },
    quote: { type: "string", description: "MUST be an exact, verbatim substring of the returned `text` field — copy-paste, not paraphrase." },
    startIndex: { type: "number", description: "Character offset where `quote` begins in the returned `text` field." },
    endIndex: { type: "number", description: "Character offset where `quote` ends in the returned `text` field." },
  },
  required: ["quote", "startIndex", "endIndex"],
};

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The COMPLETE, unabridged document text, exactly as written. Preserve headings, lists, and tables as markdown. Do not summarize." },
    documentLanguages: { type: "array", items: { type: "string" }, description: "ISO-ish short codes for every language the document is written in, e.g. ['ar','en']." },
    discriminants: {
      type: "array",
      description: "Axes this document itself distinguishes label requirements by (e.g. a product category, a species group, a claim type) — DISCOVERED from the document's own structure, not a fixed list you're given. A document with no such axes should return an empty array.",
      items: {
        type: "object",
        properties: {
          labelInDocument: { type: "string", description: "The exact wording this document uses for this axis." },
          values: {
            type: "array",
            items: {
              type: "object",
              properties: {
                labelInDocument: { type: "string" },
                citation: CITATION_SCHEMA,
              },
              required: ["labelInDocument", "citation"],
            },
          },
          confidence: { type: "number" },
          citation: CITATION_SCHEMA,
        },
        required: ["labelInDocument", "values", "confidence", "citation"],
      },
    },
    fields: {
      type: "array",
      description: "Every distinct label field this document requires, permits, or constrains.",
      items: {
        type: "object",
        properties: {
          mapsToCoreField: { type: "boolean" },
          mapsToCoreFieldKey: { type: ["string", "null"], description: `When mapsToCoreField is true, MUST be exactly one of: ${[...CORE_FIELD_KEYS].join(", ")}. null when mapsToCoreField is false.` },
          labelInDocument: { type: "string" },
          type: { type: "string", enum: ["string", "string[]", "number", "object"] },
          requirement: { type: "string", enum: ["required", "conditional", "optional"] },
          appliesWhen: { type: ["string", "null"], description: "Free-text restatement of the condition, for a human reader. If the condition names a discriminant value you ALSO extracted above, appliesToDiscriminants (not this field) is what the composer actually filters on — this must never be the ONLY place the condition is recorded." },
          appliesToDiscriminants: { type: "object", description: "REQUIRED whenever this field's condition names a value of a discriminant you extracted above — e.g. if appliesWhen is \"X = imported\" and you extracted a discriminant with a value literally meaning 'imported', this MUST be { \"<that discriminant's labelInDocument>\": [\"<that value's labelInDocument>\"] }. Empty object {} ONLY when the field always applies, or when its condition genuinely does not correspond to any extracted discriminant value (e.g. a condition on something you didn't model as a discriminant)." },
          formatSpec: { type: ["string", "null"] },
          requiredLanguages: { type: "array", items: { type: "string" } },
          example: {
            type: ["object", "null"],
            properties: { text: { type: "string" }, illustrative: { type: "boolean" } },
          },
          confidence: { type: "number" },
          citation: CITATION_SCHEMA,
        },
        required: ["mapsToCoreField", "mapsToCoreFieldKey", "labelInDocument", "type", "requirement", "appliesToDiscriminants", "confidence", "citation"],
      },
    },
  },
  required: ["text", "documentLanguages", "discriminants", "fields"],
};

function buildPrompt({ title, authority, country }) {
  return `
You are performing a single-pass extraction of a regulatory document for a veterinary/animal-feed label validation system.

Document: "${title || "Untitled"}" — Authority: ${authority || "Unknown"} — Country: ${country || "Unknown"}

Produce TWO things from the attached document in one response:

1. "text": the COMPLETE, unabridged document text, exactly as written, in every language it appears. Preserve headings, lists, and tables as markdown. Do not summarize or omit anything.

2. A label-field catalog discovered from this specific document:
   - "discriminants": axes THIS document itself uses to vary label requirements (e.g. it might require different fields for different product categories, species groups, or claim types). Do not assume any particular set of axes — discover them from how the document is actually organized. A document with no such axes should return an empty array; that is a valid, expected result, not an error.
   - "fields": every distinct label field this document requires, permits, or restricts, whether or not it corresponds to a field you'd expect on a generic label. If a field genuinely corresponds to one of these existing core fields: ${[...CORE_FIELD_KEYS].join(", ")} — set "mapsToCoreField": true and "mapsToCoreFieldKey" to that EXACT name. Otherwise set "mapsToCoreField": false and "mapsToCoreFieldKey": null. Do not force a mapping that isn't a real match.

CRITICAL RULES:
- Every "citation.quote" MUST be an EXACT, VERBATIM substring of the "text" you return in this same response — copy-paste the characters, do not paraphrase, translate, or normalize whitespace. "citation.startIndex"/"citation.endIndex" MUST be the exact character offsets of that quote WITHIN the "text" you return. A discriminant, value, or field you cannot support with a real quote-and-offset pair from your own "text" should not be produced at all.
- "example.text" (when present) illustrates FORMAT ONLY (e.g. "state a numeric value followed by a unit, like '5 mg'") — never copy a real value from the document as if it were this product's data. Mark it "illustrative": true.
- Do not invent discriminants or fields that aren't actually in the document. An empty "discriminants" array is a correct answer for a document with no such axes.
- STRUCTURE EVERY CONDITION, NOT JUST DESCRIBE IT. Whenever a field's "appliesWhen" names a value you ALSO extracted as one of "discriminants[].values[]", you MUST ALSO set "appliesToDiscriminants" to point at it — never leave a machine-checkable condition sitting only in free text. Worked example: if you extracted a discriminant with labelInDocument "Origin" and a value with labelInDocument "Imported", and a field is only required "when Origin is Imported", that field's entry MUST be:
  { "appliesWhen": "Origin = Imported", "appliesToDiscriminants": { "Origin": ["Imported"] }, "requirement": "conditional", ... }
  A field whose condition does NOT correspond to any discriminant value you extracted (e.g. a condition on something you chose not to model as a discriminant) may leave "appliesToDiscriminants" as {} — but check first whether it actually IS one of your discriminants before concluding that.
- If you find yourself writing a condition in "appliesWhen" that mentions the same words as a discriminant/value you already extracted, that is the signal to go back and fill in "appliesToDiscriminants" — do not submit a field with a populated "appliesWhen" and an empty "appliesToDiscriminants" without first checking this.

Return ONLY the JSON object matching the schema. No markdown, no commentary.
  `.trim();
}

/**
 * The one-pass extraction (§2). `fileInlineDataPart` is the raw Gemini
 * `{ inlineData: { data, mimeType } }` part for the native PDF — this module
 * owns the instruction text (buildPrompt) rather than taking a pre-built
 * `contents` array, so the citation/schema contract stays in one place.
 * Returns { text, catalog } — `catalog` is the FULL reader's shape (see
 * catalogReader.js for the stripped variant used by generation).
 */
export async function extractTextAndCatalog(fileInlineDataPart, { title, authority, country } = {}) {
  const contents = [fileInlineDataPart, { text: buildPrompt({ title, authority, country }) }];
  const response = await geminiClient.generateJson({
    ledger: { feature: "regulatory.ingest" },
    model: MODELS.EXTRACT_WITH_CATALOG.id,
    contents,
    schema: EXTRACTION_SCHEMA,
    temperature: MODELS.EXTRACT_WITH_CATALOG.temperature,
    thinkingBudget: MODELS.EXTRACT_WITH_CATALOG.thinkingBudget,
    maxOutputTokens: 65536,
  });

  const text = typeof response.text === "string" ? response.text : "";
  if (!text.trim()) {
    throw new Error("Extraction produced no text — refusing to store an empty regulatory document.");
  }

  const rawDiscriminants = Array.isArray(response.discriminants) ? response.discriminants : [];
  const rawFields = Array.isArray(response.fields) ? response.fields : [];

  let discarded = 0;

  // Fields: verify+repair citation, then assign a stable slug from
  // labelInDocument (using the REPAIRED index — the model's own is untrusted).
  const verifiedFields = rawFields
    .map((f) => {
      const citation = locateCitation(text, f.citation);
      return citation ? { ...f, citation } : null;
    })
    .filter((f) => {
      if (!f) { discarded++; return false; }
      return true;
    });
  const fieldSlugs = assignStableSlugs(verifiedFields, (f) => f.labelInDocument, (f) => f.citation.startIndex);
  const fields = verifiedFields.map((f) => {
    // A model-claimed core mapping is only honored if it names a REAL core
    // field — same discipline as ruleCompiler's targetPath check. An invalid
    // or missing key downgrades this to a catalog-only field (its own
    // deterministic slug) rather than silently trusting an unverified name.
    const mapsToCoreField = !!f.mapsToCoreField && CORE_FIELD_KEYS.has(f.mapsToCoreFieldKey);
    return {
    key: mapsToCoreField ? f.mapsToCoreFieldKey : fieldSlugs.get(f),
    mapsToCoreField,
    labelInDocument: f.labelInDocument,
    type: f.type,
    requirement: f.requirement,
    appliesWhen: f.appliesWhen ?? null,
    appliesToDiscriminants: f.appliesToDiscriminants || null,
    formatSpec: f.formatSpec ?? null,
    requiredLanguages: Array.isArray(f.requiredLanguages) ? f.requiredLanguages : [],
    example: f.example || null,
    confidence: typeof f.confidence === "number" ? f.confidence : null,
    citation: f.citation,
    };
  });

  // Discriminants: verify+repair the discriminant's own citation, then each
  // value's citation independently. A discriminant that ends up with zero
  // surviving values is dropped entirely — it can no longer scope anything.
  const discriminants = [];
  for (const d0 of rawDiscriminants) {
    const dCitation = locateCitation(text, d0.citation);
    if (!dCitation) { discarded++; continue; }
    const d = { ...d0, citation: dCitation };
    const rawValues = Array.isArray(d.values) ? d.values : [];
    const verifiedValues = rawValues
      .map((v) => {
        const citation = locateCitation(text, v.citation);
        return citation ? { ...v, citation } : null;
      })
      .filter((v) => {
        if (!v) { discarded++; return false; }
        return true;
      });
    if (verifiedValues.length === 0) { discarded++; continue; }

    const dKey = slugify(d.labelInDocument);
    const valueSlugs = assignStableSlugs(verifiedValues, (v) => v.labelInDocument, (v) => v.citation.startIndex);
    discriminants.push({
      key: dKey,
      labelInDocument: d.labelInDocument,
      confidence: typeof d.confidence === "number" ? d.confidence : null,
      citation: d.citation,
      values: verifiedValues.map((v) => ({
        key: valueSlugs.get(v),
        labelInDocument: v.labelInDocument,
        citation: v.citation,
      })),
    });
  }

  // Remap fields' appliesToDiscriminants (keyed by the model's labelInDocument
  // strings) onto the deterministic slugs we just assigned, dropping any
  // reference to a discriminant/value that didn't survive verification —
  // never silently keeping an appliesToDiscriminants pointer to nothing.
  const discriminantKeyByLabel = new Map(discriminants.map((d) => [d.labelInDocument, d]));
  for (const f of fields) {
    if (!f.appliesToDiscriminants) continue;
    const remapped = {};
    for (const [dLabel, valueLabels] of Object.entries(f.appliesToDiscriminants)) {
      const d = discriminantKeyByLabel.get(dLabel);
      if (!d) continue;
      const valueKeys = (Array.isArray(valueLabels) ? valueLabels : [valueLabels])
        .map((vLabel) => d.values.find((v) => v.labelInDocument === vLabel)?.key)
        .filter(Boolean);
      if (valueKeys.length > 0) remapped[d.key] = valueKeys;
    }
    f.appliesToDiscriminants = Object.keys(remapped).length > 0 ? remapped : null;
  }

  const catalog = {
    catalogVersion: CATALOG_VERSION,
    authority: authority || null,
    countryCode: country || null,
    documentLanguages: Array.isArray(response.documentLanguages) ? response.documentLanguages : [],
    extractedAt: new Date().toISOString(),
    modelId: MODELS.EXTRACT_WITH_CATALOG.id,
    coverage: {
      discriminantsExtracted: discriminants.length,
      fieldsExtracted: fields.length,
      entriesDiscardedForBadCitation: discarded,
      textCharsTotal: text.length,
    },
    discriminants,
    fields,
  };

  return { text, catalog };
}
