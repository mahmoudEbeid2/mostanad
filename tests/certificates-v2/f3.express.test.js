// Path 2 — "Express" (client, 25 Nov: "send the chatbot the certificates and the products and
// it produces the certificates, without registering everything first"). The intake files the
// drop; then the Express job (expressService.runExpress):
//   - a certificate design with its suggested (UNCONFIRMED) fields is prepared and used as is —
//     its fields stay unconfirmed, nothing is remembered as the company's mapping;
//   - a design listing several products in one table (an FSC) is NOT used (its rows would be
//     printed as they are) — listed for a person;
//   - one run makes a DRAFT per product, batch facts blank and marked (none were given), then
//     the ZIP and one combined PDF;
//   - everything made is listed "Express — needs review" until marked checked; tenant-scoped.
// And the chat's new registration cards: create_company (system users only), create_products,
// create_certificate_type, generate_certificates_for_products (batch facts only as typed),
// add_regulatory_rules (read, never approved in the chat), start_intake express.
// The AI is off here (GEMINI_DISABLED): the suggested fields are set up as the intake's
// follow-up would leave them. Needs `npm run dev:test` (cert-renderer + workers).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PDFDocument } from "pdf-lib";
import { api, asCompany, makeAssert, createCompany, cleanupCompany, uploadTemplate, FIXTURES, prisma } from "./helpers.js";
import { runExpress } from "../../src/services/intake/expressService.js";
import * as registry from "../../src/services/assistant/registry/index.js";
import * as actions from "../../src/services/assistant/actions.js";
import * as assistant from "../../src/services/assistant/assistantService.js";
import { storeAttachments } from "../../src/services/assistant/attachments.js";
import { SYSTEM_PROMPT } from "../../src/services/assistant/agent/systemPrompt.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
const co = await createCompany("f3");
const other = await createCompany("f3b");
const A = asCompany(co.id);
const B = asCompany(other.id);
const companyActor = { kind: "company", id: co.id, name: co.name, companyId: co.id };
const admin = { kind: "user", id: crypto.randomUUID(), name: "express admin", permissions: null };
const made = { companies: [] };

/** A converted draft with the fields the intake's AI follow-up would leave: suggested, NOT confirmed. */
async function draftWithSuggestedFields(name, typeId, brandId) {
  const up = await uploadTemplate(co.id, { file: "PHARMAVET_COA.pdf", name, certificateTypeId: typeId, brandId });
  const v = up.version;
  const fields = golden["PHARMAVET_COA.pdf"].map((g) => {
    const text = v.lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    const { occurrence, ...rest } = g;
    return { ...rest, charStart: start, charEnd: start + g.sampleValue.length, required: true };
  });
  // the product name, as the AI suggests it on a real drop
  const pl = v.lines.find((l) => l.text.includes("DOXYPHARMA"));
  fields.push({ key: "product_name", label: "Product name", lineId: pl.id, charStart: pl.text.indexOf("DOXYPHARMA"), charEnd: pl.text.indexOf("DOXYPHARMA") + 10, sampleValue: "DOXYPHARMA", source: { kind: "product", path: "name" }, required: true });
  const r = await api("PUT", `/template-versions/${v.id}/fields`, A, { fields });
  if (r.status !== 200) throw new Error(`fields ${r.status} ${JSON.stringify(r.data)}`);
  await prisma.templateField.updateMany({ where: { versionId: v.id }, data: { confirmed: false, origin: "ai_suggested" } });
  return { templateId: up.data.data.templateId, versionId: v.id };
}

/** runExpress until it finishes (it throws "not ready" while something is being made; BullMQ would retry). */
async function drive(batchId, ms = 240_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      return await runExpress({ batchId });
    } catch (err) {
      if (!err.retry) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const b = await prisma.intakeBatch.findUnique({ where: { id: batchId }, select: { express: true } });
  throw new Error(`express didn't finish in time: ${JSON.stringify(b?.express)}`);
}

