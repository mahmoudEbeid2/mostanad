import { prisma } from "../../lib/prisma.js";
import { CertError, notFound } from "../certificates/errors.js";
import { scheduleDictionaryRebuild } from "../certificates/dictionary/rebuildScheduler.js";
import { catalogueRefOf } from "./catalogueService.js";
import { matchContext, matchBlock } from "./productMatch.js";
import { presentError } from "../ai/aiErrorMessage.js";

// The admin's review of an extracted catalogue (plan.md §15.3 steps 6–7; A6.4).
//  - Accepting a block CREATES a product for the version's company from the
//    verified record: catalogue values with tier-C provenance (block, page,
//    quote), estimates for what the catalogue doesn't print as tier I
//    { estimated: true, basis, modelId, promptHash }, a person's typed values as
//    "manual" — and the product's catalogueRef.
//  - A block that matches an EXISTING product (its code, else its normalised
//    name, in the company) is never applied here: existing products change only
//    through the re-upload diff a person approves (§15.4, §15.8).
//  - Bulk accept takes the pending product blocks with NO flags and no match.
//  - An ambiguous number blocks accepting until the convention is confirmed.
//  - Segmentation fixes: merge two blocks, split one at a line (their extraction
//    is cleared; extract just those blocks again).

const PRODUCT_FIELDS = ["name", "productCode", "physicalForm", "description", "indications", "dosage", "mixingInstructions", "withdrawalPeriod", "contraindications", "storage", "packaging", "registrationNumber", "appearance", "origin", "producer"];
const LIST_FIELDS = ["targetSpecies", "userSafety"];
const EDITABLE = new Set([...PRODUCT_FIELDS, ...LIST_FIELDS]);
const BLOCKING_FLAGS = new Set(["ambiguous_number", "no_name"]);

async function loadBlock(id, companyScope) {
  const block = await prisma.catalogueBlock.findUnique({ where: { id }, include: { version: { include: { catalogue: true } } } });
  if (!block || (companyScope && block.companyId !== companyScope)) throw notFound("Catalogue block");
  return block;
}

const quoteOf = (q) => (Array.isArray(q) ? q[0] : q) || null;
const present = (v) => v !== null && v !== undefined && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== "");

/**
 * Where each field's quote sits on the page: { field: [{ x, y, w, h }] } in PDF
 * points (scale 1, top-left origin — the frame of block.lines). A quote is an
 * offset range into block.text; every line it touches gives one box, cut to the
 * quoted characters in proportion (lines keep their own width, not per glyph).
 */
export function highlightsOf(block) {
  const lines = block.lines || [];
  const out = {};
  const boxes = (q) => {
    if (!q || !Number.isInteger(q.start) || !Number.isInteger(q.end) || q.end <= q.start) return [];
    const r = [];
    for (const l of lines) {
      const len = l.t.length || 1;
      const s = Math.max(q.start, l.o);
      const e = Math.min(q.end, l.o + l.t.length);
      if (e <= s) continue;
      const x = l.x + (l.w * (s - l.o)) / len;
      r.push({ x: Math.round(x * 10) / 10, y: l.y, w: Math.round(((l.w * (e - s)) / len) * 10) / 10, h: l.h });
    }
    return r;
  };
  for (const [field, q] of Object.entries(block.extracted?.quotes || {})) {
    const list = (Array.isArray(q) ? q : [q]).flatMap(boxes);
    if (list.length) out[field] = list;
  }
  return out;
}

