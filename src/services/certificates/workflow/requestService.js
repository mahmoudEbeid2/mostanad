import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { startGeneration, isBlocking } from "../generation/batchService.js";
import { usableTemplates } from "../generation/planService.js";
import { selectTemplates } from "../generation/templateSelector.js";
import { readinessMap } from "../templates/readinessService.js";
import { isLabResult } from "../inference/policy.js";
import { displayPack, packKey, samePack, splitNamePack } from "../matching/packNormalizer.js";

// The client's request → matrix (Dossira_Certificate_Workflow_EN §1, §3, §5): a request starts
// from an invoice, or from pasted names / a list / products picked from the catalogue. Its lines
// keep their order; an unclear name or pack is flagged for a person. One row per product × pack
// (and lot), one status cell per certificate asked (COA, COC, HC, FSC by default):
//   awaiting_inputs → draft → in_review → awaiting_authorization → approved → exported
// with what each cell still needs (a missing lab report holds only that COA).
// A request is an internal "direct" record (hidden from invoice lists), like every no-invoice run.

export const DEFAULT_CODES = ["COA", "COC", "HC", "FSC"];
export const CELL_STATUS = ["awaiting_inputs", "draft", "in_review", "awaiting_authorization", "approved", "exported"];
const clean = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "");

/** "ADD-E120\nSULFARIM 100 mL" / "A, B" → [{ name }] in the order written */
export const linesFromText = (text) =>
  String(text || "")
    .split(/\r?\n|;|,(?![^(]*\))/)
    .map((s) => s.replace(/^\s*(?:\d+[.)-]\s*)?/, "").trim())
    .filter(Boolean)
    .map((name) => ({ name }));

/** One requested line → its product, or why a person must choose: { productId, status: matched | ambiguous | unmatched, candidates } */
async function matchLine(companyId, line) {
  if (line.productId) {
    const p = await prisma.product.findFirst({ where: { id: line.productId, companyId }, select: { id: true, name: true, packaging: true } });
    if (!p) throw new CertError("NOT_FOUND", "Product not found!", 404);
    return { productId: p.id, name: p.name, status: "matched", candidates: [] };
  }
  // Phase 4: name AND pack — "OLIGOVET 1L" is never linked to OLIGOVET 100 mL; the asked pack stays on the line
  const split = splitNamePack(clean(line.name) || "");
  const name = split.name;
  if (!name) return { productId: null, name: "", status: "unmatched", candidates: [], pack: null };
  const pack = clean(line.packing) ? displayPack(line.packing) : split.pack;
  const all = await prisma.product.findMany({ where: { companyId, OR: [{ name: { contains: name.split(/\s+/)[0], mode: "insensitive" } }, { productCode: { equals: name, mode: "insensitive" } }] }, select: { id: true, name: true, packaging: true, productCode: true }, take: 50 });
  // a product whose own name carries a pack ("OLIGOVET 100mL") is the same name with that pack
  const nameOf = (p) => splitNamePack(p.name).name;
  const packOf = (p) => p.packaging || splitNamePack(p.name).pack;
  const exact = all.filter((p) => norm(nameOf(p)) === norm(name) || norm(p.productCode) === norm(name));
  const view = (p) => ({ id: p.id, name: p.name, packaging: p.packaging, productCode: p.productCode });
  if (pack) {
    const byPack = exact.filter((p) => samePack(packOf(p), pack));
    if (byPack.length === 1) return { productId: byPack[0].id, name: byPack[0].name, status: "matched", candidates: [], pack };
    // the product exists, not in this pack: a new pack of it (one click), or another pack if that was meant
    if (exact.length && !byPack.length) return { productId: null, name, status: "new_pack", candidates: exact.slice(0, 8).map(view), pack };
    if (byPack.length > 1) return { productId: null, name, status: "ambiguous", candidates: byPack.slice(0, 8).map(view), pack };
  } else if (exact.length === 1) return { productId: exact[0].id, name: exact[0].name, status: "matched", candidates: [], pack: packOf(exact[0]) || null };
  const close = (exact.length ? exact : all.filter((p) => norm(p.name).includes(norm(name)) || norm(name).includes(norm(p.name)))).slice(0, 8);
  return { productId: null, name, status: close.length ? "ambiguous" : "unmatched", candidates: close.map(view), pack };
}

/**
 * POST /certificate-requests/:id/lines/:lineId/new-pack { fromProductId } — «أضف عبوة جديدة لنفس المنتج»:
 * a pack variant of the product — its composition, composition basis (the basis never depends on the pack)
 * and descriptive data copied, its package the asked one — and the line linked to it.
 */
