// Client report 24 Nov, item 5 ("maxvet label"): MAXVET's FSC / COC / HC / COA
// files were attached as "the brand's certificates" and the assistant asked for
// an invoice number four times.
//   create_certificate_templates: each file → its type (created when missing)
//     → the existing upload + convert → a DRAFT template (or a new draft version
//     of the slot's template). One card for every file.
//   generate_certificate_for_product: a draft for a product with no invoice —
//     the same engine on an internal "direct" record, hidden from invoice lists;
//     batch facts only as the person typed them.
// Needs `npm run dev:test` (cert-renderer + workers).
import fs from "fs";
import path from "path";
import { api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, pollTask, FIXTURES, prisma, confirmStatic } from "./helpers.js";
import * as registry from "../../src/services/assistant/registry/index.js";
import * as actions from "../../src/services/assistant/actions.js";
import * as assistant from "../../src/services/assistant/assistantService.js";
import { storeAttachments } from "../../src/services/assistant/attachments.js";
import { typeCodeFromName } from "../../src/services/certificates/templates/fromFiles.js";
import { SYSTEM_PROMPT } from "../../src/services/assistant/agent/systemPrompt.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const co = await createCompany("f1");
const A = asCompany(co.id);
const actor = { kind: "company", id: co.id, name: co.name, companyId: co.id };
// a write tool's refusal: no card, the reason on the draft (or the call)
const refused = (t, re) => !t.data?.actionId && re.test(t.data?.draft?.error || t.error || "");

/** upload → fields → prepare → activate (as p4.generation does) */
async function activeTemplate(label, { file, typeId, brandId }) {
  const up = await uploadTemplate(co.id, { file, name: label, certificateTypeId: typeId, brandId });
  const v = up.version;
  const fields = golden[file].map((g) => {
    const text = v.lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
  let r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields });
  if (r.status !== 200) throw new Error(`fields ${r.status} ${JSON.stringify(r.data)}`);
  r = await api("POST", `/template-versions/${v.id}/prepare`, A);
  const task = await pollTask(r.data.data.taskId, A, { timeoutMs: 120_000 });
  if (task?.status !== "completed") throw new Error(`prepare ${task?.status} ${task?.error}`);
  await confirmStatic(v.id, A);
  r = await api("POST", `/template-versions/${v.id}/activate`, A);
  if (r.status !== 200) throw new Error(`activate ${r.status} ${JSON.stringify(r.data)}`);
  return { templateId: up.data.data.templateId, versionId: v.id };
}