/** extracted record (+ estimates, manual edits) → { data, fieldProvenance } for prisma.product.create */
export function productFromBlock(block, { categoryId = null, brandId = null } = {}) {
  const ex = block.extracted || {};
  const rec = ex.record || {};
  const manual = ex.manual || {};
  const at = new Date().toISOString();
  const data = {};
  const prov = {};
  const C = (field, q) => ({ tier: "C", catalogueVersionId: block.versionId, blockId: block.id, page: q?.page ?? block.page, quote: q?.quote ?? null, at });
  const put = (field, value, p) => {
    if (value === null || value === undefined || (Array.isArray(value) && !value.length) || (!Array.isArray(value) && !String(value).trim())) return;
    data[field] = value;
    prov[field] = p;
  };
  for (const f of [...PRODUCT_FIELDS, ...LIST_FIELDS]) {
    if (manual[f] !== undefined) put(f, manual[f].value, { tier: "manual", by: manual[f].by || null, at: manual[f].at || at });
    else if (present(rec[f])) put(f, rec[f], C(f, quoteOf(ex.quotes?.[f])));
    else if (ex.estimated?.[f]) {
      const e = ex.estimated[f];
      put(f, e.value, { tier: "I", estimated: true, basis: e.basis, modelId: e.modelId, promptHash: e.promptHash, at: e.at || at });
    }
  }
  if (rec.subtitle && !data.description) put("description", rec.subtitle, C("subtitle", ex.quotes?.subtitle));
  if (rec.activeIngredients?.length) {
    data.activeIngredients = rec.activeIngredients.map(({ name, amountRaw, amount, unit, basis }) => ({ name, concentration: amountRaw ?? null, amountRaw: amountRaw ?? null, amount: amount ?? null, unit: unit ?? null, basis: basis ?? null }));
    prov.activeIngredients = { ...C("activeIngredients", quoteOf(ex.quotes?.activeIngredients)), quotes: (ex.quotes?.activeIngredients || []).map((q) => q?.quote) };
  }
  if (rec.specifications?.length) {
    data.specifications = { type: "Specification", values: Object.fromEntries(rec.specifications.map((s) => [s.item, s.specRaw])) };
    prov.specifications = { ...C("specifications", quoteOf(ex.quotes?.specifications)), quotes: (ex.quotes?.specifications || []).map((q) => q?.quote) };
  }
  if (categoryId) data.categoryId = categoryId;
  if (brandId) data.brandId = brandId;
  for (const f of LIST_FIELDS) if (data[f] !== undefined && !Array.isArray(data[f])) data[f] = String(data[f]).split(/\n|;\s*/).map((s) => s.trim()).filter(Boolean);
  return { data, fieldProvenance: prov };
}

/** GET /catalogue-versions/:id/review — every block with what accepting it would do. */
export async function reviewVersion(versionId, companyScope) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId }, include: { catalogue: { include: { brand: { select: { id: true, name: true } } } } } });
  if (!version || (companyScope && version.companyId !== companyScope)) throw notFound("Catalogue version");
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
  const mctx = await matchContext(version, blocks);
  const categories = await prisma.category.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  const out = [];
  const counts = { products: 0, pending: 0, flagged: 0, unflagged: 0, accepted: 0, applied: 0, rejected: 0, existing: 0, ambiguous: 0, notExtracted: 0 };
  for (const b of blocks) {
    if (b.kind !== "product") {
      out.push({ id: b.id, seq: b.seq, kind: b.kind, page: b.page, bbox: b.bbox, title: b.title });
      continue;
    }
    counts.products++;
    const ex = b.extracted;
    const flags = ex?.flags || [];
    const match = ex && b.status === "pending" ? matchBlock(mctx, b) : null;
    if (b.status === "pending") counts.pending++;
    else counts[b.status] = (counts[b.status] || 0) + 1;
    if (!ex) counts.notExtracted++;
    if (b.status === "pending" && ex) flags.length ? counts.flagged++ : !match ? counts.unflagged++ : null;
    if (match) counts.existing++;
    if (flags.some((f) => f.code === "ambiguous_number")) counts.ambiguous++;
    out.push({ id: b.id, seq: b.seq, kind: b.kind, page: b.page, bbox: b.bbox, title: b.title, status: b.status, productId: b.productId, lines: (b.lines || []).map((l) => l.t), extracted: ex, highlights: ex ? highlightsOf(b) : {}, categoryId: categoryFor(ex), match, bulkAcceptable: b.status === "pending" && !!ex && !flags.length && !match });
  }
  return { version: { id: version.id, label: version.label, status: version.status, pages: version.pages, numberConvention: version.numberConvention, extraction: version.extraction, ...presentError({ error: version.error }), catalogue: { id: version.catalogue.id, manufacturer: version.catalogue.manufacturer, brand: version.catalogue.brand } }, counts, categories, blocks: out };
}

