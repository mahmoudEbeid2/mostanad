// Fixes from the live QA run (2026-11-23), phase by phase. The model is a script:
// no Gemini call is made. Needs Postgres (sendMessage runs in this process).
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import { runAgent } from "../src/services/assistant/agent/agentLoop.js";
import { sanitizeOutput, claimsAction } from "../src/services/assistant/agent/answerGuard.js";
import { toolRecord, replayText } from "../src/services/assistant/agent/history.js";
import { selectModules } from "../src/services/assistant/agent/selectTools.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const admin = { kind: "user", id: crypto.randomUUID(), name: "qa admin", permissions: null };
export const script = (steps) => {
  const seen = [];
  const generate = async (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return { content: { role: "model", parts: typeof step === "function" ? step(req) : step }, usage: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  };
  return { generate, seen };
};
const call = (name, args) => ({ functionCall: { name, args } });
const FAKE = 'تم تجهيز بطاقة لإنشاء منتج جديد للسطر 1.\n\n[tools used in this answer: start_draft({"tool":"create_product_from_line","values":[{"field":"lineNo","value":"1"}]}) → waiting for your OK. Rows are not repeated here: call the tool again to read them.]';

async function main() {
  const co = await createCompany(`qa${s}`);
  await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
  try {
    console.log("Phase 1 — no claimed actions, no internal notes");
    let m = script([[{ text: FAKE }], [{ text: FAKE }]]);
    const conv = await assistant.createConversation(admin, { companyId: co.id });
    let turn = await assistant.sendMessage(admin, conv.id, { text: "طابقهم، واللي ملوش منتج اعمله منتج جديد" }, { generate: m.generate });
    let t = turn.message.text;
    assert("the fake claim and the bracket note never reach the person", !/tools used|Rows are not repeated|تم تجهيز بطاقة/.test(t), t);
    assert("…they get an honest answer in their language instead", /لم أُجهّز أي عملية/.test(t), t);
    assert("…the model was told once to call the tool or say it couldn't", m.seen.length === 2 && JSON.stringify(m.seen[1].contents.at(-1)).includes("no card exists"));
    assert("…the event is logged on the message", turn.message.grounding?.guard?.some((g) => g.type === "false_action_claim"), turn.message.grounding);
    m = script([[{ text: FAKE }], [{ text: "لم أستطع تجهيز البطاقة لأن السطر غير محدد. أي سطر تقصد؟" }]]);
    turn = await assistant.sendMessage(admin, conv.id, { text: "اعمل المنتجات" }, { generate: m.generate });
    assert("a corrected second answer is shown as written", turn.message.text.startsWith("لم أستطع تجهيز"), turn.message.text);
    const replay = m.seen[0].contents;
    assert("history replays earlier answers without any tools note", !JSON.stringify(replay.slice(0, -1)).includes("tools used"), JSON.stringify(replay).slice(0, 400));
    const dirty = sanitizeOutput('Here.\n{"name":"get_invoice","args":{}}\nstart_draft({"tool":"x"})\nText… (85 more characters)\nSee entity:product/0b0b0b0b-0000-4000-8000-000000000000 now');
    assert("sanitizer: JSON args, tool calls, truncation markers and bare ids removed; prose kept", dirty.text === "Here.\nText…\nSee  now" && ["internal_line", "truncation", "entity_id"].every((k) => dirty.removed.includes(k)), dirty);
    assert("a link keeps its id", sanitizeOutput("See [X](entity:product/0b0b0b0b-0000-4000-8000-000000000000).").text.includes("entity:product/0b0b0b0b-0000-4000-8000-000000000000"));
    assert("claims: Arabic and English; a plain read isn't a claim", claimsAction("جهزت لك كارت") && claimsAction("I've prepared a card for you.") && claimsAction("The product has been created.") && !claimsAction("تم العثور على 3 منتجات") && !claimsAction("Here are 5 products."));
    const rec = toolRecord([{ role: "assistant", text: "x", toolCalls: [{ ok: true, name: "list_products", args: { page: 1 }, summary: "25 of 89", nextPage: 2 }] }]);
    assert("the tool record lives in the context, marked internal, with the cursor", /never write this record/i.test(rec) && rec.includes("nextPage=2"));
    assert("an old answer that leaked a note is replayed cleaned", replayText({ role: "assistant", text: FAKE }) === "تم تجهيز بطاقة لإنشاء منتج جديد للسطر 1.");
    m = script([[call("start_draft", { tool: "create_product", values: [{ field: "name", value: `Qa ${s}` }] })], [{ text: "جهزت لك بطاقة بالمنتج." }]]);
    turn = await assistant.sendMessage(admin, conv.id, { text: `ضيف منتج اسمه Qa ${s}` }, { generate: m.generate });
    assert("a real draft step lets the same words through", turn.message.text === "جهزت لك بطاقة بالمنتج.", turn.message.text);

    console.log("\nPhase 2 — tools never disappear on a follow-up");
    assert("'اعرض المستندات الرقابية' → regulatory", selectModules("اعرض المستندات الرقابية").includes("regulatory"));
    assert("folded Arabic: 'الرقابيه' / 'المستندات' match", selectModules("المستند الرقابيه").includes("regulatory"));
    assert("'ايه حالة آخر مهمة شغالة' → tasks", selectModules("ايه حالة آخر مهمة شغالة؟").includes("tasks"));
    m = script([[call("list_regulatory_documents", {})], [{ text: "هذه المستندات." }]]);
    let out = await runAgent({ text: "اعرض الملفات اللي عندنا", ctx: { actor: admin, scope: { companyId: co.id }, audit: async () => {} }, generate: m.generate });
    assert("a tool from a module not offered is loaded and run in the same turn (no 'isn't available')", out.toolCalls[0]?.ok === true && !/isn't available/.test(JSON.stringify(out.toolCalls)) && out.guard?.some((g) => g.type === "module_autoloaded" && g.module === "regulatory"), out.toolCalls);
    const conv2 = await assistant.createConversation(admin, { companyId: co.id });
    m = script([[call("search_invoices", { limit: 1 })], [{ text: "لا توجد فواتير." }]]);
    await assistant.sendMessage(admin, conv2.id, { text: "اعرض آخر فاتورة" }, { generate: m.generate });
    m = script([[{ text: "تمام." }]]);
    await assistant.sendMessage(admin, conv2.id, { text: "مفيش كارت ظهر. اعمل المنتجات للسبع بنود كلهم" }, { generate: m.generate });
    const offered = m.seen[0].tools.map((x) => x.name);
    assert("the follow-up keeps the invoices tools (sticky modules)", offered.includes("get_invoice") && offered.includes("create_product_from_line"), offered);

    console.log("\nPhase 3 — draft values in any form, a budget that counts real work");
    const amino = await prisma.product.create({ data: { companyId: co.id, name: `AMINOVITA ${s}`, withdrawalPeriod: "3 days" } });
    const inv = await prisma.invoice.create({ data: { companyId: co.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `QA-${s}` } } });
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: { name: "Unknown line" }, dataExtracted: {}, matchStatus: "needs_match" } });
    const conv3 = await assistant.createConversation(admin, { companyId: co.id });
    const said = `غير فترة السحب بتاعت AMINOVITA ${s} لـ 5 ايام`;
    m = script([
      [call("start_draft", { tool: "update_product_fields", values: [{ field: "productId", value: amino.id }, { field: "changes", value: [{ field: "فترة السحب", value: { amount: 5, unit: "days" } }] }] })],
      [{ text: "جهزت لك بطاقة التعديل." }],
    ]);
    turn = await assistant.sendMessage(admin, conv3.id, { text: said }, { generate: m.generate });
    let first = turn.message.toolCalls[0];
    let draft = await prisma.assistantDraft.findUnique({ where: { id: first?.draftId || "00000000-0000-4000-8000-000000000000" } });
    assert("'غير فترة السحب … لـ 5 ايام': an object value and an Arabic field name → a card on the first call", first?.ok && draft?.status === "ready", first);
    assert("…the value is the person's own words ('5 ايام') and the field its key", JSON.stringify(draft?.fields?.changes?.value) === JSON.stringify([{ field: "withdrawalPeriod", value: "5 ايام" }]), draft?.fields?.changes);
    m = script([[call("start_draft", { tool: "match_invoice_line", values: [{ field: "invoiceId", value: inv.id }, { field: "lineNo", value: 1 }, { field: "productId", value: amino.id }] })], [{ text: "جهزت لك بطاقة المطابقة." }]]);
    turn = await assistant.sendMessage(admin, conv3.id, { text: `اربط السطر 1 بـ AMINOVITA ${s}` }, { generate: m.generate });
    first = turn.message.toolCalls[0];
    draft = await prisma.assistantDraft.findUnique({ where: { id: first?.draftId || "00000000-0000-4000-8000-000000000000" } });
    assert("lineNo as a number (1) is accepted → a card on the first call", first?.ok && draft?.status === "ready" && draft.fields.lineNo.value === 1, first);
    const bad = call("get_product", { productId: "not-a-uuid" });
    m = script([[bad], [bad], [bad], [bad], [{ text: "لم أجد المنتج." }]]);
    out = await runAgent({ text: "x", ctx: { actor: admin, scope: { companyId: co.id }, audit: async () => {} }, generate: m.generate, limits: { maxToolCalls: 2, maxModelCalls: 6 } });
    const errs = out.toolCalls.map((c) => c.error || "");
    assert("an identical failing call isn't run again: the model gets one fix hint", errs.length === 4 && errs.slice(1).every((e) => /already made this exact call/.test(e)), errs);
    assert("…and arguments refused or repeated don't spend the call budget (no 'limit reached')", !errs.some((e) => /limit/.test(e)), errs);
    const decl = m.seen[0].tools.find((x) => x.name === "start_draft");
    assert("start_draft declares value as text | number | true/false", JSON.stringify(decl.parameters).includes('"number"') && JSON.stringify(decl.parameters).includes('"boolean"'), JSON.stringify(decl.parameters).slice(0, 300));
    const ask = (await import("../src/services/assistant/drafts/specs.js")).specFor("update_product_fields").fields.find((f) => f.name === "changes");
    assert("the draft form offers the fields to change as a list labelled in Arabic and English", ask.fieldOptions?.some((o) => o.value === "withdrawalPeriod" && o.label === "فترة السحب / Withdrawal period"), ask.fieldOptions?.slice(0, 3));

    console.log("\nPhase 4 — many invoice lines in one card");
    const drafts = await import("../src/services/assistant/drafts/draftService.js");
    const actions = await import("../src/services/assistant/actions.js");
    const { runTool } = await import("../src/services/assistant/registry/index.js");
    const other = await createCompany(`qa4o${s}`);
    const sele = await prisma.product.create({ data: { companyId: co.id, name: `SELE GOLD ${s}`, productCode: `SG-${s}` } });
    await prisma.product.create({ data: { companyId: other.id, name: `MAXPROTECT ${s}` } });
    const inv4 = await prisma.invoice.create({ data: { companyId: co.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `BRN-${s}`, invoiceDate: { raw: "01/01/2099", iso: "2099-01-01" } } } });
    await prisma.invoiceItem.create({ data: { invoiceId: inv4.id, lineNo: 1, data: { name: `SELE GOLD ${s}` }, dataExtracted: {}, matchStatus: "needs_match", matchCandidates: [{ productId: sele.id, name: sele.name, score: 0.92, reasons: [] }] } });
    await prisma.invoiceItem.create({ data: { invoiceId: inv4.id, lineNo: 2, data: { name: `MAXPROTECT ${s}` }, dataExtracted: {}, matchStatus: "needs_match" } });
    await prisma.invoiceItem.create({ data: { invoiceId: inv4.id, lineNo: 3, data: { name: `Brand new ${s}` }, dataExtracted: {}, matchStatus: "needs_match" } });
    const conv4 = await assistant.createConversation(admin, { companyId: co.id });
    const env4 = { actor: admin, scope: { companyId: co.id }, conversationId: conv4.id, userTexts: ["طابقهم واللي ملوش منتج اعمله منتج جديد"], audit: async () => {}, companyExists: async () => true };
    const sess = drafts.draftSession(env4);
    let v = await sess.open({ tool: "match_invoice_lines", values: { invoiceId: inv4.id }, companyId: co.id });
    const lines4 = v.fields.find((f) => f.name === "lines")?.value;
    assert("'طابقهم…': ONE ready card proposing every line from the matcher (match the strong candidate, else create)", v.status === "ready" && (lines4 || []).map((l) => `${l.lineNo}:${l.action}:${l.productId || ""}`).join() === `1:match:${sele.id},2:create:,3:create:`, lines4);
    const card4 = await prisma.assistantAction.findUnique({ where: { id: v.actionId } });
    assert("the card lists each line with its action, and names another company that has the product", card4.preview.details.length === 3 && /SELE GOLD/.test(card4.preview.details[0].value) && /exists in qa4o/.test(card4.preview.details[1].value), card4.preview.details);
    v = await drafts.submitDraftFields(admin, v.id, { lines: [{ lineNo: 1, action: "match", productId: sele.id }, { lineNo: 2, action: "ignore" }, { lineNo: 3, action: "create" }] });
    assert("rows can be changed on the card (line 2 → ignore): a new card, still one", v.status === "ready" && v.fields.find((f) => f.name === "lines").value[1].action === "ignore");
    const ran = await actions.approveAction(admin, v.actionId);
    const after = await prisma.invoiceItem.findMany({ where: { invoiceId: inv4.id }, orderBy: { lineNo: "asc" }, select: { matchStatus: true, productId: true } });
    assert("one button: line 1 matched, line 2 ignored, line 3 a new product — each reported", ran.status === "done" && ran.result.done === 3 && after[0].productId === sele.id && after[1].matchStatus === "ignored" && after[2].matchStatus === "matched" && after[2].productId, { ran: ran.result, after });

    const inv5 = await prisma.invoice.create({ data: { companyId: co.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `PER-${s}` } } });
    for (const n of [1, 2]) await prisma.invoiceItem.create({ data: { invoiceId: inv5.id, lineNo: n, data: { name: `Line ${n}` }, dataExtracted: {}, matchStatus: "needs_match" } });
    const d1 = await sess.open({ tool: "match_invoice_line", values: { invoiceId: inv5.id, lineNo: 1, productId: sele.id }, companyId: co.id });
    const d2 = await sess.open({ tool: "match_invoice_line", values: { invoiceId: inv5.id, lineNo: 2, productId: sele.id }, companyId: co.id });
    await actions.approveAction(admin, d1.actionId);
    const still = (await sess.list()).find((x) => x.id === d2.id);
    assert("approving line 1's card leaves line 2's card valid (it watches only its own line)", still?.status === "ready", still?.status);
    await prisma.invoiceItem.updateMany({ where: { invoiceId: inv5.id, lineNo: 2 }, data: { matchStatus: "ignored" } });
    const expired = (await drafts.conversationDrafts(admin, conv4.id)).find((x) => x.id === d2.id);
    assert("…but a change to line 2 itself expires it", expired?.status === "expired", expired?.status);
    const refreshed = await drafts.refreshDraft(admin, d2.id);
    assert("Refresh rebuilds the expired card from its values, checked again now (a new draft, a new card)", refreshed.id !== d2.id && refreshed.tool === "match_invoice_line" && refreshed.status === "ready" && refreshed.actionId && refreshed.actionId !== d2.actionId, refreshed.error || refreshed.status);

    const inv6 = await prisma.invoice.create({ data: { companyId: co.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `GEN-${s}` } } });
    await prisma.invoiceItem.create({ data: { invoiceId: inv6.id, lineNo: 1, data: { name: "x" }, dataExtracted: {}, matchStatus: "needs_match" } });
    const gen = await sess.open({ tool: "generate_certificates", values: { invoiceId: inv6.id }, companyId: co.id });
    assert("prerequisites in order: unmatched lines block first, 'confirm the invoice' isn't offered yet", gen.blockedBy.map((b) => b.key).join() === "lines_matched" && gen.blockedBy[0].fix[0] === "match_invoice_lines", gen.blockedBy);
    const fix = await drafts.startFixDraft(admin, gen.id, "lines_matched");
    assert("'Do this step' starts the fix operation's draft directly (the invoice carried over)", fix.tool === "match_invoice_lines" && fix.fields.find((f) => f.name === "invoiceId")?.value === inv6.id, fix);
    t = await runTool("search_invoices", { limit: 1 }, { actor: admin, scope: { companyId: co.id }, audit: async () => {} });
    assert("'latest invoice' = newest invoice date (2099-01-01), not upload order", t.data.items[0]?.invoiceNumber === `BRN-${s}`, t.data.items.map((i) => i.invoiceNumber));
    await cleanupCompany(other.id).catch(() => {});

    console.log("\nPhase 5 — results the person actually gets");
    const { recordVerification } = await import("../src/services/label/verificationRecord.js");
    const { taskSummary, actionEventText } = await import("../src/services/assistant/actions.js");
    const { withHereLink } = await import("../src/services/assistant/agent/agentLoop.js");
    const lt = (en) => ({ translations: { en }, primary: "en" });
    const verifyResult = {
      regulatoryStatus: { status: "checked", message: "Checked against EG rules" },
      productMatchStatus: { state: "none" },
      product: { extractedDetails: { schemaVersion: "vet-label@2.0.0", productType: "veterinary_drug", productName: lt("ADDOXY 200-LA"), targetAnimalSpecies: { list: ["Cattle"] }, activeIngredients: [] }, extractionMeta: {} },
      validation: { passed: false, errorCount: 1, warningCount: 1, engineVersion: "t", rulesetIds: [], verdicts: [{ path: "withdrawalPeriod", status: "FAIL", message: "Withdrawal period is required" }, { path: "storage", status: "NEEDS_REVIEW", message: "Storage wording unclear" }, { path: "x", status: "PASS" }] },
    };
    const verified = await recordVerification(verifyResult, { companyId: co.id, country: "EG", fileName: "addoxy.pdf" });
    const lab = await prisma.generatedLabel.findUnique({ where: { id: verified.labelId }, include: { validations: true } });
    assert("a label check is kept as a label with its report: labelId, validationId, verdict, risk, top issues, link", lab?.origin === "extracted" && lab.validations.length === 1 && verified.verdict === "FAIL" && verified.issues.map((i) => i.field).join() === "withdrawalPeriod,storage" && verified.link === `/labels/detail/${verified.labelId}` && typeof verified.riskScore === "number", verified);
    const sum = taskSummary({ status: "ok", summary: verified, coas: [{ fileName: "ADDVET OMAN COA 10-26.pdf", extracted: 6, kept: 0, discarded: 6, reasons: ["batch AV-9: not on any invoice line (×6)"] }], kept: 0, discarded: 6 });
    assert("the finished job keeps its outcome for the card and the model (verdict, issues, COA kept/discarded + reasons)", sum.summary?.verdict === "FAIL" && sum.coas?.[0]?.reasons?.[0]?.includes("not on any invoice line") && sum.kept === 0);
    const ev = actionEventText({ status: "done", tool: "upload_label_and_resize", preview: { title: "Resize" }, result: { uploadId: "u1" } }, { tool: "get_label_upload", data: { status: "review", empty: ["withdrawalPeriod"] } });
    assert("the continuation carries the follow-up read and says: show it now, never 'later'", /Already read for you with get_label_upload/.test(ev) && /never say you will do it later/.test(ev));
    t = await runTool("get_invoice_data_check", { invoiceId: inv6.id }, { actor: admin, scope: { companyId: co.id }, audit: async () => {} });
    assert("data check with unmatched lines: 'can't check N lines until matched', never 'nothing missing'", t.ok && t.data.uncheckedLines === 1 && /does NOT mean nothing is missing/.test(t.data.note), t.data || t.error);
    const env5 = { ...env4, userTexts: ["افحص الليبل ده، البلد مصر"] };
    const att = await prisma.assistantAttachment.create({ data: { conversationId: conv4.id, companyId: co.id, ownerType: "user", ownerId: admin.id, fileId: (await prisma.storedFile.create({ data: { companyId: co.id, kind: "assistant_attachment", path: `certificates/${co.id}/x.pdf`, mimeType: "application/pdf", sizeBytes: 1, sha256: "x" } })).id, name: "label.pdf", mimeType: "application/pdf", sizeBytes: 1 } });
    v = await drafts.draftSession({ ...env5, attachments: [att] }).open({ tool: "verify_label", values: { attachmentId: att.id }, companyId: co.id });
    assert("'البلد مصر' fills the country as its code (EG), from the person's words", v.fields.find((f) => f.name === "country")?.value === "EG", v.fields);
    v = await drafts.draftSession(env4).open({ tool: "upload_label", values: { attachmentId: att.id, country: "مصر" }, companyId: co.id });
    assert("a country given as 'مصر' is stored as EG", v.fields.find((f) => f.name === "country")?.value === "EG", v.fields.find((f) => f.name === "country"));
    const { specFor } = await import("../src/services/assistant/drafts/specs.js");
    assert("the form offers countries as a choice, not free text", specFor("verify_label").fields.find((f) => f.name === "country").staticOptions?.some((o) => o.value === "EG" && /مصر/.test(o.label)));
    const refsT = new Map([["0b0b0b0b-0000-4000-8000-000000000001", { type: "label", id: "0b0b0b0b-0000-4000-8000-000000000001", name: "ADDOXY" }]]);
    console.log("\nPhase 6 — grounding and list stripping don't hide correct answers");
    const G = await import("../src/services/assistant/agent/grounding.js");
    const corpus = G.corpusOf(["AMINOVITA 3 days Amoxicillin"]);
    const labelsAnswer = "تفاصيل منتج AMINOVITA:\n**الاسم:** AMINOVITA\n**المكونات النشطة:** Amoxicillin\n**الوصف:** —\nconversion: 3\n**P95**: 1200\n**Upload invoice**";
    const g6 = G.checkGrounding(labelsAnswer, corpus, { toolCallsThisTurn: 1 });
    assert("labels ('الوصف:', 'المكونات النشطة:', 'conversion:', P95) and English step names are not entities", g6.ok, g6.unknown);
    assert("…an invented product code is still blocked", !G.checkGrounding("The closest is **MOXYVET 500**.", corpus, { toolCallsThisTurn: 1 }).ok);
    const fields6 = "بيانات شركة Vetline هي:\n- الاسم: Vetline\n- نشط: نعم\n- البريد: a@b.c\n- الهاتف: 123\n- المنتجات: 7";
    assert("one record's typed fields stay when no block shows them", G.stripTypedLists(fields6, []) === fields6);
    assert("…and go when a block under the answer shows them", G.stripTypedLists(fields6, ["Vetline", "نعم", "a@b.c", "123", "7"]) === "بيانات شركة Vetline هي:");
    m = script([[call("get_company", { companyId: co.id })], [{ text: `بيانات شركة ${co.name}:\n- الاسم: ${co.name}\n- نشط: نعم\n- x: 1\n- y: 2` }]]);
    out = await runAgent({ text: "اعرض بيانات الشركة", ctx: { actor: admin, scope: { companyId: co.id }, audit: async () => {}, companyExists: async () => true }, generate: m.generate });
    const rb = out.blocks.find((b) => b.type === "record");
    assert("a single record gets a code-built record card (stored values, Arabic/English labels)", rb?.tool === "get_company" && rb.fields.some((f) => f.key === "name" && f.value === co.name && f.label.ar === "الاسم" && f.label.en === "Name"), rb);
    assert("…the answer isn't replaced by 'couldn't get that from the system'", !/لم أستطع الحصول/.test(out.text) && out.text.startsWith("بيانات شركة"), out.text);
    m = script([[call("help_topics", { topic: "certificates" })], [{ text: "الخطوات:\n1. **ارفع الفاتورة**\n2. **طابق السطور**\n3. **أكد الفاتورة**\n4. **جهز الشهادات**\n5. **أصدر الشهادات**" }]]);
    out = await runAgent({ text: "ازاي اطلع شهادة COA من السيستم؟ اشرحلي الخطوات", ctx: { actor: admin, scope: { companyId: co.id }, audit: async () => {} }, generate: m.generate });
    assert("how-to: grounded on help_topics, steps shown (not 'couldn't get that')", out.toolCalls[0]?.ok && /ارفع الفاتورة/.test(out.text) && !out.grounding?.blocked, out.text);
    t = await runTool("help_topics", { topic: "capabilities" }, { actor: admin, scope: { companyId: co.id }, audit: async () => {} });
    assert("'ماهي الأدوات التي تدعمها': capabilities come from the registry", t.ok && t.data.capabilities.some((c) => c.module === "invoices" && c.changes.length > 0), t.error);
    m = script([[{ text: "المنتج المقصود **ZORBAX-77**." }], [{ text: "المنتج المقصود **ZORBAX-77**." }]]);
    out = await runAgent({ text: "فين منتج zorbax", ctx: { actor: admin, scope: { companyId: co.id }, audit: async () => {} }, generate: m.generate });
    assert("a blocked answer is retried in the person's language, then says WHAT couldn't be verified", /Answer in Arabic/.test(JSON.stringify(m.seen[1].contents.at(-1))) && /ZORBAX-77/.test(out.text) && /لم أستطع التحقق/.test(out.text), out.text);

    assert("'يمكنك متابعة حالتها هنا' gets a real link", withHereLink("يمكنك متابعة حالتها هنا.", refsT, new Map()).includes("](entity:label/0b0b0b0b-0000-4000-8000-000000000001)") && withHereLink("No pointer.", refsT, new Map()) === "No pointer.");
  } finally {
    await prisma.invoice.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await prisma.product.deleteMany({ where: { name: `Qa ${s}` } }).catch(() => {});
    await cleanupCompany(co.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  process.exit(counts.failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
