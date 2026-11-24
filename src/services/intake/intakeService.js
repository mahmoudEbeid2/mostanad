import crypto from "crypto";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { enqueueTask, QUEUES } from "../certificates/jobs/queues.js";
import { createProduct } from "../productService.js";
import { newEntities, ACTIONS } from "./intakeResolve.js";

// "ارفع ملفاتك" — drop any files (many, a folder, a .zip) and the system works out
// what each one is and whose, proposes what to create, and files everything when
// the person presses "نفّذ الكل". Upload → classify (background) → review → execute
// (background). Until execute nothing exists outside the intake tables: the files
// are kept unbound (no company) or in the session's company.
//
// Tenancy: a company session's drop is always its own company (it may add brands and
// products, never companies); a system user may name a company (hint), or let the
// files say, and may create companies with create_companies.

export const MAX_FILE_BYTES = 60 * 1024 * 1024;
export const MAX_ZIP_BYTES = 250 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const ACCEPTED = ["pdf", "ai", "png", "jpg", "jpeg", "webp", "xlsx", "csv", "html", "htm", "zip"];
const TMP_DIR = path.join(process.cwd(), "uploads", "intake_tmp");

const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
const owner = (actor) => ({ ownerType: actor.kind, ownerId: actor.id });

/** actor: { kind: "company" | "user", id, companyId?, can(slug) } */
export async function loadBatch(actor, id) {
  const b = await prisma.intakeBatch.findUnique({ where: { id } });
  if (!b || b.ownerType !== actor.kind || b.ownerId !== actor.id) throw new AppError("Upload not found!", 404);
  return b;
}

async function loadItem(actor, id) {
  const item = await prisma.intakeItem.findUnique({ where: { id }, include: { batch: true } });
  if (!item || item.batch.ownerType !== actor.kind || item.batch.ownerId !== actor.id) throw new AppError("File not found!", 404);
  return item;
}

/** POST /intake/batches { companyId? } — a new drop. A company session always uses its own company. */
export async function createBatch(actor, { companyId = null, conversationId = null } = {}) {
  let scope = actor.kind === "company" ? actor.companyId : companyId || null;
  if (scope && actor.kind === "user" && !(await prisma.company.findUnique({ where: { id: scope }, select: { id: true } }))) throw new AppError("Company not found!", 404);
  return prisma.intakeBatch.create({ data: { ...owner(actor), companyId: scope, conversationId } });
}

/** POST /intake/batches/:id/files { name, size, relPath? } — announces one file; its bytes come in chunks. */
export async function addFile(actor, batchId, { name, size, relPath = null }) {
  const batch = await loadBatch(actor, batchId);
  if (!["uploading", "review"].includes(batch.status)) throw new AppError("This upload is already being processed", 409);
  const ext = extOf(name);
  if (!ACCEPTED.includes(ext)) throw new AppError(`${name}: this kind of file can't be filed (PDF, AI, images, Excel/CSV, HTML or ZIP)`, 400);
  const limit = ext === "zip" ? MAX_ZIP_BYTES : MAX_FILE_BYTES;
  if (!Number.isInteger(size) || size <= 0) throw new AppError(`${name} is empty`, 400);
  if (size > limit) throw new AppError(`${name} is larger than ${Math.round(limit / 1024 / 1024)} MB`, 413);
  return prisma.intakeItem.create({ data: { batchId, name: String(name).slice(0, 250), relPath: relPath ? String(relPath).slice(0, 500) : null, sizeBytes: size } });
}

/**
 * PUT /intake/items/:id/chunk?offset=N (raw bytes). Resumable: a chunk the server
 * already has is acknowledged, one past the end is refused with what it has.
 * → { receivedBytes, complete }
 */
