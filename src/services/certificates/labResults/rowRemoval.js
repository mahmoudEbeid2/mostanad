// 28 Nov (owner), COA: a test whose result is unknown is taken off the certificate — never printed blank,
// never "N/A", never inferred. The certificate prints only the tests with a real result (a lab report, a
// file or the person); the table closes up (engine removeRows) and the certificate stays a normal one,
// finalizable. A test the product type doesn't have (Sterility / Pyrogen on an oral product) goes the same
// way. An unknown batch size takes its header line off. When the result is given later, the row comes back:
// the decision is made from the values at every render, never stored apart from them. Pure.

export const ROW_REMOVED = "row_removed";
const BATCH_SIZE = /\b(batch|lot)\s*size\b|حجم/i;

export const isBatchSizeField = (f) => BATCH_SIZE.test(String(f?.label || ""));
/** A field whose row goes when its value is unknown */
export const isRemovableRow = (f) => f?.isLabResult === true || isBatchSizeField(f);
/** Row removal is the COA rule */
export const removesRows = (typeCode) => String(typeCode || "").toUpperCase() === "COA";

/** The design's fields whose row goes with these values → [key] */
export function rowsToRemove(fields, values, typeCode) {
  if (!removesRows(typeCode)) return [];
  return fields.filter((f) => isRemovableRow(f) && !String(values?.[f.key]?.value ?? values?.[f.key] ?? "").trim()).map((f) => f.key);
}

/** The removed rows' names for a person ("pH", "Assay", "Batch size") */
export const rowName = (f) => String(f?.label || f?.key || "").replace(/\s*(result|النتيجة|نتيجة)\s*$/i, "").trim();

/** One line for the card and the editor: «اتشال من الشهادة: pH، Assay — مفيش نتيجة. ابعت النتيجة في سطر وترجع» */
export function removedLineAr(names) {
  const list = [...new Set((names || []).filter(Boolean))];
  return list.length ? `اتشال من الشهادة: ${list.join("، ")} — مفيش نتيجة. ابعت النتيجة في سطر وترجع` : null;
}

/** A stored value's removed rows: [key] (the unknown values themselves, not the row's other cells) */
export const removedKeys = (values) => Object.entries(values || {}).filter(([, v]) => (v?.flags || []).includes(ROW_REMOVED) && !v?.removedWith).map(([k]) => k);

// what an empty place would say — none of it holds for a row that isn't printed
const NOT_PRINTED = new Set(["missing", "empty_optional", "sample_value", "overflow", "shrunk", "unconfirmed"]);

/**
 * The render's removed rows onto the stored values (in place): the unknown value is `row_removed`
 * (informational, never blocking); the row's other cells (its specification) say they went with it
 * (`removedWith`). A row the engine couldn't find stays as it was (blank, flagged `missing`).
 * rows: the engine's { removed: { key: [keys in its row] } } → the removed keys
 */
export function applyRemovedRows(values, rows) {
  for (const v of Object.values(values || {})) if (v && typeof v === "object" && "removedWith" in v) delete v.removedWith;
  const removed = rows?.removed || {};
  for (const [key, inRow] of Object.entries(removed)) {
    for (const k of new Set([key, ...(inRow || [])])) {
      const v = values[k];
      if (!v) continue;
      v.flags = [...new Set([...(v.flags || []).filter((f) => !NOT_PRINTED.has(f)), ROW_REMOVED])];
      if (k !== key && !removed[k]) v.removedWith = key;
    }
  }
  return Object.keys(removed);
}