try {
  console.log("Type from the file name");
  assert("MAXVET FSC.pdf → FSC, MAXVET COC.pdf → COC, HC, COA", typeCodeFromName("MAXVET FSC.pdf") === "FSC" && typeCodeFromName("MAXVET COC.pdf") === "COC" && typeCodeFromName("MAXVET HC.pdf") === "HC" && typeCodeFromName("maxvet coa.PDF") === "COA");
  assert("words work too; a name that says two types or none → null (asked)", typeCodeFromName("Certificate of Analysis - Vitamax.pdf") === "COA" && typeCodeFromName("COA and FSC.pdf") === null && typeCodeFromName("scan 001.pdf") === null);

  await assistant.updateSettings(co.id, { enabled: true });
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "MAXVET" } });
  const coa = await prisma.certificateType.create({ data: { companyId: co.id, code: "COA", name: "Certificate of Analysis" } });
  const conv = await assistant.createConversation(actor, {});
  const ctx = (texts = []) => ({ actor, scope: { companyId: co.id }, conversationId: conv.id, userTexts: texts, propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor, ...p }) });
  const pdf = fs.readFileSync(path.join(FIXTURES, "PHARMAVET_COA.pdf"));
  const [fsc, coaFile, odd] = await storeAttachments({ conversationId: conv.id, companyId: co.id, actor, files: ["MAXVET FSC.pdf", "MAXVET COA.pdf", "scan 001.pdf"].map((n) => ({ buffer: pdf, originalname: n, mimetype: "application/pdf" })) });

  console.log("\ncreate_certificate_templates");
  let t = await registry.runTool("create_certificate_templates", { attachmentIds: [fsc.id, odd.id], brandId: brand.id }, ctx(["دي شهادات maxvet"]));
  assert("a file whose name doesn't say the type → no card, the reason names the file", refused(t, /scan 001\.pdf: the file name doesn't say/), t.data?.draft?.error || t.error);
  t = await registry.runTool("create_certificate_templates", { attachmentIds: [fsc.id, coaFile.id], brandId: brand.id }, ctx(["دي شهادات maxvet"]));
  let card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
  const det = Object.fromEntries((card?.preview?.details || []).map((d) => [d.label, d.value]));
  assert("one card for both files: FSC is a new type, COA uses the company's, both new drafts, for MAXVET", card?.status === "pending" && /FSC \(new certificate type\)/.test(det["MAXVET FSC.pdf"]) && /^COA · new draft template/.test(det["MAXVET COA.pdf"]) && det.Brand === "MAXVET", det);
  assert("nothing made before Run", (await prisma.certificateTemplate.count({ where: { companyId: co.id } })) === 0 && !(await prisma.certificateType.findFirst({ where: { companyId: co.id, code: "FSC" } })));
  let done = await actions.approveAction(actor, card.id);
  const made = done.result?.templates || [];
  assert("Run → two templates, the FSC type created", done.status === "running" || done.status === "done" ? made.length === 2 && made.find((m) => m.type === "FSC")?.typeCreated === true && made.every((m) => /\/certificates\/templates\/.+\/versions\//.test(m.link)) : false, done);
  for (const m of made) await pollTask(m.taskId, A, { timeoutMs: 120_000 });
  const versions = await prisma.templateVersion.findMany({ where: { id: { in: made.map((m) => m.versionId) } }, include: { template: true } });
  assert("…converted into DRAFT versions (fields to mark next), brand MAXVET, not active", versions.length === 2 && versions.every((v) => v.status === "draft" && v.template.brandId === brand.id && !v.template.activeVersionId), versions.map((v) => `${v.status}/${v.template.activeVersionId}`));

  t = await registry.runTool("create_certificate_templates", { attachmentIds: [coaFile.id], brandId: brand.id }, ctx(["update the COA"]));
  card = await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } });
  assert("the same type for the same brand again → a new draft version of that template", /new draft version of "MAXVET COA"/.test(card.preview.details.find((d) => d.label === "MAXVET COA.pdf")?.value || ""), card.preview.details);

  console.log("\ngenerate_certificate_for_product");
  const product = await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: "VITAMAX 1L", productCode: "VMX-1" } });
  t = await registry.runTool("generate_certificate_for_product", { productId: product.id, certificateTypeId: coa.id }, ctx(["generate"]));
  assert("no active COA template yet → no card; says to make one first", refused(t, /no active COA template/), t.data?.draft?.error || t.error);
  await activeTemplate("MAXVET COA live", { file: "PHARMAVET_COA.pdf", typeId: coa.id, brandId: null });
  t = await registry.runTool("generate_certificate_for_product", { productId: product.id, certificateTypeId: coa.id, batchNo: "LOT-9001" }, ctx(["generate"]));
  const dropped = t.data?.draft;
  assert("a batch number the person never typed is dropped, never written (the card leaves it empty and flagged)", (dropped?.rejected || []).some((x) => x.field === "batchNo") && !(dropped?.action?.preview?.fields || []).some((f) => f.name === "batchNo") && (dropped?.action?.preview?.missing || []).some((m) => /batchNo/.test(m)), dropped?.rejected);
  if (dropped?.actionId) await actions.cancelAction(actor, dropped.actionId).catch(() => {});
  t = await registry.runTool("generate_certificate_for_product", { productId: product.id, certificateTypeId: coa.id, coaAttachmentIds: [coaFile.id] }, ctx(["read it from the COA"]));
  assert("a supplier COA without a batch number → asks for it", refused(t, /batch number/), t.data?.draft?.error || t.error);
  t = await registry.runTool("generate_certificate_for_product", { productId: product.id, certificateTypeId: coa.id, batchNo: "LOT-9001", expiryDate: "2028-01" }, ctx(["don't use a number. batch LOT-9001, expiry 2028-01"]));
  card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
  const d2 = Object.fromEntries((card?.preview?.details || []).map((d) => [d.label, d.value]));
  assert("card: product, COA and its template, Invoice: none, the typed facts", card?.status === "pending" && d2.Invoice === "none" && /VITAMAX 1L/.test(d2.Product) && /^COA · template/.test(d2.Certificate) && d2.batchNo === "LOT-9001", d2);
  // 26 Nov (Phase 6): the card in Arabic, the English kept for the switch
  const ar = Object.fromEntries((card?.preview?.details || []).map((d) => [d.label, d.labelAr]));
  assert("the card's Arabic: «شهادة لمنتج (من غير فاتورة)», the run button, field labels", card.preview.titleAr === "شهادة لمنتج (من غير فاتورة)" && card.preview.runLabelAr === "اعمل الشهادة" && card.preview.title && ar.batchNo === "رقم التشغيلة", { titleAr: card.preview.titleAr, ar });
  const invoicesBefore = await prisma.invoice.count({ where: { companyId: co.id } });
  assert("nothing made before Run", invoicesBefore === 0);
  done = await actions.approveAction(actor, card.id);
  if (!done.result?.taskId) console.log("approve failed:", done.error);
  const batchTask = await pollTask(done.result.taskId, A, { timeoutMs: 120_000 });
  const cert = await prisma.certificate.findFirst({ where: { companyId: co.id }, include: { invoice: true, versions: true } });
  assert("Run → a certificate draft through the usual engine (a version with values)", batchTask?.status === "completed" && cert && cert.status !== "final" && cert.versions.length >= 1, { task: batchTask?.status, error: batchTask?.error, cert: cert?.status });
  assert("the result names the certificate and links to IT — not to /certificates?invoiceId= of the hidden record", done.result?.certificates?.length === 1 && done.result.certificates[0].id === cert.id && done.result.link === `/certificates/${cert.id}` && !/invoiceId/.test(done.result.link), done.result);
  assert("…on an internal 'direct' record with the product and the typed batch facts", cert?.invoice.origin === "direct" && cert.invoice.header.invoiceNumber === null && (await prisma.invoiceItem.findFirst({ where: { invoiceId: cert.invoiceId } })).data.batchNo === "LOT-9001");
  let r = await api("GET", "/invoices?limit=100", A);
  assert("that record is not in the invoice list", r.status === 200 && !(r.data.data.invoices || []).some((i) => i.id === cert.invoiceId), r.data?.data?.invoices?.map((i) => i.id));
  t = await registry.runTool("search_invoices", {}, ctx([]));
  assert("…nor in the assistant's invoice search", t.status === "ok" && !t.data.items.some((i) => i.id === cert.invoiceId));
  r = await api("GET", `/certificates/${cert.id}`, A);
  const view = r.data?.data?.certificate || r.data?.data;
  assert("the certificate says it has no invoice, batch from the person", view?.withoutInvoice === true && view.batchNo === "LOT-9001", { withoutInvoice: view?.withoutInvoice, batchNo: view?.batchNo });

  console.log("\nThe prompt");
  assert("certificates don't need an invoice; never ask for an invoice ID; recent invoices as choices", /Certificates do not need an invoice/.test(SYSTEM_PROMPT) && /Never ask for an invoice "ID"/.test(SYSTEM_PROMPT) && /offer those invoices as choices/.test(SYSTEM_PROMPT));
} catch (err) {
  assert(`crashed: ${err.message}`, false, err.stack);
} finally {
  await prisma.assistantConversation.deleteMany({ where: { companyId: co.id } }).catch(() => {});
  await cleanupCompany(co.id).catch((e) => console.error(e.message));
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