/** PATCH /catalogue-blocks/:id { values?: { field: value|null }, categoryId? } — a person's corrections before accepting. */
export async function editBlock(blockId, companyScope, { values = {}, categoryId } = {}, userId = null) {
  const block = await loadBlock(blockId, companyScope);
  if (block.kind !== "product") throw new CertError("NOT_A_PRODUCT_BLOCK", "Only a product block can be edited", 409);
  if (block.status !== "pending") throw new CertError("BLOCK_DECIDED", `This block is already ${block.status}`, 409);
  // P8 — everything degrades to manual: a block the AI didn't (or couldn't) read is
  // entered by hand. Nothing is filled in for the person; every value is "manual".
  const base = block.extracted || {
    isProduct: true,
    record: {},
    quotes: {},
    estimated: {},
    flags: [{ code: "manual_entry", message: "Not read by AI — every value of this product is typed by a person" }],
    category: null,
    manualOnly: true,
  };
  const ex = { ...base, manual: { ...(base.manual || {}) } };
  const at = new Date().toISOString();
  for (const [field, value] of Object.entries(values)) {
    if (!EDITABLE.has(field)) throw new CertError("NOT_EDITABLE", `"${field}" can't be typed here (amounts and specifications come from the catalogue only)`, 400);
    if (value === null || value === "" || (Array.isArray(value) && !value.length)) delete ex.manual[field];
    else ex.manual[field] = { value: LIST_FIELDS.includes(field) ? (Array.isArray(value) ? value : String(value).split(/\n|,\s*/)).map((s) => String(s).trim()).filter(Boolean) : String(value).trim().slice(0, 4000), by: userId, at };
  }
  // a typed name / a value typed for an unverified field answers its flag
  ex.flags = (ex.flags || []).filter((f) => !(f.code === "no_name" && ex.manual.name) && !(f.code === "unverified" && f.field && ex.manual[f.field]));
  if (categoryId !== undefined) {
    if (categoryId && !(await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } }))) throw notFound("Category");
    ex.category = { ...(ex.category || {}), chosenCategoryId: categoryId || null };
  }
  await prisma.catalogueBlock.update({ where: { id: block.id }, data: { extracted: ex } });
  return { blockId: block.id, extracted: ex };
}

/** The category a product gets: the admin's pick, else an EXISTING category whose name is the proposal. Never a new one. */
const categoryFor = (ex) => (ex?.category && "chosenCategoryId" in ex.category ? ex.category.chosenCategoryId : ex?.category?.existingCategoryId) || null;

