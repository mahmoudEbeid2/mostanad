import path from "path";
import { prisma } from "../../lib/prisma.js";
import { CertError, notFound } from "../certificates/errors.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { enqueueTask, QUEUES } from "../certificates/jobs/queues.js";
import { readPdfLayout } from "./pdfLayout.js";
import { segment, SEGMENTER_VERSION } from "./segmenter.js";

// Product catalogues as source documents (plan.md §15.2, §15.7; Phase A6.1).
//  - A system user (manage_catalogues) uploads a manufacturer's catalogue FOR a
//    company; the file is a StoredFile kept forever (never deleted, never swept).
//  - Each upload is a CatalogueVersion under its Catalogue (company + manufacturer).
//  - Code splits it into product blocks { page, bbox, text, lines } (segmenter.js).
//  - Every query is tenant-scoped: a company sees only its own catalogues;
//    another tenant's row is reported as missing (404), never as forbidden.
// Nothing here creates, changes or deletes a product's data; linking a block to
// a product only writes that product's catalogueRef.

export const MAX_CATALOGUE_BYTES = 60 * 1024 * 1024;
const isPdf = (b) => b.subarray(0, 5).toString("latin1") === "%PDF-";

const visible = (row, companyScope) => !!row && (!companyScope || row.companyId === companyScope);

async function assertCompany(companyId) {
  if (!companyId) throw new CertError("COMPANY_REQUIRED", "Pick the company this catalogue belongs to", 400);
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } });
  if (!company) throw notFound("Company");
}

async function assertBrand(companyId, brandId) {
  if (!brandId) return null;
  const brand = await prisma.brand.findFirst({ where: { id: brandId, companyId }, select: { id: true, name: true } });
  if (!brand) throw new CertError("BRAND_NOT_IN_COMPANY", "This brand does not belong to the chosen company", 400);
  return brand;
}

function assertFile(file) {
  if (!file?.buffer?.length) throw new CertError("FILE_REQUIRED", "Upload the catalogue PDF in the 'file' field", 400);
  if (file.buffer.length > MAX_CATALOGUE_BYTES) throw new CertError("FILE_TOO_LARGE", "Catalogues are limited to 60 MB", 413);
  if (!isPdf(file.buffer)) throw new CertError("NOT_A_PDF", "A catalogue must be a PDF file", 415);
}

const baseName = (name) => path.basename(String(name || "catalogue.pdf")).replace(/\.pdf$/i, "").trim().slice(0, 120) || "Catalogue";

/** Stores the file, creates the version and queues its segmentation (then, unless extract === false, its extraction). */
async function addVersion({ catalogue, label, file, userId, extract = true }) {
  const stored = await fileStore.putFile({ companyId: catalogue.companyId, kind: "catalogue_source", buffer: file.buffer, mimeType: "application/pdf", originalName: file.originalname || null });
  const version = await prisma.catalogueVersion.create({
    data: {
      catalogueId: catalogue.id,
      companyId: catalogue.companyId,
      label: String(label || "").trim() || baseName(file.originalname),
      sourceFileId: stored.id,
      uploadedByUserId: userId || null,
    },
  });
  const task = await enqueueTask({
    queueName: QUEUES.catalogue,
    jobName: "segment",
    type: "catalogue_segment",
    companyId: catalogue.companyId,
    data: { entity: "catalogue_version", entityId: version.id, versionId: version.id, extract: extract !== false },
  });
  return { catalogue, version, taskId: task.id };
}

/** Queues the AI extraction of a segmented version (catalogue worker `extract`). → the task row */
export function enqueueExtraction(version, { infer = true } = {}) {
  return enqueueTask({
    queueName: QUEUES.catalogue,
    jobName: "extract",
    type: "catalogue_extract",
    companyId: version.companyId,
    data: { entity: "catalogue_version", entityId: version.id, versionId: version.id, infer: infer !== false },
  });
}

