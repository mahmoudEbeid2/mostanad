// Assistant files, client report 24 Nov (item 4): a file attached in "All
// companies" failed ("Pick a company before attaching a file…"), the message
// went out without it, and the model then called inspect_attachment with an id
// that was never in the conversation ("Attachment not found!").
// Now: files attach in "All companies" (unbound) and are SENT unbound when no company is
// picked (25 Nov: an urgent order starts from an empty chat — start_intake works out whose
// they are), or bound by the company picked on send / …/attachments/bind; a tool on a
// bound file takes the file's company, and a missing file says what the
// conversation does hold. Needs `npm run dev:test`.
import crypto from "crypto";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asAdmin, asCompany, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as registry from "../src/services/assistant/registry/index.js";
import { storeAttachments, loadAttachment } from "../src/services/assistant/attachments.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const admin = { kind: "user", id: crypto.randomUUID(), name: "files admin", permissions: null };
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
// the model, scripted (tests never call a paid API)
const script = (steps) => {
  const seen = [];
  const generate = async (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return { content: { role: "model", parts: step }, usage: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  };
  return { generate, seen };
};
const pdf = (name) => ({ buffer: PDF, originalname: name, mimetype: "application/pdf" });

async function main() {
  console.log("🧪 Assistant — files in \"All companies\"\n");
  const coA = await createCompany("attA");
  const coB = await createCompany("attB");
  await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
  try {
    const conv = await assistant.createConversation(admin, { companyId: null });

    console.log("Attaching with no company picked");
    const [f1] = await assistant.uploadAttachments(admin, conv.id, [pdf("MAXVET COA.pdf")], { companyId: "all" });
    assert("the file is kept in the conversation, not refused", !!f1?.id && f1.companyId === null, f1);
    const unbound = await assistant.sendMessage(admin, conv.id, { text: "اعمل قالب من الشهادة دي", companyId: "all", attachmentIds: [f1.id] }, { generate: script([[{ text: "x" }]]).generate }).catch((e) => e);
    assert("sending it in \"All companies\" → sent, the file still unbound (its company is worked out from it)", unbound?.message?.role === "assistant" && (await prisma.assistantAttachment.findUnique({ where: { id: f1.id } })).companyId === null, unbound?.message || unbound);
    let err = await loadAttachment(f1.id, { conversationId: conv.id, companyId: null }).catch((e) => e);
    assert("a tool can't read a file with no company yet (it asks which company)", err.statusCode === 409 && /isn't linked to a company/.test(err.message), err.message);

    console.log("\nThe company picked on send");
    const m = script([[{ text: "تمام، استلمت الملف." }]]);
    const turn = await assistant.sendMessage(admin, conv.id, { text: "اعمل قالب من الشهادة دي", companyId: coA.id, attachmentIds: [f1.id] }, { generate: m.generate });
    const att = await prisma.assistantAttachment.findUnique({ where: { id: f1.id } });
    const file = await prisma.storedFile.findUnique({ where: { id: att.fileId } });
    assert("sent with a company → the file is bound to it (attachment and stored file)", att.companyId === coA.id && file.companyId === coA.id, { att: att.companyId, file: file.companyId });
    const userMsg = await prisma.assistantMessage.findFirst({ where: { conversationId: conv.id, role: "user" }, orderBy: { createdAt: "desc" } });
    assert("…and the message carries it", userMsg.attachments?.[0]?.id === f1.id && userMsg.companyId === coA.id && turn.message?.role === "assistant", userMsg.attachments);
    assert("…the model was told the file is attached", JSON.stringify(m.seen[0].contents).includes(`[attached: ${f1.id}`));

    // QA 27 Nov (re-test): files + a short message go to Express by code, never to the model's choice
    console.log("\nA drop with a short message → Express, no model call");
    const [fx] = await assistant.uploadAttachments(admin, conv.id, [pdf("ADDVET FSC.pdf")], { companyId: coA.id });
    const mx = script([[{ text: "should not be called" }]]);
    const drop = await assistant.sendMessage(admin, conv.id, { text: "شهادات ADDVET", companyId: coA.id, attachmentIds: [fx.id] }, { generate: mx.generate });
    const first = drop.message?.toolCalls?.[0];
    assert("start_intake with express: true, routed by code", first?.name === "start_intake" && first.args?.express === true && first.routedByCode === true, drop.message?.toolCalls);
    assert("…the model was not asked", mx.seen.length === 0, mx.seen.length);
    assert("…the drop's card is under the answer", (drop.message?.blocks || []).some((b) => b.type === "intake"), drop.message?.blocks);

    console.log("\nBinding over HTTP (the company chips)");
    const r0 = await api("POST", "/assistant/conversations", asAdmin, { companyId: "all" });
    const conv2 = r0.data?.data?.conversation || r0.data?.data;
    const [f2] = await storeAttachments({ conversationId: conv2.id, companyId: null, actor: { kind: "user", id: "x" }, files: [pdf("FSC.pdf")] });
    let r = await api("POST", `/assistant/conversations/${conv2.id}/attachments/bind`, asAdmin, { companyId: coB.id, attachmentIds: [f2.id] });
    assert("POST …/attachments/bind → bound to the picked company", r.status === 200 && r.data?.data?.attachments?.[0]?.companyId === coB.id, { status: r.status, body: r.data });
    r = await api("POST", `/assistant/conversations/${conv2.id}/attachments/bind`, asAdmin, { companyId: coA.id, attachmentIds: [f2.id] });
    assert("binding a file that already belongs to another company → 400", r.status === 400, r.status);
    r = await api("POST", `/assistant/conversations/${conv2.id}/attachments/bind`, asAdmin, { companyId: "all", attachmentIds: [f2.id] });
    assert('"All companies" is not a company for files → 400', r.status === 400, r.status);

    console.log("\nA tool on a bound file, in \"All companies\"");
    const conv3 = await assistant.createConversation(admin, { companyId: null });
    const [f3] = await storeAttachments({ conversationId: conv3.id, companyId: coA.id, actor: admin, files: [pdf("HC.pdf")] });
    const ctx = { actor: admin, scope: { companyId: null }, conversationId: conv3.id, userTexts: [], companyExists: async () => true, propose: async () => ({ id: "card" }) };
    let t = await registry.runTool("inspect_attachment", { attachmentId: f3.id }, ctx);
    assert("inspect_attachment works and runs in the file's company", t.status === "ok" && t.companyId === coA.id && t.data?.name === "HC.pdf", t);
    t = await registry.runTool("inspect_attachment", { attachmentId: crypto.randomUUID() }, ctx);
    assert("an id that isn't in the conversation → says which files it has", t.status === "error" && /HC\.pdf/.test(t.error), t.error);
    const conv4 = await assistant.createConversation(admin, { companyId: coA.id });
    t = await registry.runTool("inspect_attachment", { attachmentId: crypto.randomUUID() }, { ...ctx, conversationId: conv4.id, scope: { companyId: coA.id } });
    assert("no files at all → says none reached the system (WhatsApp / email) and to attach it here", t.status === "error" && /no attached files/.test(t.error) && /WhatsApp/.test(t.error), t.error);
    t = await registry.runTool("inspect_attachment", { attachmentId: f3.id }, { ...ctx, conversationId: conv3.id, scope: { companyId: coB.id } });
    assert("a file of company A in a company-B call → not found", t.status === "error", t);

    console.log("\nCompany sessions");
    await assistant.updateSettings(coA.id, { enabled: true });
    r = await api("POST", "/assistant/conversations", asCompany(coA.id), {});
    const conv5 = r.data?.data?.conversation || r.data?.data;
    const fd = new FormData();
    fd.append("files", new Blob([PDF], { type: "application/pdf" }), "COC.pdf");
    r = await api("POST", `/assistant/conversations/${conv5.id}/attachments`, asCompany(coA.id), fd);
    assert("a company session's file is always its own company's", r.status === 201 && r.data.data.attachments[0].companyId === coA.id, r.data);
  } finally {
    await prisma.assistantConversation.deleteMany({ where: { OR: [{ ownerId: admin.id }, { companyId: { in: [coA.id, coB.id] } }] } }).catch(() => {});
    await cleanupCompany(coA.id).catch((e) => console.error(e.message));
    await cleanupCompany(coB.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
