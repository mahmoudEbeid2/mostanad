// Auto-intake ("ارفع ملفاتك"): drop any files → recognised, reviewed on one card,
// filed on "نفّذ الكل". Part 1 needs nothing: the rules against the real test
// folder (fixtures/intake/samples.json — names and text layers of the 33 files,
// scripts/intakeFixtures.js) and its hand-checked table (fixtures/intake/expected.json).
// Part 2 needs `npm run dev:test`: the whole folder dropped (as small PDFs carrying
// each real file's name and text) into an empty company over the real API and worker.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asAdmin, asCompany, createCompany, cleanupCompany, pollTask } from "./certificates-v2/helpers.js";
import { classify, fromFilename, batchFacts, splitBundle, fromText } from "../src/services/intake/intakeRules.js";
import { productsFromRows, readCsv } from "../src/services/intake/productSheet.js";
import { runClassify } from "../src/services/intake/intakeClassify.js";
import { createBatch, storeBuffer } from "../src/services/intake/intakeService.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const samples = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "intake", "samples.json"), "utf8"));
const expected = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "intake", "expected.json"), "utf8")).files;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real file's name and page text as a small PDF (Helvetica: characters it can't draw are dropped). */
async function pdfOf(sample) {
  const doc = await PDFDocument.create();
  doc.setTitle(sample.name); // a .ai and its .pdf say the same text, yet are two files (different bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of sample.pages || [{ text: "" }]) {
    const page = doc.addPage([595, 842]);
    const text = String(p.text || "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ");
    const lines = text.match(/.{1,110}(\s|$)/g) || [];
    lines.slice(0, 70).forEach((l, k) => page.drawText(l.trim(), { x: 30, y: 800 - k * 11, size: 7, font }));
  }
  return Buffer.from(await doc.save());
}

async function waitFor(fn, ms = 120000, step = 700) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(step);
  }
}

async function upload(headers, batchId, name, buffer, { chunk = 256 * 1024 } = {}) {
  const add = await api("POST", `/intake/batches/${batchId}/files`, headers, { name, size: buffer.length });
  if (add.status !== 201) throw new Error(`${name}: ${add.status} ${JSON.stringify(add.data)}`);
  const id = add.data.data.item.id;
  for (let off = 0; off < buffer.length; off += chunk) {
    const res = await fetch(`${process.env.TEST_API_URL || "http://127.0.0.1:3000/api/v1"}/intake/items/${id}/chunk?offset=${off}`, { method: "PUT", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: buffer.subarray(off, off + chunk) });
    if (res.status !== 200) throw new Error(`${name} chunk ${off}: ${res.status} ${await res.text()}`);
  }
  return id;
}

