import { slugKey } from "../mapping/labelProposal.js";

// Template auto-repair, the scan (owner, 2026-10-24, item 2). Pure: from the
// version's lines, every line's cells (engine `lineCells`) and its fields, find
//   - the analysis table (a header row naming a specification and a result column)
//     and its rows;
//   - a constituent block in it (a "Constituents / Composition …" row and the
//     unlabelled rows under it) → ONE repeating group bound to the product's
//     activeIngredients, replacing the per-row fields that hard-code one product's list;
//   - fixed specification cells (product-specific text printed on every certificate);
//   - fixed result cells (“Complies”, “102.7%”) → listed for the owner to decide,
//     never changed automatically;
//   - "Label: value" text outside the table (Batch No.: AVVS1122005) → fields;
//   - unnamed fields (“Field 6”) → what they are, or that they can go.
// Nothing here decides a source: every candidate carries the printed label and
// sample; the service suggests sources (memory → dictionary → rules).

const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const printed = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim(); // "Identiﬁcation" → "Identification"
const SPEC_HEAD = /\b(specifications?|specified|limits?|standards?|requirements?|acceptance criteria|norms?)\b/;
const RESULT_HEAD = /\b(results?|found|observed|obtained|actual|test values?)\b/;
const CONSTITUENT = /\b(constituents?|composition|ingredients?|active (substances?|ingredients?)|each \d|contains|per (ml|millilit(re|er)|litre|liter|l|g|gram|kg|tablet|dose))\b/i;
const QUANTITY = /^[<>≤≥~]?\s*\d[\d.,]*\s*(%|[a-zµμ]{1,6}|i\.?u\.?)(\s*\/\s*[a-z]{1,6})?$/i;
const DASH = /^[—–\-·.]+$/;
const GENERIC_LABEL = /^field\s*\d+$/i;
const COL_SLACK = 12; // px a cell may start left of its column header
const ROW_TOL = 3; // px: lines within this y distance are one table row

/** Cells → the analysis table's header: { lineId, page, y, columns: [{ kind: label|spec|result|other, x0, text }] } | null */
export function findHeader(cellLines) {
  for (const l of cellLines) {
    if (l.cells.length < 2) continue;
    const texts = l.cells.map((c) => norm(c.text));
    const spec = texts.findIndex((t) => SPEC_HEAD.test(t));
    const result = texts.findIndex((t, i) => i > spec && RESULT_HEAD.test(t));
    if (spec < 0 || result < 0) continue;
    const columns = l.cells.map((c, i) => ({ kind: i < spec ? "label" : i === spec ? "spec" : i === result ? "result" : i < result ? "spec" : "other", x0: c.x0, x1: c.x1, text: c.text }));
    return { lineId: l.id, page: l.page, y: l.y, h: l.h, columns };
  }
  return null;
}

/** Which header column a cell sits in, or -1 when it crosses into the next column (not a table cell). */
function columnOf(cell, columns) {
  let col = -1;
  for (let i = 0; i < columns.length; i++) if (cell.x0 >= columns[i].x0 - COL_SLACK) col = i;
  if (col < 0) return cell.x1 <= columns[0].x0 + 2 ? -1 : 0;
  const next = columns[col + 1];
  if (next && cell.x1 > next.x0 + 2) return -1;
  return col;
}

/**
 * The table's rows under the header (same page), until a line no longer fits
 * the columns (a paragraph running across them ends the table).
 * → [{ y, label: cellRef|null, spec: [cellRef], result: [cellRef], other: [cellRef] }]
 * cellRef: { lineId, start, end, text, x0, x1 }
 */
const textOf = (l, start, end) => {
  // the line's text between two cell offsets, rebuilt from its cells (spaces between them kept as one)
  let out = "";
  for (const c of l.cells) if (c.start >= start && c.end <= end) out += (out ? " " : "") + c.text;
  return out;
};

export function tableRows(cellLines, header) {
  if (!header) return [];
  const below = cellLines.filter((l) => l.page === header.page && l.y > header.y + header.h * 0.5 && l.id !== header.lineId).sort((a, b) => a.y - b.y);
  const rows = [];
  for (const l of below) {
    const cols = l.cells.map((c) => columnOf(c, header.columns));
    if (cols.some((c) => c < 0)) {
      if (rows.length) break;
      continue;
    }
    let row = rows.find((r) => Math.abs(r.y - l.y) <= ROW_TOL);
    if (!row) {
      row = { y: l.y, label: null, spec: [], result: [], other: [] };
      rows.push(row);
    }
    l.cells.forEach((c, i) => {
      const ref = { lineId: l.id, start: c.start, end: c.end, text: c.text, x0: c.x0, x1: c.x1 };
      const kind = header.columns[cols[i]].kind;
      // two cells of one line in the same column are one cell (a split the gap rule made)
      const prev = kind !== "label" ? row[kind][row[kind].length - 1] : null;
      if (prev && prev.lineId === l.id && cols[i - 1] === cols[i]) {
        Object.assign(prev, { end: c.end, text: (textOf(l, prev.start, c.end)), x1: c.x1 });
        return;
      }
      if (kind === "label") {
        if (row.label) row.label = { ...row.label, text: `${row.label.text} ${c.text}`, x1: c.x1 };
        else row.label = ref;
      } else row[kind].push(ref);
    });
  }
  return rows.sort((a, b) => a.y - b.y);
}

