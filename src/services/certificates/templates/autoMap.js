// What an automatic template's unmarked places are filled from (28 Nov: "the person must never type
// what a file already says"). Before: every such place became a blank to type. Now each gets its
// source by what it is:
//   product data   category, pack, form, validity, name, composition basis   → the product (harvested)
//   composition    a row printed per ingredient (name / amount)              → activeIngredients[row]
//   COA table      a test's specification                                   → specifications.values.<test>
//                  its result                                               → blank (a lab result, never filled)
//   document       its number → the company's numbering (a NEW number); its issue date → today
//   batch facts    batch no, production / expiry date → the request's line (only what a person or a document gives)
//   anything else  a blank, flagged (never the sample's text)
// Pure: expressService writes the fields.

// a result is its own word at the end ("4.0-6.5 5.2"), never the end of a range ("3.0-5.0" is a specification)
const RESULT_TAIL = /(?:^|\s+)((?:Conforms?|Complies|Positive|Negative|Pass(?:es)?|Absent|Present|Not\s+detected)|\d+(?:[.,]\d+)?\s*%?)\s*$/i;
const AMOUNT = /^(?:(?:ad|q\.?\s?s\.?(?:\s*to)?|up\s+to)\s+)?[\d.,]+\s*(?:mg|g|mcg|µg|μg|ug|IU|iu|mL|ml|L|%|ppm|kg)$/i;
const AMOUNT_TAIL = /\s+((?:(?:ad|q\.?\s?s\.?(?:\s*to)?|up\s+to)\s+)?[\d.,]+\s*(?:mg|g|mcg|µg|μg|ug|IU|iu|mL|ml|L|%|ppm|kg))\s*$/i;
const COMP_HEADER = /Composition\s*:|^\s*Constituents?\b|\bEach\s+[\d.,]*\s*\w+\s+contains|Contains\s+per/i; // "constituents" inside a sentence is no heading
const COMP_END = /^\s*(?:Package|Packing|Pack)\s+Size|^\s*Validity|^\s*Product\s+Form|^\s*Category|^\s*Country|^\s*Produced|^\s*Sterility|^\s*Pyrogen|^\s*Assay|^\s*Producer|^\s*\*/i;

/** company date format ("D/M/YYYY", "DD/MM/YYYY", "MM/YYYY") → the engine's format tokens */
const dateFormat = (f) => (f ? f.replace(/\bD\b/, "DD").replace(/\bM\b/, "MM") : "DD/MM/YYYY");

const BY_LABEL = [
  [/^Product name$/i, () => ({ source: { kind: "product", path: "name" } })],
  [/^Category$/i, () => ({ source: { kind: "product", path: "productType" } })],
  [/Packaging|Packing|Pack size|Package/i, () => ({ source: { kind: "product", path: "packaging" } })],
  // "Product Form" prints what the certificate printed there (ADDVET COC: Antibiotic); a "Form" column the physical form
  [/Product\s*form/i, () => ({ source: { kind: "product", path: "productForm" } })],
  [/^Form$|Dosage form|Physical form/i, () => ({ source: { kind: "product", path: "physicalForm" } })],
  [/^Validity$|Shelf life/i, () => ({ source: { kind: "product", path: "validity" } })],
  [/Composition basis/i, () => ({ source: { kind: "product", path: "compositionBasis" }, role: "composition_basis" })],
  [/Document number/i, () => ({ source: { kind: "docnumber" } })],
  [/Issue date/i, (ctx) => ({ source: { kind: "today" }, format: { date: dateFormat(ctx.dateFormat) } })],
  [/^Batch number$/i, () => ({ source: { kind: "item", path: "batchNo" }, isBatchFact: true })],
  [/^Batch size$/i, () => ({ source: { kind: "manual" }, isBatchFact: true })], // no request-line field: typed (a batch fact)
  [/^Expiry date$/i, (ctx) => ({ source: { kind: "item", path: "expiryDate" }, isBatchFact: true, format: { date: ctx.monthYear ? "MM/YYYY" : dateFormat(ctx.dateFormat) } })],
  [/^Manufacturing date$/i, (ctx) => ({ source: { kind: "item", path: "productionDate" }, isBatchFact: true, format: { date: ctx.monthYear ? "MM/YYYY" : dateFormat(ctx.dateFormat) } })],
];

// a COA row the converter kept as ONE line: "Assay 90-110% of the labeled amount of constituents 101.7%"
// (prod COA, 28 Nov: its "110%" and "101.7%" became two «Quantity / pack» blanks — the first one INSIDE
// the specification). The test's name, its specification, then its result.
const TEST_ROW = /^(\s*)(Appearance|Identification|pH|Sterility|Pyrogens?|Assay|Density|Moisture|Loss\s+on\s+drying|Viscosity|Clarity|Colou?r|Odou?r|Solubility|Endotoxins?|Heavy\s+metals|Fill\s+volume|Microbial\s+limits?)(\s+)\S/i;

