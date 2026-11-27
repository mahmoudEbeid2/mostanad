// Acceptance #1 / #9 (27 Nov): the shipment's MO decides the request's products and packs, and the HC's
// consignee — in the drop, or filed before with the batch numbers the drop's certificates print. The
// unrelated ROSHAN invoice in the same drop is never the shipment. A page linked to the wrong pack is
// corrected to the pack it prints. Needs Postgres (no API, no model).
import { makeAssert, createCompany, cleanupCompany, prisma } from "./certificates-v2/helpers.js";
import { requestScope, shipmentConsignee } from "../src/services/intake/expressService.js";
import * as fileStore from "../src/services/certificates/storage/fileStore.js";

const { assert, counts } = makeAssert();
const co = await createCompany("shipDoc");
const cid = co.id;
try {
  const P = async (name, packaging) => prisma.product.create({ data: { companyId: cid, name, packaging } });
  const oli100 = await P("OLIGOVET", "100mL");
  const oli1l = await P("OLIGOVET", "1 L");
  const addmectin = await P("ADDMECTIN 1%", "100mL");
  const sulfaprim = await P("SULFAPRIM", "100mL");
  const adde = await P("ADD-E120", "1L");
  const amino = await P("AMINOVITA", "1L");
  const hepa = await P("ADDHEPA", "1L");
  const file = await fileStore.putFile({ companyId: cid, kind: "invoice_source", buffer: Buffer.from("%PDF-1.4 test"), mimeType: "application/pdf", originalName: "doc.pdf" });
  const doc = async (header, lines) =>
    prisma.invoice.create({
      data: {
        companyId: cid, origin: "upload", status: "review", sourceFileId: file.id, header, headerExtracted: {},
        items: { create: lines.map(([name, packing, batchNo, productId], i) => ({ lineNo: i + 1, productId: productId || null, matchStatus: productId ? "matched" : "needs_match", matchMethod: productId ? "exact" : null, dataExtracted: {}, data: { name, packing, batchNo, quantity: "2400" } })) },
      },
    });
  const MADHOOB = "Madhoob Trading Group Mawaleh South, Muscat. Sultante Of Oman P.O Box 437 Tel: +968268904412";
  // the MO as production filed it: 4 lines the filing couldn't match
  const mo = await doc({ customerName: MADHOOB }, [
    ["ADDMECTIN", "100ML", "MADADD02610001", null],
    ["SULFARIM", "100ML", "MADADD02610002", null],
    ["OLIGOVET", "100ML", "MADADD02610003", oli100.id],
    ["ADD E 120", "1 L", "MADADD02610005", null],
    ["AMINOVITE", "1 L", "MADADD02610006", null],
    ["ADDHEPA", "1 L", "MADADD02610010", hepa.id],
  ]);
  const roshan = await doc({ customerName: "ROSHAN VET PHARMA", invoiceNumber: "BRN2025002" }, [["ACTILIVER PLUS", "5L", null, null], ["TOXOVET", "1L", null, null]]);
  const batch = { id: "b", createdAt: new Date(), express: {} };
  const ex = { startedAt: new Date(0).toISOString() };
  // the drop's files: COC pages linked by the filing (OLIGOVET's page to the 1 L — the bug), the MO, ROSHAN
  const page = (name, pageFrom, productId) => ({ id: name, name, status: "done", companyId: cid, parentId: "coc", pageFrom, pageTo: pageFrom, result: { plan: { productIds: [productId] } } });
  const cocPages = [page("ADDVET OMAN COC 10-26.pdf — ADDMECTIN", 1, addmectin.id), page("ADDVET OMAN COC 10-26.pdf — SULFARIM", 2, sulfaprim.id), page("ADDVET OMAN COC 10-26.pdf — OLIGOVET", 3, oli1l.id), page("ADDVET OMAN COC 10-26.pdf — ADD-E120", 5, adde.id), page("ADDVET OMAN COC 10-26.pdf — AMINOVITA", 6, amino.id), page("ADDVET OMAN COC 10-26.pdf — ADDHEPA", 10, hepa.id)];
  const moItem = { id: "mo", name: "MADADD2610001.pdf", status: "done", companyId: cid, parentId: null, result: { invoiceId: mo.id } };
  const roshanItem = { id: "ro", name: "BRN2025002 - ROSHAN.pdf", status: "done", companyId: cid, parentId: null, result: { invoiceId: roshan.id } };
  const label = (l) => `${l.productId ? [oli100, oli1l, addmectin, sulfaprim, adde, amino, hepa].find((p) => p.id === l.productId)?.name + "/" + l.packing : `?${l.name}`}`;

  console.log("The MO in the drop (with the ROSHAN invoice)");
  const scope = await requestScope(batch, [...cocPages, moItem, roshanItem], cid, ex);
  const ids = scope.map((l) => l.productId);
  assert("every MO line is on the request, in its order (6 of 6) — the unmatched 4 matched by name and pack", scope.length === 6 && ids.join() === [addmectin.id, sulfaprim.id, oli100.id, adde.id, amino.id, hepa.id].join(), scope.map(label));
  assert("OLIGOVET in the MO's pack only (100 mL), no 1 L", ids.includes(oli100.id) && !ids.includes(oli1l.id), scope.map(label));
  assert("nothing of the ROSHAN invoice", !scope.some((l) => /ACTILIVER|TOXOVET/.test(l.name || "")), scope.map(label));
  assert("the batch numbers ride along", scope.find((l) => l.productId === oli100.id)?.lotNo === "MADADD02610003");
  const c1 = await shipmentConsignee(batch, [...cocPages, moItem, roshanItem], cid, ex);
  assert("the HC consignee is the MO's customer, split (never ROSHAN)", c1?.customerName === "Madhoob Trading Group" && /Mawaleh South/.test(c1.customerAddress || "") && /Oman/i.test(c1.customerCountry || "") && /968268904412/.test(c1.customerPhone || ""), c1);

  console.log("\nThe MO filed before, not in this drop: found by the batch numbers the certificates print");
  await prisma.harvestedFact.createMany({ data: ["MADADD02610001", "MADADD02610003", "MADADD02610010"].map((b, i) => ({ companyId: cid, entity: "batch", key: "batchNo", value: b, valueNorm: b.toLowerCase(), sourceType: "certificate", certCode: "COA", fileName: "ADDVET OMAN COA 10-26.pdf", page: i + 1, perBatch: true, batchNo: b, extractor: "test", reviewStatus: "confirmed" })) });
  const coaFile = { id: "coa", name: "ADDVET OMAN COA 10-26.pdf", status: "duplicate", companyId: cid, parentId: null, result: { reused: { from: "earlier_filing" }, plan: { productIds: [] } } };
  const scope2 = await requestScope(batch, [...cocPages, coaFile], cid, ex);
  assert("the request = the MO's 6 lines again", scope2.length === 6 && scope2.every((l) => l.productId) && !scope2.some((l) => l.productId === oli1l.id), scope2.map(label));
  const c2 = await shipmentConsignee(batch, [...cocPages, coaFile], cid, ex);
  assert("…and its consignee", c2?.customerName === "Madhoob Trading Group", c2);

  console.log("\nNo shipment document anywhere: each page in the pack it prints");
  await prisma.harvestedFact.deleteMany({ where: { companyId: cid, key: "batchNo" } });
  await prisma.harvestedFact.create({ data: { companyId: cid, entity: "product", key: "packaging", value: "100 mL", valueNorm: "100 ml", sourceType: "certificate", certCode: "COC", fileName: "ADDVET OMAN COC 10-26.pdf", page: 3, extractor: "test", reviewStatus: "confirmed" } });
  const scope3 = await requestScope(batch, cocPages, cid, ex);
  assert("OLIGOVET's page prints 100 mL → OLIGOVET 100 mL, not the 1 L it was linked to", scope3.some((l) => l.productId === oli100.id) && !scope3.some((l) => l.productId === oli1l.id), scope3.map(label));
  assert("…and no consignee is invented", (await shipmentConsignee(batch, cocPages, cid, ex)) === null);
} finally {
  await cleanupCompany(cid);
}
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
await prisma.$disconnect();
process.exit(counts.failed ? 1 : 0);
