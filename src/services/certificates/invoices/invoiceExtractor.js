import crypto from "crypto";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { CertError } from "../errors.js";
import { INVOICE_HEADER_FIELDS, INVOICE_ITEM_FIELDS } from "./invoiceSchema.js";
import { dateValue } from "./dateNormalizer.js";
import { normalizeQuantity } from "./quantityNormalizer.js";
import { runLogged } from "../ai/aiRunLog.js";

// Invoice extraction (CERTIFICATES_V2_PLAN.md §9.1) — the ONLY AI call in the
// certificate pipeline. The invoice file goes to Gemini natively (inline data;
// pdf-parse would destroy the line table), through geminiClient (rate limit,
// retries, guard). The model transcribes what is printed — every field is
// nullable, nothing is inferred. Dates are normalised to ISO by code, only
// when unambiguous. A failure is a failure: no other model, no fallback.

const str = { type: "string", nullable: true };
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    // plan.md §6.1: the full text the model read, so later AI answers can be
    // checked verbatim against it (P2). First, so the fields below are copied from it.
    textContent: {
      type: "string",
      description: "every piece of text printed on the invoice, in reading order, page by page; each page starts with a line '=== Page N ==='",
    },
    header: {
      type: "object",
      properties: Object.fromEntries(INVOICE_HEADER_FIELDS.map((f) => [f.path, str])),
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...Object.fromEntries(INVOICE_ITEM_FIELDS.map((f) => [f.path, f.path === "lineNo" ? { type: "integer", nullable: true } : str])),
          extra: {
            type: "array",
            description: "other per-line columns printed on the invoice (e.g. registration no., weight)",
            items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
          },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" }, description: "anything unreadable or ambiguous" },
  },
  required: ["textContent", "header", "items"],
  propertyOrdering: ["textContent", "header", "items", "warnings"],
};

const PROMPT = [
  "Transcribe this commercial invoice into the JSON schema.",
  "Rules:",
  "- Copy values exactly as printed. Do not translate, reformat, complete or guess anything.",
  "- Use null for anything that is not printed on the invoice.",
  "- Dates: copy the printed text exactly (e.g. '11/2025', '15.04.2025', 'APR-2026'); never convert them.",
  "- items: one entry per product line, in printed order; lineNo is the printed line number or the 1-based position.",
  "- quantity: the number as printed; unit: its unit (KG, L, PCS…); packing: the pack size/description (e.g. '25KG BAG').",
  "- customerCountry: the destination/consignee country as printed.",
  "- Put anything unreadable or ambiguous in warnings.",
  "- textContent: transcribe ALL printed text exactly as printed (headers, every table row, footers), in reading order;",
  "  start each page with a line '=== Page N ===' (N = 1, 2, …). The cells of one table row stay on one line, separated by ' | '.",
].join("\n");

export const PROMPT_HASH = crypto.createHash("sha256").update(PROMPT + JSON.stringify(RESPONSE_SCHEMA)).digest("hex").slice(0, 16);

const clean = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

/** Model output → { header, items[] } in the stored shape (dates as { raw, iso }). */
export function shapeExtraction(out) {
  const h = out?.header || {};
  const header = {};
  for (const f of INVOICE_HEADER_FIELDS) header[f.path] = f.type === "date" ? dateValue(h[f.path]) : clean(h[f.path]);
  const items = (out?.items || []).map((it, i) => {
    const data = {};
    for (const f of INVOICE_ITEM_FIELDS) {
      if (f.path === "lineNo") continue;
      if (f.type === "date") data[f.path] = dateValue(it[f.path]);
      else if (f.path === "quantity") {
        // "1.250" is 1250 or 1.25 → null, raw kept, flagged (review #4)
        const q = normalizeQuantity(clean(it.quantity));
        data.quantity = q.value;
        data.quantityRaw = clean(it.quantity);
        if (q.ambiguous) data.quantityAmbiguous = true;
      } else data[f.path] = clean(it[f.path]);
    }
    data.extra = Object.fromEntries((it.extra || []).filter((e) => e?.label).map((e) => [String(e.label).trim(), clean(e.value)]));
    return { lineNo: Number.isInteger(it.lineNo) && it.lineNo > 0 ? it.lineNo : i + 1, data };
  });
  // line numbers must be unique per invoice
  const seen = new Set();
  let next = Math.max(0, ...items.map((x) => x.lineNo)) + 1;
  for (const it of items) {
    if (seen.has(it.lineNo)) it.lineNo = next++; // next free number after the printed ones
    seen.add(it.lineNo);
  }
  return { header, items, textContent: cleanText(out?.textContent) };
}

// Stored text (plan.md §6.1). Bounded so one odd file can't bloat the row; a
// page marker is added when the model left them out.
export const MAX_TEXT_CHARS = 200_000;
export function cleanText(t) {
  if (typeof t !== "string" || !t.trim()) return null;
  let s = t.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!/^=== Page \d+ ===/m.test(s)) s = `=== Page 1 ===\n${s}`;
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s;
}

/**
 * buffer + mimeType → { header, items, textContent, raw, provenance }
 * With `log.companyId` the call is recorded in ai_runs (plan.md §3.3).
 * Throws CertError EXTRACTION_FAILED with the provider's real message.
 */
export async function extractInvoice(buffer, mimeType, log = null) {
  const t0 = Date.now();
  let out;
  const call = () =>
    geminiClient.generateJson({
      model: MODELS.INVOICE_EXTRACT.id,
      temperature: MODELS.INVOICE_EXTRACT.temperature,
      thinkingBudget: MODELS.INVOICE_EXTRACT.thinkingBudget,
      contents: [{ inlineData: { mimeType, data: buffer.toString("base64") } }, PROMPT],
      schema: RESPONSE_SCHEMA,
      maxOutputTokens: 32768, // the full transcription (textContent) roughly doubles the output
    });
  const logged = () =>
    runLogged(
      {
        companyId: log.companyId,
        kind: "INVOICE_EXTRACT",
        promptHash: PROMPT_HASH,
        inputHash: crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16),
        entityType: "invoice",
        entityId: log.invoiceId ?? null,
        reason: "invoice upload",
      },
      call
    ).then((r) => r.result);
  try {
    out = await (log?.companyId ? logged() : call());
  } catch (err) {
    throw new CertError("EXTRACTION_FAILED", `Invoice extraction failed: ${err.message}`, err.statusCode || 502);
  }
  if (!out || !Array.isArray(out.items)) throw new CertError("EXTRACTION_FAILED", "Invoice extraction failed: the model returned no items array", 502);
  const shaped = shapeExtraction(out);
  return {
    ...shaped,
    raw: out,
    provenance: {
      modelId: MODELS.INVOICE_EXTRACT.id,
      promptHash: PROMPT_HASH,
      ms: Date.now() - t0,
      at: new Date().toISOString(),
      warnings: [
        ...(Array.isArray(out.warnings) ? out.warnings.map(String) : []),
        ...shaped.items.filter((x) => x.data.quantityAmbiguous).map((x) => `Line ${x.lineNo}: quantity "${x.data.quantityRaw}" is ambiguous (thousands or decimal separator) — enter the number in review`),
      ],
    },
  };
}