async function applyOne(block, userId, mctx = null) {
  if (block.kind !== "product") throw new CertError("NOT_A_PRODUCT_BLOCK", "Only a product block can be accepted", 409);
  if (block.status !== "pending") throw new CertError("BLOCK_DECIDED", `This block is already ${block.status}`, 409);
  const ex = block.extracted;
  if (!ex) throw new CertError("NOT_EXTRACTED", "This block has no extracted record yet", 409);
  const blocking = (ex.flags || []).filter((f) => BLOCKING_FLAGS.has(f.code));
  if (blocking.some((f) => f.code === "ambiguous_number")) throw new CertError("CONFIRM_NUMBER_CONVENTION", "Confirm how this catalogue writes \".\" + three digits before accepting (a number on this page reads two ways)", 409);
  if (blocking.length && !ex.manual?.name) throw new CertError("NAME_REQUIRED", "Type the product name before accepting", 409);
  const ctx = mctx || (await matchContext(block.version));
  const match = matchBlock(ctx, block);
  if (match) throw new CertError("EXISTING_PRODUCT", match.productId ? `"${match.name}" already exists in this company — its changes go through the catalogue diff` : "Several existing products match this block — resolve it in the catalogue diff", 409, { match });
  const { data, fieldProvenance } = productFromBlock(block, { categoryId: categoryFor(ex), brandId: block.version.catalogue.brandId || null });
  if (!data.name) throw new CertError("NAME_REQUIRED", "Type the product name before accepting", 409);
  const catalogueRef = catalogueRefOf({ ...block, version: { catalogueId: block.version.catalogueId } });
  // one transaction; the status guard makes a second, concurrent accept of the same block fail instead of creating a twin
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({ data: { ...data, companyId: block.companyId, catalogueRef, fieldProvenance } });
    const { count } = await tx.catalogueBlock.updateMany({ where: { id: block.id, status: "pending" }, data: { status: "applied", productId: created.id, extracted: { ...ex, appliedAt: new Date().toISOString(), appliedByUserId: userId } } });
    if (count !== 1) throw new CertError("BLOCK_DECIDED", "This block was decided meanwhile", 409);
    return created;
  });
  ctx.products.push({ id: product.id, name: product.name, productCode: product.productCode, catalogueRef });
  ctx.taken.set(product.id, block.id);
  return product;
}

async function afterApply(version) {
  const pending = await prisma.catalogueBlock.count({ where: { versionId: version.id, kind: "product", status: "pending" } });
  if (!pending) await prisma.catalogueVersion.update({ where: { id: version.id }, data: { status: "applied", appliedAt: new Date() } });
  await scheduleDictionaryRebuild(version.companyId);
}

/** POST /catalogue-blocks/:id/accept → the created product */
export async function acceptBlock(blockId, companyScope, userId = null) {
  const block = await loadBlock(blockId, companyScope);
  const product = await applyOne(block, userId, null);
  await afterApply(block.version);
  return { blockId: block.id, productId: product.id, product };
}

/** POST /catalogue-versions/:id/accept-unflagged — every pending block with no flag and no existing match. */
export async function acceptUnflagged(versionId, companyScope, userId = null) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  if (!version || (companyScope && version.companyId !== companyScope)) throw notFound("Catalogue version");
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product", status: "pending" }, include: { version: { include: { catalogue: true } } }, orderBy: { seq: "asc" } });
  const mctx = await matchContext(version);
  const created = [];
  const skipped = { flagged: 0, existing: 0, notExtracted: 0 };
  for (const b of blocks) {
    if (!b.extracted) {
      skipped.notExtracted++;
      continue;
    }
    if ((b.extracted.flags || []).length) {
      skipped.flagged++;
      continue;
    }
    if (matchBlock(mctx, b)) {
      skipped.existing++;
      continue;
    }
    const p = await applyOne(b, userId, mctx);
    created.push({ blockId: b.id, productId: p.id, name: p.name });
  }
  if (created.length) await afterApply(version);
  return { created: created.length, products: created, skipped };
}

/** POST /catalogue-blocks/:id/reject — not a product / not wanted; nothing is written. */
export async function rejectBlock(blockId, companyScope, userId = null) {
  const block = await loadBlock(blockId, companyScope);
  if (block.status !== "pending") throw new CertError("BLOCK_DECIDED", `This block is already ${block.status}`, 409);
  await prisma.catalogueBlock.update({ where: { id: block.id }, data: { status: "rejected", extracted: block.extracted ? { ...block.extracted, rejectedByUserId: userId, rejectedAt: new Date().toISOString() } : block.extracted } });
  await afterApply(block.version);
  return { blockId: block.id, status: "rejected" };
}

