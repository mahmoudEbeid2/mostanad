// 28 Nov add-on, the AI read of a drop (Gemini stubbed — no paid call, no network):
//   model      GEMINI_HARVEST_MODEL only, never flash / lite; no fallback to a smaller model; high resolution
//   one call   every file of the drop in one extraction call, then one verification call
//   failure    a file the model can't read is reported; the others are read
//   checks     a number not in its own quote, or a value the checker disputes → "needs review", never filled
//   facts      once the drop is filed: the certificate fills, the label's other validity is a conflict,
//              a document's number becomes only its numbering pattern; applying twice changes nothing
// DB part only (no API needed).
import { PDFDocument } from "pdf-lib";
import { makeAssert, createCompany, cleanupCompany, prisma, finish } from "./helpers.js";
import geminiClient from "../../src/services/ai/geminiClient.js";
import { harvestModel } from "../../src/services/ai/modelRegistry.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";

delete process.env.GEMINI_DISABLED;
process.env.GEMINI_HARVEST_MODEL = "gemini-3.1-pro-preview";
const { aiHarvestAvailable, runDropHarvest, applyDropHarvest, exactCheck, groupsOf, harvestStoredAi } = await import("../../src/services/harvest/harvestAi.js");
const { assert, counts } = makeAssert();

console.log("The harvest model");
for (const [v, ok] of [["gemini-3.1-pro-preview", true], ["gemini-3.8-flash", false], ["gemini-3.1-flash-lite", false], ["", false]]) {
  process.env.GEMINI_HARVEST_MODEL = v;
  assert(`  ${v || "(unset)"} → ${ok ? "used" : "refused (rules reader)"}`, !!harvestModel().id === ok, harvestModel());
}
process.env.GEMINI_HARVEST_MODEL = "gemini-3.1-pro-preview";
assert("  GEMINI_DISABLED → off", (() => { process.env.GEMINI_DISABLED = "true"; const r = aiHarvestAvailable().on; delete process.env.GEMINI_DISABLED; return r === false; })());
assert("exact copy: a batch number not in its quote is doubted; one that is, isn't", exactCheck({ field: "batchNo", value: "ABC123", snippet: "Batch No.: ABC124" }) && !exactCheck({ field: "batchNo", value: "ABC123", snippet: "Batch No.:  ABC123" }));
assert("exact copy: an ingredient's amount too", exactCheck({ field: "ingredient", value: "Ivermectin", amount: "10 mg", snippet: "Ivermectin 1 mg" }) && !exactCheck({ field: "ingredient", value: "Ivermectin", amount: "10 mg", snippet: "Ivermectin 10 mg" }));
assert("grouping: files kept together, ≤ 400 pages a call", groupsOf([{ pages: 300 }, { pages: 150 }, { pages: 10 }]).map((g) => g.length).join(",") === "1,2");

// ── the stub: what Gemini would answer ──────────────────────────────────────────────────────
const calls = [];
const orig = { gen: geminiClient.generateContentWithRetry, up: geminiClient.uploadFile, get: geminiClient.getFile };
let uploads = 0;
geminiClient.uploadFile = async (_p, { mimeType }) => ({ name: `files/f${++uploads}`, uri: `https://gemini/files/f${uploads}`, mimeType });
geminiClient.getFile = async (name) => ({ name, uri: `https://gemini/${name}`, mimeType: "application/pdf", state: "ACTIVE", expirationTime: new Date(Date.now() + 48 * 3600e3).toISOString() });
const reply = (obj) => ({ text: JSON.stringify(obj), candidates: [{ finishReason: "STOP" }] });
geminiClient.generateContentWithRetry = async (req) => {
  const texts = req.contents[0].parts.map((p) => p.text || "").join("\n");
  const labels = [...texts.matchAll(/=== File (F\d+)/g)].map((m) => m[1]);
  calls.push({ model: req.model, config: req.config, labels, kind: /Check EACH one/.test(texts) ? "verify" : "extract" });
  if (labels.includes("F3")) throw Object.assign(new Error("400 the document has no pages"), { status: 400 });
  if (/Check EACH one/.test(texts)) {
    const list = JSON.parse(texts.slice(texts.indexOf("Values:\n") + 8, texts.indexOf("\n=== File")));
    return reply({ checks: list.map((v) => (v.field === "physicalForm" ? { i: v.i, verdict: "mismatch", printed: "Solution" } : { i: v.i, verdict: "match" })) });
  }
  const values = [];
  if (labels.includes("F1"))
    values.push(
      { entity: "product", field: "validity", value: "36 months", product: "ADDMECTIN 1%", file: "F1", page: 1, snippet: "Validity: 36 months" },
      { entity: "product", field: "ingredient", value: "Ivermectin", amount: "10 mg", row: 1, product: "ADDMECTIN 1%", file: "F1", page: 1, snippet: "Ivermectin 10 mg" },
      { entity: "batch", field: "batchNo", value: "ABC123", product: "ADDMECTIN 1%", file: "F1", page: 1, snippet: "Batch No.: ABC124" },
      { entity: "document", field: "documentNumber", value: "COCAF26009006", file: "F1", page: 1, snippet: "Document #: COCAF26009006" },
      { entity: "document", field: "issueDate", value: "23/09/2026", file: "F1", page: 1, snippet: "Issue Date: 23/09/2026" },
    );
  if (labels.includes("F2"))
    values.push(
      { entity: "product", field: "validity", value: "24 months", file: "F2", page: 1, snippet: "Shelf life 24 months" },
      { entity: "product", field: "physicalForm", value: "Liquid", file: "F2", page: 1, snippet: "Solution for injection" },
    );
  return reply({ files: labels.map((l) => ({ file: l, docType: l === "F1" ? "certificate_coc" : "label", company: "ADDVET" })), values });
};

