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
  } finally {
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