/** POST /catalogue-versions/:id/extract — (re-)extract the products of a version whose blocks nobody acted on yet. */
export async function requestExtraction(versionId, companyScope, { infer = true } = {}) {
  const version = await loadVersion(versionId, companyScope);
  if (!["segmented", "review"].includes(version.status)) throw new CertError("VERSION_NOT_READY", `A version that is ${version.status} can't be extracted`, 409);
  const touched = await prisma.catalogueBlock.count({ where: { versionId, OR: [{ status: { not: "pending" } }, { productId: { not: null } }] } });
  if (touched) throw new CertError("BLOCKS_IN_USE", "Blocks of this version were already accepted or linked; it can't be extracted again", 409);
  const task = await enqueueExtraction(version, { infer });
  return { versionId, jobId: task.id };
}

/**
 * POST /catalogues — a new catalogue for `companyId` (or a new version of the
 * company's catalogue from the same manufacturer). manufacturer defaults to the
 * brand's name, else the file name.
 */
export async function uploadCatalogue({ companyId, manufacturer, brandId, label, file, userId, extract = true }) {
  await assertCompany(companyId);
  const brand = await assertBrand(companyId, brandId);
  assertFile(file);
  const maker = String(manufacturer || "").trim() || brand?.name || baseName(file.originalname);
  const catalogue = await prisma.catalogue.upsert({
    where: { companyId_manufacturer: { companyId, manufacturer: maker } },
    update: brand ? { brandId: brand.id } : {},
    create: { companyId, manufacturer: maker, brandId: brand?.id || null },
  });
  return addVersion({ catalogue, label, file, userId, extract });
}

/** POST /catalogues/:id/versions — a newer file of an existing catalogue (diff in §15.4). */
export async function uploadVersion(catalogueId, companyScope, { label, file, userId, extract = true }) {
  const catalogue = await prisma.catalogue.findUnique({ where: { id: catalogueId } });
  if (!visible(catalogue, companyScope)) throw notFound("Catalogue");
  assertFile(file);
  return addVersion({ catalogue, label, file, userId, extract });
}

/**
 * The catalogue worker's `segment` job: text with positions → blocks. Idempotent
 * by version: a retried job replaces the blocks it wrote, unless a person already
 * acted on them (then it refuses rather than lose that work).
 */
export async function runSegmentJob(versionId, ctx = { progress: () => {} }, { extract = false } = {}) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  if (!version) throw notFound("Catalogue version");
  // checked before anything changes, so a refused retry leaves a reviewed version as it is
  const touched = await prisma.catalogueBlock.count({ where: { versionId, OR: [{ status: { not: "pending" } }, { productId: { not: null } }] } });
  if (touched) throw new CertError("BLOCKS_IN_USE", "This version's blocks were already reviewed or linked; it can't be segmented again", 409);
  const started = Date.now();
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "segmenting", error: null } });
  try {
    ctx.progress(10, "Reading the catalogue's text layer");
    const { buffer } = await fileStore.readFile(version.sourceFileId, { companyId: version.companyId });
    const layout = await readPdfLayout(buffer);
    ctx.progress(60, "Finding product blocks");
    const { blocks, warnings, stats } = segment(layout);
    await prisma.$transaction([
      prisma.catalogueBlock.deleteMany({ where: { versionId } }),
      prisma.catalogueBlock.createMany({
        data: blocks.map((b) => ({ versionId, companyId: version.companyId, seq: b.seq, kind: b.kind, page: b.page, bbox: b.bbox, title: b.title, text: b.text, lines: b.lines })),
      }),
      prisma.catalogueVersion.update({
        where: { id: versionId },
        data: { status: "segmented", pages: stats.pages, warnings, extraction: { segmenter: SEGMENTER_VERSION, bodySize: stats.bodySize, ms: Date.now() - started } },
      }),
    ]);
    ctx.progress(100, `${stats.products} product blocks found`);
    // the AI step is its own job (own task, own retry); a scanned/empty catalogue has nothing to extract
    const next = extract && stats.products ? await enqueueExtraction({ id: versionId, companyId: version.companyId }) : null;
    return { versionId, pages: stats.pages, productBlocks: stats.products, contextBlocks: stats.context, warnings, ...(next ? { extractJobId: next.id } : {}) };
  } catch (err) {
    await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "failed", error: err.code ? `${err.code}: ${err.message}` : err.message } });
    throw err;
  }
}

