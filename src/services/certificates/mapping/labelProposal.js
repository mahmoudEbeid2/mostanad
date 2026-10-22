// Label proposal for a marked value (plan.md §5.1 step 2) — code, no AI.
//  1. Same line: the text left of the value, when it reads as "Label:" /
//     "Label #" (trailing ':'/'#' stripped): "Batch No.:  AVVS1122005" → "Batch No.".
//  2. Column header: the nearest row above, in the value's column, printed in
//     a different font than the value (headers are styled; the values stacked
//     between them are not): PHARMAVET "EXPIRATION DATE" above "09/2028".
//     A generic header ("Specifications", "Results") defers to the row's own
//     label: "pH" + "Results" → "pH result" (from: "row_label").
//  3. Neither → null, and the AI is asked (one batched call, §5.2).
// The engine (fieldEngine `inspect`) supplies the layout context.

/** Normalised label (memory key, plan.md §4): lower-case, no punctuation, collapsed spaces. */
export function normLabel(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** snake_case key from a label: "Batch No." → "batch_no" (same rule as the UI). */
export function slugKey(text) {
  const s = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 50);
  return s || "field";
}

// "EXPIRATION DATE" → "Expiration date"; anything with lower-case letters is kept as printed
const sentence = (s) => (/\p{Ll}/u.test(s) ? s : s.charAt(0) + s.slice(1).toLocaleLowerCase("en-US"));
// NFKC: PDF text carries ligatures ("Speciﬁcations" with U+FB01)
const clean = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
const hasDigit = (s) => /\d/.test(s);
const MAX_LABEL = 80;

// separators between label/value pairs on one printed line
const CHUNK_SPLIT = /\s{2,}|\t|\s[•|·]\s|[•|]/;

/** Step 1 → the label, or null. */
export function sameLineLabel(lineText, charStart) {
  const before = String(lineText ?? "").slice(0, charStart);
  const chunks = before.split(CHUNK_SPLIT).map(clean).filter(Boolean);
  const last = chunks[chunks.length - 1];
  if (!last || !/[:#：]$/.test(last)) return null;
  const label = clean(last.replace(/[\s:#：]+$/, ""));
  return label && label.length <= MAX_LABEL && /\p{L}/u.test(label) ? label : null;
}

/**
 * ctx: { lineText, charStart, sampleValue, context?: { columnHeader, rowCells, rowIndex } }
 *  - columnHeader: text of the header found above (engine), or null
 *  - rowCells: the texts of the row's cells left → right (engine), rowIndex: the value's cell
 * → { label, from: "same_line" | "column_header" | null }
 */
export function proposeLabel({ lineText, charStart, context = null }) {
  const same = sameLineLabel(lineText, charStart);
  if (same) return { label: same, from: "same_line" };
  const header = clean(context?.columnHeader);
  if (header && /\p{L}/u.test(header) && header.length <= MAX_LABEL) {
    // a generic table header ("Specifications", "Results") says little: in a
    // table the row's own label (its first cell) names the value — "pH" +
    // "Results" → "pH result", "Producer" under "Specifications" → "Producer"
    if (GENERIC_HEADER_RE.test(header)) {
      const first = clean((context.rowCells || [])[0]);
      if (context.rowIndex > 0 && first && !hasDigit(first) && first.length <= MAX_LABEL) {
        return { label: RESULT_HEADER_RE.test(header) ? `${first} result` : first, from: "row_label" };
      }
      return { label: null, from: null }; // the value IS the row label — the AI names it
    }
    return { label: sentence(header).slice(0, MAX_LABEL), from: "column_header" };
  }
  return { label: null, from: null };
}

const GENERIC_HEADER_RE = /^(specifications?|descriptions?|values?|details?|results?|parameters?|tests?|analysis|analyses|limits?|requirements?|findings?)$/i;
const RESULT_HEADER_RE = /^(results?|findings?)$/i;

// plan.md §5.1 step 6: per-batch lab results aren't stored anywhere — they are
// asked during invoice review (A2). Code recognises the analysis-table layout
// (description | specification | RESULT, the specification a range or limit);
// the AI classifies the rest (category batch_data). A "Results" column alone
// is not enough: the same column often holds constituent amounts.
const RESULT_RE = /\b(results?|found|observed|actual|measured|test value)\b/i;
const SPEC_RE = /\d\s*[-–—]\s*\d|[≤≥<>]|\b(nlt|nmt|not less|not more|min|max|between)\b|%/i;

/** → true when the layout (or, without layout, the label) says this value is a per-batch result. */
export function looksLikeBatchResult({ label, context }) {
  if (context?.columnHeader !== undefined && context?.rowCells) {
    const cells = context.rowCells;
    const i = context.rowIndex;
    return RESULT_RE.test(context.columnHeader || "") && cells.length >= 3 && i >= 2 && SPEC_RE.test(cells[i - 1] || "");
  }
  return /\bresults?\b/i.test(String(label || ""));
}
