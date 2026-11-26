// A design that lists several products in one table (MAXVET's FSC: 5 products; ADDVET's HC
// "ATTACHED LIST") → one repeating row (§7.8 group, invoice_lines) so ONE certificate covers
// every product of the order, its rows filled from each product (26 Nov, Phase 3.5).
// Pure: the converted design's lines + the product names the file lists → the group and its
// cells as replaceFields takes them, or why not. The first listed product's row becomes the
// row's cells; the other sample rows are the group's (the engine removes them).
//
//   name column     → product.name
//   a column whose header says PACK / FORM / BRAND / DESCRIPTION / CATEGORY / REG → that product field
//   any other column → a blank (manual) cell: never the sample's text

import { isPhysicalForm } from "../../harvest/productForm.js";

const norm = (s) => String(s || "").toUpperCase().replace(/[*•]/g, "").replace(/\s+/g, " ").trim();
const COLUMN_SOURCES = [
  // Phase 5: a quantity comes only from the invoice line (or a person) — never the sample's
  [/\bQ(?:UAN)?TY\b|QUANTITY/i, "quantity", "Quantity"],
  [/PACK/i, "product.packaging", "Packing size"],
  [/\bFORM\b/i, "product.physicalForm", "Form"],
  [/BRAND/i, "product.brand.name", "Brand"],
  [/DESCRIPTION|DESCR/i, "product.description", "Description"],
  [/CATEGOR/i, "product.category.name", "Category"],
  [/REG/i, "product.registrationNumber", "Registration number"],
  [/ORIGIN/i, "product.origin", "Origin"],
];