export async function addPackVariant(id, companyId, lineId, { fromProductId }) {
  const inv = await loadRequest(id, companyId);
  const line = inv.items.find((i) => i.id === lineId);
  if (!line) throw notFound("Request line");
  const pack = line.data?.packing ? displayPack(line.data.packing) : null;
  if (!pack) throw new CertError("PACK_REQUIRED", "This line names no pack size", 400);
  const src = await prisma.product.findFirst({ where: { id: fromProductId, companyId: inv.companyId } });
  if (!src) throw notFound("Product");
  const existing = await prisma.product.findMany({ where: { companyId: inv.companyId, name: src.name }, select: { id: true, packaging: true } });
  let variant = existing.find((p) => samePack(p.packaging, pack));
  if (!variant) {
    const COPY = ["name", "productCode", "description", "indications", "targetSpecies", "physicalForm", "appearance", "activeIngredients", "validity", "compositionBasis", "dosage", "mixingInstructions", "withdrawalPeriod", "contraindications", "userSafety", "storage", "registrationNumber", "origin", "producer", "specifications", "routeOfAdmin", "dosageForm", "strength", "productType", "prescriptionStatus", "categoryId", "brandId", "productForm"]; // productForm: the COC's «Product Form» (27 Nov QA: a variant made then lacked it)
    const data = Object.fromEntries(COPY.filter((k) => src[k] !== null && src[k] !== undefined).map((k) => [k, src[k]]));
    variant = await prisma.product.create({ data: { ...data, companyId: inv.companyId, packaging: pack, sourceProductId: src.id, fieldProvenance: { ...(src.fieldProvenance || {}), packaging: { tier: "manual", source: "request", note: `pack variant of ${src.packaging || src.name}`, at: new Date().toISOString() } } } });
  }
  return resolveLine(id, companyId, lineId, { productId: variant.id });
}

/**
 * POST /certificate-requests { companyId, text? | lines?: [{ productId? | name, packing?, lotNo?, lotSize?, lotUnit?, quantity? }],
 *   certificateCodes? (default COA, COC, HC, FSC), country? } → the request with its matrix
 */
export async function createRequest({ companyId, userId = null, text = null, lines = [], certificateCodes = null, country = null, meta = null, reviewed = false }) {
  const wanted = [...(lines || []), ...linesFromText(text)];
  if (!wanted.length) throw new CertError("LINES_REQUIRED", "Paste the product names, or choose the products", 400);
  if (wanted.length > 200) throw new CertError("TOO_MANY_LINES", "At most 200 lines in one request", 400);
  const codes = [...new Set((certificateCodes?.length ? certificateCodes : DEFAULT_CODES).map((c) => String(c).toUpperCase()))];
  const types = await prisma.certificateType.findMany({ where: { companyId, code: { in: codes }, isActive: true }, select: { id: true, code: true } });
  const matched = [];
  for (const l of wanted) matched.push({ line: l, m: await matchLine(companyId, l) });
  const source = await fileStore.putFile({ companyId, kind: "direct_request", buffer: Buffer.from(JSON.stringify({ kind: "certificate_request", lines: wanted, codes, by: userId, at: new Date().toISOString() }, null, 2)), mimeType: "application/json", originalName: `request ${wanted.length} products.json`, ext: "json" });
  const today = new Date().toISOString().slice(0, 10);
  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      origin: "direct",
      status: matched.every((x) => x.m.status === "matched") ? "ready" : "review",
      sourceFileId: source.id,
      country: clean(country)?.toUpperCase().slice(0, 2) || null,
      certificateTypeIds: types.map((t) => t.id),
      // meta (28 Nov, a chat drop): { conversationId, intakeBatchIds } — a second drop of the conversation adds to it
      header: { invoiceNumber: null, invoiceDate: { iso: today, raw: today }, direct: true, request: { codes, ...(meta || {}) } },
      headerExtracted: {},
      uploadedByUserId: userId,
      ...(reviewed ? { reviewedAt: new Date(), reviewedByUserId: userId } : {}),
      items: {
        create: matched.map(({ line, m }, i) => ({
          lineNo: i + 1,
          productId: m.productId,
          matchStatus: m.status === "matched" ? "matched" : "unmatched",
          matchMethod: "user",
          dataExtracted: {},
          data: { name: m.name || clean(line.name) || "", code: null, batchNo: clean(line.lotNo), productionDate: null, expiryDate: null, quantity: clean(line.quantity), unit: null, packing: m.pack || (clean(line.packing) ? displayPack(line.packing) : null), extra: { lotSize: clean(line.lotSize), lotUnit: clean(line.lotUnit), asked: clean(line.name), match: m.status, candidates: m.candidates } },
        })),
      },
    },
  });
  return getRequest(invoice.id, companyId);
}

