import { prisma } from "../../lib/prisma.js";
import { startPrepare, activateVersion } from "../certificates/templates/prepareService.js";
import { generateForProducts } from "../certificates/direct/directService.js";
import { startExportZip } from "../certificates/certificates/editService.js";

// "Express" — an urgent order from the chat ("طلّعلي الشهادات دي لمنتجات MAXVET"): the
// drop is filed as usual (company, brand, products, types, templates, references — one
// click on the card), THEN, without anyone registering anything by hand:
//   templates  — each certificate design's suggested fields (the intake's follow-up) are
//                prepared and the template is used as is (activateVersion express: its
//                fields stay "to check", nothing is remembered). A design that lists several
//                products in one table (an FSC) is NOT used — its rows would be printed as
//                they are on every certificate; it is listed for a person to set up.
//   generate   — one run for every product of the drop × every type asked (or every type
//                it has a template for): drafts, batch/lab values only from the files or the
//                person's message — a missing one is a marked blank, never filled in.
//   files      — the ZIP and one combined PDF of the drafts.
// Everything made is recorded in intake_created (reviewedAt null = "Express — needs
// review"); certificates stay drafts until a person approves them.
// The `intakeExpress` job runs this; it throws "not ready" while something is still being
// made (BullMQ retries it), so each run advances the state saved in batch.express.

const NOT_READY = "express: still working";
const notReady = () => Object.assign(new Error(NOT_READY), { retry: true });

async function save(batchId, express) {
  await prisma.intakeBatch.update({ where: { id: batchId }, data: { express } });
  return express;
}

/** A design whose page lists several products in one table (an FSC listing 5 items): its rows can't be filled automatically. */
const listsSeveralProducts = (item) => !item.pageFrom && (item.classification?.productNames || []).length >= 2;

async function record(batchId, entityType, row, companyId, itemId = null) {
  const exists = await prisma.intakeCreated.findFirst({ where: { batchId, entityType, entityId: row.id }, select: { id: true } });
  if (!exists) await prisma.intakeCreated.create({ data: { batchId, itemId, entityType, entityId: row.id, name: row.name, companyId } });
}

/** Step 1: every certificate design of the drop → used as a template (or why not). → true when all are settled */
async function settleTemplates(batch, items, ex) {
  const templates = { ...(ex.templates || {}) };
  let pending = false;
  for (const item of items.filter((i) => i.status === "done" && i.result?.template?.versionId)) {
    const t = item.result.template;
    const vid = t.versionId;
    const cur = templates[vid] || { code: t.code, file: item.name, templateId: t.templateId, link: item.result.link };
    if (["active", "needs_table", "failed", "no_fields"].includes(cur.status)) {
      templates[vid] = cur;
      continue;
    }
    if (listsSeveralProducts(item)) {
      templates[vid] = { ...cur, status: "needs_table", why: `lists ${(item.classification.productNames || []).length} products in one table — set up its product rows on the template screen` };
      continue;
    }
    const version = await prisma.templateVersion.findUnique({ where: { id: vid }, select: { status: true, error: true, template: { select: { companyId: true, name: true } } } });
    if (!version) {
      templates[vid] = { ...cur, status: "failed", why: "the template is gone" };
      continue;
    }
    const companyId = version.template.companyId;
    if (["uploaded", "converting", "preparing"].includes(version.status) || t.fields === "pending" || t.fields === undefined) {
      pending = true;
      templates[vid] = { ...cur, status: version.status === "preparing" ? "preparing" : "reading" };
      continue;
    }
    if (version.status === "failed") {
      templates[vid] = { ...cur, status: "failed", why: version.error || "the design couldn't be converted" };
      continue;
    }
    if (version.status === "draft") {
      if (cur.status === "preparing" && version.error) {
        templates[vid] = { ...cur, status: "failed", why: version.error };
        continue;
      }
      const count = await prisma.templateField.count({ where: { versionId: vid } });
      if (!count) {
        templates[vid] = { ...cur, status: "no_fields", why: t.fields?.why || "no field could be found on it — mark its fields on the template screen" };
        continue;
      }
      await startPrepare(vid, companyId);
      pending = true;
      templates[vid] = { ...cur, status: "preparing" };
      continue;
    }
    if (version.status === "ready") {
      try {
        await activateVersion(vid, companyId, batch.executedByUserId, { express: true });
      } catch (err) {
        templates[vid] = { ...cur, status: "failed", why: err.message };
        continue;
      }
    }
    // active (just now or before): its fields, for the card — what each draft will still need
    const fields = await prisma.templateField.findMany({ where: { versionId: vid }, select: { key: true, label: true, source: true } });
    const toFill = fields.filter((f) => ["manual", "item"].includes(f.source?.kind)).map((f) => f.label || f.key);
    templates[vid] = { ...cur, status: "active", fields: fields.length, toFill };
    await record(batch.id, "certificate_template", { id: t.templateId, name: version.template.name }, companyId, item.id);
  }
  ex.templates = templates;
  return !pending;
}