/** lines: version.lines; names: the products the file lists → { group, fields } | { problem } */
export function productTableFrom(lines = [], names = []) {
  const wanted = [...new Set(names.map(norm).filter((n) => n.length >= 3))];
  if (wanted.length < 2) {
    const byHeader = numberedTable(lines);
    return byHeader.problem ? { problem: "fewer than 2 product names to find in the design, and no numbered table under a column header" } : byHeader;
  }
  // each listed product's own line (a cell that starts with its name)
  const hits = [];
  for (const n of wanted) {
    const l = lines.find((x) => x.box && norm(x.text).startsWith(n) && norm(x.text).length <= n.length + 3);
    if (l) hits.push({ name: n, line: l });
  }
  if (hits.length < 2) {
    // rows found by the table's own header first (numbered rows, any products), then by product names in one line
    const byHeader = numberedTable(lines);
    if (!byHeader.problem) return byHeader;
    const byNames = rowLinesTable(lines, wanted);
    return byNames.problem && !/no numbered table/.test(byHeader.problem) ? byHeader : byNames;
  }
  const page = hits[0].line.page;
  const col = hits.filter((h) => h.line.page === page && Math.abs(h.line.box.x - hits[0].line.box.x) <= 6).sort((a, b) => a.line.box.y - b.line.box.y);
  if (col.length < 2) return { problem: "the product names aren't in one column" };
  const first = col[0].line;
  // the row pitch: the smallest step between recognised names (an unknown product between two of them —
  // SULFARIM*, not one of ADDVET's — would double it)
  const pitch = Math.min(...col.slice(1).map((h, i) => h.line.box.y - col[i].line.box.y));
  if (pitch <= 0) return { problem: "the product rows overlap" };
  // the sample rows: every line of the name column at that pitch, recognised or not (28 Nov: 9 of the HC's
  // 10 rows counted → the engine fitted 9 rows to a 10-row band and every row after the gap shifted)
  const nameCol = lines.filter((l) => l.page === first.page && l.box && Math.abs(l.box.x - first.box.x) <= 6 && l.box.y >= first.box.y - 1).sort((a, b) => a.box.y - b.box.y);
  let sampleRows = 1;
  for (let i = 1; i < nameCol.length; i++) {
    const step = nameCol[i].box.y - nameCol[i - 1].box.y;
    if (step < pitch * 0.6 || step > pitch * 1.4) break;
    sampleRows++;
  }
  // the first row: every line on the same baseline band as the first product's name
  const rowLines = lines.filter((l) => l.page === page && l.box && Math.abs(l.box.y - first.box.y) <= Math.max(2, first.box.h * 0.4)).sort((a, b) => a.box.x - b.box.x);
  // the header row: the nearest line above each cell, overlapping it in x
  const headerOf = (cell) =>
    lines
      .filter((l) => l.page === page && l.box && l.box.y < first.box.y - first.box.h * 0.5 && l.box.y > first.box.y - pitch * 3 && l.box.x < cell.box.x + cell.box.w && l.box.x + l.box.w > cell.box.x)
      .sort((a, b) => b.box.y - a.box.y)[0] || null;
  // one header line over every column ("PRODUCT NAME BRAND DESCRIPTION PACKING SIZE FORM", ADDVET HC p.2):
  // its column phrases, in order, are the row's cells in order — never the whole line for each cell
  const phrases = headerPhrases(rowLines.map(headerOf));
  // each column's alignment: where its sample cells line up — left edges, centres or right edges
  // (28 Nov: the HC's centred columns drifted when a row's text was wider or narrower than row 1's)
  const alignOf = (cell) => {
    const xs = col.map((h) => lines.find((l) => l.page === page && l.box && Math.abs(l.box.y - h.line.box.y) <= Math.max(2, h.line.box.h * 0.4) && l.box.x < cell.box.x + cell.box.w && l.box.x + l.box.w > cell.box.x)).filter(Boolean);
    if (xs.length < 2) return "left";
    const spread = (f) => Math.max(...xs.map(f)) - Math.min(...xs.map(f));
    const s = { left: spread((b) => b.box.x), center: spread((b) => b.box.x + b.box.w / 2), right: spread((b) => b.box.x + b.box.w) };
    return s.left <= 1.5 ? "left" : Object.entries(s).sort((a, b) => a[1] - b[1])[0][0];
  };
  const fields = [];
  rowLines.forEach((l, i) => {
    const text = l.text;
    const s = text.length - text.trimStart().length;
    const e = text.trimEnd().length;
    if (e <= s) return;
    const isName = l.id === first.id;
    const header = isName ? null : phrases ? { text: phrases[i] } : headerOf(l);
    let known = header ? COLUMN_SOURCES.find(([re]) => re.test(header.text)) : null;
    // a description column of one or two words per row (INJECTABLE, SUPPLEMENT) is the category, not a description
    if (known?.[1] === "product.description" && col.every((h) => sameRowWords(lines, h.line, l) <= 2)) known = [known[0], "product.category.name", "Description (category)", "product.productType"];
    fields.push({
      key: isName ? "row_product_name" : `row_cell_${i + 1}`,
      label: isName ? "Product name" : known ? known[2] : header?.text?.trim().slice(0, 40) || `Column ${i + 1}`,
      lineId: l.id,
      charStart: s,
      charEnd: e,
      sampleValue: text.slice(s, e),
      // the shared category when the product has one, else the category its documents print (ADDOXY 200-LA: "Injectable")
      source: isName ? { kind: "row", path: "product.name" } : known ? { kind: "row", path: known[1], ...(known[3] ? { orPath: known[3] } : {}) } : { kind: "manual" },
      required: isName,
      groupKey: "products",
      sortOrder: i,
      origin: "detected",
      align: alignOf(l),
    });
  });
  return {
    group: { key: "products", label: "Products", mode: "repeat", source: { kind: "invoice_lines" }, whenEmpty: "dash", required: true, sampleRows },
    fields,
    rows: sampleRows,
  };
}

const NAME_HEADER = /PRODUCT\s+NAME|PRODUCT|NAME|ITEM|DESCRIPTION OF GOODS/i;
/**
 * Every cell found the same header line, and that line names as many columns as the row has cells →
 * the column phrases in order (one per cell), else null (each cell keeps the header above it)
 */
