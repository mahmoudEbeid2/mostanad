import path from "path";
import { prisma } from "../../lib/prisma.js";
import { CertError, notFound } from "../certificates/errors.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { enqueueTask, QUEUES } from "../certificates/jobs/queues.js";
import { presentError } from "../ai/aiErrorMessage.js";
import { openPdf } from "./pages/pdfInfo.js";
import { selectionForExtraction } from "./pages/pageService.js";

// Product catalogues as source documents (plan.md §15.2, §15.7; Phase A6.1).
//  - A system user (manage_catalogues) uploads a manufacturer's catalogue FOR a
//    company; the file is a StoredFile kept forever (never deleted, never swept).
//  - Each upload is a CatalogueVersion under its Catalogue (company + manufacturer).
//  - An upload only opens the file (page count, sizes) and answers at once: no text
//    is read and no thumbnail drawn. A person chooses the pages, and only those are
//    read into product blocks and sent to the AI (extractionService).
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

/** Stores an opened file as a new version of the catalogue, with its page rows. Nothing is queued. */
async function addVersion({ catalogue, label, file, info, userId }) {
  const stored = await fileStore.putFile({ companyId: catalogue.companyId, kind: "catalogue_source", buffer: file.buffer, mimeType: "application/pdf", originalName: file.originalname || null });
  // the admin confirms the number convention once per catalogue: a new version inherits the last confirmed one
  const prior = await prisma.catalogueVersion.findFirst({ where: { catalogueId: catalogue.id, numberConvention: { path: ["source"], equals: "admin" } }, orderBy: { createdAt: "desc" }, select: { id: true, numberConvention: true } });
  const version = await prisma.catalogueVersion.create({
    data: {
      catalogueId: catalogue.id,
      companyId: catalogue.companyId,
      label: String(label || "").trim() || baseName(file.originalname),
      sourceFileId: stored.id,
      uploadedByUserId: userId || null,
      status: "pages_ready",
      pages: info.pageCount,
      ...(prior ? { numberConvention: { ...prior.numberConvention, inheritedFromVersionId: prior.id } } : {}),
    },
  });
  await prisma.cataloguePage.createMany({ data: info.pages.map((p) => ({ ...p, versionId: version.id, companyId: catalogue.companyId })) });
  return { catalogue, version, pageCount: info.pageCount };
}

/** Queues the extraction of a version's chosen pages (catalogue worker `extract`). → the task row */
export async function enqueueExtraction(version, { infer = true, blockIds = null } = {}) {
  const task = await enqueueTask({
    queueName: QUEUES.catalogue,
    jobName: "extract",
    type: "catalogue_extract",
    companyId: version.companyId,
    data: { entity: "catalogue_version", entityId: version.id, versionId: version.id, infer: infer !== false, ...(blockIds?.length ? { blockIds } : {}) },
  });
  await prisma.catalogueVersion.update({ where: { id: version.id }, data: { extractTaskId: task.id } });
  return task;
}

/**
 * POST /catalogue-versions/:id/extract { infer?, blockIds? } — read and extract the chosen pages not
 * read yet (blocks a person reviewed stay), or just some pending product blocks (after a merge/split).
 */
export async function requestExtraction(versionId, companyScope, { infer = true, blockIds = null } = {}) {
  const version = await loadVersion(versionId, companyScope);
  if (!["pages_ready", "segmented", "review", "applied"].includes(version.status)) throw new CertError("VERSION_NOT_READY", `A version that is ${version.status} can't be extracted`, 409);
  if (blockIds?.length) {
    const own = await prisma.catalogueBlock.count({ where: { versionId, id: { in: blockIds }, kind: "product" } });
    if (own !== blockIds.length) throw notFound("Catalogue block");
    const touched = await prisma.catalogueBlock.count({ where: { versionId, id: { in: blockIds }, OR: [{ status: { not: "pending" } }, { productId: { not: null } }] } });
    if (touched) throw new CertError("BLOCKS_IN_USE", "These blocks were already accepted or linked; they can't be extracted again", 409);
  } else {
    await selectionForExtraction(version); // nothing chosen is refused here, not in the job
  }
  const task = await enqueueExtraction(version, { infer, blockIds });
  return { versionId, jobId: task.id };
}

/**
 * POST /catalogues — a new catalogue for `companyId` (or a new version of the
 * company's catalogue from the same manufacturer). manufacturer defaults to the
 * brand's name, else the file name.
 */
export async function uploadCatalogue({ companyId, manufacturer, brandId, label, file, userId }) {
  await assertCompany(companyId);
  const brand = await assertBrand(companyId, brandId);
  assertFile(file);
  const info = await openPdf(file.buffer); // refused before anything is stored or created
  const maker = String(manufacturer || "").trim() || brand?.name || baseName(file.originalname);
  const catalogue = await prisma.catalogue.upsert({
    where: { companyId_manufacturer: { companyId, manufacturer: maker } },
    update: brand ? { brandId: brand.id } : {},
    create: { companyId, manufacturer: maker, brandId: brand?.id || null },
  });
  return addVersion({ catalogue, label, file, info, userId });
}

/** POST /catalogues/:id/versions — a newer file of an existing catalogue (diff in §15.4). */
export async function uploadVersion(catalogueId, companyScope, { label, file, userId }) {
  const catalogue = await prisma.catalogue.findUnique({ where: { id: catalogueId } });
  if (!visible(catalogue, companyScope)) throw notFound("Catalogue");
  assertFile(file);
  return addVersion({ catalogue, label, file, info: await openPdf(file.buffer), userId });
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
  pageSelection: true,
  extractTaskId: true,
  _count: { select: { blocks: true } },
};

/** A version being extracted carries its task's progress, for the list's status pill. */
async function withTasks(versions) {
  const ids = versions.filter((v) => v.status === "extracting" && v.extractTaskId).map((v) => v.extractTaskId);
  const tasks = ids.length ? await prisma.backgroundTask.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, progress: true, message: true, stage: true } }) : [];
  return versions.map((v) => ({ ...presentError(v), task: (v.status === "extracting" && tasks.find((t) => t.id === v.extractTaskId)) || null }));
}

/** GET /catalogues — the scoped company's catalogues (a system user without ?companyId sees all). */
export async function listCatalogues(companyScope) {
  const rows = await prisma.catalogue.findMany({
    where: companyScope ? { companyId: companyScope } : {},
    include: { brand: { select: { id: true, name: true } }, company: { select: { id: true, name: true } }, versions: { select: versionSummary, orderBy: { createdAt: "desc" } } },
    orderBy: { updatedAt: "desc" },
  });
  return Promise.all(rows.map(async (c) => ({ ...c, versions: await withTasks(c.versions) })));
}

export async function getCatalogue(id, companyScope) {
  const row = await prisma.catalogue.findUnique({
    where: { id },
    include: { brand: { select: { id: true, name: true } }, company: { select: { id: true, name: true } }, versions: { select: versionSummary, orderBy: { createdAt: "desc" } } },
  });
  if (!visible(row, companyScope)) throw notFound("Catalogue");
  return { ...row, versions: await withTasks(row.versions) };
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
  return presentError({ ...version, blocks });
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
