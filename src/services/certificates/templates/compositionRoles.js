// Phase 1 (28 Nov): in a Certificate of Composition the ingredient / amount table is the PRODUCT's
// composition — copied as stored (names, amounts, order, units, "ad 1 L"), never a lab result. Production
// QA: every ADDVET COC draft had 32 "Analysis result" blanks and its matrix cell said "تقرير المعمل ناقص",
// while the product held all 14 rows.
//
// A field in a COC's composition block (or a template titled "…Composition…") is re-classified in place:
//   the whole row ("Sorbitol  400,000 mg")      → composition_name, source {{name}} + {{concentration}}
//   the name only / the amount only            → composition_name / composition_amount
//   the basis line ("Each 1 L contains:")      → composition_basis (products.composition_basis)
// isLabResult / isBatchFact false, inference never (copying stored product data — AI composition stays
// forbidden). Spans never change, so a prepared or active version stays valid (fieldsHash ignores sources).
// A design whose rows were blanked word by word can't be re-mapped in place: it is listed (needsRemap).
import { prisma } from "../../../lib/prisma.js";
import { compositionRows } from "./autoMap.js";

export const COMPOSITION_ROLES = ["composition_name", "composition_amount", "composition_basis"];
const BASIS = /^\s*(?:Composition\s*:?\s*)?(?:(?:Each|Every)\s+[\d.,]*\s*\w+\s+contains\s*:?|Contains\s+per\s+\S+\s*:?|\(per\s+\w+\))\s*$/i;
const AMOUNT = /^(?:(?:ad|q\.?\s?s\.?(?:\s*to)?|up\s+to)\s+)?[\d.,]+\s*(?:mg|g|mcg|µg|μg|ug|IU|iu|mL|ml|L|%|ppm|kg)$/i;
const AMOUNT_TAIL = /\s+((?:(?:ad|q\.?\s?s\.?(?:\s*to)?|up\s+to)\s+)?[\d.,]+\s*(?:mg|g|mcg|µg|μg|ug|IU|iu|mL|ml|L|%|ppm|kg))\s*$/i;

/** Is this template a Certificate of Composition? (its type, or "Composition" in its name) */
export const isCompositionTemplate = (template) => template?.certificateType?.code === "COC" || /composition/i.test(String(template?.name || "")) || /composition/i.test(String(template?.certificateType?.name || ""));

/**
 * The role a field should have → { role, source, required } | null (not composition) | { needsRemap: true }
 * field: { lineId, charStart, charEnd, sampleValue }, lines: the version's lines
 */
export function compositionRoleOf(field, lines, rowsOf = compositionRows(lines)) {
  const line = lines.find((l) => l.id === field.lineId);
  if (!line) return null;
  const text = String(field.sampleValue || line.text.slice(field.charStart, field.charEnd)).trim();
  if (BASIS.test(text) || (/contains|per\s+(litre|liter|l|ml|kg|g)\b/i.test(text) && text.split(/\s+/).length <= 5 && !rowsOf.has(line.id))) {
    return { role: "composition_basis", source: { kind: "product", path: "compositionBasis" }, required: false };
  }
  const row = rowsOf.get(line.id);
  if (row === undefined) return null;
  const whole = line.text.trim();
  const required = row === 0;
  const name = `activeIngredients[${row}].name`;
  const conc = `activeIngredients[${row}].concentration`;
  if (AMOUNT.test(text)) return { role: "composition_amount", source: { kind: "product", path: conc }, required };
  if (text === whole && AMOUNT_TAIL.test(text)) return { role: "composition_name", source: { kind: "template", template: `{{product.${name}}}  {{product.${conc}}}` }, required };
  // a name: the row's text before its amount
  const tail = whole.match(AMOUNT_TAIL);
  const rowName = (tail ? whole.slice(0, tail.index) : whole).trim();
  if (text === rowName) return { role: "composition_name", source: { kind: "product", path: name }, required };
  // already reading its own row (autoMap: the amount's figure and unit apart) — only the role is missing
  const own = /^activeIngredients\[(\d+)\]\.(name|concentration|amountFigure|amountUnit)$/.exec(field.source?.kind === "product" ? field.source.path || "" : "");
  if (own && Number(own[1]) === row) return { role: own[2] === "name" ? "composition_name" : "composition_amount", source: field.source, required };
  // a word of a name or an amount ("Vitamin" of "Vitamin A", "10,000,000" of "10,000,000 IU"): blanked word by word
  return { needsRemap: true };
}

/**
 * Re-classify a version's composition fields in place. dryRun lists what would change.
 * → { versionId, changed: [{ key, from, to }], needsRemap: [key] }
 */
export async function applyCompositionRoles(versionId, { dryRun = false } = {}) {
  const v = await prisma.templateVersion.findUnique({ where: { id: versionId }, select: { id: true, lines: true, template: { select: { name: true, certificateType: { select: { code: true, name: true } } } }, fields: true } });
  if (!v || !isCompositionTemplate(v.template)) return { versionId, changed: [], needsRemap: [], skipped: "not a composition certificate" };
  const lines = v.lines || [];
  const rowsOf = compositionRows(lines);
  const changed = [];
  const needsRemap = [];
  for (const f of v.fields) {
    if (f.groupKey) continue;
    const r = compositionRoleOf(f, lines, rowsOf);
    if (!r) continue;
    if (r.needsRemap) {
      needsRemap.push(f.key);
      continue;
    }
    const same = f.role === r.role && JSON.stringify(f.source) === JSON.stringify(r.source) && !f.isLabResult && f.isBatchFact !== true;
    if (same) continue; // idempotent
    changed.push({ key: f.key, from: { role: f.role, source: f.source, isLabResult: f.isLabResult }, to: { role: r.role, source: r.source } });
    if (!dryRun) {
      await prisma.templateField.update({
        where: { id: f.id },
        data: { role: r.role, source: r.source, isLabResult: false, isBatchFact: false, inferencePolicy: "never", required: r.required, dataCategory: f.dataCategory === "batch_data" ? "product_data" : f.dataCategory },
      });
    }
  }
  return { versionId, changed, needsRemap };
}
