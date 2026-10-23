import { headingsOf } from "./segmenter.js";
import { normalizeEvidence, normalizeWithMap, findOccurrences } from "../certificates/dataNeeds/evidenceVerifier.js";
import { fromSource, canonicalFull } from "../certificates/paths/sourcePath.js";

// Tier C, code only (plan.md §15.5): a certificate field → the section of the
// product's own catalogue block that holds it, matched by the section heading
// and the field's product path or label — no model, no reasoning. Every value
// is a verbatim slice of the block, and verifyBlockQuote is the one check every
// catalogue value goes through (code's and the A2 gap call's alike): the quote
// is in THAT block's text and the value is inside the quote.
// Pure: no I/O, never throws on bad input.

// product column / certificate meaning → the section headings that print it
const SECTIONS = {
  storage: ["STORAGE", "STORAGE CONDITION", "STORAGE CONDITIONS"],
  dosage: ["DOSAGE", "DOSAGE AND ADMINISTRATION", "DOSE", "HOW TO USE", "DIRECTIONS", "DIRECTIONS FOR USE", "ADMINISTRATION", "APPLICATION", "APPLICATION & DOSAGE"],
  withdrawalPeriod: ["WITHDRAWAL", "WITHDRAWAL TIME", "WITHDRAWAL TIMES", "WITHDRAWAL PERIOD", "WITHDRAWAL PERIODS"],
  packaging: ["PACKING", "PACKAGING", "PACK SIZE", "PACK SIZES", "PRESENTATION"],
  physicalForm: ["FORM"],
  productCode: ["CODE"],
  indications: ["INDICATIONS", "INDICATION", "BENEFITS", "FUNCTIONS"],
  activeIngredients: ["COMPOSITION", "ACTIVE INGREDIENTS", "ACTIVE INGREDIENT", "INGREDIENTS"],
  userSafety: ["PRECAUTIONS", "WARNINGS", "WARNING"],
  contraindications: ["CONTRAINDICATIONS", "CONTRAINDICATION"],
  targetSpecies: ["TARGET SPECIES"],
  description: ["DESCRIPTION"],
  shelfLife: ["SHELF LIFE"],
};
// a field label → the same meanings (first match wins; specific before generic)
const LABEL_RULES = [
  [/\bcontra-?indications?\b/, "contraindications"],
  [/\bwithdrawal\b/, "withdrawalPeriod"],
  [/\bshelf\s*life\b/, "shelfLife"],
  [/\bstor(age|e)\b/, "storage"],
  [/\b(dos(age|e)|administration|directions|how to use|mixing rate)\b/, "dosage"],
  [/\b(pack(ing|aging|age)?|pack size|presentation)\b/, "packaging"],
  [/\b(product|item|catalogue|article)\s*code\b|^code$/, "productCode"],
  [/\b(physical|dosage)\s*form\b|^form$/, "physicalForm"],
  [/\b(composition|active ingredients?|ingredients)\b/, "activeIngredients"],
  [/\b(target\s*)?species\b/, "targetSpecies"],
  [/\b(indications?|benefits|uses?)\b/, "indications"],
  [/\b(precautions?|warnings?|safety)\b/, "userSafety"],
  [/\bdescription\b/, "description"],
];
const ONE_LINE = new Set(["physicalForm", "productCode"]);
const COMPARATOR = /^[≥≤<>=±]+$/;
const STORE_SENTENCE = /^(?:[-•]\s*)?(store\b|keep (it )?away\b|keep in\b|protect from\b|do not store\b)/i;

const normLabel = (s) =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** "Assay, %" / "Pb (mg/kg)" / "Loss on drying , %" → "assay" / "pb" / "loss on drying" */
export const specItemKey = (item) => normLabel(String(item || "").replace(/\([^)]*\)/g, " ").replace(/[,:]?\s*%\s*$/, " ").replace(/%/g, " "));

/** The block's lines with their offsets ({ t, o, y } from the segmenter; geometry optional). */
function linesOf(block) {
  if (Array.isArray(block?.lines) && block.lines.length) return block.lines;
  let o = 0;
  return String(block?.text || "")
    .split("\n")
    .map((t) => {
      const line = { t, o };
      o += t.length + 1;
      return line;
    });
}

const isHeadingLine = (t) => {
  const cells = t.split("\t").map((c) => c.trim()).filter(Boolean);
  const hs = headingsOf(t);
  return hs.length > 0 && hs.length === cells.length;
};

/**
 * Block → sections [{ heading, start, end, lines: [{ t, o }] }] in reading order.
 * A section runs until the next heading line, or until the text jumps back up the
 * page (a new text frame — the banner, the next column). A line of several
 * headings ("FORM\tCODE") is a small table: each heading gets its cell of the next line.
 */
export function parseSections(block) {
  const lines = linesOf(block);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!isHeadingLine(l.t)) continue;
    const heads = headingsOf(l.t);
    if (heads.length > 1) {
      const next = lines[i + 1];
      if (!next || isHeadingLine(next.t)) continue;
      const cells = next.t.split("\t");
      let o = next.o;
      cells.forEach((c, k) => {
        if (heads[k] && c.trim()) out.push({ heading: heads[k], start: o, end: o + c.length, lines: [{ t: c, o }] });
        o += c.length + 1;
      });
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j];
      if (isHeadingLine(n.t)) break;
      const prev = body.length ? body[body.length - 1] : l;
      if (typeof n.y === "number" && typeof prev.y === "number" && n.y < prev.y - 1) break; // a new frame
      body.push(n);
    }
    if (body.length) out.push({ heading: heads[0], start: body[0].o, end: body[body.length - 1].o + body[body.length - 1].t.length, lines: body });
  }
  return out;
}

