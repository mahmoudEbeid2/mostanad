// Client report 24 Nov, item 8 (the assistant in production that day, before the
// fixes of 23 Nov were deployed). The model is a script; no Gemini call is made.
//  - "[tools used in this answer: list_products(…) → 25 of 25. Rows are not repeated
//    here…]" reached the person (Malven, Vetline).
//  - "اعرض المنتجات" for Vetline (82 products): the model copied the Malven turn's note,
//    called no tool, and wrote "25 of 25" — no table ("فين").
//  - "انت عندك كل ملفات addvet": no such company or brand.
// Needs Postgres (the tools run in this process).
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as registry from "../src/services/assistant/registry/index.js";
import * as actions from "../src/services/assistant/actions.js";
import { runAgent } from "../src/services/assistant/agent/agentLoop.js";
import { sanitizeOutput, announcesList } from "../src/services/assistant/agent/answerGuard.js";
import { SYSTEM_PROMPT } from "../src/services/assistant/agent/systemPrompt.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const admin = { kind: "user", id: "00000000-0000-4000-8000-000000000124", name: "list admin", permissions: null };
const script = (steps) => {
  const seen = [];
  const generate = async (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return { content: { role: "model", parts: step }, usage: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  };
  return { generate, seen };
};
const call = (name, args) => ({ functionCall: { name, args } });

async function main() {
  console.log("🧪 Assistant — lists, notes, records, unknown names\n");
  const co = await createCompany("Vetline QA");
  await prisma.product.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ companyId: co.id, name: `VL Product ${String(i + 1).padStart(2, "0")}` })) });
  const ctx = { actor: admin, scope: { companyId: null }, audit: async () => {}, companyExists: async (id) => !!(await prisma.company.findUnique({ where: { id } })) };
  const NOTE = `بالتأكيد، إليك المنتجات لشركة [Vetline](entity:company/${co.id}): [tools used in this answer: list_products({"companyId":"${co.id}"}) → 25 of 25. Rows are not repeated here: call the tool again to read them.]`;
  try {
    console.log("The tools note never reaches the person");
    const clean = sanitizeOutput(NOTE).text;
    assert("the bracket note is removed from any answer", !/tools used|Rows are not repeated|25 of 25/.test(clean), clean);

    console.log("\nA list announced with no tool call (the Vetline turn)");
    assert("'إليك المنتجات …:' and 'Here are the products:' announce a list", announcesList(clean) && announcesList("Here are the products:") && !announcesList("Vetline has 82 products."));
    let m = script([[{ text: NOTE }], [call("list_products", { companyId: co.id, limit: 25 })], [{ text: "هذه منتجات Vetline:" }]]);
    let out = await runAgent({ text: "اعرض المنتجات", ctx, generate: m.generate });
    const block = out.blocks.find((b) => b.type === "table" && b.tool === "list_products");
    assert("the model is sent back once to call the tool, and calls list_products", m.seen.length === 3 && JSON.stringify(m.seen[1].contents.at(-1)).includes("announces a list") && out.toolCalls.some((c) => c.name === "list_products" && c.ok), out.toolCalls);
    assert("…the rows come as a table block with the real total (30, not '25 of 25')", block?.total === 30 && block.rows.length === 25 && block.more === 5, { total: block?.total, rows: block?.rows?.length, more: block?.more });
    assert("…and the answer has no note in it", !/tools used|25 of 25/.test(out.text), out.text);
    m = script([[{ text: NOTE }], [{ text: NOTE }]]);
    out = await runAgent({ text: "اعرض المنتجات", ctx, generate: m.generate });
    assert("still no tool call → it says plainly it didn't fetch the list (in Arabic), no invented rows", /لم أجلب القائمة/.test(out.text) && !out.blocks.length && out.guard?.some((g) => g.type === "list_without_data"), out.text);
    m = script([[call("list_products", { companyId: co.id, limit: 10 })], [{ text: "Here are the products:" }]]);
    out = await runAgent({ text: "show Vetline's products", ctx, generate: m.generate });
    assert("a list answer with its tool call is left alone", m.seen.length === 2 && out.blocks.some((b) => b.tool === "list_products") && !out.guard?.some((g) => g.type === "list_without_data"), out.guard);

    console.log("\nOne product → a record card, not raw keys");
    const p = await prisma.product.findFirst({ where: { companyId: co.id } });
    m = script([[call("get_product", { productId: p.id })], [{ text: `${p.name}\n- name: ${p.name}\n- packaging: (فارغ)\n- targetSpecies: (فارغ)` }]]);
    out = await runAgent({ text: `اعرض ${p.name}`, ctx, generate: m.generate });
    const rec = out.blocks.find((b) => b.type === "record");
    assert("get_product → a record card with labels (Arabic / English)", rec?.tool === "get_product" && rec.fields.some((f) => f.key === "name" && f.label?.ar && f.label?.en), rec);
    assert("…and the typed raw keys are gone from the text", !/packaging:|targetSpecies:/.test(out.text), out.text);

    console.log("\nA name that is no company and no brand (addvet)");
    const unknown = `Qzxw${Date.now()}`; // a name no company and no brand has
    let t = await registry.runTool("list_companies", { q: unknown }, ctx);
    const t2 = await registry.runTool("list_brands", { q: unknown }, ctx);
    assert("list_companies / list_brands: an unknown name finds nothing (the assistant can say so)", t.status === "ok" && t.data.items.length === 0 && t2.status === "ok" && t2.data.items.length === 0, { companies: t.data?.items?.map((c) => c.name), brands: t2.data?.items });
    const conv = await assistant.createConversation({ kind: "company", id: co.id, name: co.name, companyId: co.id }, {}).catch(() => null);
    const actor = { kind: "company", id: co.id, name: co.name, companyId: co.id };
    await assistant.updateSettings(co.id, { enabled: true });
    const conv2 = conv || (await assistant.createConversation(actor, {}));
    const cctx = { actor, scope: { companyId: co.id }, conversationId: conv2.id, userTexts: ["add the brand AddVet"], propose: (x) => actions.proposeAction({ conversationId: conv2.id, messageId: null, actor, ...x }) };
    t = await registry.runTool("create_brand", { name: "AddVet" }, cctx);
    const card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    assert("create_brand → a card (nothing added before Run)", card?.status === "pending" && card.preview.details.some((d) => d.label === "Brand" && d.value === "AddVet") && (await prisma.brand.count({ where: { companyId: co.id } })) === 0, t.data?.draft?.error || card?.preview);
    const done = await actions.approveAction(actor, card.id);
    assert("Run → the brand exists in the company", done.status === "done" && (await prisma.brand.count({ where: { companyId: co.id, name: "AddVet" } })) === 1, done.error);
    t = await registry.runTool("create_brand", { name: "addvet" }, cctx);
    assert("the same brand again → no card (it exists)", !t.data?.actionId && /already has the brand AddVet/.test(t.data?.draft?.error || t.error || ""), t.data?.draft?.error || t.error);
    t = await registry.runTool("list_brands", { q: "Add Vet" }, { ...ctx, scope: { companyId: co.id } });
    assert("list_brands finds it now (asked again, not answered from memory)", t.data.items[0]?.name === "AddVet" && t.data.items[0].match === "exact", t.data.items);
    assert("the prompt: say when a name isn't there, offer create_brand, companies on the Companies page", /create_brand/.test(SYSTEM_PROMPT) && /Companies page/.test(SYSTEM_PROMPT) && /again each time it comes up/.test(SYSTEM_PROMPT));
  } finally {
    await prisma.assistantConversation.deleteMany({ where: { OR: [{ ownerId: admin.id }, { companyId: co.id }] } }).catch(() => {});
    await cleanupCompany(co.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
