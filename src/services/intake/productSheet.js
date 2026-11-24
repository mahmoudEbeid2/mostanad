import JSZip from "jszip";

// A dropped product list (.xlsx / .csv) → rows of product fields, read by column
// headers in English or Arabic. Only what a column states is used; a column this
// doesn't know is kept in `extra` and listed, never guessed into a field.

const HEADERS = {
  name: ["name", "product", "product name", "item", "trade name", "description of goods", "الاسم", "اسم المنتج", "المنتج", "الصنف"],
  productCode: ["code", "product code", "item code", "sku", "الكود", "كود المنتج", "كود"],
  brand: ["brand", "البراند", "العلامة التجارية", "الماركة"],
  packaging: ["packing", "packaging", "pack", "pack size", "size", "العبوة", "التعبئة"],
  registrationNumber: ["registration", "registration no", "reg no", "رقم التسجيل"],
  category: ["category", "type", "الفئة", "النوع", "التصنيف"],
  dosageForm: ["form", "dosage form", "الشكل"],
};
const norm = (s) => String(s || "").toLowerCase().replace(/[._:#]+/g, " ").replace(/\s+/g, " ").trim();
const fieldOf = (header) => Object.entries(HEADERS).find(([, names]) => names.includes(norm(header)))?.[0] || null;

const decodeXml = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The first sheet of an .xlsx → rows of cell text. */
export async function readXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const shared = [];
  const sst = zip.file("xl/sharedStrings.xml");
  if (sst) for (const m of (await sst.async("string")).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const sheetName = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) return [];
  const xml = await zip.file(sheetName).async("string");
  const rows = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = c[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const type = c[2].match(/t="(\w+)"/)?.[1];
      const v = c[3]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const inline = c[3]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      cells[col] = type === "s" ? shared[Number(v)] ?? "" : decodeXml(inline ?? v ?? "");
    }
    rows.push(Array.from(cells, (x) => (x ?? "").trim()));
  }
  return rows;
}

/** CSV (comma, semicolon or tab; quoted fields) → rows. */
export function readCsv(text) {
  const t = String(text).replace(/^﻿/, "");
  const sep = [",", ";", "\t"].map((s) => [s, (t.split("\n")[0].match(new RegExp(s === "\t" ? "\t" : `\\${s}`, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) row.push(cell.trim()), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

/** rows (first = headers) → { columns: [{ header, field }], products: [{ name, productCode, …, extra }], unknownColumns } */
export function productsFromRows(rows) {
  const headerIdx = rows.findIndex((r) => r.some((h) => fieldOf(h) === "name"));
  if (headerIdx < 0) return { columns: [], products: [], unknownColumns: rows[0] || [], error: "no product name column" };
  const headers = rows[headerIdx];
  const columns = headers.map((h) => ({ header: h, field: fieldOf(h) }));
  const products = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const p = { extra: {} };
    columns.forEach((c, i) => {
      const v = (r[i] ?? "").trim();
      if (!v) return;
      if (c.field) p[c.field] = v;
      else if (c.header) p.extra[c.header] = v;
    });
    if (p.name) products.push(p);
  }
  return { columns, products, unknownColumns: columns.filter((c) => !c.field && c.header).map((c) => c.header) };
}

/** A product list file → productsFromRows(...) */
export async function readProductSheet(buffer, ext) {
  const rows = ext === "xlsx" ? await readXlsx(buffer) : readCsv(buffer.toString("utf8"));
  return productsFromRows(rows);
}
