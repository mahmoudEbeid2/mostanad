// Template readiness (26 Nov production test, "CALCIUT printed DOXYPHARMA's batch"): a design
// can only make certificates once every place that changes from one product / batch to the
// next is either a marked field or confirmed by a person as "static on purpose". This finds
// the text that LOOKS variable and is neither — by code, from the converted design's lines.
//
//   batch    — a batch / lot code (letters + digits: HSPhar02509001)
//   date     — 09/2025, 12-03-2026, 2026-03-12, Mar 2026
//   quantity — a number with a unit (500 mg, 1KG, 102.0%, 0.64 g/100 mL)
//   result   — a row of an analysis / composition table (after its test name), a pH value
//   value    — what is printed under a header that names product data (CATEGORY, PACKAGING…)
//
// Pure: no database. readinessService.js reads the version and its confirmations.

const BATCH_RE = /(?<![\w@./])(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9-]{5,}(?![\w@])|(?<![\w@./])\d{2,}[A-Za-z]{1,4}\d{2,}[A-Za-z0-9]*(?![\w@])/g;
const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const DATE_RES = [
  /(?<![\w/.-])\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?![\w/.-])/g,
  /(?<![\w/.-])(?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}(?![\w/.-])/g,
  /(?<![\w/.-])(?:19|20)\d{2}[/.-](?:0?[1-9]|1[0-2])(?:[/.-]\d{1,2})?(?![\w/.-])/g,
  new RegExp(`(?<![\\w])(?:\\d{1,2}[\\s-])?(?:${MONTHS})\\.?[\\s,-]+(?:19|20)\\d{2}(?![\\w])`, "gi"),
];
const UNIT = "mg|MG|mcg|µg|ug|g|G|gm|gr|kg|KG|Kg|ml|mL|ML|l|L|lt|ltr|LTR|iu|IU|ppm|ppb|cfu|CFU|%";
const QTY_RE = new RegExp(`(?<![\\w.])\\d+(?:[.,]\\d+)?\\s?(?:${UNIT})(?![A-Za-z])(?:\\s?\\/\\s?\\d*\\s?(?:${UNIT}|kg|ml|l))?`, "g");
const PH_RE = /\bpH\b\s*[:=]?\s*(\d+(?:[.,]\d+)?)(?!\s*[–-]\s*\d)/g;

