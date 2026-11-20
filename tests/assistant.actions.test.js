import fs from "fs";
import path from "path";
import { z } from "zod";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asCompany, asAdmin, createCompany, form } from "./certificates-v2/helpers.js";
import * as registry from "../src/services/assistant/registry/index.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as actions from "../src/services/assistant/actions.js";
import { storeAttachments, loadAttachment } from "../src/services/assistant/attachments.js";

// Assistant C2: files in the chat and actions behind confirmation cards. Write
// tools never run from a model call; Run executes the stored args (hash-checked,
// 15 min); no chat tool finalizes / deletes / activates / touches users; lab
// results and batch facts only from the person's own words (or a supplier COA);
// every attachment and write stays in one company. The model is a script.

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const PDF = fs.readFileSync(path.join(process.cwd(), "fixtures", "certificates", "outlined_text.pdf"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const admin = { kind: "user", id: crypto.randomUUID(), name: "actions admin", permissions: null };
const companyActor = (c) => ({ kind: "company", id: c.id, name: c.name, companyId: c.id });
const script = (steps) => {
  const seen = [];
  return {
    seen,
    generate: async (req) => {
      seen.push(JSON.parse(JSON.stringify(req)));
      const step = steps[Math.min(seen.length - 1, steps.length - 1)];
      return { content: { role: "model", parts: typeof step === "function" ? step(req) : step }, usage: { promptTokenCount: 5, candidatesTokenCount: 1 } };
    },
  };
};
const call = (name, args) => ({ functionCall: { name, args } });

async function seed(c, tag) {
  const product = await prisma.product.create({ data: { companyId: c.id, name: `Actprod ${tag}`, storage: "Cool place" } });
  const invoice = await prisma.invoice.create({ data: { companyId: c.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `ACT-${tag}` } } });
  await prisma.invoiceItem.create({ data: { invoiceId: invoice.id, lineNo: 1, data: { name: "Unknown thing", batchNo: "B-77" }, dataExtracted: {}, matchStatus: "needs_match" } });
  return { product, invoice };
}

async function main() {
  console.log("🧪 Assistant C2 — files and confirmed actions\n");
  const cA = await createCompany(`actA${s}`);
  const cB = await createCompany(`actB${s}`);
  const A = await seed(cA, `a${s}`);
  const B = await seed(cB, `b${s}`);
  const actorA = companyActor(cA);
  const actorB = companyActor(cB);
  await assistant.updateSettings(cA.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
  await assistant.updateSettings(cB.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });

  try {
    // ── the registry's rules ────────────────────────────────────────────────
    console.log("What the chat can never do");
    const names = registry.allTools().map((t) => t.name);
    assert("no chat tool finalizes, deletes, activates, applies, or touches users / roles / companies", !names.some((n) => registry.FORBIDDEN_ACTIONS.test(n) && registry.getTool(n).risk !== "read"), names.filter((n) => /finali|delete|activ|apply|user|role/.test(n)));
    for (const bad of ["finalize_certificates", "delete_invoice", "activate_template", "apply_catalogue_changes", "update_users", "create_roles", "update_company"]) {
      let err = null;
      try {
        registry.defineTool({ name: bad, module: "x", risk: "write", label: "x", description: "TEST: must be refused by the registry whatever it does.", args: z.object({}), preview: async () => ({}), run: async () => {} });
      } catch (e) {
        err = e;
      }
      assert(`${bad} can't be defined`, !!err);
    }
    const writes = registry.allTools().filter((t) => t.risk !== "read");
    assert(`the ${writes.length} write tools each need a preview and one company`, writes.length >= 10 && writes.every((t) => typeof t.preview === "function" && t.needsCompany));

    // a counting write tool, to prove when run happens
    let runs = 0;
    registry.defineTool({ name: "test_count_write", module: "products", risk: "write", label: "x", description: "TEST ONLY: counts how often run is called, to prove a card gates it.", args: z.object({ n: z.number() }), preview: async (a) => ({ title: `count ${a.n}`, details: [{ label: "n", value: String(a.n) }] }), run: async (a) => ({ n: a.n, runs: ++runs }) });

    console.log("\nCards: nothing runs without Run");
    const conv = await assistant.createConversation(actorA);
    let m = script([[call("test_count_write", { n: 7 })], [{ text: "I've prepared a card for you." }]]);
    const turn = await assistant.sendMessage(actorA, conv.id, { text: "count to 7" }, { generate: m.generate });
    const card = turn.message.actions[0];
    assert("a write tool call makes a pending card and does NOT run", card?.status === "pending" && card.preview.title === "count 7" && runs === 0, card);
    assert("…the model is told nothing has happened yet", JSON.stringify(m.seen[1].contents.at(-1)).includes("NOTHING has happened yet"));
    const row = await prisma.assistantAction.findUnique({ where: { id: card.id } });
    assert("the card stores the exact args, a hash, its company and a 15-minute expiry", row.args.n === 7 && row.argsHash === actions.argsHashOf(row) && row.companyId === cA.id && Math.abs(row.expiresAt - row.createdAt - 15 * 60_000) < 2000);

    let err = null;
    try {
      await actions.approveAction(actorB, card.id);
    } catch (e) {
      err = e;
    }
    assert("someone else can't run my card (404)", err?.statusCode === 404 && runs === 0);
    await prisma.assistantAction.update({ where: { id: card.id }, data: { args: { n: 999 } } });
    err = null;
    try {
      await actions.approveAction(actorA, card.id);
    } catch (e) {
      err = e;
    }
    assert("args changed after the card was shown → refused, never run", err?.statusCode === 409 && runs === 0, err?.message);
    await prisma.assistantAction.update({ where: { id: card.id }, data: { args: { n: 7 } } });
    const done = await actions.approveAction(actorA, card.id);
    assert("Run executes exactly the stored args, once", done.status === "done" && done.result.n === 7 && runs === 1 && done.decidedBy === "you" && done.decidedAt);
    err = null;
    try {
      await actions.approveAction(actorA, card.id);
    } catch (e) {
      err = e;
    }
    assert("a second Run is refused", err?.statusCode === 409 && runs === 1);

    m = script([[call("test_count_write", { n: 8 })], [{ text: "Card ready." }]]);
    const late = (await assistant.sendMessage(actorA, conv.id, { text: "count to 8" }, { generate: m.generate })).message.actions[0];
    await prisma.assistantAction.update({ where: { id: late.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    err = null;
    try {
      await actions.approveAction(actorA, late.id);
    } catch (e) {
      err = e;
    }
    assert("an expired card is refused (410) and marked expired", err?.statusCode === 410 && runs === 1 && (await prisma.assistantAction.findUnique({ where: { id: late.id } })).status === "expired");
    m = script([[call("test_count_write", { n: 9 })], [{ text: "Card ready." }]]);
    const nope = (await assistant.sendMessage(actorA, conv.id, { text: "count to 9" }, { generate: m.generate })).message.actions[0];
    const cancelled = await actions.cancelAction(actorA, nope.id);
    assert("Cancel closes it with who and when; it never runs", cancelled.status === "cancelled" && cancelled.decidedAt && runs === 1);
    const audit = await prisma.assistantToolCall.findMany({ where: { conversationId: conv.id }, select: { status: true, tool: true } });
    assert("audit: the card shown, Run, refusals, expiry and Cancel are all recorded", ["needs_confirmation", "approved_ok", "refused", "expired", "cancelled"].every((st) => audit.some((a) => a.status === st)), audit.map((a) => a.status));

    // ── All companies is read-only ─────────────────────────────────────────
    console.log("\nCompany");
    const adminConv = await assistant.createConversation(admin, { companyId: "all" });
    m = script([[call("match_invoice_line", { invoiceId: A.invoice.id, lineNo: 1, productId: A.product.id })], [{ text: "Which company?" }]]);
    const allTurn = await assistant.sendMessage(admin, adminConv.id, { text: "match line 1" }, { generate: m.generate });
    assert("with All companies a write makes no card and the model is told to ask which company", allTurn.message.actions.length === 0 && /needs one company/.test(allTurn.message.toolCalls[0].error));
    m = script([[call("match_invoice_line", { invoiceId: A.invoice.id, lineNo: 1, productId: A.product.id })], [{ text: "Card ready." }]]);
    const adminTurn = await assistant.sendMessage(admin, adminConv.id, { text: "for company A", companyId: cA.id }, { generate: m.generate });
    assert("…with a company picked, the card runs in that company", adminTurn.message.actions[0]?.companyId === cA.id);

    // ── every write tool, aimed at the other company ─────────────────────────
    console.log("\nTenant isolation for every write");
    const attB = (await storeAttachments({ conversationId: (await assistant.createConversation(actorB)).id, companyId: cB.id, actor: actorB, files: [{ buffer: PDF, originalname: "b.pdf" }] }))[0];
    const hostile = { attachmentId: attB.id, attachmentIds: [attB.id], invoiceId: B.invoice.id, productId: B.product.id, lineNo: 1, country: "Egypt", edition: "2026", changes: [{ field: "storage", value: "x" }], values: { name: "x" }, companyId: cB.id };
    const before = await prisma.assistantAction.count();
    for (const t of registry.toolsFor(actorA).filter((x) => x.risk !== "read")) {
      if (t.name.startsWith("test_")) continue;
      const args = Object.fromEntries(Object.keys(t.args.shape).filter((k) => k in hostile).map((k) => [k, hostile[k]]));
      const r = await registry.runTool(t.name, { ...args, companyId: cB.id }, { actor: actorA, scope: { companyId: cA.id }, conversationId: conv.id, userTexts: [], propose: async () => { throw new Error(`card proposed for ${t.name}`); } });
      if (r.ok || r.companyId !== cA.id) assert(`${t.name} on company B's data makes no card`, false, r);
    }
    assert("no write tool proposes a card on another company's invoice / product / file", (await prisma.assistantAction.count()) === before);
    let foreign = null;
    try {
      await loadAttachment(attB.id, { conversationId: conv.id, companyId: cA.id });
    } catch (e) {
      foreign = e;
    }
    assert("another company's attachment is not found", foreign?.statusCode === 404);

    // ── protected data ───────────────────────────────────────────────────────
    console.log("\nLab results and batch facts");
    const ctx = (userTexts) => ({ actor: actorA, scope: { companyId: cA.id }, conversationId: conv.id, userTexts, propose: async (p) => ({ id: "card", ...p }) });
    let r = await registry.runTool("update_product_fields", { productId: A.product.id, changes: [{ field: "specifications.Batch No", value: "LOT-555" }] }, ctx(["set the batch please"]));
    assert("a batch fact the person didn't type is refused in the tool", !r.ok && /lab result or batch fact/.test(r.error), r);
    r = await registry.runTool("update_product_fields", { productId: A.product.id, changes: [{ field: "specifications.pH result", value: "6.8" }] }, ctx(["what's the ph?"]));
    assert("a lab result the person didn't type is refused", !r.ok && /lab result or batch fact/.test(r.error));
    r = await registry.runTool("update_product_fields", { productId: A.product.id, changes: [{ field: "specifications.Batch No", value: "LOT-555" }] }, ctx(["the batch is LOT-555"]));
    assert("…the same value typed verbatim by the person gets a card", r.status === "needs_confirmation");
    r = await registry.runTool("create_product_from_line", { invoiceId: A.invoice.id, lineNo: 1, values: { expiryDate: "2027-01-01" } }, ctx([]));
    assert("create_product_from_line has no batch / date fields at all", !r.ok && /Invalid arguments/.test(r.error));
    assert("lab results come in only through upload_supplier_coa (the COA verifier)", registry.getTool("upload_supplier_coa")?.risk === "write" && !registry.allTools().some((t) => /lab_result/.test(t.name) && t.risk !== "read"));

    // ── real actions through a card ─────────────────────────────────────────
    console.log("\nActions run through the existing services");
    const prodTurn = await registry.runTool("update_product_fields", { productId: A.product.id, changes: [{ field: "storage", value: "Below 25 °C" }, { field: "specifications.pH", value: "6.5-7.5" }] }, { ...ctx([]), propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor: actorA, ...p }) });
    const prodCard = await prisma.assistantAction.findUnique({ where: { id: prodTurn.data.actionId } });
    assert("the card shows old → new", prodCard.preview.details.some((d) => d.value === "Cool place → Below 25 °C") && prodCard.preview.details.some((d) => d.value === "— → 6.5-7.5"), prodCard.preview);
    assert("…and nothing changed yet", (await prisma.product.findUnique({ where: { id: A.product.id } })).storage === "Cool place");
    await actions.approveAction(actorA, prodCard.id);
    const prod = await prisma.product.findUnique({ where: { id: A.product.id } });
    assert("after Run the product has the new values", prod.storage === "Below 25 °C" && prod.specifications.values.pH === "6.5-7.5");

    const matchTurn = await registry.runTool("match_invoice_line", { invoiceId: A.invoice.id, lineNo: 1, productId: A.product.id }, { ...ctx([]), propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor: actorA, ...p }) });
    await actions.approveAction(actorA, matchTurn.data.actionId);
    const item = await prisma.invoiceItem.findFirst({ where: { invoiceId: A.invoice.id, lineNo: 1 } });
    assert("match_invoice_line after Run: the line is matched by a person", item.productId === A.product.id && item.matchStatus === "matched" && item.matchMethod === "user", item);

    const attA = (await storeAttachments({ conversationId: conv.id, companyId: cA.id, actor: actorA, files: [{ buffer: PDF, originalname: "INV-2026-0144.pdf" }] }))[0];
    assert("an attachment is stored in its company like any upload", (await prisma.storedFile.findFirst({ where: { companyId: cA.id, kind: "assistant_attachment" } })) !== null && attA.pages >= 1);
    m = script([[call("inspect_attachment", { attachmentId: attA.id })], [call("upload_invoice", { attachmentId: attA.id })], [{ text: "Here is the card to upload INV-2026-0144.pdf." }]]);
    const upTurn = await assistant.sendMessage(actorA, conv.id, { text: "upload this invoice", attachmentIds: [attA.id] }, { generate: m.generate });
    assert("the model sees the file by id, never its bytes", /\[attached: [0-9a-f-]{36} · INV-2026-0144\.pdf · application\/pdf/.test(JSON.stringify(m.seen[0].contents.at(-1))) && !JSON.stringify(m.seen).includes(PDF.subarray(0, 40).toString("base64")));
    const upCard = upTurn.message.actions[0];
    assert("upload_invoice card: file, company, types, AI use", upCard?.preview.details.some((d) => d.label === "File" && d.value.startsWith("INV-2026-0144.pdf")) && upCard.preview.aiCalls.includes("AI call"), upCard?.preview);
    assert("the answer naming the file and the card is not blocked by the grounding check", upTurn.message.text.includes("INV-2026-0144.pdf") && !upTurn.message.grounding);
    const invoicesBefore = await prisma.invoice.count({ where: { companyId: cA.id } });
    const ran = await actions.approveAction(actorA, upCard.id);
    assert("after Run the existing invoice job starts in company A (a running card with its task)", ran.status === "running" && ran.taskId && (await prisma.invoice.count({ where: { companyId: cA.id } })) === invoicesBefore + 1, ran);

    // the card's job finishes → the model is told and continues
    await prisma.backgroundTask.update({ where: { id: ran.taskId }, data: { status: "completed", progress: 100 } });
    const prog = await actions.refreshAction(actorA, ran.id);
    assert("the progress comes from the existing task; done when it completes", prog.action.status === "done" && prog.task.progress === 100);
    m = script([[{ text: "The invoice was uploaded." }]]);
    const cont = await assistant.continueAfterAction(actorA, conv.id, ran.id, { generate: m.generate });
    assert("when it is done the model gets the result and continues", JSON.stringify(m.seen[0].contents).includes("[action finished]") && JSON.stringify(m.seen[0].contents).includes("Upload invoice") && cont.message.text === "The invoice was uploaded.");
    const ev = await prisma.assistantMessage.findUnique({ where: { id: cont.userMessageId } });
    assert("…as an event, not as a message the person typed", ev.role === "event");

    // ── API ──────────────────────────────────────────────────────────────────
    console.log("\nAPI");
    let res = await api("POST", `/assistant/conversations/${conv.id}/attachments`, asCompany(cA.id), form({}, { field: "files", buffer: PNG, name: "label.png", type: "image/png" }));
    assert("attach: a PNG is stored (201)", res.status === 201 && res.data.data.attachments[0].mimeType === "image/png", res.data);
    res = await api("POST", `/assistant/conversations/${conv.id}/attachments`, asCompany(cA.id), form({}, { field: "files", buffer: Buffer.from("hello"), name: "x.txt", type: "text/plain" }));
    assert("attach: a text file is refused by its bytes", res.status === 400 && /PDF, PNG, JPEG or WebP/.test(res.data.message));
    res = await api("POST", `/assistant/conversations/${conv.id}/attachments`, asCompany(cB.id), form({}, { field: "files", buffer: PNG, name: "x.png", type: "image/png" }));
    assert("attach to another company's conversation → 404", res.status === 404);
    const allConv = (await api("POST", "/assistant/conversations", asAdmin, { companyId: "all" })).data.data.conversation;
    res = await api("POST", `/assistant/conversations/${allConv.id}/attachments`, asAdmin, form({}, { field: "files", buffer: PNG, name: "x.png", type: "image/png" }));
    assert("attach with All companies → 400 pick a company", res.status === 400 && /Pick a company/.test(res.data.message));
    m = script([[call("test_count_write", { n: 11 })], [{ text: "Card." }]]);
    const apiCard = (await assistant.sendMessage(actorA, conv.id, { text: "count 11" }, { generate: m.generate })).message.actions[0];
    res = await api("POST", `/assistant/actions/${apiCard.id}/approve`, asCompany(cB.id));
    assert("approve someone else's card over the API → 404", res.status === 404);
    res = await api("POST", `/assistant/actions/${apiCard.id}/cancel`, asCompany(cA.id));
    assert("cancel over the API", res.status === 200 && res.data.data.action.status === "cancelled");
    res = await api("GET", `/assistant/conversations/${conv.id}`, asCompany(cA.id));
    assert("the conversation returns its cards on their messages", res.status === 200 && res.data.data.conversation.messages.some((x) => x.actions?.some((a) => a.id === apiCard.id)));
  } finally {
    await prisma.assistantConversation.deleteMany({ where: { ownerId: { in: [cA.id, cB.id, admin.id] } } });
    await prisma.assistantSetting.deleteMany({ where: { scopeKey: { in: [cA.id, cB.id] } } });
    for (const c of [cA, cB]) {
      await prisma.backgroundTask.deleteMany({ where: { companyId: c.id } });
      await prisma.invoiceItem.deleteMany({ where: { invoice: { companyId: c.id } } });
      await prisma.invoice.deleteMany({ where: { companyId: c.id } });
      await prisma.storedFile.deleteMany({ where: { companyId: c.id } });
      await prisma.company.delete({ where: { id: c.id } }).catch((e) => console.log(`  (cleanup: ${e.message})`));
    }
    await prisma.$disconnect();
  }
  console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
  process.exit(counts.failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