async function main() {
  console.log("🧪 Auto-intake\n\nPart 1 — the rules on the real folder (no AI)");
  const rows = [];
  let right = 0;
  for (const s of samples) {
    const c = classify({ name: s.name, pages: s.pages || [], pageCount: s.pageCount });
    const e = expected[s.name];
    const got = { docType: c.docType, certCode: c.certCode || null, product: c.docType === "label" ? c.productNames[0] : null, volume: c.docType === "label" ? c.volume : null, parts: c.parts?.length || 0, design: c.role === "design_source" };
    const ok = e && Object.keys(e).every((k) => e[k] === got[k]);
    if (ok) right++;
    rows.push({ file: s.name, ...got, confidence: c.confidence, ok });
  }
  console.table(rows.map((r) => ({ file: r.file.slice(0, 36), type: r.docType, cert: r.certCode || "", product: r.product || "", conf: r.confidence, parts: r.parts || "", ok: r.ok ? "✓" : "✗" })));
  assert(`every file of the folder classified as the checked table says (${right}/${samples.length}), no AI`, right === samples.length, rows.filter((r) => !r.ok));

  const f1 = fromFilename("40 - ADDMECTIN 1% _100ML.pdf");
  assert("filename: numbering, pack size and noise go, the product stays", f1.productName === "ADDMECTIN 1%" && f1.volume === "100ML");
  assert("filename: certificate code, country, document number", fromFilename("ADDVET OMAN COA 10-26.pdf").certCode === "COA" && fromFilename("ADDVET OMAN COA 10-26.pdf").country === "OM" && fromFilename("FSCAVIV22-066.pdf").certCode === "FSC" && fromFilename("BRN2025002 - ROSHAN.pdf").documentNo === "BRN2025002" && fromFilename("x KSA.pdf").country === "SA");
  assert("filename: '14 H-RESPI 1L new' → H-RESPI, 1L", fromFilename("14 H-RESPI 1L new.pdf").productName === "H-RESPI" && fromFilename("14 H-RESPI 1L new.pdf").volume === "1L");
  assert("text: titles decide (invoice, manufacturing order, catalogue, certificates)", fromText([{ n: 1, text: "INVOICE Invoice #: BRN2025002" }]).docType === "invoice" && fromText([{ n: 1, text: "MANUFACTURING ORDER" }]).docType === "manufacturing_order" && fromText([{ n: 1, text: "HEALTH CERTIFICATE CERTIFICATE NO: PL1 DATE OF CERTIFICATE: 23/09/2026" }]).certCode === "HC");
  assert("batch facts: read only when printed next to their label (never inferred)", batchFacts("Batch No.: MADADD02610001 | Prod. Date: 10/2026 | Exp. Date: 10/2029", 1).batchNo === "MADADD02610001" && batchFacts("Batch No.: Pro. Date : Exp. Date : MADADD02610001 1 0 / 2 0 2 6", 1) === null && batchFacts("BATCH NO. NOTES ADDMECTIN", 1) === null);
  assert("a bundle of certificates splits per page; a certificate with an attached list doesn't", splitBundle([{ n: 1, text: "CERTIFICATE OF ANALYSIS Product Name: ALPHA 1 Category" }, { n: 2, text: "CERTIFICATE OF ANALYSIS Product Name: BETA 2 Category" }], "COA")?.length === 2 && splitBundle([{ n: 1, text: "HEALTH CERTIFICATE" }, { n: 2, text: "ATTACHED LIST" }], "HC") === null);
  assert("a design (.ai) certificate is the template; the issued PDF is filled", classify({ name: "X COA.ai", pages: [{ n: 1, text: "CERTIFICATE OF ANALYSIS Batch No.: B12345" }] }).docType === "certificate_template" && classify({ name: "X COA.pdf", pages: [{ n: 1, text: "CERTIFICATE OF ANALYSIS Batch No.: B12345" }] }).docType === "certificate_filled");
  const sheet = productsFromRows(readCsv("Product Name,Code,Pack Size,Color\nAMINOVITA,AV-1,1L,red\n\"H-DURIN, herbal\",HD-1,1L,\n"));
  assert("product list: columns by header (English / Arabic), quoted cells, unknown columns listed", sheet.products.length === 2 && sheet.products[1].name === "H-DURIN, herbal" && sheet.products[0].packaging === "1L" && sheet.unknownColumns.includes("Color"));
  assert("a scan with no text → asked (or the AI), never guessed", classify({ name: "scan001.pdf", pages: [{ n: 1, text: "" }] }).question === "doc_type");

  console.log("\nPart 2 — the whole folder into an empty company (real API, worker; AI off)");
  const co = await createCompany("intake");
  const other = await createCompany("intakeB");
  try {
    let r = await api("POST", "/intake/batches", asAdmin, { companyId: co.id });
    const batchId = r.data?.data?.batch?.id;
    assert("a drop is created with the optional company hint", r.status === 201 && !!batchId && r.data.data.chunkBytes > 0, r.data);
    const files = {};
    for (const s of samples) files[s.name] = await pdfOf(s);
    // the four catalogues come as one .zip (a folder the person zipped)
    const zip = new JSZip();
    for (const n of Object.keys(files).filter((n) => /catalogue/i.test(n))) zip.file(`catalogues/${n}`, files[n]);
    zip.file("__MACOSX/._junk", "x");
    const zipped = await zip.generateAsync({ type: "nodebuffer" });
    for (const [n, b] of Object.entries(files)) if (!/catalogue/i.test(n)) await upload(asAdmin, batchId, n, b);
    // chunked + resumed: a chunk past what the server has is refused with where to resume
    const add = await api("POST", `/intake/batches/${batchId}/files`, asAdmin, { name: "catalogues.zip", size: zipped.length });
    const zipId = add.data.data.item.id;
    const put = (off, body) => fetch(`${process.env.TEST_API_URL || "http://127.0.0.1:3000/api/v1"}/intake/items/${zipId}/chunk?offset=${off}`, { method: "PUT", headers: { ...asAdmin, "Content-Type": "application/octet-stream" }, body });
    let res = await put(0, zipped.subarray(0, 3000));
    res = await put(9000, zipped.subarray(9000, 12000));
    const resume = await res.json();
    assert("chunked upload: a gap → 409 with the bytes the server has (resume from there)", res.status === 409 && resume.receivedBytes === 3000, resume);
    res = await put(1000, zipped.subarray(1000, 6000)); // overlaps what it has: only the new tail counts
    assert("…a resent overlapping chunk only adds its new bytes", (await res.json()).data?.receivedBytes === 6000);
    for (let off = 6000; off < zipped.length; off += 4000) await put(off, zipped.subarray(off, off + 4000));
    r = await api("POST", `/intake/batches/${batchId}/files`, asAdmin, { name: "virus.exe", size: 10 });
    assert("a kind of file intake can't file → refused", r.status === 400, r.data);

    r = await api("POST", `/intake/batches/${batchId}/classify`, asAdmin);
    assert("classify → 202, a background task", r.status === 202 && r.data.data.taskId, r.data);
    const task = await pollTask(r.data.data.taskId, asAdmin, { timeoutMs: 180000 });
    assert("…the task completes", task?.status === "completed", task);
    r = await api("GET", `/intake/batches/${batchId}`, asAdmin);
    const view = r.data?.data;
    const items = view?.items || [];
    const byName = (n) => items.find((i) => i.name === n);
    assert("the drop is ready for review", view?.batch?.status === "review", view?.batch);
    const wrong = Object.entries(expected).filter(([n, e]) => (byName(n)?.docType || null) !== e.docType);
    assert(`every file (zip unpacked) is on the card with its type (${Object.keys(expected).length - wrong.length}/${Object.keys(expected).length})`, wrong.length === 0, wrong.map(([n, e]) => `${n}: ${byName(n)?.docType} ≠ ${e.docType}`));
    assert("the .zip was unpacked (its __MACOSX junk ignored)", items.find((i) => i.name === "catalogues.zip")?.actionText?.en?.startsWith("Unpacked (4 files)"), items.find((i) => i.name === "catalogues.zip"));
    assert("labels: the company from the other files (the hint), brand ADDVET proposed new", byName("12 H-DURIN 1L.pdf")?.company?.id === co.id && byName("12 H-DURIN 1L.pdf").brand?.name === "ADDVET" && byName("12 H-DURIN 1L.pdf").brand.isNew === true);
    assert("…the label's product proposed new with its pack size; its .ai is the same label's design file", byName("12 H-DURIN 1L.pdf").products[0]?.name === "H-DURIN" && byName("12 H-DURIN 1L.pdf").products[0].volume === "1L" && byName("12 H-DURIN 1L.ai").action === "label_design");
    assert("certificates: the .ai designs become templates, the COA PDF splits into 10 evidence rows", byName("ADDVET OMAN COA 10-26.ai").action === "certificate_template" && byName("ADDVET OMAN COA 10-26.pdf").action === "bundle" && items.filter((i) => i.parentId === byName("ADDVET OMAN COA 10-26.pdf").id).length === 10);
    const coaPart = items.find((i) => i.parentId === byName("ADDVET OMAN COA 10-26.pdf").id && i.products[0]?.name === "SULFAPRIM");
    assert("…the COA's 'SULFARIM' is the label's SULFAPRIM; its batch is read with its page", !!coaPart && coaPart.batches[0]?.batchNo === "MADADD02610002" && coaPart.batches[0].page === 2, coaPart);
    const cocTwice = items.filter((i) => i.parentId === byName("ADDVET OMAN COC 10-26.pdf").id && i.question === "product");
    // two COC pages print ADD-E120: page 5 is confirmed by the COA's page 5 (settled); page 6 is the
    // document's copy-paste — ONE question, the COA's page 6 suggested, nothing applied (Phase 7)
    assert("…of the two COC pages printing the same name, the one the COA doesn't confirm is a question with a suggestion, not fixed", cocTwice.length === 1 && cocTwice[0].pages === "6" && cocTwice[0].suggested?.name === "AMINOVITA" && cocTwice[0].products[0]?.name === "ADD-E120", cocTwice.map((i) => `${i.name} p.${i.pages} → ${i.suggested?.name}`));
    assert("invoice and manufacturing order: read like an invoice; they don't take the drop's country", byName("BRN2025002 - ROSHAN.pdf").action === "invoice" && byName("MADADD2610001.pdf").action === "manufacturing_order" && !byName("BRN2025002 - ROSHAN.pdf").country);
    assert("new at the top: brand ADDVET, the 10 products, 4 certificate types; no company (the hint is one)", view.newEntities.companies.length === 0 && view.newEntities.brands.map((b) => b.name).join() === "ADDVET" && view.newEntities.products.length === 10 && view.newEntities.certificateTypes.sort().join() === "COA,COC,FSC,HC", view.newEntities);
    const nothing = await Promise.all([prisma.brand.count({ where: { companyId: co.id } }), prisma.product.count({ where: { companyId: co.id } }), prisma.certificateTemplate.count({ where: { companyId: co.id } }), prisma.invoice.count({ where: { companyId: co.id } }), prisma.catalogue.count({ where: { companyId: co.id } }), prisma.backgroundTask.count({ where: { companyId: co.id, type: "reference_label_extraction" } })]);
    assert("NOTHING is created before the button (brands, products, templates, invoices, catalogues, labels)", nothing.every((n) => n === 0), nothing);
    assert("no AI call for any of these files", view.batch.aiCalls === 0 && items.every((i) => i.aiCalls === 0));

    // one change on the card: the FSC only kept, not also a template
    const fsc = byName("FSCAVIV22-066.pdf");
    r = await api("PATCH", `/intake/items/${fsc.id}`, asAdmin, { action: "issued_document" });
    assert("a dropdown change → the row's action and a new revision", r.status === 200 && r.data.data.item.action === "issued_document" && r.data.data.item.revision === fsc.revision + 1, r.data);
    const revisions = Object.fromEntries(items.map((i) => [i.id, i.revision]));
    r = await api("POST", `/intake/batches/${batchId}/execute`, asAdmin, { revisions });
    assert("execute with the card from before that change → 409, out of date (only this card's items)", r.status === 409 && r.data.code === "STALE_CARD" && r.data.itemIds.join() === fsc.id, r.data);
    revisions[fsc.id] = fsc.revision + 1;
    r = await api("POST", `/intake/batches/${batchId}/execute`, asAdmin, { revisions });
    assert("\"نفّذ الكل\" → 202 and the new brand / products made at once", r.status === 202 && r.data.data.created.brands.length === 1 && r.data.data.created.products.length === 10, r.data);
    const done = await pollTask(r.data.data.taskId, asAdmin, { timeoutMs: 240000 });
    assert("…the filing job completes", done?.status === "completed", done);
    r = await api("GET", `/intake/batches/${batchId}`, asAdmin);
    const after = r.data.data;
    console.log("\n   summary:", after.summary?.text?.ar, "\n  ", after.summary?.text?.en, "\n");
    assert("summary: brand 1, products 10, 3 templates (COA, COC, HC), 10 labels, invoice + order, 4 catalogues", after.summary?.created?.brands === 1 && after.summary.created.products === 10 && after.summary.done.templates === 3 && after.summary.done.labels === 10 && after.summary.done.invoices === 2 && after.summary.done.catalogues === 4, after.summary);
    assert("…the certificates kept as evidence (10 COA + 10 COC pages, HC, FSC), and what needs a person listed", after.summary.done.evidence === 22 && after.summary.needs.some((n) => n.kind === "template_fields") && /اتعمل/.test(after.summary.text.ar), after.summary.done);
    const db = await Promise.all([prisma.brand.count({ where: { companyId: co.id } }), prisma.product.count({ where: { companyId: co.id } }), prisma.certificateType.count({ where: { companyId: co.id } }), prisma.certificateTemplate.count({ where: { companyId: co.id } }), prisma.invoice.count({ where: { companyId: co.id } }), prisma.catalogueVersion.count({ where: { companyId: co.id } }), prisma.backgroundTask.count({ where: { companyId: co.id, type: "reference_label_extraction" } }), prisma.intakeCreated.count({ where: { batchId } })]);
    assert("in the database: 1 brand, 10 products, 3 types, 3 templates, 2 invoices, 4 catalogue versions, 10 reference-label tasks, 14 rows marked as made by intake (brand, products, types)", db.join() === "1,10,3,3,2,4,10,14", db);
    const product = await prisma.product.findFirst({ where: { companyId: co.id, name: "H-DURIN" } });
    assert("a made product carries its source file", product?.packaging === "1L" && product.fieldProvenance?.name?.source === "intake" && /H-DURIN/.test(product.fieldProvenance.name.file), product?.fieldProvenance);
    const evidence = (await prisma.intakeItem.findMany({ where: { batchId, parentId: byName("ADDVET OMAN COA 10-26.pdf").id } })).find((i) => i.result?.evidence?.batches?.[0]?.batchNo === "MADADD02610002");
    assert("evidence keeps the batch with its source file and page", evidence?.result.evidence.batches[0].source.file === "ADDVET OMAN COA 10-26.pdf" && evidence.result.evidence.batches[0].source.page === 2 && evidence.result.waiting?.includes("MADADD02610002"), evidence?.result?.evidence);
    const tpl = await waitFor(async () => {
      const its = await prisma.intakeItem.findMany({ where: { batchId, result: { path: ["template", "code"], not: null } } });
      return its.length === 3 && its.every((i) => i.result.template.fields && i.result.template.fields !== "pending") ? its : null;
    }, 120000, 1500);
    assert("templates converted, then their fields: suggested — or by hand when AI is off (never confirmed by intake)", tpl?.every((i) => i.result.template.fields.byHand || i.result.template.fields.suggested >= 0), tpl?.map((i) => i.result.template));

    console.log("\nDuplicates, tenancy");
    r = await api("POST", "/intake/batches", asAdmin, { companyId: co.id });
    const b2 = r.data.data.batch.id;
    await upload(asAdmin, b2, "again.pdf", files["BRN2025002 - ROSHAN.pdf"]);
    const fresh = await pdfOf({ ...samples.find((x) => x.name === "12 H-DURIN 1L.pdf"), name: "12 H-DURIN 1L v2.pdf" }); // a new version of the label: not filed before
    await upload(asAdmin, b2, "same twice.pdf", fresh);
    await upload(asAdmin, b2, "same twice copy.pdf", fresh);
    r = await api("POST", `/intake/batches/${b2}/classify`, asAdmin);
    await pollTask(r.data.data.taskId, asAdmin, { timeoutMs: 60000 });
    let v2 = (await api("GET", `/intake/batches/${b2}`, asAdmin)).data.data.items;
    assert("the same file already filed in this company → duplicate (by content, not by name)", v2.find((i) => i.name === "again.pdf")?.action === "duplicate", v2.map((i) => `${i.name}:${i.action}`));
    assert("the same file twice in one drop → the second is a duplicate", v2.filter((i) => i.name.startsWith("same twice")).map((i) => i.action).sort().join() === "duplicate,label");
    r = await api("POST", "/intake/batches", asAdmin, { companyId: other.id });
    const b3 = r.data.data.batch.id;
    await upload(asAdmin, b3, "again.pdf", files["BRN2025002 - ROSHAN.pdf"]);
    r = await api("POST", `/intake/batches/${b3}/classify`, asAdmin);
    await pollTask(r.data.data.taskId, asAdmin, { timeoutMs: 60000 });
    const v3 = (await api("GET", `/intake/batches/${b3}`, asAdmin)).data.data.items;
    assert("…but in another company the same file is not a duplicate", v3[0]?.action === "invoice", v3[0]);
    r = await api("GET", `/intake/batches/${batchId}`, asCompany(other.id));
    assert("another account's drop → 404", r.status === 404);
    r = await api("POST", "/intake/batches", asCompany(other.id), { companyId: co.id });
    assert("a company session's drop is always its own company (a companyId sent is ignored)", r.data.data.batch.companyId === other.id, r.data);
    const own = r.data.data.batch.id;
    await upload(asCompany(other.id), own, "12 H-DURIN 1L.pdf", files["12 H-DURIN 1L.pdf"]);
    r = await api("POST", `/intake/batches/${own}/classify`, asCompany(other.id));
    await pollTask(r.data.data.taskId, asCompany(other.id), { timeoutMs: 60000 });
    const ownItem = (await api("GET", `/intake/batches/${own}`, asCompany(other.id))).data.data.items[0];
    assert("…its file proposes its own company", ownItem.company?.id === other.id, ownItem.company);
    r = await api("PATCH", `/intake/items/${ownItem.id}`, asCompany(other.id), { company: { name: "Someone Else" } });
    assert("…and it can't move a file to another or a new company", r.status === 403, r.status);

    console.log("\nThe AI step (mocked) — only when the rules don't decide");
    const actor = { kind: "user", id: "00000000-0000-4000-8000-000000000125" };
    const bAi = await createBatch(actor, { companyId: co.id });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const scan = await prisma.intakeItem.create({ data: { batchId: bAi.id, name: "photo 001.png", sizeBytes: png.length } });
    await storeBuffer(scan, png);
    const asked = [];
    const mock = async ({ item }) => (asked.push(item.name), { docType: "label", certCode: null, filled: false, companyName: "ADDVET", brandName: null, productNames: ["AMINOVITA"], country: null, confidence: 0.95, reason: "a label: composition and indications" });
    const ran = await runClassify(bAi.id, {}, { ai: mock });
    const got = await prisma.intakeItem.findUnique({ where: { id: scan.id } });
    assert("a photo with no text → one AI call, its answer used (capped below certain, shown to check)", ran.aiCalls === 1 && asked.join() === "photo 001.png" && got.classification.docType === "label" && got.classification.confidence === 0.85 && got.aiCalls === 1, got.classification);
    await prisma.intakeBatch.deleteMany({ where: { ownerId: actor.id } });
  } finally {
    await prisma.intakeBatch.deleteMany({ where: { OR: [{ companyId: { in: [co.id, other.id] } }, { ownerId: other.id }] } }).catch(() => {});
    await prisma.intakeCreated.deleteMany({ where: { companyId: { in: [co.id, other.id] } } }).catch(() => {});
    await cleanupCompany(co.id).catch((e) => console.error(e.message));
    await cleanupCompany(other.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