// the readiness rules' generic labels — a place labelled only by its kind
const GENERIC = /^(?:Date|Analysis result|Quantity \/ pack|Product data|Value)$/;
// a printed label → the label a BY_LABEL rule knows
const ROW_LABELS = [
  [/^(?:Production|Manufactur(?:ing|e)|Mfg\.?|Prod\.?)\s*Date$/i, "Manufacturing date"],
  [/^(?:Expiry|Expiration|Exp\.?)\s*Date$/i, "Expiry date"],
  [/^(?:Batch|Lot)\s*(?:No\.?|Number|#)$/i, "Batch number"],
  [/^(?:Batch|Lot)\s*Size$/i, "Batch size"],
  [/^(?:Issue|Issuing)\s*Date$/i, "Issue date"],
  [/^(?:Certificate|Document|Cert\.?|Doc\.?)\s*(?:No\.?|Number|#)$/i, "Document number"],
  [/^Date\s+of\s+(?:Certificate|Issue)$/i, "Issue date"],
];

/** The label printed left of a place on its row ("Production Date:" … "10/2026") → a known label, or null */
function rowLabel(a, lines) {
  const line = lines.find((l) => l.id === a.lineId);
  if (!line?.box) return null;
  const left = lines
    .filter((l) => l.page === line.page && l.box && l.id !== line.id && Math.abs(l.box.y - line.box.y) <= Math.max(3, line.box.h * 0.4) && l.box.x < line.box.x)
    .sort((x, y) => y.box.x - x.box.x)[0];
  const text = left?.text.trim().replace(/:\s*$/, "").trim();
  if (!text) return null;
  return ROW_LABELS.find(([re]) => re.test(text))?.[1] || null;
}

/** The lines of the composition block, in rows (same y), from its header to the next section */
const HEAD_PREFIX = /^\s*(?:Composition\s*:?|Constituents?(?:\s*\([^)]*\))?|(?:Each|Every)\s+[\d.,]*\s*\w+\s+contains\s*:?|Contains\s+per\s+\S+\s*:?)\s*/i;

export function compositionRows(lines) {
  const out = new Map(); // lineId → ingredient row (0 = the first ingredient)
  const heads = lines.filter((l) => COMP_HEADER.test(l.text)).sort((a, b) => a.page - b.page || a.box.y - b.box.y);
  for (const head of heads) {
    if (out.has(head.id)) continue;
    const below = lines.filter((l) => l.page === head.page && l.box && l.box.y >= head.box.y - 2).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const rows = [];
    for (const l of below) {
      // the block ends at the next section — also when that section's name sits in another column of the same row
      if (l !== head && below.some((x) => Math.abs(x.box.y - l.box.y) <= Math.max(3, l.box.h * 0.4) && COMP_END.test(x.text))) break;
      // a heading line ("Composition:", "Each 1 L contains:") is no row — unless an ingredient follows it on the line
      const rest = COMP_HEADER.test(l.text) ? l.text.replace(HEAD_PREFIX, "").replace(HEAD_PREFIX, "") : l.text;
      if (!rest.trim()) continue;
      const row = rows.find((r) => Math.abs(r.y - l.box.y) <= Math.max(3, l.box.h * 0.4));
      if (row) row.lines.push(l);
      else rows.push({ y: l.box.y, lines: [l] });
      if (rows.length > 40) break;
    }
    rows.forEach((r, i) => r.lines.forEach((l) => out.set(l.id, i)));
  }
  return out;
}

/**
 * areas: the open places (readinessCheck), lines: the version's lines, ctx: { dateFormat, monthYear }
 * → field rows { key, label, lineId, page, charStart, charEnd, sampleValue, source, format?, required, isBatchFact?, isLabResult? }
 */
export function fieldsForAreas(areas, lines, ctx = {}) {
  const rowsOf = compositionRows(lines);
  const fields = [];
  const used = new Set();
  const key = (base) => {
    let k = base;
    for (let n = 2; used.has(k); n++) k = `${base}_${n}`;
    used.add(k);
    return k;
  };
  const add = (a, s, e, label, how, base) => {
    const text = (lines.find((l) => l.id === a.lineId)?.text || "").slice(s, e);
    const t = text.trim();
    if (!t) return;
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    fields.push({ key: key(base), label, lineId: a.lineId, page: a.page, charStart: s + lead, charEnd: e - trail, sampleValue: t, required: true, ...how });
  };
  // an amount is printed as two words ("1,000" … "mg") with their own gap: one field each, so both stay
  // where they're printed (one field over both drifts the round-trip past the prepare check — 28 Nov, ADDVET COA)
  const amount = (a, s, e, slot) => {
    const text = (lines.find((l) => l.id === a.lineId)?.text || "").slice(s, e);
    const m = text.match(/^(\s*)(.*?[\d.,]+)(\s+)([A-Za-zµμ%]+(?:\/[A-Za-z]+)?)\s*$/);
    const how = (part) => ({ source: { kind: "product", path: `activeIngredients[${slot}].${part}` }, required: slot === 0, role: "composition_amount" });
    if (!m) return add(a, s, e, `Ingredient ${slot + 1} amount`, how("concentration"), `comp_${slot}_amount`);
    const figEnd = s + m[1].length + m[2].length;
    // right-aligned: a longer amount ("25,000" where the sample printed "300") grows left into the gap
    // before it, never right over its unit (28 Nov prod: 5 overflow flags on ADDHEPA's COC)
    add(a, s, figEnd, `Ingredient ${slot + 1} amount`, { ...how("amountFigure"), align: "right" }, `comp_${slot}_amount`);
    // the unit is never required on its own: "Quantity not stated" has none (the figure carries the requirement)
    add(a, figEnd + m[3].length, e, `Ingredient ${slot + 1} unit`, { ...how("amountUnit"), required: false }, `comp_${slot}_unit`);
  };
  const testRows = new Set(); // lines handled as one COA row
  for (const raw of areas) {
    // the label printed left of the place ("CERTIFICATE NO:") beats the readiness rules' guess (HC p.2: "Batch number")
    const printed = rowLabel(raw, lines);
    const a = printed ? { ...raw, label: printed } : raw;
    const row = rowsOf.get(a.lineId);
    if (testRows.has(a.lineId)) continue;
    // a whole COA row on one line, found only by its generic places: its specification and its result
    const lineText = lines.find((l) => l.id === a.lineId)?.text || "";
    const tr = row === undefined && (!a.label || GENERIC.test(a.label)) ? TEST_ROW.exec(lineText) : null;
    const trTail = tr ? lineText.match(RESULT_TAIL) : null;
    if (tr && trTail) {
      testRows.add(a.lineId);
      const test = tr[2].replace(/\s+/g, " ");
      const slug = test.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const specStart = tr[1].length + tr[2].length + tr[3].length;
      const a1 = { ...a, label: test };
      if (trTail.index > specStart) add(a1, specStart, trTail.index, `${test} specification`, { source: { kind: "product", path: `specifications.values.${test}` } }, `spec_${slug}`);
      add(a1, trTail.index, lineText.trimEnd().length, `${test} result`, { source: { kind: "manual" }, isLabResult: true }, `result_${slug}`);
      continue;
    }
    // composition: each printed row is an ingredient slot (name, amount)
    if (row !== undefined && (a.kind === "result" || a.kind === "quantity" || a.kind === "value")) {
      const slot = row;
      if (AMOUNT.test(a.text.trim())) {
        amount(a, a.charStart, a.charEnd, slot);
        continue;
      }
      const tail = a.text.match(AMOUNT_TAIL);
      const nameEnd = tail ? a.charStart + tail.index : a.charEnd;
      add(a, a.charStart, nameEnd, `Ingredient ${slot + 1}`, { source: { kind: "product", path: `activeIngredients[${slot}].name` }, required: slot === 0, role: "composition_name" }, `comp_${slot}_name`);
      if (tail) amount(a, nameEnd, a.charEnd, slot);
      continue;
    }
    if (a.kind === "basis") {
      add(a, a.charStart, a.charEnd, "Composition basis", { source: { kind: "product", path: "compositionBasis" }, role: "composition_basis" }, "composition_basis");
      continue;
    }
    // a COA row: the test's specification (the product's), then its result (a blank: a lab result)
    if (a.kind === "result" && a.label && !/Analysis result|Constituents|Composition/i.test(a.label)) {
      const test = a.label.replace(/ﬁ/g, "fi").replace(/\s*\(.*$/, "").trim();
      const tail = a.text.match(RESULT_TAIL);
      const specEnd = tail ? a.charStart + tail.index : a.charEnd;
      if (specEnd > a.charStart) add(a, a.charStart, specEnd, `${test} specification`, { source: { kind: "product", path: `specifications.values.${test}` } }, `spec_${test.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`);
      if (tail) add(a, specEnd, a.charEnd, `${test} result`, { source: { kind: "manual" }, isLabResult: true }, `result_${test.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`);
      continue;
    }
    const hit = BY_LABEL.find(([re]) => re.test(a.label || ""));
    if (hit) {
      // a date printed as month/year keeps that form
      add(a, a.charStart, a.charEnd, a.label, hit[1]({ ...ctx, monthYear: /^\d{1,2}\/\d{4}$/.test(a.text.trim()) }), String(a.label).toLowerCase().replace(/[^a-z0-9]+/g, "_"));
      continue;
    }
    // an unlabelled date on a health / free sale / composition / origin certificate is the certificate's own date
    if (a.kind === "date" && (!a.label || a.label === "Date") && ["HC", "FSC", "COC", "COO"].includes(ctx.certCode)) {
      add(a, a.charStart, a.charEnd, "Issue date", { source: { kind: "today" }, format: { date: dateFormat(ctx.dateFormat) } }, "issue_date");
      continue;
    }
    // what nothing can fill: a blank, flagged — a batch / date / result kind is a batch fact or a lab result
    add(a, a.charStart, a.charEnd, a.label || "Value", { source: { kind: "manual" }, isBatchFact: a.kind === "batch" || a.kind === "date", isLabResult: a.kind === "result" }, `blank_${a.kind}`);
  }
  return fields;
}
