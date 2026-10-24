import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import * as renderer from "../engine/rendererClient.js";
import { enqueueTask, QUEUES } from "../jobs/queues.js";
import { loadVersion, convertVersion } from "./templateService.js";
import { listFields, listGroups, replaceFields } from "./fieldService.js";
import { runPrepareJob } from "./prepareService.js";
import { sourceType } from "./sourceCatalogue.js";
import { scanTemplate } from "./repairScan.js";
import { getDictionary } from "../dictionary/dataDictionary.js";
import { recallMapping } from "../mapping/mappingMemory.js";
import { matchLabel } from "../mapping/dictionaryMatch.js";
import { inferFormat } from "../mapping/formatInference.js";
import { codeCategory, sourceFromPath } from "../mapping/fieldMapper.js";
import { isIdentifier, quoteKey } from "../paths/sourcePath.js";
import { defaultIsLabResult } from "../inference/policy.js";

// "Fix this template" (owner, 2026-10-24, item 2). GET → the checklist the
// scan found (repairScan) with a suggested source per new field; POST with
// what the owner ticked → a NEW version (the original is never touched):
// re-converted with a vector background when a repeating group is added
// (groups need it, §7.8), the ticked changes applied, prepare re-run. The new
// version stops at `ready` (or back at `draft` with the gate's report): the
// owner sees the gate and activates it themselves.
// Fixed RESULT text is never changed unless the owner picked what to do with
// that row (keep fixed / lab-result field / show the specification).

const RESULT_CHOICES = ["keep_fixed", "lab_result_field", "show_specification"];
const specPath = (label) => `specifications.values${isIdentifier(label) ? `.${label}` : quoteKey(label)}`;

