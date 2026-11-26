import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import * as fileStore from "../storage/fileStore.js";
import { startGeneration, isBlocking } from "../generation/batchService.js";
import { usableTemplates } from "../generation/planService.js";
import { selectTemplates } from "../generation/templateSelector.js";
import { readinessMap } from "../templates/readinessService.js";
import { isLabResult } from "../inference/policy.js";

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
  const name = clean(line.name);
  if (!name) return { productId: null, name: "", status: "unmatched", candidates: [] };
  const all = await prisma.product.findMany({ where: { companyId, OR: [{ name: { contains: name.split(/\s+/)[0], mode: "insensitive" } }, { productCode: { equals: name, mode: "insensitive" } }] }, select: { id: true, name: true, packaging: true, productCode: true }, take: 50 });
  const exact = all.filter((p) => norm(p.name) === norm(name) || norm(p.productCode) === norm(name));
  const pack = clean(line.packing);
  // the same product in several packs: the pack decides, else a person does
  const byPack = pack ? exact.filter((p) => norm(p.packaging) === norm(pack)) : exact;
  if (byPack.length === 1) return { productId: byPack[0].id, name: byPack[0].name, status: "matched", candidates: [] };
  const close = (exact.length ? exact : all.filter((p) => norm(p.name).includes(norm(name)) || norm(name).includes(norm(p.name)))).slice(0, 8);
  return { productId: null, name, status: close.length ? "ambiguous" : "unmatched", candidates: close.map((p) => ({ id: p.id, name: p.name, packaging: p.packaging, productCode: p.productCode })) };
}

/**
 * POST /certificate-requests { companyId, text? | lines?: [{ productId? | name, packing?, lotNo?, lotSize?, lotUnit?, quantity? }],
 *   certificateCodes? (default COA, COC, HC, FSC), country? } → the request with its matrix
 */
export async function createRequest({ companyId, userId = null, text = null, lines = [], certificateCodes = null, country = null }) {
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
      header: { invoiceNumber: null, invoiceDate: { iso: today, raw: today }, direct: true, request: { codes } },
      headerExtracted: {},
      uploadedByUserId: userId,
      items: {
        create: matched.map(({ line, m }, i) => ({
          lineNo: i + 1,
          productId: m.productId,
          matchStatus: m.status === "matched" ? "matched" : "unmatched",
          matchMethod: "user",
          dataExtracted: {},
          data: { name: m.name || clean(line.name) || "", code: null, batchNo: clean(line.lotNo), productionDate: null, expiryDate: null, quantity: clean(line.quantity), unit: null, packing: clean(line.packing), extra: { lotSize: clean(line.lotSize), lotUnit: clean(line.lotUnit), asked: clean(line.name), match: m.status, candidates: m.candidates } },
        })),
      },
    },
  });
  return getRequest(invoice.id, companyId);
}

async function loadRequest(id, companyId) {
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { items: { orderBy: { lineNo: "asc" }, include: { product: { select: { id: true, name: true, packaging: true, brandId: true } } } } } });
  if (!inv || (companyId && inv.companyId !== companyId) || inv.origin !== "direct") throw notFound("Certificate request");
  return inv;
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
  value: "ناقص",
};

// what a cell with nothing missing still needs before it can be delivered
const STEP_NEED = { draft: "محتاجة تتبعت للمراجعة وتتعتمد", in_review: "في المراجعة", awaiting_authorization: "مستنية الاعتماد" };

/** A certificate's open inputs: its blocking values, a lab result's grouped as the missing lab report */
async function missingOf(cert) {
  if (!cert.currentVersion) return [];
  const [v, fields] = await Promise.all([
    prisma.certificateVersion.findFirst({ where: { certificateId: cert.id, versionNumber: cert.currentVersion }, select: { values: true } }),
    prisma.templateField.findMany({ where: { versionId: cert.templateVersionId }, select: { key: true, label: true, isLabResult: true, dataCategory: true } }),
  ]);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out = [];
  const lab = [];
  for (const [k, x] of Object.entries(v?.values || {})) {
    if (!(x.flags || []).some(isBlocking)) continue;
    const f = byKey.get(k);
    if (f && isLabResult(f)) lab.push(f.label || k);
    else out.push({ code: "value", field: k, label: f?.label || k, ar: `${MISSING_AR.value}: ${f?.label || k}` });
  }
  if (lab.length) out.unshift({ code: "lab_report", fields: lab, ar: `${MISSING_AR.lab_report} (${lab.join("، ")})` });
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
        cell = { status: missing.length ? "awaiting_inputs" : statusOf(cert), certificateId: cert.id, revision: cert.revisionNumber, shared: cert.items.length > 1, missing, comments: (cert.reviewComments || []).filter((c) => !c.resolvedAt) };
      } else {
        const entry = t && plan.entries.find((e) => e.certificateTypeId === t.id && e.invoiceItemIds.includes(line.id));
        const why = !line.productId ? "unmatched" : !t ? "no_type" : !entry ? "no_template" : !ready[entry.templateVersionId]?.ready ? "not_ready" : "not_generated";
        cell = { status: "awaiting_inputs", missing: [{ code: why, ar: MISSING_AR[why], ...(why === "not_ready" ? { link: ready[entry.templateVersionId].link } : {}) }] };
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
  return { request: { id: inv.id, companyId: inv.companyId, status: inv.status, country: inv.country, createdAt: inv.createdAt }, codes, rows, outstanding, batch: batch ? { id: batch.id, status: batch.status, zip: !!batch.zipFileId, combinedPdf: !!batch.combinedPdfFileId } : null };
}