function headerPhrases(headers) {
  const h = headers[0];
  if (!h || headers.length < 2 || headers.some((x) => x?.id !== h.id)) return null;
  const starts = [];
  const name = NAME_HEADER.exec(h.text);
  if (name) starts.push(name.index);
  for (const [re] of COLUMN_SOURCES) {
    const m = new RegExp(re.source, "i").exec(h.text);
    if (m && !starts.some((s) => Math.abs(s - m.index) < 2) && !(name && m.index > name.index && m.index < name.index + name[0].length)) starts.push(m.index);
  }
  starts.sort((a, b) => a - b);
  if (starts.length !== headers.length) return null;
  return starts.map((s, i) => h.text.slice(s, starts[i + 1] ?? h.text.length).trim());
}

/** The words of the cell in `nameLine`'s row that sits in the same column as `cell` */
function sameRowWords(lines, nameLine, cell) {
  const c = lines.find((l) => l.page === nameLine.page && l.box && Math.abs(l.box.y - nameLine.box.y) <= Math.max(2, nameLine.box.h * 0.4) && l.box.x < cell.box.x + cell.box.w && l.box.x + l.box.w > cell.box.x);
  return c ? c.text.trim().split(/\s+/).length : 0;
}

/**
 * The converter often keeps a table row as ONE line ("ADDMECTIN 1% 100mL Liquid" under
 * "PRODUCT NAME PACKING SIZE FORM"): the row's cells are the product name at its start and the
 * words after it, each under its header column (characters spread evenly over the line's box).
 */
function rowLinesTable(lines, wanted) {
  const hits = [];
  for (const n of wanted) {
    const l = lines.find((x) => x.box && norm(x.text).startsWith(`${n} `) && !hits.some((h) => h.line.id === x.id));
    if (l) hits.push({ name: n, line: l });
  }
  if (hits.length < 2) return { problem: `the product names aren't in the design's table (found ${hits.length} of ${wanted.length})` };
  const page = hits[0].line.page;
  const col = hits.filter((h) => h.line.page === page && Math.abs(h.line.box.x - hits[0].line.box.x) <= 6).sort((a, b) => a.line.box.y - b.line.box.y);
  if (col.length < 2) return { problem: "the product rows aren't in one column" };
  const first = col[0];
  const row = first.line;
  const header = lines.filter((l) => l.page === page && l.box && l.box.y < row.box.y - row.box.h * 0.5 && l.box.y > row.box.y - (col[1].line.box.y - row.box.y) * 3 && l.box.x < row.box.x + row.box.w && l.box.x + l.box.w > row.box.x).sort((a, b) => b.box.y - a.box.y)[0];
  // the header's columns: the name column, then each known column phrase, with their x spans
  const cols = [];
  if (header) {
    const per = header.box.w / Math.max(1, header.text.length);
    const take = (re, path, label) => {
      const m = new RegExp(re.source, "i").exec(header.text);
      if (m) cols.push({ s: m.index, x0: header.box.x + m.index * per, x1: header.box.x + (m.index + m[0].length) * per, path, label });
    };
    take(/PRODUCT\s+NAME|PRODUCT|NAME|ITEM|DESCRIPTION OF GOODS/, "product.name", "Product name");
    for (const [re, p, label] of COLUMN_SOURCES) if (!cols.some((c) => c.path === p)) take(new RegExp(`${re.source}\\S*(?:\\s+SIZE)?`), p, label);
    cols.sort((a, b) => a.s - b.s);
  }
  // the name cell: the product name exactly as printed at the start of the row
  const start = row.text.length - row.text.trimStart().length;
  const nameEnd = start + row.text.trimStart().toUpperCase().replace(/[*•]/g, " ").indexOf(first.name) + first.name.length;
  const fields = [{ key: "row_product_name", label: "Product name", lineId: row.id, charStart: start, charEnd: nameEnd, sampleValue: row.text.slice(start, nameEnd), source: { kind: "row", path: "product.name" }, required: true, groupKey: "products", sortOrder: 0, origin: "detected" }];
  const per = row.box.w / Math.max(1, row.text.length);
  const words = [...row.text.slice(nameEnd).matchAll(/\S+/g)].map((m) => ({ s: nameEnd + m.index, e: nameEnd + m.index + m[0].length }));
  const colOf = (w) => {
    const x0 = row.box.x + w.s * per;
    const x1 = row.box.x + w.e * per;
    let best = null;
    let ov = 0;
    for (const c of cols.filter((c) => c.path !== "product.name")) {
      const o = Math.min(x1, c.x1) - Math.max(x0, c.x0);
      if (o > ov) [best, ov] = [c, o];
    }
    // nothing above it: the nearest column to its left
    return best || cols.filter((c) => c.path !== "product.name" && c.x0 <= x0).sort((a, b) => b.x0 - a.x0)[0] || null;
  };
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const k = fields.length + 1;
    fields.push({ key: `row_cell_${k}`, label: cur.col?.label || `Column ${k}`, lineId: row.id, charStart: cur.s, charEnd: cur.e, sampleValue: row.text.slice(cur.s, cur.e), source: cur.col ? { kind: "row", path: cur.col.path } : { kind: "manual" }, required: false, groupKey: "products", sortOrder: k - 1, origin: "detected" });
    cur = null;
  };
  for (const w of words) {
    const c = colOf(w);
    if (cur && cur.col === c) cur.e = w.e;
    else {
      flush();
      cur = { s: w.s, e: w.e, col: c };
    }
  }
  flush();
  return {
    group: { key: "products", label: "Products", mode: "repeat", source: { kind: "invoice_lines" }, whenEmpty: "dash", required: true, sampleRows: col.length },
    fields,
    rows: col.length,
  };
}