// printed labels code can map without the dictionary (invoice values first: a product never holds them)
const RULES = [
  { re: /\b(batch|lot)\s*(no\.?|nr\.?|number|#)?$/i, source: { kind: "item", path: "batchNo" }, category: "invoice_line", why: "a batch / lot number is the invoice line's" },
  { re: /\b(production|manufactur\w*|mfg\.?|mfd\.?|prod\.?)\s*date\b|^date of manufacture/i, source: { kind: "item", path: "productionDate" }, category: "invoice_line", why: "the production date of the shipped batch (invoice line)" },
  { re: /\b(expiry|expiration|exp\.?|use before|best before)\s*(date)?\b/i, source: { kind: "item", path: "expiryDate" }, category: "invoice_line", why: "the expiry date of the shipped batch (invoice line)" },
  { re: /\b(issue|issuing|report|release)\s*date\b|^date of issue/i, source: { kind: "today" }, category: "constant", why: "the day the certificate is issued" },
  { re: /\bbatch\s*size\b/i, source: { kind: "manual" }, category: "batch_data", labResult: true, why: "a fact of that batch: supplied with its results (supplier COA / the results grid), never inferred" },
  { re: /\b(quantity|qty)\b/i, source: { kind: "item", path: "quantity" }, category: "invoice_line", why: "the shipped quantity (invoice line)" },
  { re: /\b(packing|pack size|package size|presentation)\b/i, source: { kind: "item", path: "packing" }, category: "invoice_line", why: "the shipped pack size (invoice line)" },
  { re: /\b(product name|trade name|name of product)\b/i, source: { kind: "product", path: "name" }, category: "product_data", why: "the product's name" },
  { re: /\bcategory\b/i, source: { kind: "product", path: "category.name" }, category: "product_data", why: "the product's category" },
  { re: /\b(origin|country of origin|made in)\b/i, source: { kind: "product", path: "origin" }, category: "product_data", why: "the product's origin" },
  { re: /\b(producer|manufacturer|manufactured by)\b/i, source: { kind: "product", path: "producer" }, category: "product_data", why: "the product's producer" },
  { re: /\bappearance\b/i, source: { kind: "product", path: "appearance" }, category: "product_data", why: "the product's appearance" },
  { re: /\bstorage\b/i, source: { kind: "product", path: "storage" }, category: "product_data", why: "the product's storage conditions" },
  { re: /\bshelf[\s-]*life\b/i, source: { kind: "product", path: 'specifications.values["Shelf life"]' }, category: "product_data", why: "the product's shelf life" },
];
const DOC_NUMBER = /\b(document|certificate|coa|report|analysis)\b.*(no\.?|nr\.?|number|#)?$|^(document|doc)\s*#?$/i;

/**
 * A source for a value printed after `label` (or in a table row named `label`).
 * Order: the company's memory → rules for invoice values → the dictionary → a
 * specification-table key → per kind. ctx: { companyId, typeId, entries, batchSample }
 * → { source, format, category, isLabResult, origin: memory|rule|dictionary|specification|none, why }
 */
export async function suggestSource({ label, sample, where }, ctx) {
  const done = (source, category, origin, why, extra = {}) => {
    const f = inferFormat(sample, sourceType(source));
    return { source, format: f.format, ...(f.ambiguousDate ? { ambiguousDate: f.ambiguousDate } : {}), category, isLabResult: extra.isLabResult ?? category === "batch_data", origin, why };
  };
  const mem = await recallMapping(ctx.companyId, label, ctx.typeId);
  if (mem) return { ...done(mem.source, mem.category || codeCategory(mem.source) || "unknown", "memory", `you mapped “${label}” this way before`), ...(mem.format ? { format: mem.format } : {}) };
  // a document number that ends with the batch number → "COA" + the batch number
  if (DOC_NUMBER.test(label) && ctx.batchSample && sample.endsWith(ctx.batchSample) && sample.length > ctx.batchSample.length) {
    const prefix = sample.slice(0, -ctx.batchSample.length);
    return done({ kind: "template", template: `${prefix}{{item.batchNo}}` }, "invoice_line", "rule", `“${sample}” is “${prefix}” + the batch number`);
  }
  const rule = RULES.find((r) => r.re.test(label));
  if (rule && (rule.source.kind !== "product" || where === "label_value" || /appearance|producer|manufactur/i.test(label))) return done(rule.source, rule.category, "rule", rule.why, { isLabResult: rule.labResult });
  const hit = matchLabel({ label, sampleValue: sample, entries: ctx.entries.filter((e) => e.pickable !== false) });
  if (hit?.entry) {
    const source = sourceFromPath(hit.entry.path);
    return done(source, codeCategory(source) || "unknown", "dictionary", hit.rationale);
  }
  if (rule) return done(rule.source, rule.category, "rule", rule.why, { isLabResult: rule.labResult });
  if (where === "table_spec") return done({ kind: "product", path: specPath(label) }, "product_data", "specification", `the product's “${label}” specification (filled automatically from its data, catalogue or the web when missing)`);
  return done({ kind: "manual" }, "unknown", "none", "no source found — pick one, or leave it typed by hand");
}

async function versionWithCells(versionId, companyId) {
  const version = await loadVersion(versionId, companyId);
  if (!version.sanitizedFileId) throw new CertError("VERSION_NOT_CONVERTED", "This version has no converted design yet", 409);
  const [fields, groups] = await Promise.all([listFields(versionId), listGroups(versionId)]);
  const html = await fileStore.readText(version.sanitizedFileId);
  const { lineCells } = await renderer.inspect(html, { fields: [], lineCells: true });
  return { version, fields, groups, lineCells };
}

/**
 * GET /template-versions/:id/repair → { versionId, versionNumber, status, templateName, needsSvg, summary, items }
 * Every item: { id, kind, default, … } — see repairScan; fixed_to_field items carry `suggestion`.
 */
export async function getRepairPlan(versionId, companyId) {
  const { version, fields, groups, lineCells } = await versionWithCells(versionId, companyId);
  const scan = scanTemplate({ lines: version.lines || [], cellLines: lineCells, fields, groups });
  const entries = (await getDictionary(version.template.companyId)).entries;
  const batchItem = scan.items.find((i) => i.kind === "fixed_to_field" && RULES[0].re.test(i.label));
  const batchField = fields.find((f) => f.source?.kind === "item" && f.source.path === "batchNo");
  const ctx = { companyId: version.template.companyId, typeId: version.template.certificateTypeId, entries, batchSample: batchItem?.field.sampleValue || batchField?.sampleValue || null };
  for (const item of scan.items) {
    if (item.kind === "fixed_to_field") item.suggestion = await suggestSource({ label: item.label, sample: item.field.sampleValue, where: item.where }, ctx);
    if (item.kind === "unnamed_field" && item.rename) item.suggestion = await suggestSource({ label: item.rename.label, sample: item.sampleValue, where: "table_spec" }, ctx);
  }
  const count = (k) => scan.items.filter((i) => i.kind === k).length;
  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    templateName: version.template.name,
    needsSvg: scan.items.some((i) => i.kind === "constituent_group") && version.backgroundFormat !== "svg",
    summary: { groups: count("constituent_group"), fixedToField: count("fixed_to_field"), fixedResults: count("fixed_result"), unnamed: count("unnamed_field") },
    table: scan.header ? { columns: scan.header.columns.map((c) => ({ kind: c.kind, text: c.text })), rows: scan.rows } : null,
    items: scan.items,
  };
}

const pick = (f) => ({
  key: f.key,
  label: f.label,
  lineId: f.lineId,
  charStart: f.charStart,
  charEnd: f.charEnd,
  sampleValue: f.sampleValue,
  source: f.source,
  format: f.format ?? null,
  required: f.required !== false,
  align: f.align || "left",
  origin: "manual", // a confirmed field of the base version, or one the owner ticked here
  groupKey: f.groupKey || null,
  mappingOrigin: ["manual", "memory", "dictionary"].includes(f.mappingOrigin) ? f.mappingOrigin : "manual",
  dataCategory: f.dataCategory ?? null,
  inferencePolicy: f.inferencePolicy,
  isLabResult: f.isLabResult === true,
  showSpecInstead: f.showSpecInstead === true,
  specFieldKey: f.specFieldKey ?? null,
});

/**
 * The owner's decisions → the new version's full field and group lists. Pure.
 * decisions: [{ id, apply?: boolean, choice?: keep_fixed|lab_result_field|show_specification, source?, format? }]
 * → { fields, groups, applied: [ids], problems: [] }
 */
export function buildRepair(plan, baseFields, baseGroups, decisions = []) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const problems = [];
  for (const d of decisions) if (!plan.items.some((i) => i.id === d.id)) problems.push({ id: d.id, message: "not an item of this version's checklist (it changed — reload it)" });
  const ticked = (item) => (byId.has(item.id) ? byId.get(item.id).apply !== false : false);
  const fields = baseFields.map(pick);
  const groups = baseGroups.map(({ id, versionId, geometry, ...g }) => g);
  const applied = [];
  const removeKeys = new Set();
  const add = (f) => {
    if (fields.some((x) => x.key === f.key)) problems.push({ id: f.key, message: `field key "${f.key}" exists already` });
    else fields.push(f);
  };
  const specItemField = new Map(); // spec item id → the field it adds
  for (const item of plan.items) {
    const d = byId.get(item.id) || {};
    if (item.kind === "constituent_group" && ticked(item)) {
      groups.push({ ...item.group, sortOrder: groups.length });
      item.cells.forEach((c, i) => add({ ...c, format: null, origin: "manual", mappingOrigin: "dictionary", dataCategory: c.isLabResult ? "batch_data" : "product_data", isLabResult: c.isLabResult === true, sortOrder: 500 + i }));
      item.removes.forEach((k) => removeKeys.add(k));
      applied.push(item.id);
    }
    if (item.kind === "unnamed_field" && ticked(item) && !item.absorbedBy) {
      const f = fields.find((x) => x.key === item.fieldKey);
      if (f && item.remove) removeKeys.add(f.key);
      else if (f && item.rename) {
        const s = d.source ? { source: d.source, format: d.format ?? null } : item.suggestion || {};
        Object.assign(f, { key: item.rename.key, label: item.rename.label, source: s.source || f.source, format: s.format ?? null, dataCategory: s.category || f.dataCategory, isLabResult: s.isLabResult ?? f.isLabResult });
      }
      applied.push(item.id);
    }
  }
  // a "show the specification" result needs its row's specification as a field
  const specNeeded = new Set(plan.items.filter((i) => i.kind === "fixed_result" && byId.get(i.id)?.choice === "show_specification" && i.spec?.itemId).map((i) => i.spec.itemId));
  for (const item of plan.items.filter((i) => i.kind === "fixed_to_field")) {
    if (!ticked(item) && !specNeeded.has(item.id)) continue;
    const d = byId.get(item.id) || {};
    const s = d.source ? { source: d.source, format: d.format ?? null, category: d.category || item.suggestion?.category, isLabResult: d.isLabResult ?? defaultIsLabResult({ label: item.field.label }) } : item.suggestion || { source: { kind: "manual" }, format: null, category: item.field.dataCategory || "unknown", isLabResult: false, origin: "none" };
    const f = { ...item.field, source: s.source, format: s.format ?? null, origin: "manual", mappingOrigin: s.origin === "memory" ? "memory" : s.origin === "dictionary" ? "dictionary" : "manual", dataCategory: s.category || item.field.dataCategory || null, isLabResult: s.isLabResult === true, sortOrder: 300 + fields.length };
    add(f);
    specItemField.set(item.id, f);
    applied.push(item.id);
  }
  for (const item of plan.items.filter((i) => i.kind === "fixed_result")) {
    const choice = byId.get(item.id)?.choice || "keep_fixed";
    if (!RESULT_CHOICES.includes(choice) || !item.choices.includes(choice)) {
      problems.push({ id: item.id, message: `choose one of ${item.choices.join(", ")}` });
      continue;
    }
    if (choice === "keep_fixed") continue;
    const base = { key: item.resultKey, label: `${item.rowLabel} result`, lineId: item.cell.lineId, charStart: item.cell.start, charEnd: item.cell.end, sampleValue: item.text, align: "left", required: true, origin: "manual", mappingOrigin: "manual", groupKey: null, sortOrder: 400 + fields.length };
    if (choice === "lab_result_field") add({ ...base, source: { kind: "manual" }, format: null, dataCategory: "batch_data", isLabResult: true });
    else {
      const specKey = item.spec?.fieldKey || specItemField.get(item.spec?.itemId)?.key;
      if (!specKey) problems.push({ id: item.id, message: "this row has no specification to show" });
      else add({ ...base, source: { kind: "manual" }, format: null, dataCategory: "batch_data", isLabResult: true, showSpecInstead: true, specFieldKey: specKey });
    }
    applied.push(item.id);
  }
  return { fields: fields.filter((f) => !removeKeys.has(f.key)).map((f, i) => ({ ...f, sortOrder: i })), groups, applied, problems };
}

/**
 * POST /template-versions/:id/repair { decisions } → 202 { templateId, versionId, versionNumber, taskId, applied }
 * The base version is never changed; the new draft is based on it.
 */
export async function startRepair(versionId, companyId, userId, decisions) {
  const plan = await getRepairPlan(versionId, companyId);
  const base = await loadVersion(versionId, companyId);
  if (base.template.archivedAt) throw new CertError("TEMPLATE_ARCHIVED", "This template is archived", 409);
  const [baseFields, baseGroups] = await Promise.all([listFields(versionId), listGroups(versionId)]);
  const built = buildRepair(plan, baseFields, baseGroups, decisions);
  if (built.problems.length) throw new CertError("INVALID_REPAIR", `The repair can't be applied: ${built.problems.slice(0, 3).map((p) => `${p.id}: ${p.message}`).join("; ")}`, 422, { problems: built.problems });
  if (!built.applied.length) throw new CertError("NOTHING_TO_REPAIR", "Tick at least one change", 422);
  const svg = built.groups.length > 0 && base.backgroundFormat !== "svg";
  if (svg && base.sourceFormat === "html") throw new CertError("GROUPS_NEED_PDF", "Repeating groups need an .ai or .pdf design (an .html upload has no separate drawing layer)", 409);
  const version = await prisma.$transaction(async (tx) => {
    const last = await tx.templateVersion.findFirst({ where: { templateId: base.templateId }, orderBy: { versionNumber: "desc" } });
    return tx.templateVersion.create({
      data: {
        templateId: base.templateId,
        versionNumber: last.versionNumber + 1,
        status: svg ? "converting" : "draft",
        sourceFormat: base.sourceFormat,
        sourceFileId: base.sourceFileId,
        backgroundFormat: svg ? "svg" : base.backgroundFormat,
        basedOnVersionId: base.id,
        createdByUserId: userId || null,
        ...(svg
          ? {}
          : { sanitizedFileId: base.sanitizedFileId, thumbnailFileId: base.thumbnailFileId, pages: base.pages ?? undefined, lines: base.lines ?? undefined, fontCoverage: base.fontCoverage ?? undefined, conversion: base.conversion ?? undefined }),
      },
    });
  });
  const task = await enqueueTask({
    queueName: QUEUES.template,
    jobName: "repair",
    type: "certificate_template_repair",
    companyId: base.template.companyId,
    data: { entity: "template_version", entityId: version.id, versionId: version.id, fields: built.fields, groups: built.groups, applied: built.applied, basedOn: base.id, userId: userId || null },
  });
  return { templateId: base.templateId, versionId: version.id, versionNumber: version.versionNumber, taskId: task.id, applied: built.applied, reconverted: svg };
}

/** A planned field on a re-converted text layer: the same line and offsets, else the sample's single occurrence. */
export function relocate(field, lines) {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const same = byId.get(field.lineId);
  if (same?.text.slice(field.charStart, field.charEnd) === field.sampleValue) return field;
  if (same) {
    const i = same.text.indexOf(field.sampleValue);
    if (i >= 0 && same.text.indexOf(field.sampleValue, i + 1) < 0) return { ...field, charStart: i, charEnd: i + field.sampleValue.length };
  }
  const hits = lines.flatMap((l) => {
    const i = l.text.indexOf(field.sampleValue);
    return i >= 0 && l.text.indexOf(field.sampleValue, i + 1) < 0 ? [{ l, i }] : [];
  });
  return hits.length === 1 ? { ...field, lineId: hits[0].l.id, charStart: hits[0].i, charEnd: hits[0].i + field.sampleValue.length } : field;
}

/**
 * The `repair` job: convert (vector background, when a group is added) → apply the
 * owner's changes → prepare (the gate). → { versionId, status, passed, applied, failing? }
 */
export async function runRepairJob({ versionId, fields, groups, applied, basedOn, userId }, ctx = {}) {
  let version = await prisma.templateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  if (!version) throw new CertError("NOT_FOUND", "Template version not found", 404);
  const companyId = version.template.companyId;
  if (["uploaded", "converting"].includes(version.status)) {
    ctx.progress?.(5, "Converting the design with a vector background");
    await convertVersion(versionId, ctx);
    version = await prisma.templateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
  }
  if (version.status === "draft") {
    ctx.progress?.(55, "Applying the changes");
    const placed = fields.map((f) => relocate(f, version.lines || []));
    try {
      await replaceFields(versionId, companyId, placed, groups);
    } catch (err) {
      await prisma.templateVersion.update({ where: { id: versionId }, data: { error: `Repair could not apply the changes: ${err.code ? `${err.code}: ` : ""}${err.message}` } });
      throw err;
    }
    await prisma.templateVersion.update({ where: { id: versionId }, data: { conversion: { ...(version.conversion || {}), repair: { basedOn, applied, byUserId: userId, at: new Date().toISOString() } } } });
    const claimed = await prisma.templateVersion.updateMany({ where: { id: versionId, status: "draft" }, data: { status: "preparing", error: null } });
    if (!claimed.count) throw new CertError("VERSION_NOT_DRAFT", "The repaired version changed meanwhile", 409);
  }
  ctx.progress?.(70, "Preparing (the gate)");
  const out = await runPrepareJob(versionId, ctx);
  return { ...out, applied };
}
