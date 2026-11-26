// 26 Nov production test, Phase 2: 5 files dropped in the chat for ADDVET → "5 duplicate files",
// 0 certificates, and every step still showed a green check. The chat attachments are stored in
// the company before they're classified, so the duplicate check matched the drop's own files.
//   • the drop's own files are never its duplicates; a file filed BEFORE the drop still is
//   • with no design file, each issued certificate is also its type's template (and evidence);
//     the types come along (COC = Certificate of Composition)
//   • labels are filed as reference labels, linked to their product
//   • the steps say what really happened: a step that made nothing is red with the reason and
//     a fix ("اعمل قوالب من الملفات دي"), which makes the templates and runs Express again
// The model is a script (no Gemini call). Needs `npm run dev:test` (classify runs in the worker).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { Queue } from "bullmq";
import { prisma } from "../src/lib/prisma.js";
import { getRedisConfig } from "../src/lib/redis.js";
import { makeAssert, api, asAdmin, createCompany, cleanupCompany, pollTask } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import { runAgent } from "../src/services/assistant/agent/agentLoop.js";
import { storeAttachments } from "../src/services/assistant/attachments.js";
import * as fileStore from "../src/services/certificates/storage/fileStore.js";
import { expressSteps, makeTemplatesFromFiles } from "../src/services/intake/expressService.js";
import { newEntities } from "../src/services/intake/intakeResolve.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const admin = { kind: "user", id: "00000000-0000-0000-0000-000000000000", name: "bypass", permissions: null };
const script = (steps) => {
  const seen = [];
  return { seen, generate: async (req) => (seen.push(req), { content: { role: "model", parts: steps[Math.min(seen.length - 1, steps.length - 1)] }, usage: { promptTokenCount: 5, candidatesTokenCount: 1 } }) };
};
async function pdf(title, text) {
  const d = await PDFDocument.create();
  d.setTitle(title);
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([595, 842]).drawText(text, { x: 30, y: 800, size: 8, font: f });
  return Buffer.from(await d.save());
}