export async function putChunk(actor, itemId, offset, chunk) {
  const item = await loadItem(actor, itemId);
  if (item.status !== "uploading") return { receivedBytes: item.receivedBytes, complete: true };
  if (offset > item.receivedBytes) throw Object.assign(new AppError(`Expected bytes from ${item.receivedBytes}`, 409), { code: "RESUME_FROM", receivedBytes: item.receivedBytes });
  const skip = item.receivedBytes - offset; // a resent chunk: only its new tail
  const fresh = chunk.subarray(Math.max(0, skip));
  if (item.receivedBytes + fresh.length > item.sizeBytes) throw new AppError("More bytes than the file's size", 400);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  if (fresh.length) fs.appendFileSync(path.join(TMP_DIR, `${item.id}.part`), fresh);
  const receivedBytes = item.receivedBytes + fresh.length;
  await prisma.intakeItem.update({ where: { id: item.id }, data: { receivedBytes } });
  if (receivedBytes < item.sizeBytes) return { receivedBytes, complete: false };
  await finishFile(item);
  return { receivedBytes, complete: true };
}

/** The whole file is here: hashed and stored (in the drop's company, or unbound). */
async function finishFile(item) {
  const tmp = path.join(TMP_DIR, `${item.id}.part`);
  const buffer = fs.readFileSync(tmp);
  await storeBuffer(item, buffer);
  try {
    fs.rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 200 }); // Windows may hold the file a moment longer
  } catch (err) {
    console.warn(`[intake] couldn't remove ${tmp} (the file is stored; the leftover is only disk space): ${err.message}`);
  }
}