// ── a table found by its header, whatever its products are (27 Nov QA: ADDVET's FSC sample lists 17 products
// of which one is the company's, each row ONE line "1 MUCOTHOL 1L LIQUID SUPPLEMENT" under
// "No Item Packing FORM CATEGORY" — no product name led a row, so its rows printed on every FSC) ──
const HEADER_COLS = [
  [/^(?:No\.?|S\.?\s?No\.?|Sr\.?|#)$/i, "no"],
  [/^(?:Items?|Products?(?:\s+Names?)?|Names?|Trade\s+Names?|Description\s+of\s+Goods)$/i, "name"],
  [/^(?:Packing(?:\s+Size)?|Pack(?:\s+Size)?|Package|Packaging|Presentation)$/i, "pack"],
  [/^(?:Form|Dosage\s+Form|Physical\s+Form)$/i, "form"],
  [/^(?:Category|Type|Description)$/i, "category"],
];
const PACK_TOKEN = /^\d+(?:[.,]\d+)?\s?(?:ML|L|LT|LTR|LITRE|LITER|KG|KGS|GM|GMS|G|GR|MG|CC)$/i;
const UNIT_TOKEN = /^(?:ML|L|LT|LTR|LITRE|LITER|KG|KGS|GM|GMS|G|GR|MG|CC)$/i;

/** "No Item Packing FORM CATEGORY" → ["no", "name", "pack", "form", "category"], or null when a word isn't a column name */
export function headerColumns(text) {
  const words = String(text || "").trim().split(/\s+/);
  const cols = [];
  for (let i = 0; i < words.length; ) {
    let hit = null;
    for (let n = Math.min(3, words.length - i); n >= 1 && !hit; n--) {
      const phrase = words.slice(i, i + n).join(" ");
      const c = HEADER_COLS.find(([re]) => re.test(phrase));
      if (c) hit = { kind: c[1], n };
    }
    if (!hit || cols.includes(hit.kind)) return null;
    cols.push(hit.kind);
    i += hit.n;
  }
  return cols.length >= 3 && cols.includes("name") ? cols : null;
}

/** one row line → { no?, name, pack, form, category } as [start, end] character ranges, or null when it doesn't fit the columns */
export function splitRow(text, cols) {
  const toks = [...String(text).matchAll(/\S+/g)].map((m) => ({ s: m.index, e: m.index + m[0].length, t: m[0] }));
  let i = 0;
  const out = {};
  const span = (a, b) => [toks[a].s, toks[b].e];
  if (cols.includes("no")) {
    if (!/^\d+\.?$/.test(toks[0]?.t || "")) return null;
    out.no = span(0, 0);
    i = 1;
  }
  // the pack: one token ("1L") or a number and its unit ("100 ML"), after at least one name word
  let p = -1;
  for (let k = i + 1; k < toks.length; k++) {
    if (PACK_TOKEN.test(toks[k].t)) {
      p = k;
      break;
    }
    if (/^\d+(?:[.,]\d+)?$/.test(toks[k].t) && UNIT_TOKEN.test(toks[k + 1]?.t || "")) {
      p = k;
      break;
    }
  }
  if (p < 0) return null;
  const pEnd = PACK_TOKEN.test(toks[p].t) ? p : p + 1;
  out.name = span(i, p - 1);
  out.pack = span(p, pEnd);
  let k = pEnd + 1;
  if (cols.includes("form")) {
    if (!toks[k] || !isPhysicalForm(toks[k].t)) return null;
    out.form = span(k, k);
    k++;
  }
  if (cols.includes("category")) {
    if (k >= toks.length) return null;
    out.category = span(k, toks.length - 1);
  } else if (k < toks.length) return null;
  return out;
}

const SOURCES_BY_COL = {
  no: { key: "row_no", label: "No", source: { kind: "row", path: "lineNo" } },
  name: { key: "row_product_name", label: "Product name", source: { kind: "row", path: "product.name" }, required: true },
  pack: { key: "row_cell_pack", label: "Packing", source: { kind: "row", path: "packing", orPath: "product.packaging" } },
  form: { key: "row_cell_form", label: "Form", source: { kind: "row", path: "product.physicalForm" } },
  category: { key: "row_cell_category", label: "Category", source: { kind: "row", path: "product.category.name", orPath: "product.productType" } },
};

/** lines → { group, fields, rows, rowLineIds } for a numbered table under a column header, or { problem } */
export function numberedTable(lines = []) {
  const usable = lines.filter((l) => l.box && l.text?.trim());
  for (const header of usable) {
    const cols = headerColumns(header.text);
    if (!cols || !cols.includes("pack")) continue;
    const below = usable.filter((l) => l.page === header.page && l.box.y > header.box.y + header.box.h * 0.5 && Math.abs(l.box.x - header.box.x) <= 8).sort((a, b) => a.box.y - b.box.y);
    const rows = [];
    let pitch = null;
    for (const l of below) {
      const prev = rows.at(-1) || header;
      const step = l.box.y - prev.box.y;
      if (rows.length && pitch && (step < pitch * 0.6 || step > pitch * 1.4)) break;
      if (!rows.length && step > header.box.h * 4) break;
      if (cols.includes("no") && !new RegExp(String.raw`^\s*${rows.length + 1}\.?\s`).test(l.text)) break;
      if (!splitRow(l.text, cols)) return { problem: `row ${rows.length + 1} of the table under "${header.text.trim()}" doesn't split into its columns ("${l.text.trim()}")` };
      if (rows.length) pitch = pitch ? (pitch * rows.length + step) / (rows.length + 1) : step;
      rows.push(l);
    }
    if (rows.length < 2) continue;
    const first = rows[0];
    const cells = splitRow(first.text, cols);
    const fields = cols.map((c, i) => {
      const [s, e] = cells[c];
      const def = SOURCES_BY_COL[c];
      return { key: def.key, label: def.label, lineId: first.id, charStart: s, charEnd: e, sampleValue: first.text.slice(s, e), source: def.source, required: !!def.required, groupKey: "products", sortOrder: i, origin: "detected" };
    });
    return {
      group: { key: "products", label: "Products", mode: "repeat", source: { kind: "invoice_lines" }, whenEmpty: "dash", required: true, sampleRows: rows.length },
      fields,
      rows: rows.length,
      rowLineIds: rows.map((r) => r.id),
    };
  }
  return { problem: "no numbered table under a column header" };
}