/** SPECIFICATIONS rows → [{ item, value, quote, start, end }]. Two pairs on one printed row are two rows. */
export function specRows(block) {
  const rows = [];
  for (const s of parseSections(block).filter((x) => x.heading.startsWith("SPECIFICATION"))) {
    for (const l of s.lines) {
      const cells = l.t.split("\t");
      let o = l.o;
      const pos = cells.map((c) => {
        const at = o;
        o += c.length + 1;
        return { c: c.trim(), at, end: at + c.length };
      });
      let i = 0;
      while (i < pos.length) {
        const item = pos[i++];
        const val = [];
        if (i < pos.length) val.push(pos[i++]);
        if (val.length && COMPARATOR.test(val[val.length - 1].c) && i < pos.length) val.push(pos[i++]);
        if (!item.c || !val.length) continue;
        const value = val.map((v) => v.c).join(" ");
        if (/^items?$|^parameters?$/i.test(item.c) && /^specifications?$/i.test(value)) continue; // the table's header row
        rows.push({ item: item.c, value, start: item.at, end: val[val.length - 1].end });
      }
    }
  }
  return rows.map((r) => ({ ...r, quote: String(block.text).slice(r.start, r.end) }));
}

/** The meaning of a field for the catalogue: its product column, else its label. */
export function meaningOf(field) {
  const full = field?.source?.kind === "product" ? canonicalFull(fromSource(field.source)) || "" : "";
  const rel = full.startsWith("product.") ? full.slice("product.".length) : "";
  const column = rel.split(/[.[]/)[0];
  const specKey = /^specifications\b/.test(rel) ? (rel.match(/(?:\.|\["?)([^."[\]]+)"?\]?$/)?.[1] || null) : null;
  if (column && SECTIONS[column]) return { meaning: column, specKey: null };
  const label = normLabel(field?.label);
  const rule = LABEL_RULES.find(([re]) => re.test(label));
  return { meaning: rule ? rule[1] : null, specKey: specKey || label || null };
}

/**
 * A certificate field → its catalogue value in this block, or null.
 * → { value, quote, start, end, section, page }
 * Order: a SPECIFICATIONS row named like the field (a specification column,
 * "Assay" → "≥ 50"), then the section of the field's meaning; storage also
 * from "Store …" sentences under PRECAUTIONS (many catalogues have no STORAGE section).
 */
export function findCatalogueValue(field, block) {
  if (!block?.text) return null;
  const { meaning, specKey } = meaningOf(field);
  const text = String(block.text);
  const hit = (value, start, end, section) => ({ value: value.trim(), quote: text.slice(start, end), start, end, section, page: block.page });
  if (specKey && (!meaning || field?.source?.path?.startsWith?.("specifications"))) {
    const want = specItemKey(specKey);
    const row = want && specRows(block).find((r) => specItemKey(r.item) === want);
    if (row) return hit(row.value, row.start, row.end, "SPECIFICATIONS");
  }
  if (!meaning) return null;
  const sections = parseSections(block);
  const sec = sections.find((s) => SECTIONS[meaning].includes(s.heading));
  if (sec) {
    const lines = ONE_LINE.has(meaning) ? sec.lines.slice(0, 1) : sec.lines;
    const value = lines.map((l) => l.t.replace(/\t/g, " ").trim()).filter(Boolean).join("\n");
    if (value) return hit(value, lines[0].o, lines[lines.length - 1].o + lines[lines.length - 1].t.length, sec.heading);
  }
  if (meaning === "storage") {
    // "Store in a cool and dry place." under PRECAUTIONS — the first run of storage sentences
    for (const s of sections.filter((x) => SECTIONS.userSafety.includes(x.heading))) {
      // the section's sentences in order (several per line, or one per line), then the first run of storage ones
      const sentences = s.lines.flatMap((l) =>
        [...l.t.matchAll(/[^.!]+[.!]?/g)]
          .map((m) => ({ s: m[0].trim(), at: l.o + m.index + (m[0].length - m[0].trimStart().length) }))
          .filter((x) => x.s)
      );
      const first = sentences.findIndex((x) => STORE_SENTENCE.test(x.s));
      if (first < 0) continue;
      let last = first;
      while (last + 1 < sentences.length && STORE_SENTENCE.test(sentences[last + 1].s)) last++;
      // the value is the verbatim slice from the first storage sentence to the last (its leading bullet dropped)
      const start = sentences[first].at + (sentences[first].s.match(/^[-•]\s*/)?.[0].length || 0);
      const end = sentences[last].at + sentences[last].s.length;
      return hit(text.slice(start, end), start, end, s.heading);
    }
  }
  return null;
}

/**
 * The one check for a catalogue value: `quote` is in THIS block's text and
 * `value` is inside the quote (both after the evidence normalisation — case,
 * dashes, whitespace/tabs). → { ok, quote (as printed), start, end, page } | { ok: false, reason }
 */
export function verifyBlockQuote(block, quote, value) {
  if (!block?.text) return { ok: false, reason: "the product has no catalogue block" };
  const q = String(quote ?? "").trim();
  const v = String(value ?? "").trim();
  if (!q || !v) return { ok: false, reason: "a quote and a value are needed" };
  if (!normalizeEvidence(q).includes(normalizeEvidence(v))) return { ok: false, reason: "the value is not inside the quote" };
  const occ = findOccurrences(normalizeWithMap(block.text), q);
  if (!occ.length) return { ok: false, reason: "the quote is not in this product's catalogue block" };
  return { ok: true, quote: block.text.slice(occ[0].start, occ[0].end), start: occ[0].start, end: occ[0].end, page: block.page };
}