const pdf = async (text) => {
  const d = await PDFDocument.create();
  d.addPage([200, 200]).drawText(text, { x: 10, y: 100, size: 8 });
  return Buffer.from(await d.save());
};

console.log("A drop of 3 files (a COC, a label, one the model fails on)");
const co = await createCompany("h2");
try {
  const product = await prisma.product.create({ data: { companyId: co.id, name: "ADDMECTIN 1%" } });
  const batch = await prisma.intakeBatch.create({ data: { ownerType: "company", ownerId: co.id, companyId: co.id, status: "done" } });
  const items = [];
  for (const [name, text, plan] of [["ADDVET COC.pdf", "COC", { companyId: co.id }], ["ADDMECTIN label.pdf", "LABEL", { companyId: co.id, productIds: [product.id] }], ["broken.pdf", "BROKEN", { companyId: co.id }]]) {
    const f = await fileStore.putFile({ companyId: co.id, kind: "intake_file", buffer: await pdf(text), mimeType: "application/pdf", originalName: name });
    items.push(await prisma.intakeItem.create({ data: { batchId: batch.id, name, sizeBytes: 100, receivedBytes: 100, fileId: f.id, status: "done", companyId: co.id, result: { plan } } }));
  }
  const out = await runDropHarvest(batch.id);
  const ext = calls.filter((c) => c.kind === "extract");
  assert("  the first extraction call carries all 3 files", ext[0]?.labels.join(",") === "F1,F2,F3", ext.map((c) => c.labels));
  assert("  every call on the env model, no fallback, high resolution, its own long timeout", calls.every((c) => c.model === "gemini-3.1-pro-preview" && c.config.allowFallback === false && c.config.mediaResolution === "MEDIA_RESOLUTION_HIGH" && c.config.timeoutMs >= 600000), calls.map((c) => [c.model, c.config.allowFallback]));
  assert("  each file uploaded once (cached by content)", uploads === 3, uploads);
  const h = (await prisma.intakeBatch.findUnique({ where: { id: batch.id } })).harvest;
  const st = Object.fromEntries(h.files.map((f) => [f.name, f.status]));
  assert("  the broken file is reported; the other two are read", st["broken.pdf"] === "failed" && st["ADDVET COC.pdf"] === "read" && st["ADDMECTIN label.pdf"] === "read", h.files);
  const doubt = h.values.filter((v) => v.reviewStatus === "needs_review").map((v) => v.field).sort();
  assert("  doubted: the batch number (not in its quote) and the form (checker read «Solution»)", doubt.join(",") === "batchNo,physicalForm" && h.values.find((v) => v.field === "physicalForm").verifyNote.includes("Solution"), h.values.map((v) => [v.field, v.reviewStatus, v.verifyNote]));
  assert("  the drop says it's done, with its counts", out.status === "done" && h.status === "done" && h.review === 2);

  const facts = await prisma.harvestedFact.findMany({ where: { companyId: co.id } });
  assert("  facts written (the drop was filed): all by the AI reader", facts.length > 0 && facts.every((f) => f.extractor === "ai" && f.modelId === "gemini-3.1-pro-preview"), facts.map((f) => f.extractor));
  assert("  the document's number is kept only as its pattern", !facts.some((f) => /COCAF26009006/.test(JSON.stringify(f.value))) && facts.some((f) => f.key === "numbering" && f.value.pattern === "COCAF{YY}0{MM}{SEQ3}"), facts.filter((f) => f.entity === "document").map((f) => f.value));
  const p = await prisma.product.findUnique({ where: { id: product.id } });
  assert("  the certificate's validity fills; the label's is a conflict with both", p.validity === "36 months" && (p.harvestConflicts || []).some((c) => c.key === "validity" && c.values.length === 2), [p.validity, p.harvestConflicts]);
  assert("  the composition fills from the certificate", p.activeIngredients?.[0]?.name === "Ivermectin" && p.activeIngredients[0].concentration === "10 mg", p.activeIngredients);
  assert("  a doubted value never fills (form stays empty)", !p.physicalForm, p.physicalForm);
  const co2 = await prisma.company.findUnique({ where: { id: co.id } });
  assert("  the company's numbering is learnt", co2.profile?.numbering?.COC?.pattern === "COCAF{YY}0{MM}{SEQ3}", co2.profile);
  const n = facts.length;
  await applyDropHarvest(batch.id);
  assert("  applying again changes nothing", (await prisma.harvestedFact.count({ where: { companyId: co.id } })) === n);

  console.log("Re-harvest of stored files");
  calls.length = 0;
  const r = await harvestStoredAi(co.id, items.map((i) => ({ id: i.fileId, name: i.name })));
  assert("  files the AI already read are skipped (no new call for them)", r.skipped === 2 && calls.every((c) => !c.labels.length || c.labels.length === 1), r);
} finally {
  Object.assign(geminiClient, { generateContentWithRetry: orig.gen, uploadFile: orig.up, getFile: orig.get });
  await finish(counts, async () => {
    await prisma.harvestedFact.deleteMany({ where: { companyId: co.id } });
    await prisma.intakeBatch.deleteMany({ where: { ownerId: co.id } });
    await prisma.geminiFile.deleteMany({ where: { uri: { startsWith: "https://gemini/" } } }); // the stub's uploads
    await cleanupCompany(co.id);
  });
}