// headers whose values change per product / batch, and those that don't (they still take a column)
const VARIABLE_HEADERS = [
  [/\bBATCH(?!\s+SIZE)(?:\s+(?:NO\.?|NUMBER))?\b|\bLOT(?!\s+SIZE)(?:\s+(?:NO\.?|NUMBER))?\b|\bB\.?\s?NO\b/i, "batch", "Batch number"],
  [/\bEXPIR(?:Y|ATION)(?:\s+DATE)?\b|\bEXP\.?\s*DATE\b/i, "date", "Expiry date"],
  [/\b(?:MANUFACTUR(?:ING|E)|PRODUCTION|MFG\.?)(?:\s+DATE)?\b/i, "date", "Manufacturing date"],
  [/\bCATEGORY\b/i, "value", "Category"],
  [/\bPACK(?:AGING|ING)(?:\s+SIZE)?\b|\bPACK\s+SIZE\b|\bNET\s+CONTENTS?\b/i, "value", "Packaging"],
  [/\bDOSAGE\s+FORM\b|\bFORM\b/i, "value", "Form"],
  [/\bPRODUCT(?:\s+NAME)?\b/i, "value", "Product name"],
  [/\bBATCH\s+SIZE\b|\bLOT\s+SIZE\b|\bQUANTITY\b|\bQTY\b/i, "quantity", "Batch size"],
  [/\bSHELF\s+LIFE\b/i, "value", "Shelf life"],
];
// "Label: value" on one line — a document's own number and dates change on every certificate
const INLINE_VARIABLE = [
  [/\bDOC(?:UMENT)?\s*(?:#|NO\.?|NUMBER)|\bCERTIFICATE\s*(?:#|NO\.?|NUMBER)|\bREPORT\s*(?:#|NO\.?)|\bREF(?:ERENCE)?\.?\s*(?:#|NO\.?)|\bCOA\s*(?:#|NO\.?)/i, "batch", "Document number"],
  [/\b(?:ISSUE|ISSUED|ANALYSIS|RELEASE|REPORT|TEST(?:ING)?)\s+DATE\b|\bDATE\s+OF\s+(?:ISSUE|ANALYSIS)\b|^\s*DATE\s*$/i, "date", "Issue date"],
];
// columns of a header row that hold the same text on every certificate
const STATIC_HEADERS = [/\b(?:COUNTRY\s+OF\s+)?ORIGIN\b/i, /\bSTORAGE(?:\s+CONDITIONS?)?\b/i, /\bEXPORTER(?:\s+COMPANY)?\b/i, /\bIMPORTER(?:\s+COMPANY)?\b/i, /\bMANUFACTURER\b/i, /\bSUPPLIER\b/i, /\bADDRESS\b/i];
const RESULTS_HEADER = /\bRESULTS?\b|\bCOMPOSITION\b|\bINGREDIENTS?\b|\bEACH\s+\d*\s*(?:ML|G|KG|L)\s+CONTAINS\b/i;
// a results-table row starts with its test name (kept); what follows is product-specific
const TEST_NAMES = /^\s*(?:Appearance|Identi(?:fi|ﬁ)cation|Description|Colou?r|Odou?r|Clarity|Solubility|pH|Assay|Sterility|Pyrogens?|Endotoxins?|Moisture|Water(?:\s+content)?|Loss\s+on\s+drying|Density|Specific\s+gravity|Viscosity|Particle\s+size|Microbial[^:]*|Heavy\s+metals|Total\s+[A-Za-z]+(?:\s+count)?|Constituents?|Composition|Active(?:\s+ingredients?)?|Content|Purity|Residue[^:]*|Ash|Fat|Protein|Fibre|Fiber)\b\s*(?:\([^)]*\))?\s*/i;
const STATIC_ROWS = /^\s*(?:\*|Producer|Manufacturer|Manufactured\s+by|Exporter|Address|Tel|Fax|E-?mail|www\.|Signature|Approved\s+by|Checked\s+by|QC\s+Manager|Quality)/i;

const KIND_LABEL = { batch: "Batch number", date: "Date", quantity: "Quantity / pack", result: "Analysis result", value: "Product data" };
export const KIND_AR = { batch: "رقم التشغيلة", date: "تاريخ", quantity: "كمية / عبوة", result: "نتيجة تحليل / تركيب", value: "بيانات منتج" };

export const areaId = (lineId, s, e) => `${lineId}:${s}-${e}`;
const words = (text) => [...text.matchAll(/\S+/g)].map((m) => ({ s: m.index, e: m.index + m[0].length, t: m[0] }));
const overlaps = (a, b) => a.s < b.e && b.s < a.e;
const trimSpan = (text, s, e) => {
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return [s, e];
};

function patternSpans(text) {
  const out = [];
  const push = (s, e, kind) => out.push({ s, e, kind });
  for (const re of DATE_RES) for (const m of text.matchAll(re)) push(m.index, m.index + m[0].length, "date");
  for (const m of text.matchAll(QTY_RE)) push(m.index, m.index + m[0].length, "quantity");
  for (const m of text.matchAll(BATCH_RE)) {
    if (/^(?:ISO|GMP|HACCP|HPLC|www)/i.test(m[0]) || /^\d+(?:st|nd|rd|th)$/i.test(m[0])) continue;
    if (out.some((x) => overlaps(x, { s: m.index, e: m.index + m[0].length }))) continue; // 1KG / 09/2025 already
    push(m.index, m.index + m[0].length, "batch");
  }
  for (const m of text.matchAll(PH_RE)) {
    const s = m.index + m[0].lastIndexOf(m[1]);
    push(s, s + m[1].length, "result");
  }
  return out;
}

/** A header row's phrases with their estimated x span (characters are spread evenly over the line's box). */
function headerColumns(h) {
  const per = h.box.w / Math.max(1, h.text.length);
  const cols = [];
  const take = (re, kind, label) => {
    const m = new RegExp(re.source, "i").exec(h.text);
    if (m && !cols.some((c) => m.index < c.e && c.s < m.index + m[0].length)) cols.push({ s: m.index, e: m.index + m[0].length, x0: h.box.x + m.index * per, x1: h.box.x + (m.index + m[0].length) * per, kind, label });
  };
  for (const [re, kind, label] of VARIABLE_HEADERS) take(re, kind, label);
  for (const re of STATIC_HEADERS) take(re, "static", null);
  return cols.sort((a, b) => a.s - b.s);
}

/** The header column a word of a value row sits under (largest x overlap), or null. */
function columnOf(cols, row, w) {
  const per = row.box.w / Math.max(1, row.text.length);
  const x0 = row.box.x + w.s * per;
  const x1 = row.box.x + w.e * per;
  let best = null;
  let bestOv = 0;
  for (const c of cols) {
    const ov = Math.min(x1, c.x1) - Math.max(x0, c.x0);
    if (ov > bestOv) [best, bestOv] = [c, ov];
  }
  return best;
}

/** Lines on the same page just below `header` (a value row): within 3.5 line heights, overlapping in x. */
function rowsBelow(header, lines, maxRows = 1) {
  const hb = header.box;
  const below = lines
    .filter((l) => l !== header && l.page === header.page && l.box && l.box.y > hb.y + hb.h * 0.6 && l.box.x < hb.x + hb.w && l.box.x + l.box.w > hb.x)
    .sort((a, b) => a.box.y - b.box.y);
  const out = [];
  let lastY = hb.y;
  for (const l of below) {
    if (l.box.y - lastY > Math.max(hb.h, l.box.h) * 3.5) break;
    out.push(l);
    lastY = l.box.y;
    if (out.length >= maxRows) break;
  }
  return out;
}

/**
 * lines: version.lines [{ id, page, text, box }]; fields: [{ lineId, charStart, charEnd, groupKey? }];
 * groups: [{ key, sampleRows?, footerY? }]; confirmed: Set/array of area ids "static on purpose".
 * → { ready, areas: [{ id, lineId, page, charStart, charEnd, text, kind, label, staticConfirmed }] }
 * `ready` = every area is covered by a field or confirmed static.
 */
export function findVariableAreas(lines = [], fields = [], { groups = [], confirmed = [] } = {}) {
  const ok = new Set(confirmed || []);
  const usable = (lines || []).filter((l) => l && typeof l.text === "string" && l.text.trim());
  const marked = new Map();
  for (const f of fields || []) {
    if (!marked.has(f.lineId)) marked.set(f.lineId, []);
    marked.get(f.lineId).push({ s: f.charStart, e: f.charEnd });
  }
  // a repeating group's sample rows are its own (the engine replaces them): lines under its cells
  const groupLines = new Set();
  for (const g of groups || []) {
    const cellLines = (fields || []).filter((f) => f.groupKey === g.key).map((f) => usable.find((l) => l.id === f.lineId)).filter(Boolean);
    if (!cellLines.length) continue;
    const top = Math.min(...cellLines.map((l) => l.box.y));
    const h = Math.max(...cellLines.map((l) => l.box.h));
    const bottom = g.footerY ?? top + h * 1.8 * Math.max(1, g.sampleRows || 1);
    for (const l of usable) if (l.page === cellLines[0].page && l.box.y >= top - 1 && l.box.y < bottom) groupLines.add(l.id);
  }

  const cand = new Map(); // lineId → [{ s, e, kind, label }]
  const add = (line, s, e, kind, label = null) => {
    [s, e] = trimSpan(line.text, s, e);
    if (e <= s) return;
    if (!cand.has(line.id)) cand.set(line.id, []);
    cand.get(line.id).push({ s, e, kind, label });
  };
  for (const l of usable) for (const p of patternSpans(l.text)) add(l, p.s, p.e, p.kind);

  const inline = new Set();
  for (const l of usable) {
    // "Batch No.:  AVVS1122005 • Issue Date: 05/02/2023" — each label's value (an ORIGIN stays)
    const pairs = [...l.text.matchAll(/([A-Za-z][A-Za-z .#/()]{1,38}?)\s*:\s*(.+?)(?=\s*[•·|]\s*|$)/g)];
    if (!pairs.length) continue;
    inline.add(l.id);
    for (const m of pairs) {
      const label = m[1].trim();
      const vs = m.index + m[0].length - m[2].length;
      const known = [...VARIABLE_HEADERS, ...INLINE_VARIABLE].find(([re]) => re.test(label));
      if (!known || STATIC_HEADERS.some((re) => re.test(label))) continue; // patterns still apply
      add(l, vs, vs + m[2].length, known[1], known[2]);
    }
  }

  for (const h of usable) {
    if (inline.has(h.id)) continue;
    // a header naming product / batch data → the uncovered words of the value row under it,
    // each under its column (a column that is the same on every certificate — ORIGIN — is skipped)
    const cols = headerColumns(h);
    if (cols.some((c) => c.kind !== "static") && !RESULTS_HEADER.test(h.text) && h.text.trim().split(/\s+/).length <= 12) {
      for (const row of rowsBelow(h, usable, 2)) {
        if (VARIABLE_HEADERS.some(([re]) => re.test(row.text)) || STATIC_ROWS.test(row.text)) continue; // the next header row
        const pats = patternSpans(row.text);
        let run = null;
        const flush = () => run && (add(row, run.s, run.e, run.kind, run.label), (run = null));
        for (const w of words(row.text)) {
          const col = columnOf(cols, row, w);
          const pat = pats.find((p) => overlaps(p, w));
          if (pat) {
            flush();
            const lab = col && col.kind !== "static" ? col.label : (cols.find((c) => c.kind === pat.kind) || {}).label;
            if (lab) add(row, pat.s, pat.e, pat.kind, lab);
            continue;
          }
          if (!col || col.kind === "static") {
            flush();
            continue;
          }
          if (run && run.label === col.label) run.e = w.e;
          else {
            flush();
            run = { s: w.s, e: w.e, kind: col.kind, label: col.label };
          }
        }
        flush();
      }
    }
    // an analysis / composition table: each row after its test name, until the table ends
    if (RESULTS_HEADER.test(h.text) && h.text.trim().split(/\s+/).length <= 8) {
      for (const row of rowsBelow(h, usable, 40)) {
        if (STATIC_ROWS.test(row.text) || row.text.trim().split(/\s+/).length > 12) break;
        const lead = row.text.match(TEST_NAMES);
        add(row, lead ? lead[0].length : 0, row.text.length, "result", lead ? lead[0].trim() : "Analysis result");
      }
    }
  }

  const areas = [];
  for (const l of usable) {
    if (groupLines.has(l.id)) continue;
    const spans = (cand.get(l.id) || []).sort((a, b) => a.s - b.s || b.e - a.e);
    // merge overlapping candidates (the broader one wins; a specific kind beats "value")
    const merged = [];
    for (const c of spans) {
      const last = merged[merged.length - 1];
      if (last && c.s < last.e) {
        last.e = Math.max(last.e, c.e);
        if (last.kind === "value" && c.kind !== "value") last.kind = c.kind;
        last.label = last.label || c.label;
      } else merged.push({ ...c });
    }
    const mine = marked.get(l.id) || [];
    for (const m of merged) {
      // split around marked fields: only the unmarked parts are areas
      let pieces = [{ s: m.s, e: m.e }];
      for (const f of mine) pieces = pieces.flatMap((p) => (overlaps(p, f) ? [{ s: p.s, e: Math.min(p.e, f.s) }, { s: Math.max(p.s, f.e), e: p.e }] : [p]));
      for (let { s, e } of pieces) {
        [s, e] = trimSpan(l.text, s, e);
        const text = l.text.slice(s, e);
        if (e <= s || !/[A-Za-z0-9؀-ۿ]/.test(text)) continue;
        // a fragment glued to a field (the "PHARMAVET" before a marked DOXYPHARMA) is the field's prefix
        if (mine.some((f) => f.s === e || f.e === s) && !/\s/.test(text) && !patternSpans(text).length) continue;
        const id = areaId(l.id, s, e);
        areas.push({ id, lineId: l.id, page: l.page || 1, charStart: s, charEnd: e, text, kind: m.kind, label: m.label || KIND_LABEL[m.kind], staticConfirmed: ok.has(id) });
      }
    }
  }
  return { ready: areas.every((a) => a.staticConfirmed), areas };
}

/** The open areas as one Arabic line: "Batch number, Expiry date, جدول النتائج…" (de-duplicated, at most 8). */
export function describeOpen(areas) {
  const open = areas.filter((a) => !a.staticConfirmed);
  const names = [...new Set(open.map((a) => (a.kind === "result" ? "جدول النتائج" : a.label)))];
  return names.slice(0, 8).join("، ") + (names.length > 8 ? "…" : "");
}

/**
 * An area as one piece per word: a field must not span a table's column gap (the round-trip
 * check of prepare fails when "Light yellow crystalline powder Conforms" is refilled as one run).
 * Used where areas become fields (Express blanks). → [{ lineId, page, charStart, charEnd, text, kind, label }]
 */
export function areaWords(area) {
  return words(area.text).map((w) => ({ ...area, id: areaId(area.lineId, area.charStart + w.s, area.charStart + w.e), charStart: area.charStart + w.s, charEnd: area.charStart + w.e, text: w.t }));
}