/** The conversation's open request for this company (the latest), or null — a second drop adds to it */
export async function conversationRequest({ companyId, conversationId }) {
  if (!conversationId) return null;
  return prisma.invoice.findFirst({ where: { companyId, origin: "direct", header: { path: ["request", "conversationId"], equals: conversationId } }, orderBy: { createdAt: "desc" }, select: { id: true, header: true } });
}

// QA 27 Nov (re-test): the same ADDVET files dropped 4 times made 4 identical requests. A drop of
// the same files (by content) for the same company soon after an earlier one reuses its request.
export const SAME_FILES_HOURS = Number(process.env.EXPRESS_SAME_FILES_HOURS) || 24;

/** The request an earlier Express drop of the same files made for this company (within SAME_FILES_HOURS), or null */
export async function sameFilesRequest({ companyId, batchId, hours = SAME_FILES_HOURS }) {
  const shasOf = (items) => [...new Set(items.filter((i) => !i.parentId && i.sha256).map((i) => i.sha256))].sort().join(",");
  const mine = shasOf(await prisma.intakeItem.findMany({ where: { batchId }, select: { parentId: true, sha256: true } }));
  if (!mine) return null;
  const since = new Date(Date.now() - hours * 3600_000);
  const earlier = await prisma.intakeBatch.findMany({ where: { id: { not: batchId }, mode: "express", createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, express: true, items: { select: { parentId: true, sha256: true } } } });
  for (const b of earlier) {
    const requestId = b.express?.generation?.requestId;
    if (!requestId || shasOf(b.items) !== mine) continue;
    const inv = await prisma.invoice.findFirst({ where: { id: requestId, companyId, origin: "direct" }, select: { id: true, header: true } });
    if (inv) return inv;
  }
  return null;
}

/**
 * Add lines (products not on the request yet) and certificate types to a request.
 * lines: [{ productId, packing?, quantity?, lotNo? }] → { newItemIds, newCodes }
 */
export async function addToRequest(id, companyId, { lines = [], certificateCodes = [], intakeBatchId = null }) {
  const inv = await loadRequest(id, companyId);
  const have = new Set(inv.items.map((i) => `${i.productId}|${packKey(i.data?.packing)}`));
  const fresh = lines.filter((l) => l.productId && !have.has(`${l.productId}|${packKey(l.packing)}`));
  const codes = inv.header?.request?.codes || DEFAULT_CODES;
  const newCodes = [...new Set(certificateCodes.map((c) => String(c).toUpperCase()))].filter((c) => !codes.includes(c));
  const newItemIds = [];
  let lineNo = inv.items.reduce((n, i) => Math.max(n, i.lineNo || 0), 0);
  for (const l of fresh) {
    const m = await matchLine(companyId, l);
    const row = await prisma.invoiceItem.create({ data: { invoiceId: id, lineNo: ++lineNo, productId: m.productId, matchStatus: m.status === "matched" ? "matched" : "unmatched", matchMethod: "user", dataExtracted: {}, data: { name: m.name || "", code: null, batchNo: clean(l.lotNo), productionDate: null, expiryDate: null, quantity: clean(l.quantity), unit: null, packing: m.pack || (clean(l.packing) ? displayPack(l.packing) : null), extra: { asked: m.name, match: m.status, candidates: m.candidates } } } });
    newItemIds.push(row.id);
  }
  const allCodes = [...codes, ...newCodes];
  const types = await prisma.certificateType.findMany({ where: { companyId: inv.companyId, code: { in: allCodes }, isActive: true }, select: { id: true } });
  const header = { ...inv.header, request: { ...(inv.header?.request || {}), codes: allCodes, intakeBatchIds: [...new Set([...(inv.header?.request?.intakeBatchIds || []), ...(intakeBatchId ? [intakeBatchId] : [])])] } };
  await prisma.invoice.update({ where: { id }, data: { header, certificateTypeIds: types.map((t) => t.id) } });
  return { newItemIds, newCodes };
}

