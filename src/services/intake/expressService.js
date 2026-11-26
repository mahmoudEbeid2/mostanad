import { prisma } from "../../lib/prisma.js";
import { startPrepare, activateVersion } from "../certificates/templates/prepareService.js";
import { generateForProducts } from "../certificates/direct/directService.js";
import { startExportZip } from "../certificates/certificates/editService.js";
import { enqueueRaw, QUEUES } from "../certificates/jobs/queues.js";
import { templateFromItem } from "./intakeExecute.js";
import { getReadiness } from "../certificates/templates/readinessService.js";
import { fieldsForAreas } from "../certificates/templates/autoMap.js";
import { harvestGate } from "../harvest/harvestAi.js";
import { inferProductGaps } from "../harvest/harvestInfer.js";
import { KNOWN_TYPES, findType } from "../certificates/templates/fromFiles.js";
import { createType } from "../certificates/types/certificateTypeService.js";
import { enableGroups } from "../certificates/templates/templateService.js";
import { listFields, replaceFields } from "../certificates/templates/fieldService.js";
import { productTableFrom } from "../certificates/templates/productTable.js";

/**
 * Readiness (26 Nov): an automatic template's places that look variable and that no field
 * covers (the issued certificate's batch, dates, results…) become BLANK fields — empty and
 * flagged on every draft, never printed as they are. → how many were added
 */
export async function blankOpenAreas(versionId, companyId) {
  const r = await getReadiness(versionId, companyId);
  const open = r.areas.filter((a) => !a.staticConfirmed);
  if (!open.length) return 0;
  const [version, company, existing, last] = await Promise.all([
    prisma.templateVersion.findUnique({ where: { id: versionId }, select: { lines: true } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { profile: true } }),
    prisma.templateField.findMany({ where: { versionId }, select: { key: true } }),
    prisma.templateField.aggregate({ where: { versionId }, _max: { sortOrder: true } }),
  ]);
  // 28 Nov: each place filled from what it is (product data, composition row, specification, document
  // number, issue date, batch fact); only what nothing can fill stays a flagged blank
  const type = await prisma.templateVersion.findUnique({ where: { id: versionId }, select: { template: { select: { certificateType: { select: { code: true } } } } } });
  const mapped = fieldsForAreas(open, version.lines || [], { dateFormat: company?.profile?.dateFormat || null, certCode: type?.template?.certificateType?.code || null });
  const taken = new Set(existing.map((f) => f.key));
  const rows = mapped.map((f, i) => {
    let key = f.key;
    for (let n = 2; taken.has(key); n++) key = `${f.key}_${n}`;
    taken.add(key);
    return {
      versionId, key, label: f.label, page: f.page, lineId: f.lineId, charStart: f.charStart, charEnd: f.charEnd, sampleValue: f.sampleValue,
      source: f.source, format: f.format ?? undefined, required: f.required !== false, origin: "detected", confirmed: false, sortOrder: (last._max.sortOrder ?? 0) + i + 1,
      // a lab result, a batch fact, a document's own number / date never; a product's descriptive value may be estimated
      isBatchFact: !!f.isBatchFact, isLabResult: !!f.isLabResult, inferencePolicy: f.isBatchFact || f.isLabResult || f.source?.kind !== "product" ? "never" : "product_facts",
    };
  });
  await prisma.templateField.createMany({ data: rows });
  return rows.length;
}

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
// A bundle (one certificate per page: ADDVET's 10-page COA / COC) is NOT a table — its template is its first page (Phase 7 found it)
const listsSeveralProducts = (item) => !item.pageFrom && !(item.classification?.parts || []).length && !["bundle", "bundle_template"].includes(item.result?.plan?.action) && (item.classification?.productNames || []).length >= 2;

async function record(batchId, entityType, row, companyId, itemId = null) {
  const exists = await prisma.intakeCreated.findFirst({ where: { batchId, entityType, entityId: row.id }, select: { id: true } });
  if (!exists) await prisma.intakeCreated.create({ data: { batchId, itemId, entityType, entityId: row.id, name: row.name, companyId } });
}

/**
 * A design listing several products (§7.8): a vector-background copy of the version (groups need
 * it), then its product column becomes one repeating row (productTableFrom) and the template one
 * certificate per order (per_invoice). → { cur, pending } — cur.tableReady once the copy has its row
 */
