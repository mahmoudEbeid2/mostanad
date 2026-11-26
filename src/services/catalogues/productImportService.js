import { PDFDocument } from "pdf-lib";
import { prisma } from "../../lib/prisma.js";
import { CertError, notFound } from "../certificates/errors.js";
import { addVersion, enqueueExtraction } from "./catalogueService.js";
import { openPdf } from "./pages/pdfInfo.js";
import { reviewVersion, editBlock, applyOne } from "./reviewService.js";
import { matchContext, matchBlock } from "./productMatch.js";
import { readProductSheet, readCsv, productsFromRows } from "../intake/productSheet.js";
import { labelFileType } from "../label/layout/labelUploadService.js";

// "منتجات من ملفات" — a company's products from many files at once: labels / product
// sheets (PDF, .ai, images) and product lists (.xlsx / .csv / a pasted list). One table to
// check and correct, then "save all". It rides on the catalogue pipeline: the files are
// one catalogue version of the company's "Product files" catalogue, ONE product per file
// (segmenter.blocksPerFile), read by the same verified extraction (every value must quote
// its file; nothing inferred — infer: false); a spreadsheet / pasted row is a product
// whose values are its cells. A person's corrections are recorded as theirs ("manual").

export const IMPORT_MANUFACTURER = "Product files";
export const MAX_FILES = 60;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const extOf = (n) => (String(n).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();

async function assertCompany(companyId) {
  if (!companyId) throw new CertError("COMPANY_REQUIRED", "Choose the company the products belong to", 400);
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!c) throw notFound("Company");
  return c;
}

/** A pasted list: a table copied from Excel (with a name column), else one product name per line. */
export function rowsFromText(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const table = productsFromRows(readCsv(t));
  if (table.products.length) return table.products;
  return t.split(/\r?\n/).map((l) => l.replace(/^\s*[-•*\d.)]+\s+/, "").trim()).filter((l) => l.length > 1).map((name) => ({ name }));
}

/** A sheet row's fields → the catalogue record a block carries (the cell text is its own quote). */
function blockFromRow(row, source) {
  const record = {};
  const quotes = {};
  const put = (field, v) => {
    if (!v) return;
    record[field] = String(v).trim();
    quotes[field] = { quote: String(v).trim() };
  };
  put("name", row.name);
  put("productCode", row.productCode);
  put("packaging", row.packaging);
  put("registrationNumber", row.registrationNumber);
  put("physicalForm", row.dosageForm);
  const extra = Object.keys(row.extra || {});
  return {
    record,
    quotes,
    categoryProposal: row.category || null,
    flags: extra.length ? [{ code: "columns_not_used", message: `Columns not used: ${extra.join(", ")}` }] : [],
    source,
  };
}

/**
 * POST /product-imports (multipart files[] + text) for one company → { versionId, files, rows, refused, taskId }.
 * Nothing becomes a product until "save all".
 */