async function loadRequest(id, companyId) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { items: { orderBy: { lineNo: "asc" }, include: { product: { select: { id: true, name: true, packaging: true, brandId: true } } } } } });
  if (!inv || (companyId && inv.companyId !== companyId) || inv.origin !== "direct") throw notFound("Certificate request");
  return inv;
}

/** PATCH /certificate-requests/:id { issueDate: "YYYY-MM-DD" | null } — one issue date for all its certificates (Phase 3) */
export async function setRequestOptions(id, companyId, { issueDate }) {
  const inv = await loadRequest(id, companyId);
  if (issueDate !== null && (typeof issueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || Number.isNaN(new Date(issueDate).getTime()))) throw new CertError("INVALID_DATE", "issueDate is YYYY-MM-DD (or null for today)", 400);
  await prisma.invoice.update({ where: { id }, data: { header: { ...inv.header, request: { ...(inv.header?.request || {}), issueDate: issueDate || null } } } });
  return getRequest(id, companyId);
}

/** PATCH /certificate-requests/:id/lines/:lineId { productId } — a person picks the product of an unclear line */
export async function resolveLine(id, companyId, lineId, { productId }) {
  const inv = await loadRequest(id, companyId);
  const line = inv.items.find((i) => i.id === lineId);
  if (!line) throw notFound("Request line");
  const p = await prisma.product.findFirst({ where: { id: productId, companyId: inv.companyId }, select: { id: true, name: true } });
  if (!p) throw notFound("Product");
  await prisma.invoiceItem.update({ where: { id: lineId }, data: { productId: p.id, matchStatus: "matched", data: { ...line.data, name: p.name, extra: { ...(line.data?.extra || {}), match: "matched", candidates: [] } } } });
  const open = await prisma.invoiceItem.count({ where: { invoiceId: id, matchStatus: { not: "matched" } } });
  if (!open && inv.status === "review") await prisma.invoice.update({ where: { id }, data: { status: "ready", reviewedAt: new Date() } });
  return getRequest(id, companyId);
}

/** POST /certificate-requests/:id/generate — drafts for every matched line × asked type that has a ready template */
export async function generateRequest(id, companyId, userId) {
  const inv = await loadRequest(id, companyId);
  if (inv.items.some((i) => i.matchStatus !== "matched")) throw new CertError("LINES_UNCLEAR", "Choose the product of every unclear line first", 409, { lines: inv.items.filter((i) => i.matchStatus !== "matched").map((i) => i.id) });
  if (inv.status === "review") await prisma.invoice.update({ where: { id }, data: { status: "ready", reviewedAt: new Date() } });
  return startGeneration(id, inv.companyId, userId);
}

// ── the matrix ───────────────────────────────────────────────────────────────
const MISSING_AR = {
  no_type: "الشركة مفيهاش النوع ده",
  no_template: "مفيش قالب شغّال للنوع ده",
  not_ready: "القالب فيه أماكن متغيرة مش متحددة",
  unmatched: "اختار المنتج الأول",
  not_generated: "لسه متعملتش — دوس «طلّع الشهادات»",
  failed: "فشلت وهي بتتعمل",
  lab_report: "تقرير المعمل ناقص",
  composition: "التركيبة ناقصة في المنتج",
  value: "ناقص",
  layout: "كلام أطول من مكانه في التصميم",
  new_pack: "العبوة دي مش موجودة — أضفها كعبوة جديدة لنفس المنتج",
};

// a value really missing (vs. one that is there but doesn't fit its place)
const DATA_FLAGS = new Set(["missing", "sample_value", "unconfirmed"]);

// what a cell with nothing missing still needs before it can be delivered
const STEP_NEED = { draft: "محتاجة تتبعت للمراجعة وتتعتمد", in_review: "في المراجعة", awaiting_authorization: "مستنية الاعتماد" };