export async function storeBuffer(item, buffer, { batch = null } = {}) {
  const b = batch || (await prisma.intakeBatch.findUnique({ where: { id: item.batchId } }));
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const ext = extOf(item.name);
  const mimeType = { pdf: "application/pdf", ai: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", html: "text/html", htm: "text/html", zip: "application/zip" }[ext] || "application/octet-stream";
  const stored = await fileStore.putFile({ companyId: b.companyId, kind: "intake_file", buffer, mimeType, originalName: item.name, ext: ext || "bin" });
  return prisma.intakeItem.update({ where: { id: item.id }, data: { fileId: stored.id, sha256, mimeType, receivedBytes: buffer.length, sizeBytes: buffer.length, status: "uploaded" } });
}

/** POST /intake/batches/:id/classify — every file is up: recognise them (background). → { taskId } */
export async function startClassify(actor, batchId) {
  const batch = await loadBatch(actor, batchId);
  const items = await prisma.intakeItem.findMany({ where: { batchId } });
  if (!items.length) throw new AppError("Add at least one file", 400);
  const missing = items.filter((i) => i.status === "uploading");
  if (missing.length) throw new AppError(`${missing.length} file(s) haven't finished uploading: ${missing.map((i) => i.name).slice(0, 5).join(", ")}`, 409);
  const task = await enqueueTask({ queueName: QUEUES.template, jobName: "intakeClassify", type: "intake_classify", companyId: batch.companyId, data: { entity: "intake_batch", entityId: batch.id, batchId: batch.id } });
  await prisma.intakeBatch.update({ where: { id: batch.id }, data: { status: "classifying", classifyTaskId: task.id } });
  return { taskId: task.id };
}

// ── the review card ─────────────────────────────────────────────────────────
const ref = (x) => (x ? (x.id ? { id: x.id, name: x.name } : { name: x.name, isNew: true }) : null);

/** classification.proposal overlaid with the person's decision → what execute will do. */
export function effectiveOf(item) {
  const p = item.classification?.proposal;
  if (!p) return null;
  const d = item.decision || {};
  const e = { ...p, ...Object.fromEntries(["docType", "certCode", "company", "brand", "products", "country"].filter((k) => d[k] !== undefined).map((k) => [k, d[k]])) };
  if (d.skip) e.action = "skip";
  else if (d.action) e.action = d.action;
  else if (d.docType && d.docType !== p.docType) e.action = { label: "label", certificate_template: "certificate_template", certificate_filled: "certificate_filled", invoice: "invoice", manufacturing_order: "manufacturing_order", catalogue: "catalogue", product_list: "product_list", other: "other" }[d.docType] || "other";
  e.actionText = e.action === p.action && p.actionText ? p.actionText : ACTIONS[e.action] || ACTIONS.other;
  e.question = d.docType || d.action || d.country ? null : p.question;
  return e;
}

const rowOf = (i) => {
  const e = effectiveOf(i);
  return {
    id: i.id,
    parentId: i.parentId,
    name: i.name,
    relPath: i.relPath,
    pages: i.pageFrom ? `${i.pageFrom}${i.pageTo !== i.pageFrom ? `–${i.pageTo}` : ""}` : i.classification?.pageCount ?? null,
    sizeBytes: i.sizeBytes,
    receivedBytes: i.receivedBytes,
    status: i.status,
    revision: i.revision,
    docType: e?.docType ?? null,
    certCode: e?.certCode ?? null,
    company: ref(e?.company),
    brand: ref(e?.brand),
    products: (e?.products || []).map((p) => ({ ...ref(p), volume: p.volume || null })),
    country: e?.country ?? null,
    action: e?.action ?? null,
    actionText: e?.actionText ?? null,
    confidence: e?.confidence ?? null,
    question: e?.question ?? null,
    evidence: (e?.evidence || []).slice(0, 6),
    batches: i.classification?.batches || [],
    language: i.classification?.language || null,
    aiCalls: i.aiCalls,
    result: i.result,
    error: i.error,
  };
};

/** GET /intake/batches/:id → { batch, items, newEntities, summary } */
export async function getBatchView(actor, id) {
  const batch = await loadBatch(actor, id);
  const items = await prisma.intakeItem.findMany({ where: { batchId: id }, orderBy: [{ createdAt: "asc" }, { pageFrom: "asc" }] });
  const rows = items.map(rowOf);
  const effective = items.map(effectiveOf).filter(Boolean);
  const task = batch.executeTaskId ? await prisma.backgroundTask.findUnique({ where: { id: batch.executeTaskId }, select: { status: true, progress: true, message: true, error: true } }) : batch.classifyTaskId ? await prisma.backgroundTask.findUnique({ where: { id: batch.classifyTaskId }, select: { status: true, progress: true, message: true, error: true } }) : null;
  return { batch: { id: batch.id, status: batch.status, companyId: batch.companyId, aiCalls: batch.aiCalls, executedAt: batch.executedAt, createdAt: batch.createdAt }, task, items: rows, newEntities: newEntities(effective), summary: batch.summary };
}

/** GET /intake/batches — the caller's recent drops. */
export async function listBatches(actor, { limit = 20 } = {}) {
  const rows = await prisma.intakeBatch.findMany({ where: owner(actor), orderBy: { createdAt: "desc" }, take: Math.min(Number(limit) || 20, 100), include: { _count: { select: { items: true } } } });
  return rows.map((b) => ({ id: b.id, status: b.status, files: b._count.items, createdAt: b.createdAt, summary: b.summary }));
}

const DOC = ["label", "certificate_template", "certificate_filled", "invoice", "manufacturing_order", "catalogue", "product_list", "other"];
const ACTION_KEYS = Object.keys(ACTIONS);

/**
 * PATCH /intake/items/:id — the person changes one row of the card (a dropdown).
 * body: { docType?, certCode?, action?, company?: { id } | { name }, brand?, products?: [{ id } | { name, volume? }], country?, skip? }
 * Ids must be in the caller's scope; a company session can't pick another company.
 */
export async function decideItem(actor, id, body = {}) {
  const item = await loadItem(actor, id);
  if (item.batch.status !== "review") throw new AppError("This upload isn't waiting for review", 409);
  const d = { ...(item.decision || {}) };
  if (body.docType !== undefined) {
    if (!DOC.includes(body.docType)) throw new AppError("Unknown document type", 400);
    d.docType = body.docType;
  }
  if (body.action !== undefined) {
    if (body.action !== null && !ACTION_KEYS.includes(body.action)) throw new AppError("Unknown action", 400);
    d.action = body.action;
  }
  if (body.certCode !== undefined) d.certCode = body.certCode ? String(body.certCode).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) : null;
  if (body.country !== undefined) d.country = body.country ? String(body.country).toUpperCase().slice(0, 2) : null;
  if (body.skip !== undefined) d.skip = !!body.skip;
  if (body.company !== undefined) {
    if (actor.kind === "company") throw new AppError("Your files always go to your own company", 403);
    if (body.company?.id) {
      const c = await prisma.company.findUnique({ where: { id: body.company.id }, select: { id: true, name: true } });
      if (!c) throw new AppError("Company not found!", 404);
      d.company = { id: c.id, name: c.name };
    } else d.company = body.company?.name ? { name: String(body.company.name).trim().slice(0, 120), isNew: true } : null;
  }
  const companyId = (d.company || effectiveOf(item)?.company)?.id || (actor.kind === "company" ? actor.companyId : null);
  if (body.brand !== undefined) {
    if (body.brand?.id) {
      const b = await prisma.brand.findUnique({ where: { id: body.brand.id }, select: { id: true, name: true, companyId: true } });
      if (!b || (companyId && b.companyId !== companyId)) throw new AppError("Brand not found in this company", 404);
      d.brand = { id: b.id, name: b.name };
    } else d.brand = body.brand?.name ? { name: String(body.brand.name).trim().slice(0, 80), isNew: true } : null;
  }
  if (body.products !== undefined) {
    const out = [];
    for (const p of body.products || []) {
      if (p?.id) {
        const row = await prisma.product.findUnique({ where: { id: p.id }, select: { id: true, name: true, companyId: true } });
        if (!row || (companyId && row.companyId !== companyId)) throw new AppError("Product not found in this company", 404);
        out.push({ id: row.id, name: row.name });
      } else if (p?.name) out.push({ name: String(p.name).trim().slice(0, 120), volume: p.volume || null, isNew: true });
    }
    d.products = out;
  }
  const updated = await prisma.intakeItem.update({ where: { id: item.id }, data: { decision: d, revision: { increment: 1 } } });
  return rowOf(updated);
}