const overlaps = (f, ref) => f.lineId === ref.lineId && f.charStart < ref.end && ref.start < f.charEnd;
const coveredBy = (fields, ref) => fields.filter((f) => overlaps(f, ref));

/** The constituent block: the labelled row and the unlabelled rows right under it. → { label, rows } | null */
export function constituentBlock(rows) {
  const i = rows.findIndex((r) => r.label && CONSTITUENT.test(r.label.text) && r.spec.length);
  if (i < 0) return null;
  const block = [rows[i]];
  for (let j = i + 1; j < rows.length && !rows[j].label && (rows[j].spec.length || rows[j].result.length); j++) block.push(rows[j]);
  return { label: rows[i].label, rows: block };
}

/** "Batch No.:  AVVS1122005  •  Issue Date: 05/02/2023" → [{ label, value: ref }] (offsets into the line). */
export function labelValuePairs(line) {
  const out = [];
  const text = line.text;
  // parts separated by a bullet or a wide gap of spaces
  const re = /[^•]+/g;
  let m;
  while ((m = re.exec(text))) {
    const part = m[0];
    const base = m.index;
    const lv = part.match(/^(\s*)([^:]{1,40}?)\s*:\s*(\S(?:.*\S)?)\s*$/);
    if (!lv) continue;
    const label = lv[2].trim();
    if (!/\p{L}/u.test(label) || label.length < 2) continue;
    const value = lv[3];
    const start = base + part.indexOf(value, lv[1].length + lv[2].length);
    out.push({ label, value: { lineId: line.id, start, end: start + value.length, text: value } });
  }
  return out;
}

const keyFor = (label, used) => {
  let k = slugKey(label) || "field";
  if (!/^[a-z]/.test(k)) k = `f_${k}`;
  k = k.slice(0, 50);
  let n = 2;
  let out = k;
  while (used.has(out)) out = `${k}_${n++}`;
  used.add(out);
  return out;
};

/**
 * The scan. input: { lines: version.lines, cellLines: engine lineCells, fields: stored fields, groups: stored groups }
 * → { header, rows, items } where items are:
 *   { id, kind: "constituent_group", group, cells, removes[], rows }
 *   { id, kind: "fixed_to_field", where: table_spec|label_value, label, field (draft without source), rowLabel? }
 *   { id, kind: "fixed_result", rowLabel, text, cell, spec: { text, fixed: bool, fieldKey?|itemId? } }
 *   { id, kind: "unnamed_field", fieldKey, sampleValue, absorbedBy?, identifiedAs? }
 */