/** A certificate's open inputs: its blocking values, a lab result's grouped as the missing lab report */
async function missingOf(cert) {
  if (!cert.currentVersion) return [];
  const [v, fields] = await Promise.all([
    prisma.certificateVersion.findFirst({ where: { certificateId: cert.id, versionNumber: cert.currentVersion }, select: { values: true } }),
    prisma.templateField.findMany({ where: { versionId: cert.templateVersionId }, select: { key: true, label: true, isLabResult: true, dataCategory: true, role: true } }),
  ]);
  // Phase 1: a Certificate of Composition never waits for a lab report — its table is the product's composition
  const isComposition = cert.certificateType?.code === "COC";
  const composition = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out = [];
  const lab = [];
  const values = new Map(); // label → keys (a design's 30 "Analysis result" blanks are one line, with a count)
  const layout = [];
  for (const [k, x] of Object.entries(v?.values || {})) {
    if (!(x.flags || []).some(isBlocking)) continue;
    const f = byKey.get(k);
    // a value that is there but doesn't fit its place (overflow, a missing glyph) is a layout issue, never
    // "missing data" (27 Nov QA: COCs with their whole composition showed «التركيبة ناقصة في المنتج»)
    if (!(x.flags || []).some((fl) => DATA_FLAGS.has(fl))) {
      layout.push(f?.label || k);
      continue;
    }
    if (f && String(f.role || "").startsWith("composition_")) composition.push(k);
    else if (f && isLabResult(f) && !isComposition) lab.push(f.label || k);
    else values.set(f?.label || k, [...(values.get(f?.label || k) || []), k]);
  }
  const counted = (labels) => [...labels.reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map())].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
  for (const [label, keys] of values) out.push({ code: "value", field: keys[0], fields: keys, label, ar: `${MISSING_AR.value}: ${label}${keys.length > 1 ? ` ×${keys.length}` : ""}` });
  if (lab.length) out.unshift({ code: "lab_report", fields: lab, ar: `${MISSING_AR.lab_report} (${counted(lab).join("، ")})` });
  if (composition.length) out.unshift({ code: "composition", fields: composition, ar: MISSING_AR.composition });
  if (layout.length) out.push({ code: "layout", fields: layout, ar: `${MISSING_AR.layout}: ${counted(layout).join("، ")}` });
  return out;
}

const statusOf = (c) => (c.status === "final" ? (c.exportedAt ? "exported" : "approved") : c.reviewStatus === "in_review" ? "in_review" : c.reviewStatus === "awaiting_authorization" ? "awaiting_authorization" : "draft");

/** GET /certificate-requests/:id → { request, codes, rows: [{ line…, cells: { COA: { status, certificateId?, missing[], comments[] } } }], outstanding[] } */
export async function getRequest(id, companyId) {
  const inv = await loadRequest(id, companyId);
  const codes = inv.header?.request?.codes || DEFAULT_CODES;
  const types = await prisma.certificateType.findMany({ where: { companyId: inv.companyId, code: { in: codes } }, select: { id: true, code: true, isActive: true } });
  const typeOf = new Map(types.map((t) => [t.code, t]));
  const certs = await prisma.certificate.findMany({ where: { invoiceId: id, status: { not: "pending" } }, include: { items: { select: { invoiceItemId: true } }, certificateType: { select: { code: true } } }, orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }] });
  // which template each line × type would use, and whether it's ready
  const templates = await usableTemplates({ companyId: inv.companyId });
  const plan = selectTemplates({ invoice: { country: inv.country, brandId: inv.brandId, certificateTypeIds: types.map((t) => t.id) }, items: inv.items.filter((i) => i.productId).map((i) => ({ ...i, product: i.product })), templates });
  const ready = await readinessMap(plan.entries.map((e) => e.templateVersionId));
  const rows = [];
  const outstanding = [];
  for (const line of inv.items) {
    const cells = {};
    for (const code of codes) {
      const t = typeOf.get(code);
      const cert = t ? certs.find((c) => c.certificateTypeId === t.id && c.items.some((x) => x.invoiceItemId === line.id)) : null;
      let cell;
      if (cert && cert.status === "failed") cell = { status: "awaiting_inputs", certificateId: cert.id, missing: [{ code: "failed", ar: `${MISSING_AR.failed}: ${cert.error || ""}`.trim() }] };
      else if (cert) {
        const missing = cert.status === "final" ? [] : await missingOf(cert);
        cell = { status: missing.length ? "awaiting_inputs" : statusOf(cert), certificateId: cert.id, revision: cert.revisionNumber, shared: cert.items.length > 1, covers: cert.items.length, missing, comments: (cert.reviewComments || []).filter((c) => !c.resolvedAt), ...(cert.isExperimentSample ? { experiment: true } : {}) };
      } else {
        const entry = t && plan.entries.find((e) => e.certificateTypeId === t.id && e.invoiceItemIds.includes(line.id));
        const why = !line.productId ? (line.data?.extra?.match === "new_pack" ? "new_pack" : "unmatched") : !t ? "no_type" : !entry ? "no_template" : !ready[entry.templateVersionId]?.ready ? "not_ready" : "not_generated";
        // no active template: said plainly, per type (27 Nov QA: the FSC template is off until it passes its check)
        // a type with no template, or one whose template isn't ready yet: the same words as the drop's card,
        // in both languages (acceptance #10 — "not_ready" said only an Arabic generic line)
        const text = why === "no_template" || why === "not_ready" ? { ar: `قالب الـ ${code} لسه مش جاهز — متعملتش ${code}`, en: `${code} template isn't ready yet — no ${code} was made` } : { ar: MISSING_AR[why] };
        cell = { status: "awaiting_inputs", missing: [{ code: why, ...text, ...(why === "not_ready" ? { link: ready[entry.templateVersionId].link } : {}) }] };
      }
      cells[code] = cell;
      if (!["approved", "exported"].includes(cell.status)) outstanding.push({ lineNo: line.lineNo, product: line.product?.name || line.data?.name, code, status: cell.status, needs: cell.missing?.length ? cell.missing.map((m) => m.ar) : [STEP_NEED[cell.status]].filter(Boolean) });
    }
    rows.push({
      lineId: line.id,
      lineNo: line.lineNo,
      productId: line.productId,
      product: line.product?.name || line.data?.name || "",
      asked: line.data?.extra?.asked || null,
      packing: line.data?.packing || line.product?.packaging || null,
      lot: line.data?.batchNo || null,
      lotSize: line.data?.extra?.lotSize || null,
      lotUnit: line.data?.extra?.lotUnit || null,
      match: line.matchStatus === "matched" ? "matched" : line.data?.extra?.match || "unmatched",
      candidates: line.matchStatus === "matched" ? [] : line.data?.extra?.candidates || [],
      cells,
    });
  }
  const batch = await prisma.certificateBatch.findFirst({ where: { invoiceId: id }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, zipFileId: true, combinedPdfFileId: true } });
  return { request: { id: inv.id, companyId: inv.companyId, status: inv.status, country: inv.country, createdAt: inv.createdAt, issueDate: inv.header?.request?.issueDate || null }, codes, rows, outstanding, batch: batch ? { id: batch.id, status: batch.status, zip: !!batch.zipFileId, combinedPdf: !!batch.combinedPdfFileId } : null };
}