try {
  const brand = await prisma.brand.create({ data: { companyId: co.id, name: "MAXVET" } });
  const coa = await prisma.certificateType.create({ data: { companyId: co.id, code: "COA", name: "Certificate of Analysis" } });
  const fsc = await prisma.certificateType.create({ data: { companyId: co.id, code: "FSC", name: "Free Sale Certificate" } });
  const p1 = await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: "VITAMAX 1L", producer: "Maxvet Animals Care" } });
  const p2 = await prisma.product.create({ data: { companyId: co.id, brandId: brand.id, name: "MAXFORT", producer: "Maxvet Animals Care" } });
  const tCoa = await draftWithSuggestedFields("MAXVET COA", coa.id, brand.id);
  const tFsc = await draftWithSuggestedFields("MAXVET FSC", fsc.id, brand.id);

  // the drop as the intake leaves it after "طلّع الشهادات": filed, two certificate designs
  const batch = await prisma.intakeBatch.create({ data: { ownerType: "company", ownerId: co.id, companyId: co.id, status: "done", mode: "express", express: { requestedTypes: ["COA", "FSC"], stage: null }, executedAt: new Date() } });
  const item = (name, code, t, productNames) =>
    prisma.intakeItem.create({ data: { batchId: batch.id, name, sizeBytes: 1, receivedBytes: 1, status: "done", companyId: co.id, classification: { docType: "certificate_filled", certCode: code, productNames }, result: { plan: { action: "certificate_both", companyId: co.id, brandId: brand.id, productIds: [p1.id, p2.id], certCode: code }, template: { code, templateId: t.templateId, versionId: t.versionId, fields: { suggested: 6, toCheck: true } }, link: `/certificates/templates/${t.templateId}/versions/${t.versionId}` } } });
  await item("MAXVET COA.pdf", "COA", tCoa, ["VITAMAX"]);
  await item("MAXVET FSC.pdf", "FSC", tFsc, ["MAXFORT", "AMINOVITA", "VIAGRAMAX", "GARLIMYCES"]);

  console.log("Express: templates → drafts → files");
  const started = Date.now();
  const ex = await drive(batch.id);
  const secs = Math.round((Date.now() - started) / 1000);
  const tpl = Object.fromEntries(Object.values(ex.templates).map((t) => [t.code, t]));
  assert(`finished (${secs}s): stage done`, ex.stage === "done", ex);
  assert("the FSC lists 4 products in one table → NOT used, listed for a person (its rows would be printed as they are)", tpl.FSC?.status === "needs_table" && /4 products/.test(tpl.FSC.why), tpl.FSC);
  assert("the COA is used: prepared and active", tpl.COA?.status === "active", tpl.COA);
  const fields = await prisma.templateField.findMany({ where: { versionId: tCoa.versionId } });
  assert("…its fields still UNCONFIRMED (to check on the template screen)", fields.length > 0 && fields.every((f) => f.confirmed === false), fields.map((f) => f.confirmed));
  assert("…and nothing remembered as the company's mapping", (await prisma.fieldMappingMemory.count({ where: { companyId: co.id } }).catch(() => 0)) === 0);
  assert("…what each draft fills from the batch / by hand is listed", tpl.COA.toFill?.length > 0, tpl.COA.toFill);
  const fscT = await prisma.certificateTemplate.findUnique({ where: { id: tFsc.templateId } });
  assert("the FSC template stays inactive", !fscT.activeVersionId);

  assert("one DRAFT per product (COA × 2); FSC listed as missing, never guessed", ex.certificates.length === 2 && ex.certificates.every((c) => c.type === "COA" && c.status === "draft") && ex.generation.missing.every((m) => m.type === "FSC"), { certs: ex.certificates, missing: ex.generation.missing });
  assert("…batch facts weren't given: blank and marked on each draft (nothing filled in)", ex.certificates.every((c) => c.blanks.includes("batch_no")), ex.certificates.map((c) => c.blanks));
  const certs = await prisma.certificate.findMany({ where: { companyId: co.id }, include: { invoice: true } });
  assert("…on one internal direct record marked Express", certs.length === 2 && certs.every((c) => c.invoice.origin === "direct" && c.invoice.header?.express?.intakeBatchId === batch.id));
  assert("the ZIP and the combined PDF were made", ex.files?.zip && ex.files?.combinedPdf, ex.files);
  let r = await api("GET", `/certificate-batches/${ex.generation.certificateBatchId}/combined.pdf`, A);
  const pages = r.status === 200 ? (await PDFDocument.load(r.buffer)).getPageCount() : 0;
  assert(`combined PDF: both drafts in one file (${pages} pages)`, r.status === 200 && pages >= 2, r.status);
  r = await api("GET", `/certificates/${certs[0].id}/pdf`, A);
  assert("each draft's own PDF", r.status === 200 && r.buffer?.subarray(0, 4).toString() === "%PDF");
  assert("another company can't get the combined PDF (→ 404)", (await api("GET", `/certificate-batches/${ex.generation.certificateBatchId}/combined.pdf`, B)).status === 404);
  assert("running it again changes nothing (done)", (await runExpress({ batchId: batch.id })).stage === "done" && (await prisma.certificate.count({ where: { companyId: co.id } })) === 2);

  console.log("\nThe card and 'Express — needs review'");
  r = await api("GET", `/intake/batches/${batch.id}`, A);
  const view = r.data?.data;
  assert("the card: mode express, stage done, the drafts, the templates, AI calls counted", r.status === 200 && view.batch.mode === "express" && view.express.stage === "done" && view.express.certificates.length === 2 && view.express.templates.length === 2 && typeof view.express.ai.calls === "number", view?.express);
  r = await api("GET", "/intake/express", A);
  const order = r.data?.data?.orders?.find((o) => o.batchId === batch.id);
  assert("to review: the COA template and the 2 drafts, each with its page", r.status === 200 && order?.items.filter((i) => i.entityType === "certificate").length === 2 && order.items.some((i) => i.entityType === "certificate_template" && /\/certificates\/templates\//.test(i.link)), order);
  assert("another company sees none of it", ((await api("GET", "/intake/express", B)).data?.data?.orders || []).every((o) => o.batchId !== batch.id));
  r = await api("POST", "/intake/express/reviewed", B, { ids: order.items.map((i) => i.id) });
  assert("…and can't mark it checked (0)", r.status === 200 && r.data.data.reviewed === 0, r.data);
  r = await api("POST", "/intake/express/reviewed", A, { ids: [order.items.find((i) => i.entityType === "certificate_template").id] });
  const left = (await api("GET", "/intake/express", A)).data.data.orders.find((o) => o.batchId === batch.id);
  assert("marking the template checked takes it off the list; the drafts stay", r.data.data.reviewed === 1 && left.items.length === order.items.length - 1);

  console.log("\nChat: registering things (each a card)");
  await assistant.updateSettings(co.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
  const conv = await assistant.createConversation(companyActor, {});
  const ctx = (actor, texts = []) => ({ actor, scope: { companyId: actor.kind === "company" ? co.id : null }, conversationId: conv.id, userTexts: texts, propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor, ...p }) });
  const card = async (t) => (t.data?.actionId ? prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null);
  const det = (c) => Object.fromEntries((c?.preview?.details || []).map((d) => [d.label, d.value]));

  let t = await registry.runTool("create_company", { name: `Nova ${Date.now()}` }, ctx(companyActor, ["add a company"]));
  assert("create_company as a company account → refused (system users only)", !t.data?.actionId && /system/i.test(t.error || t.data?.draft?.error || ""), t.error || t.data);
  const nova = `Nova Vet ${Date.now()}`;
  t = await registry.runTool("create_company", { name: nova }, ctx(admin, [`ضيف شركة ${nova}`]));
  let c = await card(t);
  assert("create_company as a system user → a card for the new company, nothing made yet", c?.status === "pending" && c.companyId === null && det(c).Company === nova && !(await prisma.company.findFirst({ where: { name: nova } })), c?.preview || t);
  let done = await actions.approveAction(admin, c.id);
  const novaRow = await prisma.company.findFirst({ where: { name: nova } });
  if (novaRow) made.companies.push(novaRow.id);
  assert("…Run → the company exists", done.status === "done" && novaRow?.id === done.result.companyId, done);

  t = await registry.runTool("create_products", { products: [{ name: "AMINOVITA", packaging: "1 L" }, { name: "MAXFORT" }] }, ctx(companyActor, ["ضيف المنتجات AMINOVITA 1 L و MAXFORT"]));
  c = await card(t);
  assert("create_products: one card, the new one listed, the existing one skipped", c?.status === "pending" && det(c).AMINOVITA === "1 L" && /MAXFORT/.test(det(c)["Already there (skipped)"] || ""), c?.preview);
  done = await actions.approveAction(companyActor, c.id);
  assert("…Run → AMINOVITA added once", done.status === "done" && (await prisma.product.count({ where: { companyId: co.id, name: "AMINOVITA" } })) === 1, done);

  t = await registry.runTool("create_certificate_type", { code: "COC" }, ctx(companyActor, ["add COC"]));
  c = await card(t);
  assert("create_certificate_type COC → Certificate of Composition (COO is Origin)", det(c).Name === "Certificate of Composition", c?.preview || t);

  t = await registry.runTool("generate_certificates_for_products", { productIds: [p1.id, p2.id], certificateTypeIds: [coa.id], batches: [{ productId: p1.id, batchNo: "MX-77" }] }, ctx(companyActor, ["طلّعلي COA للمنتجين"]));
  assert("a batch number the person never typed → refused, never filled", !t.data?.actionId && /isn't in your messages/.test(t.error || t.data?.draft?.error || ""), t.error || t.data?.draft?.error);
  t = await registry.runTool("generate_certificates_for_products", { productIds: [p1.id, p2.id], certificateTypeIds: [coa.id, fsc.id], batches: [{ productId: p1.id, batchNo: "MX-77" }] }, ctx(companyActor, ["طلّعلي COA و FSC للمنتجين، تشغيلة VITAMAX هي MX-77"]));
  c = await card(t);
  assert("…typed → a card: COA for both, FSC listed as having no template, the batch as typed", c?.status === "pending" && /COA — VITAMAX 1L"/.test(JSON.stringify(c.preview.details)) && /COA — MAXFORT"/.test(JSON.stringify(c.preview.details)) && /FSC for VITAMAX 1L/.test(det(c)["No template (not made)"] || "") && /batchNo MX-77/.test(det(c)["Batch facts (as you typed)"] || ""), c?.preview);

  const [pdfAtt] = await storeAttachments({ conversationId: conv.id, companyId: co.id, actor: companyActor, files: [{ buffer: fs.readFileSync(path.join(FIXTURES, "PHARMAVET_COA.pdf")), originalname: "SFDA labelling rules.pdf", mimetype: "application/pdf" }] });
  t = await registry.runTool("add_regulatory_rules", { attachmentId: pdfAtt.id, country: "السعودية" }, ctx(companyActor, ["دي قواعد السعودية"]));
  c = await card(t);
  assert("add_regulatory_rules: a card to READ Saudi Arabia's rules; approving them is on the label / Regulatory page", c?.status === "pending" && /Saudi Arabia/.test(det(c).Country) && /approve them on the label page/.test(det(c).Then), c?.preview || t);

  t = await registry.runTool("start_intake", { attachmentIds: [pdfAtt.id], express: true, certificateTypes: ["coa", "fsc"] }, ctx(companyActor, ["طلّعلي شهادات COA وFSC"]));
  const eb = t.data?.intakeBatchId ? await prisma.intakeBatch.findUnique({ where: { id: t.data.intakeBatchId } }) : null;
  assert("start_intake express → an Express drop, the types asked kept", eb?.mode === "express" && eb.express.requestedTypes.join() === "COA,FSC", eb);

  console.log("\nThe prompt");
  assert("urgent orders → start_intake express; batch facts never filled; Express — needs review", /express: true/.test(SYSTEM_PROMPT) && /Express — needs review/.test(SYSTEM_PROMPT));
  assert("still out of the chat: finalizing / approving certificates and rules, deleting, users, roles", /cannot finalize or approve certificates, approve regulatory rules, delete anything/.test(SYSTEM_PROMPT) && /change users or roles/.test(SYSTEM_PROMPT));
} catch (err) {
  assert(`crashed: ${err.message}`, false, err.stack);
} finally {
  await prisma.assistantConversation.deleteMany({ where: { companyId: co.id } }).catch(() => {});
  for (const id of made.companies) await cleanupCompany(id).catch((e) => console.error(e.message));
  await cleanupCompany(co.id).catch((e) => console.error(e.message));
  await cleanupCompany(other.id).catch((e) => console.error(e.message));
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