export function scanTemplate({ lines = [], cellLines = [], fields = [], groups = [] }) {
  const textOf = new Map(lines.map((l) => [l.id, l.text]));
  const used = new Set([...fields.map((f) => f.key), ...groups.map((g) => g.key)]);
  const items = [];
  const header = findHeader(cellLines);
  const rows = tableRows(cellLines, header);
  const block = groups.length ? null : constituentBlock(rows);
  const blockRows = new Set(block?.rows || []);

  // 1. the constituent block → one group over the product's ingredient list
  let absorbed = [];
  if (block) {
    const first = block.rows[0];
    const name = first.spec[0];
    const amount = first.result.find((c) => QUANTITY.test(c.text.trim())) || first.result[0] || first.spec[1] || null;
    const extra = first.result.filter((c) => c !== amount);
    absorbed = fields.filter((f) => !f.groupKey && block.rows.some((r) => [...r.spec, ...r.result, ...r.other].some((c) => overlaps(f, c))));
    const groupKey = keyFor("constituents", used);
    const cell = (ref, label, source, extraProps = {}) => ({ key: keyFor(label, used), label, lineId: ref.lineId, charStart: ref.start, charEnd: ref.end, sampleValue: ref.text, source, groupKey, align: "left", required: true, ...extraProps });
    const cells = [cell(name, "Ingredient", { kind: "row", path: "name" })];
    if (amount) cells.push(cell(amount, "Amount", { kind: "row", path: "concentration" }));
    // a result column beside the amount is measured per batch, per ingredient
    for (const r of extra) cells.push(cell(r, "Ingredient result", { kind: "manual" }, { isLabResult: true }));
    items.push({
      id: `group:${groupKey}`,
      kind: "constituent_group",
      label: printed(block.label.text),
      group: { key: groupKey, label: printed(block.label.text), mode: "repeat", source: { kind: "product_list", path: "activeIngredients" }, whenEmpty: "dash", required: true, sampleRows: block.rows.length },
      cells,
      removes: absorbed.map((f) => f.key),
      rows: block.rows.map((r) => ({ name: r.spec.map((c) => c.text).join(" "), amount: r.result.map((c) => c.text).join(" ") })),
      default: true,
    });
  }

  // 2. the other rows: fixed specification cells → fields; fixed results → the owner decides
  for (const r of rows) {
    if (blockRows.has(r)) continue;
    const rowLabel = printed(r.label?.text) || null;
    if (!rowLabel) continue;
    const spec = r.spec.find((c) => !DASH.test(c.text.trim()));
    const specField = spec ? coveredBy(fields, spec)[0] || null : null;
    let specItem = null;
    if (spec && !specField) {
      specItem = {
        id: `field:${spec.lineId}:${spec.start}`,
        kind: "fixed_to_field",
        where: "table_spec",
        label: rowLabel,
        rowLabel,
        field: { key: keyFor(rowLabel, used), label: rowLabel, lineId: spec.lineId, charStart: spec.start, charEnd: spec.end, sampleValue: spec.text, align: "left", required: true, dataCategory: "product_data", isLabResult: false },
        default: true,
      };
      items.push(specItem);
    }
    for (const res of r.result) {
      const t = res.text.trim();
      if (!t || DASH.test(t) || coveredBy(fields, res).length) continue;
      items.push({
        id: `result:${res.lineId}:${res.start}`,
        kind: "fixed_result",
        rowLabel,
        text: res.text,
        cell: { lineId: res.lineId, start: res.start, end: res.end },
        spec: spec ? { text: spec.text, fieldKey: specField?.key || null, itemId: specItem?.id || null } : null,
        resultKey: keyFor(`${rowLabel} result`, used),
        choices: ["keep_fixed", "lab_result_field", ...(spec ? ["show_specification"] : [])],
        default: null, // never decided automatically
      });
    }
  }

  // 3. "Label: value" text outside the table
  const tableLines = new Set(rows.flatMap((r) => [r.label, ...r.spec, ...r.result, ...r.other].filter(Boolean).map((c) => c.lineId)));
  if (header) tableLines.add(header.lineId);
  for (const l of lines) {
    if (tableLines.has(l.id)) continue;
    for (const { label, value } of labelValuePairs(l)) {
      if (coveredBy(fields, value).length || absorbed.some((f) => overlaps(f, value))) continue;
      if (value.text.length > 60) continue; // a sentence, not a value
      items.push({
        id: `field:${value.lineId}:${value.start}`,
        kind: "fixed_to_field",
        where: "label_value",
        label,
        field: { key: keyFor(label, used), label: printed(label), lineId: value.lineId, charStart: value.start, charEnd: value.end, sampleValue: value.text, align: "left", required: true, isLabResult: false },
        default: true,
      });
    }
  }

  // 4. unnamed fields: what they print and what becomes of them
  for (const f of fields.filter((x) => !x.groupKey && GENERIC_LABEL.test(String(x.label || "")))) {
    const by = absorbed.includes(f) ? items.find((i) => i.kind === "constituent_group") : null;
    const row = rows.find((r) => [...r.spec, ...r.result].some((c) => overlaps(f, c)));
    items.push({
      id: `unnamed:${f.key}`,
      kind: "unnamed_field",
      fieldKey: f.key,
      sampleValue: f.sampleValue,
      lineText: textOf.get(f.lineId) || "",
      ...(by
        ? { absorbedBy: by.id, identifiedAs: `a constituent row's name (“${f.sampleValue}”) — the ingredient list becomes one repeating group, so this field goes` }
        : row?.label
          ? { identifiedAs: `the ${row.spec.some((c) => overlaps(f, c)) ? "specification" : "result"} of the “${row.label.text}” row`, rename: { key: keyFor(row.label.text, used), label: row.label.text } }
          : { identifiedAs: "fixed text with no row or label around it — remove the field (the text stays printed)", remove: true }),
      default: true,
    });
  }
  return { header, rows: rows.map((r) => ({ y: r.y, label: r.label?.text || null, spec: r.spec.map((c) => c.text), result: r.result.map((c) => c.text) })), items };
}