/**
 * GET /certificate-requests — the requests list (UI plan, 27 Nov: "/certificates/requests" showed "Invalid
 * UUID"; a request could only be found through a chat link). Newest first. Codes and numbers only — the page
 * words them in the UI language.
 * → { items: [{ id, company, products: [{ name, pack }], codes, types: { COA: { total, final, draft, failed } },
 *               status: new|in_progress|ready, consignee, createdAt, updatedAt }], total, page, pageSize }
 */
export async function listRequests(scopeCompanyId, { companyId = null, page = 1, pageSize = 25 } = {}) {
  const where = { origin: "direct", ...(scopeCompanyId ? { companyId: scopeCompanyId } : companyId ? { companyId } : {}) };
  const take = Math.min(100, Math.max(1, Number(pageSize) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip,
      take,
      select: {
        id: true,
        header: true,
        createdAt: true,
        updatedAt: true,
        company: { select: { id: true, name: true } },
        items: { orderBy: { lineNo: "asc" }, select: { data: true, product: { select: { name: true, packaging: true } } } },
        certificates: { where: { status: { notIn: ["pending", "superseded"] } }, select: { status: true, certificateType: { select: { code: true } } } },
      },
    }),
  ]);
  const items = rows.map((r) => {
    const codes = r.header?.request?.codes || DEFAULT_CODES;
    const types = Object.fromEntries(codes.map((c) => [c, { total: 0, final: 0, draft: 0, failed: 0 }]));
    for (const c of r.certificates) {
      const t = (types[c.certificateType.code] ||= { total: 0, final: 0, draft: 0, failed: 0 });
      t.total++;
      if (c.status === "final") t.final++;
      else if (c.status === "failed") t.failed++;
      else t.draft++;
    }
    const made = Object.values(types).reduce((n, t) => n + t.total, 0);
    const done = Object.values(types).every((t) => t.total > 0 && t.final === t.total);
    const seen = new Set();
    const products = r.items
      .map((i) => ({ name: i.product?.name || i.data?.name || null, pack: i.product?.packaging || i.data?.packing || null }))
      .filter((p) => p.name && !seen.has(`${p.name}|${p.pack}`) && seen.add(`${p.name}|${p.pack}`));
    return {
      id: r.id,
      company: r.company,
      products,
      codes,
      types,
      status: !made ? "new" : done ? "ready" : "in_progress",
      consignee: r.header?.customerName || null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}