/** Step 2: one run for every product of the drop × the types (asked, or every one with a template now). */
async function generate(batch, items, ex) {
  const active = Object.values(ex.templates || {}).filter((t) => t.status === "active");
  const companyIds = [...new Set(items.filter((i) => i.status === "done" && i.companyId).map((i) => i.companyId))];
  const companyId = (active.length && (await prisma.certificateTemplate.findUnique({ where: { id: active[0].templateId }, select: { companyId: true } }))?.companyId) || companyIds[0] || null;
  if (!companyId) return { problem: "no company was filed" };
  const asked = (ex.requestedTypes || []).map((c) => String(c).toUpperCase());
  const codes = [...new Set((asked.length ? asked : active.map((t) => t.code)).filter(Boolean))];
  const types = await prisma.certificateType.findMany({ where: { companyId, code: { in: codes }, isActive: true }, select: { id: true, code: true } });
  const productIds = [...new Set(items.filter((i) => i.status === "done" && i.companyId === companyId).flatMap((i) => i.result?.plan?.productIds || []))];
  const missingTypes = codes.filter((c) => !types.some((t) => t.code === c));
  if (!types.length || !productIds.length) return { problem: !productIds.length ? "no product was found in the files" : `no certificate type ${codes.join(", ")} for this company`, missingTypes };
  try {
    const out = await generateForProducts({ companyId, userId: batch.executedByUserId, products: productIds.map((productId) => ({ productId })), certificateTypeIds: types.map((t) => t.id), express: { intakeBatchId: batch.id } });
    return { companyId, invoiceId: out.invoiceId, certificateBatchId: out.batchId, taskId: out.taskId, planned: out.planned, missing: out.missing, missingTypes };
  } catch (err) {
    return { companyId, problem: err.message, missing: err.extra?.missing || [], missingTypes };
  }
}

/** Step 3: the drafts made → their list (what each still needs) + the ZIP / combined PDF. → true when finished */
async function collect(batch, ex) {
  const g = ex.generation;
  const cb = await prisma.certificateBatch.findUnique({ where: { id: g.certificateBatchId }, select: { status: true, zipFileId: true, combinedPdfFileId: true } });
  if (!cb || ["queued", "running"].includes(cb.status)) return false;
  if (!g.exportTaskId) {
    try {
      g.exportTaskId = (await startExportZip(g.certificateBatchId, g.companyId)).taskId;
    } catch (err) {
      g.exportProblem = err.message;
    }
    return false;
  }
  if (!cb.zipFileId && !g.exportProblem) {
    const task = await prisma.backgroundTask.findUnique({ where: { id: g.exportTaskId }, select: { status: true, error: true } });
    if (task?.status === "failed") g.exportProblem = task.error || "the files couldn't be made";
    else return false;
  }
  const certs = await prisma.certificate.findMany({ where: { batchId: g.certificateBatchId }, include: { certificateType: { select: { code: true } }, product: { select: { name: true } }, items: { include: { invoiceItem: { include: { product: { select: { name: true } } } } } } }, orderBy: { createdAt: "asc" } });
  const list = [];
  for (const c of certs) {
    const v = c.currentVersion ? await prisma.certificateVersion.findFirst({ where: { certificateId: c.id, versionNumber: c.currentVersion }, select: { values: true } }) : null;
    const blanks = Object.entries(v?.values || {}).filter(([, x]) => (x?.flags || []).length).map(([k]) => k);
    const products = c.product ? [c.product.name] : c.items.map((i) => i.invoiceItem?.product?.name).filter(Boolean);
    list.push({ id: c.id, type: c.certificateType.code, products, status: c.status, error: c.error, blanks });
    await record(batch.id, "certificate", { id: c.id, name: `${c.certificateType.code} — ${products.join(", ")}` }, c.companyId);
  }
  ex.certificates = list;
  ex.files = { zip: !!cb.zipFileId, combinedPdf: !!cb.combinedPdfFileId };
  return true;
}

/** The `intakeExpress` job (retried while not ready). */
export async function runExpress({ batchId }) {
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.mode !== "express") return { skipped: true };
  const ex = { ...(batch.express || {}) };
  if (ex.stage === "done") return ex;
  const items = await prisma.intakeItem.findMany({ where: { batchId } });
  ex.startedAt ||= new Date().toISOString();
  if (!ex.stage || ex.stage === "templates") {
    ex.stage = "templates";
    const settled = await settleTemplates(batch, items, ex);
    await save(batchId, ex);
    if (!settled) throw notReady();
    ex.stage = "generate";
  }
  if (ex.stage === "generate") {
    ex.generation = await generate(batch, items, ex);
    ex.stage = ex.generation.certificateBatchId ? "rendering" : "done";
    if (ex.stage === "done") ex.finishedAt = new Date().toISOString();
    await save(batchId, ex);
    if (ex.stage === "rendering") throw notReady();
    return ex;
  }
  if (ex.stage === "rendering") {
    const finished = await collect(batch, ex);
    if (finished) {
      ex.stage = "done";
      ex.finishedAt = new Date().toISOString();
    }
    await save(batchId, ex);
    if (!finished) throw notReady();
  }
  return ex;
}

export const EXPRESS_NOT_READY = NOT_READY;