async function productTableStep(batch, item, t, cur) {
  const names = item.classification?.productNames || [];
  const needsPerson = (why) => ({ cur: { ...cur, status: "needs_table", why: `lists ${names.length} products in one table: ${why} — set up its product rows on the template screen` }, pending: false });
  const base = await prisma.templateVersion.findUnique({ where: { id: t.versionId }, select: { status: true, backgroundFormat: true, template: { select: { companyId: true } } } });
  if (!base) return needsPerson("the template is gone");
  const companyId = base.template.companyId;
  if (!cur.tableVersionId) {
    if (["uploaded", "converting"].includes(base.status)) return { cur: { ...cur, status: "reading" }, pending: true };
    if (base.status !== "draft") return needsPerson(`its version is ${base.status}`);
    if (base.backgroundFormat === "svg") return { cur: { ...cur, tableVersionId: t.versionId, status: "table" }, pending: true };
    try {
      const copy = await enableGroups(t.versionId, companyId, batch.executedByUserId);
      return { cur: { ...cur, tableVersionId: copy.versionId, status: "table" }, pending: true };
    } catch (err) {
      return needsPerson(err.message);
    }
  }
  const v = await prisma.templateVersion.findUnique({ where: { id: cur.tableVersionId }, select: { id: true, status: true, lines: true } });
  if (!v || v.status === "failed") return needsPerson("its vector copy couldn't be made");
  if (["uploaded", "converting"].includes(v.status)) return { cur, pending: true };
  if (v.status !== "draft") return { cur: { ...cur, tableReady: true }, pending: false };
  const table = productTableFrom(v.lines || [], names);
  if (table.problem) return needsPerson(table.problem);
  // the plain fields suggested on the design stay, unless they sit on the table's row
  const rowLines = new Set(table.fields.map((f) => f.lineId));
  const plain = (await listFields(v.id)).filter((f) => !f.groupKey && !rowLines.has(f.lineId)).map(({ key, label, lineId, charStart, charEnd, sampleValue, source, format, required, align, origin, isLabResult, isBatchFact }) => ({ key, label, lineId, charStart, charEnd, sampleValue, source, format, required, align, origin, isLabResult, isBatchFact }));
  // invoice-line rows need a collective (per invoice) template: the scope first, then the fields
  const before = await prisma.certificateTemplate.findUnique({ where: { id: t.templateId }, select: { scope: true } });
  try {
    await prisma.certificateTemplate.update({ where: { id: t.templateId }, data: { scope: "per_invoice" } });
    try {
      await replaceFields(v.id, companyId, [...plain, ...table.fields], [table.group]);
    } catch (err) {
      // a list without table lines can't grow: its drawn rows are the most it prints (fixed rows; unused ones hidden)
      if (!/fixed rows/i.test(err.message)) throw err;
      await replaceFields(v.id, companyId, [...plain, ...table.fields], [{ ...table.group, mode: "fixed_rows", whenEmpty: "hide" }]);
    }
  } catch (err) {
    await prisma.certificateTemplate.update({ where: { id: t.templateId }, data: { scope: before.scope } }).catch(() => {});
    return needsPerson(err.message);
  }
  return { cur: { ...cur, tableReady: true, tableRows: table.rows }, pending: false };
}