export async function importProductFiles({ companyId, brandId = null, files = [], text = "", userId = null }) {
  const company = await assertCompany(companyId);
  if (brandId && !(await prisma.brand.findFirst({ where: { id: brandId, companyId }, select: { id: true } }))) throw new CertError("BRAND_NOT_IN_COMPANY", "This brand does not belong to the chosen company", 400);
  if (files.length > MAX_FILES) throw new CertError("TOO_MANY_FILES", `At most ${MAX_FILES} files at once`, 400);

  const merged = await PDFDocument.create();
  const groups = []; // [{ file, pages: [original page numbers] }]
  const rows = []; // [{ ...sheet row, source }]
  const refused = [];
  for (const f of files) {
    const name = f.originalname || "file";
    const ext = extOf(name);
    try {
      if (!f.buffer?.length) throw new Error("empty file");
      if (f.buffer.length > MAX_FILE_BYTES) throw new Error("larger than 40 MB");
      if (["pdf", "ai"].includes(ext)) {
        labelFileType(ext === "ai" ? "application/postscript" : "application/pdf", name, f.buffer); // an .ai with no PDF inside is refused with how to save it
        const src = await PDFDocument.load(f.buffer, { ignoreEncryption: true });
        const start = merged.getPageCount();
        const copied = await merged.copyPages(src, src.getPageIndices());
        copied.forEach((p) => merged.addPage(p));
        groups.push({ file: name, pages: copied.map((_, i) => start + i + 1) });
      } else if (["png", "jpg", "jpeg"].includes(ext)) {
        const img = ext === "png" ? await merged.embedPng(f.buffer) : await merged.embedJpg(f.buffer);
        const page = merged.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
        groups.push({ file: name, pages: [merged.getPageCount()] });
      } else if (["xlsx", "csv"].includes(ext)) {
        const sheet = await readProductSheet(f.buffer, ext);
        if (!sheet.products.length) throw new Error(sheet.error === "no product name column" ? "no product name column found" : "no products in it");
        rows.push(...sheet.products.map((p, i) => ({ ...p, source: `${name} · row ${i + 2}` })));
      } else throw new Error("not a label, product sheet or product list (PDF, .ai, PNG/JPEG, Excel or CSV)");
    } catch (err) {
      refused.push({ file: name, reason: err.message });
    }
  }
  rows.push(...rowsFromText(text).map((p, i) => ({ ...p, source: `pasted list · line ${i + 1}` })));
  if (!groups.length && !rows.length) throw new CertError("NOTHING_TO_IMPORT", `No product could be read from what was sent${refused.length ? `: ${refused.map((r) => `${r.file} (${r.reason})`).join(", ")}` : ""}`, 400, { refused });

  // the version needs a source PDF: the files themselves, or (rows only) a page naming where the rows came from
  if (!groups.length) {
    const p = merged.addPage([595, 842]);
    p.drawText(`Products from ${[...new Set(rows.map((r) => r.source.split(" · ")[0]))].join(", ")}`.replace(/[^\x20-\x7E]/g, "?").slice(0, 90), { x: 40, y: 800, size: 11 });
  }
  const buffer = Buffer.from(await merged.save());
  const catalogue = await prisma.catalogue.upsert({
    where: { companyId_manufacturer: { companyId, manufacturer: IMPORT_MANUFACTURER } },
    update: brandId ? { brandId } : {},
    create: { companyId, manufacturer: IMPORT_MANUFACTURER, brandId },
  });
  const label = `Products from files — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const { version } = await addVersion({ catalogue, label, file: { buffer, originalname: `${label}.pdf` }, info: await openPdf(buffer), userId });
  // Harvest (28 Nov): the imported files are read by code too (labels: composition, indications, dosage…)
  import("../harvest/harvestService.js").then(({ harvestSoon }) => harvestSoon({ companyId, fileId: version.sourceFileId, fileName: label, kind: "label" })).catch(() => {});
  const filesList = [...groups.map((g) => ({ file: g.file, pages: g.pages })), ...[...new Set(rows.map((r) => r.source.split(" · ")[0]))].map((file) => ({ file, rows: rows.filter((r) => r.source.startsWith(file)).length }))];
  await prisma.catalogueVersion.update({
    where: { id: version.id },
    data: {
      status: groups.length ? "pages_ready" : "review",
      extraction: { source: "product_files", fileGroups: groups, files: filesList, refused, brandId: brandId || null },
      ...(groups.length ? { pageSelection: { pages: groups.flatMap((g) => g.pages), savedAt: new Date().toISOString() } } : {}),
    },
  });

  // spreadsheet / pasted rows: products whose values are their cells (no AI)
  if (rows.length) {
    const categories = await prisma.category.findMany({ select: { id: true, name: true } });
    const norm = (s) => String(s || "").trim().toLowerCase();
    const at = new Date().toISOString();
    await prisma.catalogueBlock.createMany({
      data: rows.map((r, i) => {
        const b = blockFromRow(r, r.source);
        const hit = b.categoryProposal ? categories.find((c) => norm(c.name) === norm(b.categoryProposal)) : null;
        return {
          versionId: version.id,
          companyId,
          seq: 100000 + i,
          kind: "product",
          page: 0,
          bbox: {},
          title: r.source,
          text: Object.entries(b.record).map(([k, v]) => `${k}: ${v}`).join("\n"),
          lines: [],
          extracted: { isProduct: true, record: b.record, quotes: b.quotes, estimated: {}, flags: b.flags, category: b.categoryProposal ? { proposal: b.categoryProposal, existingCategoryId: hit?.id || null, existingName: hit?.name || null } : null, source: { kind: "row", from: r.source }, extractedAt: at },
        };
      }),
    });
  }
  // the files: read by the verified extraction, one product per file, nothing estimated
  const task = groups.length ? await enqueueExtraction({ ...version, companyId }, { infer: false }) : null;
  return { versionId: version.id, catalogueId: catalogue.id, company: company.name, files: groups.length, rows: rows.length, refused, taskId: task?.id || null };
}

async function loadImport(versionId, companyScope) {
  const v = await prisma.catalogueVersion.findUnique({ where: { id: versionId }, include: { catalogue: { select: { manufacturer: true, brandId: true } } } });
  if (!v || (companyScope && v.companyId !== companyScope) || v.extraction?.source !== "product_files") throw notFound("Product import");
  return v;
}

const val = (ex, f) => ex?.manual?.[f]?.value ?? ex?.record?.[f] ?? null;
const ingredientsText = (list) => (list || []).map((x) => (x.amountRaw ? `${x.name}: ${x.amountRaw}` : x.name)).join("\n");

/**
 * GET /product-imports/:id — the table: one row per product (name, pack, form, category,
 * composition basis, ingredients), its file, what it needs, and whether "save all" takes it.
 */
export async function getImport(versionId, companyScope) {
  const v = await loadImport(versionId, companyScope);
  const review = await reviewVersion(versionId, companyScope);
  const task = v.extractTaskId ? await prisma.backgroundTask.findUnique({ where: { id: v.extractTaskId }, select: { status: true, progress: true, message: true, error: true } }) : null;
  const groups = v.extraction?.fileGroups || [];
  const fileOfPage = (page) => groups.find((g) => g.pages.includes(page))?.file || null;
  const rows = review.blocks
    .filter((b) => b.kind === "product")
    .map((b) => {
      const ex = b.extracted;
      const flags = ex?.flags || [];
      return {
        id: b.id,
        file: b.page === 0 ? ex?.source?.from || b.title : fileOfPage(b.page),
        status: b.status,
        productId: b.productId,
        read: !!ex,
        name: val(ex, "name"),
        packaging: val(ex, "packaging"),
        physicalForm: val(ex, "physicalForm"),
        productCode: val(ex, "productCode"),
        categoryId: b.categoryId,
        categoryProposal: ex?.category?.proposal || null,
        compositionBasis: val(ex, "compositionBasis"),
        ingredients: ingredientsText(ex?.manual?.activeIngredients?.value || ex?.record?.activeIngredients),
        typed: Object.keys(ex?.manual || {}),
        flags: flags.map((f) => ({ code: f.code, field: f.field || null, message: f.message })),
        existing: b.match ? { productId: b.match.productId || null, name: b.match.name || null } : null,
        saveable: b.status === "pending" && !!ex && !!val(ex, "name") && !b.match && !flags.some((f) => f.code === "ambiguous_number"),
      };
    });
  const counts = { rows: rows.length, saveable: rows.filter((r) => r.saveable).length, saved: rows.filter((r) => r.status === "applied").length, existing: rows.filter((r) => r.existing && r.status === "pending").length, unread: rows.filter((r) => !r.read).length };
  return {
    id: v.id,
    companyId: v.companyId,
    label: v.label,
    status: v.status,
    error: v.error,
    task,
    files: v.extraction?.files || [],
    refused: v.extraction?.refused || [],
    warnings: v.warnings || [],
    categories: review.categories,
    counts,
    rows,
  };
}

/** PATCH /product-imports/:id/rows/:rowId { name?, packaging?, physicalForm?, productCode?, categoryId?, compositionBasis?, ingredients? } */
export async function editImportRow(versionId, rowId, companyScope, input = {}, userId = null) {
  await loadImport(versionId, companyScope);
  const block = await prisma.catalogueBlock.findFirst({ where: { id: rowId, versionId }, select: { id: true } });
  if (!block) throw notFound("Product row");
  const values = {};
  for (const f of ["name", "packaging", "physicalForm", "productCode", "compositionBasis"]) if (input[f] !== undefined) values[f] = input[f];
  if (input.ingredients !== undefined) values.activeIngredients = input.ingredients;
  await editBlock(rowId, companyScope, { values, ...(input.categoryId !== undefined ? { categoryId: input.categoryId || null } : {}) }, userId);
  return (await getImport(versionId, companyScope)).rows.find((r) => r.id === rowId);
}

/** POST /product-imports/:id/rows/:rowId/skip — not a product / not wanted. */
export async function skipImportRow(versionId, rowId, companyScope, userId = null) {
  await loadImport(versionId, companyScope);
  const { count } = await prisma.catalogueBlock.updateMany({ where: { id: rowId, versionId, status: "pending" }, data: { status: "rejected" } });
  if (!count) throw notFound("Product row");
  return { rowId, status: "rejected", by: userId };
}

/**
 * POST /product-imports/:id/save-all — every row with a name, not matching an existing
 * product of the company, and no number read two ways, becomes a product. The rest is
 * listed with the reason, nothing silently dropped. → { created: [{ rowId, productId, name }], left: [{ rowId, name, reason }] }
 */
export async function saveAllImported(versionId, companyScope, userId = null) {
  const v = await loadImport(versionId, companyScope);
  if (v.status === "extracting" || v.status === "pages_ready") throw new CertError("IMPORT_NOT_READ", "The files are still being read — save when the table is ready", 409);
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product", status: "pending" }, include: { version: { include: { catalogue: true } } }, orderBy: { seq: "asc" } });
  const mctx = await matchContext(v);
  const created = [];
  const left = [];
  for (const b of blocks) {
    const name = val(b.extracted, "name");
    if (!b.extracted) left.push({ rowId: b.id, name, reason: "not read yet" });
    else if (!name) left.push({ rowId: b.id, name, reason: "no product name — type it" });
    else if ((b.extracted.flags || []).some((f) => f.code === "ambiguous_number")) left.push({ rowId: b.id, name, reason: "a number reads two ways — confirm it" });
    else if (matchBlock(mctx, b)) left.push({ rowId: b.id, name, reason: "already a product of this company" });
    else {
      try {
        const p = await applyOne(b, userId, mctx);
        created.push({ rowId: b.id, productId: p.id, name: p.name });
      } catch (err) {
        left.push({ rowId: b.id, name, reason: err.message });
      }
    }
  }
  if (created.length && !(await prisma.catalogueBlock.count({ where: { versionId, kind: "product", status: "pending" } }))) await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "applied", appliedAt: new Date() } });
  return { created, left };
}

/** GET /product-imports — the company's imports, newest first. */
export async function listImports(companyScope) {
  const rows = await prisma.catalogueVersion.findMany({ where: { ...(companyScope ? { companyId: companyScope } : {}), catalogue: { manufacturer: IMPORT_MANUFACTURER } }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, label: true, status: true, createdAt: true, companyId: true, _count: { select: { blocks: true } } } });
  return rows.map((r) => ({ id: r.id, label: r.label, status: r.status, createdAt: r.createdAt, companyId: r.companyId, rows: r._count.blocks }));
}