const versionSummary = {
  id: true,
  label: true,
  status: true,
  pages: true,
  warnings: true,
  error: true,
  createdAt: true,
  appliedAt: true,
  sourceFileId: true,
  _count: { select: { blocks: true } },
};

/** GET /catalogues — the scoped company's catalogues (a system user without ?companyId sees all). */
export async function listCatalogues(companyScope) {
  const rows = await prisma.catalogue.findMany({
    where: companyScope ? { companyId: companyScope } : {},
    include: { brand: { select: { id: true, name: true } }, company: { select: { id: true, name: true } }, versions: { select: versionSummary, orderBy: { createdAt: "desc" } } },
    orderBy: { updatedAt: "desc" },
  });
  return rows;
}

export async function getCatalogue(id, companyScope) {
  const row = await prisma.catalogue.findUnique({
    where: { id },
    include: { brand: { select: { id: true, name: true } }, company: { select: { id: true, name: true } }, versions: { select: versionSummary, orderBy: { createdAt: "desc" } } },
  });
  if (!visible(row, companyScope)) throw notFound("Catalogue");
  return row;
}

async function loadVersion(id, companyScope) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id }, include: { catalogue: { select: { id: true, manufacturer: true, brandId: true } } } });
  if (!visible(version, companyScope)) throw notFound("Catalogue version");
  return version;
}

/** GET /catalogue-versions/:id — the version and its blocks (without geometry). */
export async function getVersion(id, companyScope) {
  const version = await loadVersion(id, companyScope);
  const blocks = await prisma.catalogueBlock.findMany({
    where: { versionId: id },
    select: { id: true, seq: true, kind: true, page: true, bbox: true, title: true, text: true, status: true, productId: true, extracted: true },
    orderBy: { seq: "asc" },
  });
  return { ...version, blocks };
}

/** GET /catalogue-versions/:id/file — the kept PDF. → { row, stream } */
export async function versionFile(id, companyScope) {
  const version = await loadVersion(id, companyScope);
  const row = await fileStore.getFileRow(version.sourceFileId, { companyId: version.companyId });
  return { row, stream: fileStore.createReadStream(row) };
}

export async function getBlock(id, companyScope) {
  const block = await prisma.catalogueBlock.findUnique({ where: { id }, include: { version: { select: { id: true, label: true, catalogueId: true, status: true } } } });
  if (!visible(block, companyScope)) throw notFound("Catalogue block");
  return block;
}

/**
 * POST /catalogue-blocks/:id/link { productId } — this block is that product's
 * catalogue entry: block.productId + product.catalogueRef. Touches no other
 * product field (retroactive linking of existing products, §15.8).
 */
export async function linkBlock(blockId, companyScope, productId) {
  const block = await getBlock(blockId, companyScope);
  if (block.kind !== "product") throw new CertError("NOT_A_PRODUCT_BLOCK", "Only a product block can be linked to a product", 409);
  const product = await prisma.product.findFirst({ where: { id: productId, companyId: block.companyId }, select: { id: true } });
  if (!product) throw notFound("Product");
  const catalogueRef = catalogueRefOf(block);
  await prisma.$transaction([
    prisma.catalogueBlock.update({ where: { id: block.id }, data: { productId: product.id } }),
    prisma.product.update({ where: { id: product.id }, data: { catalogueRef } }),
  ]);
  return { blockId: block.id, productId: product.id, catalogueRef };
}

/** The reference a product keeps to the block it came from (plan §15.3 step 7). */
export const catalogueRefOf = (block) => ({ catalogueId: block.version.catalogueId, catalogueVersionId: block.versionId, blockId: block.id, page: block.page });