/** Step 1: every certificate design of the drop → used as a template (or why not). → true when all are settled */
async function settleTemplates(batch, items, ex) {
  const templates = { ...(ex.templates || {}) };
  let pending = false;
  for (const item of items.filter((i) => i.status === "done" && i.result?.template?.versionId)) {
    const t = item.result.template;
    const key = t.versionId; // the card's row; the version worked on may be its product-table copy
    const cur0 = templates[key] || { code: t.code, file: item.name, templateId: t.templateId, link: item.result.link };
    if (["active", "needs_table", "failed", "no_fields"].includes(cur0.status)) {
      templates[key] = cur0;
      continue;
    }
    // a design listing several products in one table (an FSC, an HC's attached list): its rows
    // become ONE repeating row filled from each product, so one certificate covers them all
    let cur = cur0;
    if (listsSeveralProducts(item) && !cur.tableReady) {
      const step = await productTableStep(batch, item, t, cur);
      templates[key] = step.cur;
      if (step.pending) pending = true;
      if (!step.cur.tableReady) continue;
      cur = step.cur;
    }
    const vid = cur.tableVersionId || t.versionId;
    const setT = (v) => (templates[key] = { ...v, ...(cur.tableVersionId ? { link: `/certificates/templates/${t.templateId}/versions/${cur.tableVersionId}` } : {}) });
    const version = await prisma.templateVersion.findUnique({ where: { id: vid }, select: { status: true, error: true, prepareReport: true, template: { select: { companyId: true, name: true } } } });
    if (!version) {
      setT({ ...cur, status: "failed", why: "the template is gone" });
      continue;
    }
    const companyId = version.template.companyId;
    if (["uploaded", "converting", "preparing"].includes(version.status) || (!cur.tableVersionId && (t.fields === "pending" || t.fields === undefined))) {
      pending = true;
      setT({ ...cur, status: version.status === "preparing" ? "preparing" : "reading" });
      continue;
    }
    if (version.status === "failed") {
      setT({ ...cur, status: "failed", why: version.error || "the design couldn't be converted" });
      continue;
    }
    if (version.status === "draft") {
      if (cur.status === "preparing" && version.error) {
        setT({ ...cur, status: "failed", why: version.error });
        continue;
      }
      // prepared once and the quality check failed (back to draft, no error): never prepared again in a loop
      const failing = cur.status === "preparing" ? (version.prepareReport?.checks || []).filter((c) => !c.passed) : [];
      if (failing.length) {
        const keys = [...new Set(failing.flatMap((c) => c.failing || []))];
        const blanks = await prisma.templateField.findMany({ where: { versionId: vid, key: { in: keys.filter((k) => k.startsWith("blank_")) } }, select: { sampleValue: true } });
        setT({
          ...cur,
          status: "failed",
          why: blanks.length
            ? `these places couldn't be left blank automatically: ${blanks.map((b) => `"${b.sampleValue}"`).join(", ")} — mark them on the template screen (nothing from the file was printed)`
            : `the design didn't pass the preparation check (${failing.map((c) => c.label || c.id).join(", ")}) — open it on the template screen`,
        });
        continue;
      }
      await blankOpenAreas(vid, companyId);
      const count = await prisma.templateField.count({ where: { versionId: vid } });
      if (!count) {
        setT({ ...cur, status: "no_fields", why: t.fields?.why || "no field could be found on it — mark its fields on the template screen" });
        continue;
      }
      await startPrepare(vid, companyId);
      pending = true;
      setT({ ...cur, status: "preparing" });
      continue;
    }
    if (version.status === "ready") {
      try {
        await activateVersion(vid, companyId, batch.executedByUserId, { express: true });
      } catch (err) {
        setT({ ...cur, status: "failed", why: err.message });
        continue;
      }
    }
    // active (just now or before): its fields, for the card — what each draft will still need
    const fields = await prisma.templateField.findMany({ where: { versionId: vid }, select: { key: true, label: true, source: true } });
    const toFill = fields.filter((f) => ["manual", "item"].includes(f.source?.kind)).map((f) => f.label || f.key);
    setT({ ...cur, status: "active", fields: fields.length, toFill });
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
  if (!companyId) return { problem: "no company was filed", problemCode: "no_company" };
  const asked = (ex.requestedTypes || []).map((c) => String(c).toUpperCase());
  const codes = [...new Set((asked.length ? asked : active.map((t) => t.code)).filter(Boolean))];
  // the types asked for are the company's from now on (COC = Certificate of Composition, COO = Origin)
  for (const code of codes.filter((c) => KNOWN_TYPES[c])) {
    if (await findType(companyId, code)) continue;
    const t = await createType(companyId, { code, name: KNOWN_TYPES[code].name });
    await record(batch.id, "certificate_type", { id: t.id, name: `${t.code} · ${t.name}` }, companyId);
  }
  const types = await prisma.certificateType.findMany({ where: { companyId, code: { in: codes }, isActive: true }, select: { id: true, code: true } });
  const productIds = [...new Set(items.filter((i) => i.status === "done" && i.companyId === companyId).flatMap((i) => i.result?.plan?.productIds || []))];
  const missingTypes = codes.filter((c) => !types.some((t) => t.code === c));
  if (!productIds.length) return { companyId, problem: "no product was found in the files", problemCode: "no_products", missingTypes };
  if (!types.length) return { companyId, problem: `no certificate type ${codes.join(", ")} for this company`, problemCode: "no_types", missingTypes };
  // Part B (28 Nov): what no file states is estimated first (descriptive fields only, marked «مستنتج»),
  // so the drafts are filled — a model failure only leaves those fields empty
  let inferred = null;
  try {
    inferred = await inferProductGaps({ companyId, productIds });
  } catch (err) {
    console.error(`[express] inference for ${batch.id}: ${err.message}`);
  }
  try {
    const out = await generateForProducts({ companyId, userId: batch.executedByUserId, products: productIds.map((productId) => ({ productId })), certificateTypeIds: types.map((t) => t.id), express: { intakeBatchId: batch.id } });
    return { companyId, invoiceId: out.invoiceId, certificateBatchId: out.batchId, taskId: out.taskId, planned: out.planned, missing: out.missing, missingTypes, inferred: inferred ? { asked: inferred.asked, filled: inferred.filled } : null };
  } catch (err) {
    const problemCode = err.code === "NOTHING_TO_GENERATE" ? "no_templates" : err.code === "TEMPLATE_NOT_READY" ? "template_not_ready" : "failed";
    return { companyId, problem: err.message, problemCode, missing: err.extra?.missing || [], missingTypes };
  }
}

// ── what each step really produced (26 Nov: every step showed a green check, 0 certificates) ──
const PROBLEM_AR = {
  no_company: "مفيش شركة اتسجلت من الملفات",
  no_products: "ملقيناش منتجات في الملفات",
  no_types: "الشركة مفيهاش أنواع الشهادات المطلوبة",
  no_templates: "مفيش قالب شغّال للأنواع المطلوبة",
  template_not_ready: "القالب لسه فيه أماكن متغيرة مش متحددة",
  failed: "حصل خطأ وإحنا بنطلّع الشهادات",
};

/** The drop's certificate files that are not a template yet (kept as evidence only, or skipped as duplicates). */
export function certificateFilesWithoutTemplate(items) {
  return items.filter((i) => !i.parentId && ["certificate_filled", "certificate_template"].includes(i.classification?.docType) && i.classification?.certCode && !i.result?.template && ["done", "duplicate"].includes(i.status));
}

/**
 * → [{ key, ok, status: ok|warn|fail, ar, en, fix? }] and the one-line summary. A step that made
 * nothing is never "ok"; it says why and what to do (fix: make_templates | open_templates | add_products).
 */
export function expressSteps(batch, items, ex) {
  const top = items.filter((i) => !i.parentId);
  const filed = top.filter((i) => i.status === "done").length;
  const dupes = top.filter((i) => i.status === "duplicate").length;
  const failedItems = top.filter((i) => i.status === "failed").length;
  const tpl = Object.values(ex.templates || {});
  const active = tpl.filter((t) => t.status === "active").length;
  const certs = (ex.certificates || []).filter((c) => c.status !== "failed").length;
  const g = ex.generation || {};
  const canMake = certificateFilesWithoutTemplate(items).length > 0;
  const steps = [];
  steps.push({
    key: "filing",
    status: !filed ? "fail" : dupes || failedItems ? "warn" : "ok",
    ar: !filed ? "مفيش ملف اتسجل" : `اتسجل ${filed} ملف${dupes ? ` · ${dupes} متكرر اترفع قبل كده` : ""}${failedItems ? ` · ${failedItems} فشل` : ""}`,
    en: `${filed} filed${dupes ? `, ${dupes} already filed before` : ""}${failedItems ? `, ${failedItems} failed` : ""}`,
  });
  if (ex.stage && ex.stage !== "templates") {
    const notUsed = tpl.filter((t) => t.status !== "active");
    steps.push({
      key: "templates",
      status: !active ? "fail" : notUsed.length ? "warn" : "ok",
      ar: !tpl.length ? "مفيش ملف اتعمل منه قالب" : `${active} قالب شغّال${notUsed.length ? ` · ${notUsed.length} محتاج تظبيط (${notUsed.map((t) => t.code).join("، ")})` : ""}`,
      en: !tpl.length ? "no file became a template" : `${active} template(s) used${notUsed.length ? `, ${notUsed.length} need a person` : ""}`,
      ...(!active ? { fix: canMake ? "make_templates" : tpl.length ? "open_templates" : null } : {}),
    });
  }
  if (ex.stage === "done") {
    const why = g.problemCode ? PROBLEM_AR[g.problemCode] : !certs ? PROBLEM_AR.no_templates : null;
    const fix = !certs ? (g.problemCode === "no_products" ? "add_products" : g.problemCode === "template_not_ready" ? "open_templates" : canMake ? "make_templates" : "open_templates") : null;
    steps.push({ key: "certificates", status: certs ? (g.missing?.length ? "warn" : "ok") : "fail", ar: certs ? `اتعمل ${certs} شهادة (مسودة)${g.missing?.length ? ` · ${g.missing.length} ناقصة قالب` : ""}` : `اتعمل 0 شهادات — ${why}`, en: certs ? `${certs} draft certificate(s)` : `0 certificates — ${g.problem || "no template"}`, ...(fix ? { fix } : {}) });
  }
  const FIX_AR = { make_templates: "اعمل قوالب من الملفات دي", open_templates: "افتح القوالب وحدد أماكنها", add_products: "ضيف المنتجات" };
  const last = steps[steps.length - 1];
  const summary = ex.stage === "done" ? { ok: certs > 0, ar: certs ? last.ar : `${last.ar}${last.fix ? ` — ${FIX_AR[last.fix]}` : ""}`, en: last.en } : null;
  return { steps: steps.map((s) => ({ ...s, ok: s.status === "ok", ...(s.fix ? { fixAr: FIX_AR[s.fix] } : {}) })), summary };
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
  // the drafts are made from what the files say: the drop's AI read first (retried while it runs, 20 min at most)
  if (!ex.stage && (await harvestGate(batchId)) === "wait") {
    if (ex.waitingHarvest !== true) await save(batchId, { ...ex, waitingHarvest: true });
    throw notReady();
  }
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

/**
 * POST /intake/batches/:id/express/templates-from-files — the fix of "0 certificates": the
 * drop's certificate files that were kept only as evidence (or skipped as already filed)
 * each become their type's template (one per type; the type is created when missing),
 * then Express runs again from the templates step. The same as "use the certificates I sent
 * as templates" in the chat. → { made: [{ code, file, templateId, versionId }], restarted }
 */
export async function makeTemplatesFromFiles(batchId, { userId = null, companyId = null } = {}) {
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw Object.assign(new Error("Intake batch not found"), { statusCode: 404 });
  if (companyId && batch.companyId && batch.companyId !== companyId) throw Object.assign(new Error("Intake batch not found"), { statusCode: 404 });
  const items = await prisma.intakeItem.findMany({ where: { batchId } });
  const ex = { ...(batch.express || {}) };
  // a type with a template already — used by Express, or made from a file of this drop — gets no second one
  const haveActive = new Set([...Object.values(ex.templates || {}).filter((t) => t.status === "active").map((t) => t.code), ...items.filter((i) => i.result?.template?.code).map((i) => i.result.template.code)]);
  const made = [];
  const record = (entityType, row, itemId, cid) => prisma.intakeCreated.create({ data: { batchId, itemId, entityType, entityId: row.id, name: row.name, companyId: cid } });
  for (const item of certificateFilesWithoutTemplate(items)) {
    const code = item.classification.certCode;
    if (haveActive.has(code) || made.some((m) => m.code === code)) continue;
    const prop = item.classification?.proposal || {};
    const cid = item.result?.plan?.companyId || item.companyId || prop.company?.id || batch.companyId;
    if (!cid) continue;
    const plan = { ...(item.result?.plan || {}), action: "certificate_both", companyId: cid, brandId: item.result?.plan?.brandId ?? prop.brand?.id ?? null, certCode: code, productIds: item.result?.plan?.productIds || [] };
    const out = await templateFromItem(item, plan, userId, record);
    await prisma.intakeItem.update({ where: { id: item.id }, data: { status: "done", companyId: cid, result: { ...(item.result || {}), plan, ...out } } });
    made.push({ code, file: item.name, templateId: out.template.templateId, versionId: out.template.versionId });
  }
  if (!made.length) return { made, restarted: false };
  await save(batchId, { ...ex, stage: "templates", generation: null, certificates: [], files: null, finishedAt: null });
  await enqueueRaw(QUEUES.template, "intakeExpress", { batchId }, { attempts: 600, backoff: { type: "fixed", delay: 3000 } });
  return { made, restarted: true };
}