// ── execute ─────────────────────────────────────────────────────────────────
const uniqueUsername = async (name) => {
  const root = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || "company";
  for (let n = 0; ; n++) {
    const u = n ? `${root}${n}` : root;
    if (!(await prisma.company.findUnique({ where: { username: u }, select: { id: true } }))) return u;
  }
};

/**
 * POST /intake/batches/:id/execute { revisions: { [itemId]: revision } } — "نفّذ الكل".
 * The card's staleness check covers only its own items: every live item's revision
 * must be the one the card showed. Creates the new companies / brands / products
 * (marked as made by intake, with their file), files every item under its company,
 * then runs each one's pipeline in the background. → { taskId, created }
 */
export async function startExecute(actor, batchId, { revisions = {} } = {}) {
  const batch = await loadBatch(actor, batchId);
  if (batch.status !== "review") throw new AppError(batch.status === "executing" || batch.status === "done" ? "This upload has already been filed" : "This upload isn't ready yet", 409);
  const items = await prisma.intakeItem.findMany({ where: { batchId } });
  const live = items.filter((i) => i.classification?.proposal);
  const stale = live.filter((i) => revisions[i.id] !== i.revision);
  if (stale.length) throw Object.assign(new AppError(`The card is out of date for ${stale.length} file(s) — reload it`, 409), { code: "STALE_CARD", itemIds: stale.map((i) => i.id) });
  // labels first: a product is made from the file that names it with its pack size (its source in fieldProvenance)
  const first = (e) => (e.docType === "label" && e.action === "label" ? 0 : e.docType === "label" ? 1 : 2);
  const work = live
    .map((i) => ({ item: i, e: effectiveOf(i) }))
    .filter(({ e }) => !["duplicate", "skip"].includes(e.action))
    .sort((a, b) => first(a.e) - first(b.e));
  const needs = newEntities(work.map((w) => w.e));
  if (needs.companies.length && !(actor.kind === "user" && actor.can("create_companies"))) throw new AppError(`Creating a company (${needs.companies.map((c) => c.name).join(", ")}) needs a system user with create_companies — pick an existing company instead`, 403);
  if ((needs.brands.length || needs.products.length) && !actor.can("create_products")) throw new AppError("Adding brands or products needs the create_products permission", 403);
  for (const { e } of work) if (!e.company && actor.kind !== "company") throw new AppError("Some files have no company yet — choose one on the card", 400);

  const created = { companies: [], brands: [], products: [] };
  const record = (entityType, row, itemId, companyId) => prisma.intakeCreated.create({ data: { batchId, itemId, entityType, entityId: row.id, name: row.name, companyId } });
  const key = (x) => String(x?.name || "").toUpperCase().replace(/[^A-Z0-9؀-ۿ]/g, "");
  const companyIds = new Map();
  const companyOf = async (e, itemId) => {
    if (actor.kind === "company") return actor.companyId;
    if (e.company?.id) return e.company.id;
    if (!companyIds.has(key(e.company))) {
      const c = await prisma.company.create({ data: { name: e.company.name, username: await uniqueUsername(e.company.name), password: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12) }, select: { id: true, name: true } });
      await record("company", c, itemId, c.id);
      created.companies.push(c);
      companyIds.set(key(e.company), c.id);
    }
    return companyIds.get(key(e.company));
  };
  const brandIds = new Map();
  const brandOf = async (e, companyId, itemId) => {
    if (!e.brand) return null;
    if (e.brand.id) return e.brand.id;
    const k = `${companyId}|${key(e.brand)}`;
    if (!brandIds.has(k)) {
      const existing = await prisma.brand.findFirst({ where: { companyId, name: { equals: e.brand.name, mode: "insensitive" } }, select: { id: true, name: true } });
      const b = existing || (await prisma.brand.create({ data: { companyId, name: e.brand.name }, select: { id: true, name: true } }));
      if (!existing) {
        await record("brand", b, itemId, companyId);
        created.brands.push(b);
      }
      brandIds.set(k, b.id);
    }
    return brandIds.get(k);
  };
  const productIds = new Map();
  const productsOf = async (e, companyId, brandId, item) => {
    const ids = [];
    for (const p of e.products || []) {
      if (p.id) {
        ids.push(p.id);
        continue;
      }
      const k = `${companyId}|${key(p)}`;
      if (!productIds.has(k)) {
        const existing = await prisma.product.findFirst({ where: { companyId, name: { equals: p.name, mode: "insensitive" } }, select: { id: true, name: true } });
        const row =
          existing ||
          (await createProduct(companyId, {
            name: p.name,
            ...(p.volume ? { packaging: p.volume } : {}),
            ...(brandId ? { brandId } : {}),
            fieldProvenance: { name: { source: "intake", file: item.name, page: item.pageFrom || 1 }, ...(p.volume ? { packaging: { source: "intake", file: item.name, from: "file name" } } : {}) },
          }));
        if (!existing) {
          await record("product", { id: row.id, name: row.name }, item.id, companyId);
          created.products.push({ id: row.id, name: row.name });
        }
        productIds.set(k, row.id);
      }
      ids.push(productIds.get(k));
    }
    return ids;
  };

  for (const { item, e } of work) {
    const companyId = await companyOf(e, item.id);
    const brandId = await brandOf(e, companyId, item.id);
    const productIdList = await productsOf(e, companyId, brandId, item);
    await prisma.intakeItem.update({ where: { id: item.id }, data: { companyId, status: "executing", result: { ...(item.result || {}), plan: { action: e.action, companyId, brandId, productIds: productIdList, country: e.country || null, certCode: e.certCode || null } } } });
    if (item.fileId && !item.parentId) await prisma.storedFile.updateMany({ where: { id: item.fileId, companyId: null }, data: { companyId } });
  }
  for (const i of live.filter((x) => ["duplicate", "skip"].includes(effectiveOf(x).action))) await prisma.intakeItem.update({ where: { id: i.id }, data: { status: effectiveOf(i).action === "duplicate" ? "duplicate" : "skipped" } });
  const task = await enqueueTask({ queueName: QUEUES.template, jobName: "intakeExecute", type: "intake_execute", companyId: batch.companyId, data: { entity: "intake_batch", entityId: batch.id, batchId: batch.id, userId: actor.kind === "user" ? actor.id : null } });
  await prisma.intakeBatch.update({ where: { id: batch.id }, data: { status: "executing", executeTaskId: task.id, executedAt: new Date(), executedByUserId: actor.kind === "user" ? actor.id : null } });
  return { taskId: task.id, created };
}

/** GET /intake/created?companyId= — what intake made (to review later). */
export async function listCreated(actor, { companyId = null } = {}) {
  const scope = actor.kind === "company" ? actor.companyId : companyId;
  return prisma.intakeCreated.findMany({ where: scope ? { companyId: scope } : {}, orderBy: { createdAt: "desc" }, take: 500 });
}