// ── segmentation fixes (§15.3 step 2: "the admin can merge or split blocks") ──
const reseq = async (versionId) => {
  const all = await prisma.catalogueBlock.findMany({ where: { versionId }, orderBy: [{ seq: "asc" }, { createdAt: "asc" }], select: { id: true } });
  await prisma.$transaction(all.map((b, i) => prisma.catalogueBlock.update({ where: { id: b.id }, data: { seq: i } })));
};

function joinLines(blocks) {
  let o = 0;
  const lines = [];
  for (const b of blocks) for (const l of b.lines || []) {
    lines.push({ ...l, o });
    o += l.t.length + 1;
  }
  return { lines, text: lines.map((l) => l.t).join("\n") };
}
const bboxOf = (lines) => {
  const x = Math.min(...lines.map((l) => l.x));
  const y = Math.min(...lines.map((l) => l.y));
  return { x, y, w: Math.max(...lines.map((l) => l.x + l.w)) - x, h: Math.max(...lines.map((l) => l.y + l.h)) - y };
};

/** POST /catalogue-versions/:id/merge-blocks { blockIds: [a, b] } — two blocks of one page are one product. */
export async function mergeBlocks(versionId, companyScope, blockIds) {
  const blocks = await prisma.catalogueBlock.findMany({ where: { id: { in: blockIds }, versionId }, orderBy: { seq: "asc" } });
  if (blocks.length !== 2 || (companyScope && blocks.some((b) => b.companyId !== companyScope))) throw notFound("Catalogue block");
  if (blocks.some((b) => b.status !== "pending" || b.productId)) throw new CertError("BLOCK_DECIDED", "Only pending, unlinked blocks can be merged", 409);
  if (blocks[0].page !== blocks[1].page) throw new CertError("DIFFERENT_PAGES", "Only blocks of the same page can be merged", 409);
  const { lines, text } = joinLines(blocks);
  const [keep, drop] = blocks;
  await prisma.$transaction([
    prisma.catalogueBlock.update({ where: { id: keep.id }, data: { kind: "product", text, lines, bbox: bboxOf(lines), title: keep.title || drop.title, extracted: null } }),
    prisma.catalogueBlock.delete({ where: { id: drop.id } }),
  ]);
  await reseq(versionId);
  return { blockId: keep.id, removed: drop.id, needsExtraction: true };
}

/** POST /catalogue-blocks/:id/split { atLine } — the block holds two products; lines [atLine…] become a new block. */
export async function splitBlock(blockId, companyScope, atLine) {
  const block = await loadBlock(blockId, companyScope);
  if (block.status !== "pending" || block.productId) throw new CertError("BLOCK_DECIDED", "Only a pending, unlinked block can be split", 409);
  const lines = block.lines || [];
  if (!Number.isInteger(atLine) || atLine < 1 || atLine >= lines.length) throw new CertError("INVALID_SPLIT", `Split at a line between 1 and ${lines.length - 1}`, 400);
  const part = (ls) => {
    let o = 0;
    const out = ls.map((l) => {
      const r = { ...l, o };
      o += l.t.length + 1;
      return r;
    });
    return { lines: out, text: out.map((l) => l.t).join("\n"), bbox: bboxOf(out) };
  };
  const a = part(lines.slice(0, atLine));
  const b = part(lines.slice(atLine));
  // same seq, created later → ordered right after the original by reseq; its name comes from the extraction
  const [, created] = await prisma.$transaction([
    prisma.catalogueBlock.update({ where: { id: block.id }, data: { ...a, extracted: null } }),
    prisma.catalogueBlock.create({ data: { versionId: block.versionId, companyId: block.companyId, seq: block.seq, kind: "product", page: block.page, title: null, ...b } }),
  ]);
  await reseq(block.versionId);
  return { blockId: block.id, newBlockId: created.id, needsExtraction: true };
}
