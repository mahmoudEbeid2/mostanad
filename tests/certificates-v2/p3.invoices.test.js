// Certificates V2 Phase 3 — Invoices (CERTIFICATES_V2_PLAN.md §9, §17 row 3).
//  - upload validation (magic bytes), extraction failure is explicit:
//    `failed`, the provider/guard message, ZERO items (§16.3)
//  - shaping of a model response + unambiguous-only date normalisation
//  - matching: exact code, exact name, ambiguous → candidates, tenant isolation (§16.3)
//  - review edits, add/remove lines, manual match / ignore, confirm rules
//  - tenancy: every invoice route is 404 to another company
// Tests never call Gemini (GEMINI_DISABLED): a successful extraction is
// represented by storing shapeExtraction() output — the function the job uses.
import { api, asCompany, form, fixture, makeAssert, finish, createCompany, cleanupCompany, pollTask, prisma } from "./helpers.js";
import { shapeExtraction } from "../../src/services/certificates/invoices/invoiceExtractor.js";
import { normalizeDate } from "../../src/services/certificates/invoices/dateNormalizer.js";
import { matchLine, normalizeName } from "../../src/services/certificates/matching/productMatcher.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

const { assert, counts } = makeAssert();
const coA = await createCompany("p3a");
const coB = await createCompany("p3b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);

try {
  console.log("\n🧪 Date normalisation (§9.1: ISO only when unambiguous)");
  for (const [raw, iso] of [
    ["2025-04-15", "2025-04-15"],
    ["11/2025", "2025-11"],
    ["APR-2026", "2026-04"],
    ["15.04.2025", "2025-04-15"],
    ["04/15/2025", "2025-04-15"],
    ["15 Apr 2025", "2025-04-15"],
    ["Sept 2025", "2025-09"],
    ["03/04/2025", null],
    ["11/25", null],
    ["31/02/2025", null],
    ["13/2025", null],
    ["soon", null],
  ]) {
    assert(`"${raw}" → ${iso}`, normalizeDate(raw) === iso, normalizeDate(raw));
  }

  console.log("\n🧪 Shaping a model response");
  const modelOut = {
    header: { invoiceNumber: " INV-2026-0042 ", invoiceDate: "15/04/2026", supplierName: "ADDVET", customerName: "Gulf Vet Supplies", customerCountry: "SA", currency: "USD" },
    items: [
      { lineNo: 1, name: "ADD-E120", code: "AE120", batchNo: "AVVS1124011", productionDate: "06/2024", expiryDate: "06/2027", quantity: "1,200", unit: "L", packing: "1L BOTTLE", extra: [{ label: "Reg. No", value: "J-77" }] },
      { lineNo: 2, name: "add-e120 forte!", code: null, batchNo: "AVVS1124012", productionDate: "03/04/2025", expiryDate: "03/2027", quantity: "50", unit: "KG", packing: null },
      { lineNo: 3, name: "Selenium Plus", code: "SP-1", batchNo: "X1", productionDate: null, expiryDate: null, quantity: null, unit: null, packing: null },
      { lineNo: 3, name: "Unknown Tonic", code: null, batchNo: "U9", productionDate: null, expiryDate: null, quantity: "abc", unit: null, packing: null },
    ],
  };
  const shaped = shapeExtraction(modelOut);
  assert("header trimmed, date as { raw, iso }", shaped.header.invoiceNumber === "INV-2026-0042" && shaped.header.invoiceDate.raw === "15/04/2026" && shaped.header.invoiceDate.iso === "2026-04-15");
  assert("item dates keep raw + unambiguous iso", shaped.items[0].data.expiryDate.iso === "2027-06" && shaped.items[1].data.productionDate.iso === null && shaped.items[1].data.productionDate.raw === "03/04/2025");
  assert("quantity: ambiguous \"1,200\" → null + raw kept + flagged; \"50\" parsed; unreadable → null (review #4)",
    shaped.items[0].data.quantity === null && shaped.items[0].data.quantityRaw === "1,200" && shaped.items[0].data.quantityAmbiguous === true &&
    shaped.items[1].data.quantity === 50 && !shaped.items[1].data.quantityAmbiguous && shaped.items[3].data.quantity === null && shaped.items[3].data.quantityRaw === "abc");
  assert("extra columns kept", shaped.items[0].data.extra["Reg. No"] === "J-77");
  assert("duplicate line numbers made unique", new Set(shaped.items.map((i) => i.lineNo)).size === 4, shaped.items.map((i) => i.lineNo));

  console.log("\n🧪 Matching (pure)");
  const catalogue = [
    { id: "p1", name: "ADD-E120", productCode: "AE120", brandId: "b1" },
    { id: "p2", name: "ADD E120 Forte", productCode: null, brandId: null },
    { id: "p3", name: "Selenium Plus", productCode: "SP-2", brandId: null },
    { id: "p4", name: "Selenium Plus", productCode: "SP-3", brandId: "b1" },
  ];
  assert("normalizeName strips punctuation/case/space", normalizeName("  ADD-E120   Forte! ") === "add e120 forte");
  let m = matchLine({ name: "whatever", code: "ae120" }, catalogue);
  assert("exact code (case-insensitive) → exact_code", m.productId === "p1" && m.matchMethod === "exact_code");
  m = matchLine({ name: "add-e120 forte!", code: null }, catalogue);
  assert("exact normalised name, single hit → exact_name", m.productId === "p2" && m.matchMethod === "exact_name");
  m = matchLine({ name: "Selenium Plus", code: "SP-1" }, catalogue, { brandId: "b1" });
  assert("ambiguous name → needs_match with ranked candidates", m.matchStatus === "needs_match" && m.matchCandidates.length >= 2 && m.matchCandidates[0].productId === "p4", m.matchCandidates);
  assert("candidates explain themselves", m.matchCandidates[0].reasons.some((r) => r.includes("invoice brand")));
  m = matchLine({ name: "Zzz", code: null }, catalogue);
  assert("nothing similar → needs_match, no candidates", m.matchStatus === "needs_match" && m.matchCandidates.length === 0);

  console.log("\n🧪 Upload validation and explicit extraction failure");
  let r = await api("POST", "/invoices", A, form({}, { field: "invoice", buffer: Buffer.from("hello world"), name: "inv.pdf", type: "application/pdf" }));
  assert("non-PDF/image bytes (even named .pdf) → 400 UNSUPPORTED_FORMAT", r.status === 400 && r.data?.code === "UNSUPPORTED_FORMAT", r.data);
  r = await api("POST", "/invoices", A, form({ country: "sa" }, { field: "invoice", buffer: fixture("outlined_text.pdf"), name: "invoice.pdf", type: "application/pdf" }));
  assert("PDF upload → 202 with ids", r.status === 202 && r.data?.data?.invoiceId && r.data?.data?.taskId, r.data);
  const failedId = r.data.data.invoiceId;
  const task = await pollTask(r.data.data.taskId, A);
  assert("extraction task failed (Gemini disabled in tests)", task?.status === "failed", task?.status);
  r = await api("GET", `/invoices/${failedId}`, A);
  assert("invoice failed, zero items; the API says why in a sentence (no env flags), the row keeps the real reason", r.data?.data?.invoice?.status === "failed" && r.data.data.invoice.errorCode === "AI_DISABLED" && !/GEMINI|EXTRACTION_FAILED/.test(r.data.data.invoice.error) && r.data.data.invoice.items.length === 0 && /EXTRACTION_FAILED.*GEMINI_DISABLED/.test((await prisma.invoice.findUnique({ where: { id: failedId } })).error), r.data?.data?.invoice);
  assert("country from upload normalised", r.data.data.invoice.country === "SA");
  r = await api("POST", `/invoices/${failedId}/confirm`, A);
  assert("a failed invoice cannot be confirmed", r.status === 409, r.status);
  r = await api("GET", `/invoices/${failedId}/source`, A);
  assert("original file served (nosniff, CSP sandbox)", r.status === 200 && r.headers.get("content-type") === "application/pdf" && r.headers.get("x-content-type-options") === "nosniff" && /sandbox/.test(r.headers.get("content-security-policy")));
  r = await api("POST", `/invoices/${failedId}/retry`, A);
  assert("retry a failed invoice → 202 + new task", r.status === 202 && r.data?.data?.taskId, r.data);
  const retryTask = await pollTask(r.data.data.taskId, A);
  r = await api("GET", `/invoices/${failedId}`, A);
  assert("retry ran the same extraction: failed again with the real reason, zero items", retryTask?.status === "failed" && r.data.data.invoice.status === "failed" && r.data.data.invoice.errorCode === "AI_DISABLED" && r.data.data.invoice.items.length === 0, r.data.data.invoice);

  console.log("\n🧪 Review flow (extraction result stored as the job stores it)");
  const brand = await prisma.brand.create({ data: { companyId: coA.id, name: "ADDvet" } });
  const pAE = await prisma.product.create({ data: { companyId: coA.id, name: "ADD-E120", productCode: "AE120", brandId: brand.id } });
  const pForte = await prisma.product.create({ data: { companyId: coA.id, name: "ADD E120 Forte" } });
  await prisma.product.create({ data: { companyId: coA.id, name: "Selenium Plus", productCode: "SP-2" } });
  const pSel = await prisma.product.create({ data: { companyId: coA.id, name: "Selenium Plus", productCode: "SP-3", brandId: brand.id } });
  const foreign = await prisma.product.create({ data: { companyId: coB.id, name: "Unknown Tonic", productCode: "AE120" } });
  const src = await fileStore.putFile({ companyId: coA.id, kind: "invoice_source", buffer: fixture("outlined_text.pdf"), mimeType: "application/pdf" });
  const inv = await prisma.invoice.create({
    data: { companyId: coA.id, brandId: brand.id, status: "review", sourceFileId: src.id, header: shaped.header, headerExtracted: shaped.header, extraction: { modelId: "test", promptHash: "test" } },
  });
  await prisma.invoiceItem.createMany({ data: shaped.items.map((it) => ({ invoiceId: inv.id, lineNo: it.lineNo, data: it.data, dataExtracted: it.data })) });
  r = await api("POST", `/invoices/${inv.id}/rematch`, A);
  assert("rematch → 200", r.status === 200, r.data);
  r = await api("GET", `/invoices/${inv.id}`, A);
  let items = r.data.data.invoice.items;
  const line = (n) => items.find((i) => i.lineNo === n);
  assert("line 1 matched by code to the own-tenant product (foreign code ignored)", line(1).productId === pAE.id && line(1).matchMethod === "exact_code", line(1));
  assert("line 2 matched by normalised name", line(2).productId === pForte.id && line(2).matchMethod === "exact_name", line(2));
  assert("line 3 ambiguous → candidates, brand first", line(3).matchStatus === "needs_match" && line(3).matchCandidates[0].productId === pSel.id, line(3).matchCandidates);
  assert("line 4 unknown → needs_match; another tenant's product never offered", line(4).matchStatus === "needs_match" && !line(4).matchCandidates.some((c) => c.productId === foreign.id));
  assert("counts by status", r.data.data.invoice.counts.matched === 2 && r.data.data.invoice.counts.needs_match === 2, r.data.data.invoice.counts);

  r = await api("POST", `/invoices/${inv.id}/confirm`, A);
  assert("confirm with needs_match lines → 409 ITEMS_NEED_MATCH + lines", r.status === 409 && r.data?.code === "ITEMS_NEED_MATCH" && r.data.lines.join(",") === "3,4", r.data);
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(3).id}`, A, { productId: foreign.id });
  assert("matching to another tenant's product → 404", r.status === 404, r.status);
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(3).id}`, A, { productId: pSel.id });
  assert("manual match → matched (user)", r.status === 200 && r.data.data.item.matchStatus === "matched" && r.data.data.item.matchMethod === "user");
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(4).id}`, A, { ignored: true });
  assert("ignore a line", r.data?.data?.item?.matchStatus === "ignored");
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(1).id}`, A, { data: { batchNo: " AVVS1124099 ", expiryDate: "07/2027", quantity: "10" } });
  const d1 = r.data?.data?.item?.data;
  assert("edit item cells (trim, date re-normalised, number; the ambiguous-quantity flag is cleared)", d1?.batchNo === "AVVS1124099" && d1.expiryDate.iso === "2027-07" && d1.quantity === 10 && !("quantityAmbiguous" in d1), d1);
  assert("raw extraction is never edited", (await prisma.invoiceItem.findUnique({ where: { id: line(1).id } })).dataExtracted.batchNo === "AVVS1124011");
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(1).id}`, A, { data: { quantity: "1.250" } });
  assert("review edit: an ambiguous quantity is refused (422 AMBIGUOUS_QUANTITY), not stored as 1.25", r.status === 422 && r.data?.code === "AMBIGUOUS_QUANTITY", r.data);
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(1).id}`, A, { data: { quantity: "1.250,00" } });
  assert("review edit: European \"1.250,00\" → 1250", r.data?.data?.item?.data?.quantity === 1250, r.data?.data?.item?.data);
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(1).id}`, A, { data: { quantity: "10" } });
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(1).id}`, A, { data: { quantity: "lots" } });
  assert("non-number quantity → 422", r.status === 422, r.status);
  r = await api("PATCH", `/invoices/${inv.id}`, A, { header: { invoiceNumber: "INV-2026-0042-A", invoiceDate: "2026-04-16" }, country: "ae" });
  assert("edit header + country", r.status === 200 && r.data.data.invoice.header.invoiceNumber === "INV-2026-0042-A" && r.data.data.invoice.header.invoiceDate.iso === "2026-04-16" && r.data.data.invoice.country === "AE", r.data);
  assert("a PATCH without brandId leaves the brand hint alone", r.data?.data?.invoice?.brandId === brand.id, r.data?.data?.invoice?.brandId);
  r = await api("PATCH", `/invoices/${inv.id}`, A, { header: { currency: "EUR" } });
  assert("header-only PATCH keeps country and brand", r.data?.data?.invoice?.country === "AE" && r.data.data.invoice.brandId === brand.id, r.data?.data?.invoice);
  r = await api("PATCH", `/invoices/${inv.id}`, A, { country: "" });
  assert('country "" clears it', r.status === 200 && r.data.data.invoice.country === null, r.data?.data?.invoice?.country);
  r = await api("PATCH", `/invoices/${inv.id}`, A, { country: "AE" });
  r = await api("POST", `/invoices/${inv.id}/items`, A, { data: { name: "Hand-added line", batchNo: "H1" }, productId: pForte.id });
  assert("add a line the extraction missed (matched by user, empty dataExtracted)", r.status === 201 && r.data.data.item.lineNo === 5 && r.data.data.item.matchMethod === "user");
  const added = r.data.data.item.id;
  r = await api("DELETE", `/invoices/${inv.id}/items/${added}`, A);
  assert("delete a line", r.status === 204, r.status);
  r = await api("POST", `/invoices/${inv.id}/rematch`, A);
  r = await api("GET", `/invoices/${inv.id}`, A);
  items = r.data.data.invoice.items;
  assert("rematch keeps manual matches and ignored lines", line(3).matchMethod === "user" && line(4).matchStatus === "ignored");
  r = await api("POST", `/invoices/${inv.id}/confirm`, A);
  assert("confirm → ready, reviewer recorded", r.status === 200 && r.data.data.invoice.status === "ready" && !!r.data.data.invoice.reviewedAt, r.data);
  r = await api("PATCH", `/invoices/${inv.id}/items/${line(2).id}`, A, { data: { batchNo: "AVVS1124013" } });
  r = await api("GET", `/invoices/${inv.id}`, A);
  assert("editing a confirmed invoice sends it back to review", r.data.data.invoice.status === "review" && !r.data.data.invoice.reviewedAt);
  r = await api("POST", `/invoices/${inv.id}/confirm`, A);
  assert("confirm again → ready", r.data?.data?.invoice?.status === "ready");

  console.log("\n🧪 Lists");
  r = await api("GET", "/invoices", A);
  assert("list: 2 invoices, newest first", r.status === 200 && r.data.total === 2 && r.data.data.invoices[0].id === inv.id, r.data?.total);
  r = await api("GET", "/invoices?status=failed", A);
  assert("filter by status", r.data?.total === 1 && r.data.data.invoices[0].id === failedId);
  r = await api("GET", "/invoices?q=0042-a", A);
  assert("search by invoice number (case-insensitive)", r.data?.total === 1 && r.data.data.invoices[0].id === inv.id, r.data?.total);
  r = await api("GET", "/invoices?q=gulf%20vet", A);
  assert("search by customer", r.data?.total === 1 && r.data.data.invoices[0].id === inv.id, r.data?.total);
  r = await api("GET", "/invoices?q=%25", A);
  assert("LIKE wildcards are literal", r.data?.total === 0, r.data?.total);
  r = await api("POST", `/invoices/${inv.id}/retry`, A);
  assert("retry on a non-failed invoice → 409 INVOICE_NOT_FAILED", r.status === 409 && r.data?.code === "INVOICE_NOT_FAILED", r.data);

  console.log("\n🧪 Tenancy: every invoice route is 404 to another company");
  const it1 = line(1).id;
  for (const [label, method, url, body] of [
    ["GET invoice", "GET", `/invoices/${inv.id}`],
    ["GET source", "GET", `/invoices/${inv.id}/source`],
    ["PATCH invoice", "PATCH", `/invoices/${inv.id}`, { header: { invoiceNumber: "x" } }],
    ["add item", "POST", `/invoices/${inv.id}/items`, { data: { name: "x" } }],
    ["patch item", "PATCH", `/invoices/${inv.id}/items/${it1}`, { ignored: true }],
    ["delete item", "DELETE", `/invoices/${inv.id}/items/${it1}`],
    ["rematch", "POST", `/invoices/${inv.id}/rematch`],
    ["confirm", "POST", `/invoices/${inv.id}/confirm`],
    ["retry", "POST", `/invoices/${failedId}/retry`],
    ["manual", "POST", `/invoices/${failedId}/manual`],
  ]) {
    r = await api(method, url, B, body);
    assert(`${label} → 404`, r.status === 404, r.status);
  }
  r = await api("GET", "/invoices", B);
  assert("other tenant's list is empty", r.data?.total === 0);

  console.log("\n✍️ P8 — AI unavailable: a failed invoice is entered by hand");
  r = await api("POST", `/invoices/${inv.id}/manual`, A);
  assert("manual on a non-failed invoice → 409 INVOICE_NOT_FAILED", r.status === 409 && r.data?.code === "INVOICE_NOT_FAILED", r.data);
  r = await api("POST", `/invoices/${failedId}/manual`, A);
  const mInv = r.data?.data?.invoice;
  assert("failed → review, no lines, nothing filled in, the reason kept", r.status === 200 && mInv.status === "review" && mInv.items.length === 0 && !mInv.error && mInv.extraction?.manual === true && /GEMINI_DISABLED/.test(mInv.extraction.reason) && !Object.keys(mInv.header || {}).length, mInv);
  r = await api("POST", `/invoices/${failedId}/manual`, A);
  assert("…only once (409 the second time)", r.status === 409 && r.data?.code === "INVOICE_NOT_FAILED", r.data);
  r = await api("PATCH", `/invoices/${failedId}`, A, { header: { invoiceNumber: "INV-HAND-1", invoiceDate: "2026-10-20" } });
  assert("header typed by hand", r.status === 200 && r.data.data.invoice.header.invoiceNumber === "INV-HAND-1", r.data);
  r = await api("POST", `/invoices/${failedId}/items`, A, { data: { name: "ADD-E120", batchNo: "M-1", expiryDate: "11/2028" }, productId: pAE.id });
  assert("a line typed by hand, matched by the person", r.status === 201 && r.data.data.item.lineNo === 1 && r.data.data.item.matchMethod === "user", r.data);
  r = await api("POST", `/invoices/${failedId}/confirm`, A);
  assert("confirm → ready", r.status === 200 && r.data.data.invoice.status === "ready", r.data);

  console.log("\n✍️ P8 — AI unavailable at upload: extract=false opens it for manual entry straight away");
  const aiRunsBefore = await prisma.aiRun.count({ where: { companyId: coA.id } });
  r = await api("POST", "/invoices", A, form({ extract: "false" }, { field: "invoice", buffer: fixture("outlined_text.pdf"), name: "by-hand.pdf", type: "application/pdf" }));
  assert("upload extract=false → 201, no task", r.status === 201 && r.data?.data?.invoiceId && r.data.data.taskId === null, r.data);
  r = await api("GET", `/invoices/${r.data.data.invoiceId}`, A);
  const hInv = r.data?.data?.invoice;
  assert("…under review, no lines, nothing filled in, marked manual, original kept", hInv.status === "review" && hInv.items.length === 0 && !Object.keys(hInv.header).length && hInv.extraction.manual === true && !!hInv.sourceFileId, hInv);
  assert("…and no AI was asked", (await prisma.aiRun.count({ where: { companyId: coA.id } })) === aiRunsBefore);
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

await finish(counts, async () => {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
});