async function main() {
  console.log("🧪 Express drop — the drop's own files, honest steps\n");

  console.log("The steps (unit)");
  const certItem = (status, extra = {}) => ({ id: "i", parentId: null, status, classification: { docType: "certificate_filled", certCode: "COA" }, result: {}, ...extra });
  let s = expressSteps({}, [certItem("duplicate"), certItem("duplicate")], { stage: "done", templates: {}, certificates: [], generation: { problemCode: "no_types", problem: "no certificate type COA, COC, HC for this company" } });
  const tpl = s.steps.find((x) => x.key === "templates");
  const certs = s.steps.find((x) => x.key === "certificates");
  assert("the 26 Nov state: filing red (nothing filed, 2 duplicates), templates red, certificates red — no green check", s.steps.every((x) => x.status === "fail" && !x.ok), s.steps);
  assert("…the reason in Arabic, never the raw backend text", /اتعمل 0 شهادات — الشركة مفيهاش أنواع الشهادات المطلوبة/.test(certs.ar) && !/no certificate type/.test(certs.ar), certs);
  assert("…and the fix: «اعمل قوالب من الملفات دي»", tpl.fix === "make_templates" && certs.fix === "make_templates" && certs.fixAr === "اعمل قوالب من الملفات دي", { tpl, certs });
  assert("the summary says it: 0 certificates — why — what to do", s.summary.ok === false && /اتعمل 0 شهادات/.test(s.summary.ar) && /اعمل قوالب من الملفات دي/.test(s.summary.ar), s.summary);
  s = expressSteps({}, [certItem("done", { result: { template: { code: "COA" } } })], { stage: "done", templates: { v1: { code: "COA", status: "active" }, v2: { code: "FSC", status: "needs_table" } }, certificates: [{ status: "draft" }, { status: "draft" }], generation: {} });
  assert("2 drafts, one template used and one needing a person → certificates green, templates amber", s.steps.find((x) => x.key === "certificates").status === "ok" && s.steps.find((x) => x.key === "templates").status === "warn" && s.summary.ok === true, s.steps);
  assert("a bundle (one file, a certificate per product) also brings its type", newEntities([{ action: "bundle_template", certCode: "HC", products: [] }]).certificateTypes.includes("HC"));

  const co = await createCompany("addvet");
  await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
  try {
    const bypassId = (await api("GET", "/auth/me", asAdmin)).data?.data?.user?.id;
    if (bypassId) admin.id = bypassId;
    const filedBefore = await pdf("ADDVET old COA", "CERTIFICATE OF ANALYSIS Product Name: ADD-E120 Batch No.: AVVS1122005 Results");
    await fileStore.putFile({ companyId: co.id, kind: "template_source", buffer: filedBefore, mimeType: "application/pdf", originalName: "ADDVET old COA.pdf" });

    const conv = await assistant.createConversation(admin, { companyId: co.id });
    // the bug: the chat stores the files IN the company before the drop is classified
    const files = await storeAttachments({
      conversationId: conv.id,
      companyId: co.id,
      actor: admin,
      files: [
        { buffer: await pdf("ADDVET OMAN COA", "CERTIFICATE OF ANALYSIS Product Name: ADD-E120 Category Batch No.: AVVS2610001 Results OMAN"), originalname: "ADDVET OMAN COA 10-26.pdf", mimetype: "application/pdf" },
        { buffer: await pdf("ADDVET OMAN COC", "CERTIFICATE OF COMPOSITION Product Name: ADD-E120 Each 1 mL contains Vitamin E 120 mg OMAN"), originalname: "ADDVET OMAN COC 10-26.pdf", mimetype: "application/pdf" },
        { buffer: await pdf("ADDVET HC OMAN", "HEALTH CERTIFICATE Product Name: ADD-E120 Country of destination OMAN"), originalname: "ADDVET HC OMAN 10-26.pdf", mimetype: "application/pdf" },
        { buffer: filedBefore, originalname: "ADDVET old COA again.pdf", mimetype: "application/pdf" },
      ],
    });
    const attRows = await prisma.assistantAttachment.findMany({ where: { id: { in: files.map((f) => f.id) } }, select: { fileId: true } });
    const stored = await prisma.storedFile.count({ where: { id: { in: attRows.map((a) => a.fileId) }, companyId: co.id, kind: "assistant_attachment" } });
    const m = script([[{ functionCall: { name: "start_intake", args: { express: true, certificateTypes: ["COA", "COC", "HC"] } } }], [{ text: "تمام — راجع الكارت ودوس «طلّع الشهادات»." }]]);
    const out = await runAgent({ text: "دي شهادات ADDVET. طلّعلي شهادات COA و COC و HC بسرعة", ctx: { actor: admin, scope: { companyId: co.id }, conversationId: conv.id, attachments: files, audit: async () => {} }, generate: m.generate });
    const block = out.blocks.find((b) => b.type === "intake");
    const batch = await prisma.intakeBatch.findUnique({ where: { id: block?.batchId } });
    assert("an Express drop in ADDVET, the chat's files stored in the company first (the bug's set-up)", batch?.mode === "express" && batch.companyId === co.id && stored >= 3, { mode: batch?.mode, stored });
    const task = await pollTask(batch.classifyTaskId, asAdmin, { timeoutMs: 90000 });
    const view = (await api("GET", `/intake/batches/${batch.id}`, asAdmin)).data?.data;
    const by = Object.fromEntries((view?.items || []).map((i) => [i.name, i]));
    const own = ["ADDVET OMAN COA 10-26.pdf", "ADDVET OMAN COC 10-26.pdf", "ADDVET HC OMAN 10-26.pdf"];
    assert("classified", task?.status === "completed", task);
    assert("none of the drop's own files is a duplicate of itself", own.every((n) => by[n] && by[n].action !== "duplicate"), own.map((n) => `${n}:${by[n]?.action}`));
    assert("…each certificate file becomes its type's template (an issued one also kept as evidence)", own.every((n) => ["certificate_both", "certificate_template"].includes(by[n].action)) && by[own[0]].action === "certificate_both", own.map((n) => `${n}:${by[n]?.action}:${by[n]?.certCode}`));
    assert("…COA, COC and HC come along as the company's types", ["COA", "COC", "HC"].every((c) => view.newEntities.certificateTypes.includes(c)), view.newEntities);
    assert("a file filed BEFORE this drop is still a duplicate", by["ADDVET old COA again.pdf"]?.action === "duplicate", by["ADDVET old COA again.pdf"]?.action);

    console.log("\nLabels → reference labels linked to their product");
    const product = await prisma.product.create({ data: { companyId: co.id, name: "ADDOXY 200-LA" } });
    const { queueReferenceLabel } = await import("../src/services/label/labelUploads.js");
    const label = await pdf("ADDOXY 200-LA", "ADDOXY 200-LA Oxytetracycline 200 mg / mL injectable solution");
    const q = await queueReferenceLabel({ buffer: label, originalName: "27 - ADDOXY 200-LA.pdf", mimeType: "application/pdf", country: "OM", companyId: co.id, productId: product.id });
    const job = await new Queue("referenceLabelQueue", { connection: getRedisConfig() }).getJob(q.taskId);
    assert("the reference-label job carries the product", job?.data?.productId === product.id, job?.data && { productId: job.data.productId });
    const ref = await prisma.referenceLabel.create({ data: { name: "27 - ADDOXY 200-LA", companyId: co.id, sourceSha256: q.sourceSha256 } });
    const again = await queueReferenceLabel({ buffer: label, originalName: "27 - ADDOXY 200-LA.pdf", mimeType: "application/pdf", country: "OM", companyId: co.id, productId: product.id });
    assert("the same label filed again → not a second reference; the existing one is linked to the product", again.skipped && (await prisma.referenceLabel.findUnique({ where: { id: ref.id } })).productId === product.id);

    console.log("\nThe fix: «اعمل قوالب من الملفات دي»");
    // the production state: the certificates were kept as evidence only (no template), 0 certificates
    const coaItem = await prisma.intakeItem.findFirst({ where: { batchId: batch.id, name: own[0] } });
    await prisma.intakeItem.updateMany({ where: { batchId: batch.id, parentId: null }, data: { status: "duplicate" } });
    await prisma.intakeItem.update({ where: { id: coaItem.id }, data: { status: "done", companyId: co.id, result: { plan: { action: "certificate_filled", companyId: co.id, certCode: "COA", productIds: [] } } } });
    await prisma.intakeBatch.update({ where: { id: batch.id }, data: { status: "done", executedAt: new Date(), express: { requestedTypes: ["COA", "COC", "HC"], stage: "done", templates: {}, certificates: [], generation: { problemCode: "no_types", problem: "no certificate type COA, COC, HC for this company" } } } });
    let v = (await api("GET", `/intake/batches/${batch.id}`, asAdmin)).data?.data?.express;
    assert("the card: 0 certificates, red, with the fix offered", v?.summary?.ok === false && v.canMakeTemplates && v.steps.find((x) => x.key === "certificates")?.fix === "make_templates", v);
    const r = await api("POST", `/intake/batches/${batch.id}/express/templates-from-files`, asAdmin);
    const made = r.data?.data?.made || [];
    assert("→ one template per type from the certificate files (COA, COC, HC), the types created", r.status === 202 && ["COA", "COC", "HC"].every((c) => made.some((x) => x.code === c)) && made.length === 3, r.data);
    const types = await prisma.certificateType.findMany({ where: { companyId: co.id }, select: { code: true, name: true } });
    assert("…COC is the Certificate of Composition", types.find((t) => t.code === "COC")?.name === "Certificate of Composition", types);
    const b2 = await prisma.intakeBatch.findUnique({ where: { id: batch.id } });
    assert("…and Express runs again from the templates step", r.data?.data?.restarted === true && b2.express.stage === "templates" && !b2.express.generation);
    const twice = await makeTemplatesFromFiles(batch.id);
    const nTemplates = await prisma.certificateTemplate.count({ where: { companyId: co.id } });
    assert("asking again makes nothing new (each file already a template)", twice.made.length === 0 && nTemplates === 3, { made: twice.made, nTemplates });
    // Phase 6: «الطلبات السريعة» lists the evidence a drop filed, opening its file at its page
    const evItem = await prisma.intakeItem.findFirst({ where: { batchId: batch.id, name: own[0] } });
    await prisma.intakeItem.update({ where: { id: evItem.id }, data: { pageFrom: 2 } });
    await prisma.intakeCreated.create({ data: { batchId: batch.id, itemId: evItem.id, entityType: "evidence", entityId: evItem.id, name: `COA · ${own[0]}`, companyId: co.id } });
    const list = (await api("GET", "/intake/express", asAdmin)).data?.data;
    const evRow = list?.orders?.find((o) => o.batchId === batch.id)?.items.find((i) => i.entityType === "evidence");
    assert("the urgent-orders list shows the evidence, linked to its file at its page", evRow && evRow.link === `/api/v1/evidence-files/${evItem.fileId}#page=2`, evRow);
    const other = await createCompany("addvet-other");
    const foreign = await api("POST", `/intake/batches/${batch.id}/express/templates-from-files`, { ...asAdmin, "x-bypass-type": "company", "x-bypass-id": other.id });
    assert("another account can't run it on this drop (404)", foreign.status === 404, foreign.status);
    await cleanupCompany(other.id).catch(() => {});
  } catch (err) {
    assert(`no crash: ${err.stack}`, false);
  } finally {
    await prisma.intakeBatch.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await prisma.referenceLabel.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await cleanupCompany(co.id).catch(() => {});
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
