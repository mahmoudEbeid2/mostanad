import { prisma } from "../src/lib/prisma.js";
import { makeAssert, createCompany } from "./certificates-v2/helpers.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import { entityCandidates, checkGrounding, corpusOf, stripTypedLists, numberCandidates } from "../src/services/assistant/agent/grounding.js";
import { searchProductsForAssistant } from "../src/services/assistant/productSearch.js";
import { runTool } from "../src/services/assistant/registry/index.js";
import { countEntities, periodRange } from "../src/services/assistant/reads.js";

// Item 1 of the C2 brief: the assistant invented 25 products ("اعرض الباقي" with no tool
// call). Lists are table blocks the model never types, "more" uses the cursor, answers
// naming things no tool returned are blocked, close search hits are "close", counts are
// per Cairo week with every company. The model is a script: no Gemini call is made.

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const admin = { kind: "user", id: crypto.randomUUID(), name: "grounding admin", permissions: null };

const script = (steps) => {
  const seen = [];
  const generate = async (req) => {
    seen.push(JSON.parse(JSON.stringify(req)));
    const step = steps[Math.min(seen.length - 1, steps.length - 1)];
    return { content: { role: "model", parts: typeof step === "function" ? step(req) : step }, usage: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  };
  return { generate, seen };
};
const call = (name, args) => ({ functionCall: { name, args } });

async function main() {
  console.log("🧪 Assistant item 1 — no invented data\n");
  const co = await createCompany(`grd${s}`);
  const other = await createCompany(`grdzero${s}`);
  const names = Array.from({ length: 60 }, (_, i) => `Prod ${String(i + 1).padStart(2, "0")} ${s}`);
  for (const [i, name] of names.entries()) await prisma.product.create({ data: { companyId: co.id, name, productCode: `G${i}-${s}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) } });
  const moxy = await prisma.product.create({ data: { companyId: co.id, name: "MOXYVET", productCode: `MX-${s}` } });

  try {
    // ── the real conversation, replayed ─────────────────────────────────────
    console.log("Paging: 'get all products', next 25, 'اعرض الباقي'");
    const conv = await assistant.createConversation(admin, { companyId: co.id });
    const listArgs = { sort: "name", limit: 25 };
    let m = script([[call("list_products", listArgs)], [{ text: "Here are 25 of 61 products." }]]);
    const r1 = await assistant.sendMessage(admin, conv.id, { text: "get all products" }, { generate: m.generate });
    const block1 = r1.message.blocks[0];
    assert("page 1: rows come back as a table block, not in the text", block1?.type === "table" && block1.rows.length === 25 && block1.nextPage === 2 && !r1.message.text.includes("Prod 01"), r1.message);
    const dbOrder = (await prisma.product.findMany({ where: { companyId: co.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }));
    assert("…and they are the real rows, in order", block1.rows.every((r, i) => r.ref?.id === dbOrder[i].id && r.cells.name === dbOrder[i].name));

    m = script([(req) => [call("list_products", { ...listArgs, page: /nextPage=2/.test(JSON.stringify(req.contents)) ? 2 : 1 })], [{ text: "Here are the next 25." }]]);
    const r2 = await assistant.sendMessage(admin, conv.id, { text: "هاتلي كل المونتجات" }, { generate: m.generate });
    assert("the history tells the model the cursor (nextPage=2)", JSON.stringify(m.seen[0].contents).includes("nextPage=2"));
    assert("page 2 rows are rows 26–50", r2.message.blocks[0]?.rows[0]?.ref?.id === dbOrder[25].id && r2.message.blocks[0].rows.length === 25);

    // the bug: no tool call, a list typed from "memory"
    const invented = "Here are the rest:\n- **COLIVET**\n- **DOXYVET**\n- **TYLOVET**\n- **KETAMINEVET**\n- **XYLAZINEVET**\n\n…and 14 more.";
    m = script([
      [{ text: invented }],
      (req) => (/system check/.test(JSON.stringify(req.contents.at(-1))) ? [call("list_products", { ...listArgs, page: 3 })] : [{ text: "?" }]),
      [{ text: "Here are the last 11 products." }],
    ]);
    const r3 = await assistant.sendMessage(admin, conv.id, { text: "اعرض الباقي" }, { generate: m.generate });
    assert("'اعرض الباقي' with no tool call and invented names is NOT shown", !/COLIVET|DOXYVET|TYLOVET/.test(r3.message.text), r3.message.text);
    assert("…the model is told to call the tool with the cursor and does", r3.message.toolCalls.some((c) => c.name === "list_products" && c.args.page === 3) && /nextPage=3/.test(JSON.stringify(m.seen[0].contents)));
    assert("…and the rows shown are the real last 11 (51–61)", r3.message.blocks[0]?.rows.length === 11 && r3.message.blocks[0].rows.every((r, i) => r.ref?.id === dbOrder[50 + i].id) && r3.message.blocks[0].nextPage === null);
    assert("the blocked first answer is recorded", r3.message.grounding?.firstUnknown?.includes("COLIVET") && r3.message.grounding.blocked === false);

    m = script([[{ text: invented }]]);
    const r4 = await assistant.sendMessage(admin, conv.id, { text: "اعرض الباقي تاني" }, { generate: m.generate });
    assert("invented twice → 'I couldn't get that from the system' (in Arabic), logged", r4.message.text === "لم أستطع الحصول على ذلك من النظام." && r4.message.grounding?.blocked === true && r4.message.grounding.unknown.includes("DOXYVET"), r4.message);
    assert("…after exactly one retry", m.seen.length === 2);

    m = script([[{ text: "You have **61** products and **COLIVET** is the best seller." }]]);
    const r5 = await assistant.sendMessage(admin, conv.id, { text: "how many products?" }, { generate: m.generate });
    assert("a turn with no tool call that states data is blocked too", r5.message.grounding?.blocked === true);

    // Load more: the same tool + cursor, no model call
    console.log("\nLoad more");
    const more = await assistant.loadMore(admin, conv.id, r1.message.id, block1.id);
    assert("Load more appends the next page from the tool (no model call)", more.added === 25 && more.block.rows.length === 50 && more.block.rows[25].ref.id === dbOrder[25].id && more.block.nextPage === 3);
    const stored = await prisma.assistantMessage.findUnique({ where: { id: r1.message.id } });
    assert("…kept on the message, and audited as a tool call", stored.blocks[0].rows.length === 50 && (await prisma.assistantToolCall.count({ where: { messageId: r1.message.id, tool: "list_products" } })) === 2);
    const other2 = { kind: "company", id: other.id, name: other.name, companyId: other.id };
    await assistant.updateSettings(other.id, { enabled: true });
    let denied = null;
    try {
      await assistant.loadMore(other2, conv.id, r1.message.id, block1.id);
    } catch (e) {
      denied = e;
    }
    assert("someone else can't load more of my table (404)", denied?.statusCode === 404);
    const all = await assistant.loadMore(admin, conv.id, r2.message.id, r2.message.blocks[0].id, { all: true });
    assert("Show all fetches every remaining page with the cursor", all.block.rows.length === 61 - 25 && all.block.nextPage === null && all.block.rows.at(-1).ref.id === dbOrder[60].id, all.block.rows.length);

    // ── grounding units ──────────────────────────────────────────────────────
    console.log("\nGrounding check");
    assert("candidates: CODES, UPPER-CASE names, bold names", ["DOXYVET", "ZYIV25001", "Vitaminol 500"].every((c) => entityCandidates("Invoice ZYIV25001 has DOXYVET and **Vitaminol 500**.").includes(c)));
    assert("allowed words (COA, FSC, PDF) aren't entities", entityCandidates("Make COA and FSC as PDF").length === 0);
    const corpus = corpusOf(["MOXYVET", "89", "Agrikima"]);
    assert("a name a tool returned passes; one it didn't is blocked", checkGrounding("The closest is **MOXYVET**.", corpus, { toolCallsThisTurn: 1 }).ok && !checkGrounding("**DOXYVET** is there", corpus, { toolCallsThisTurn: 1 }).ok);
    assert("numbers are checked on a turn without a tool call", !checkGrounding("You have 186 certificates.", corpus).ok && checkGrounding("You have 89 products.", corpus).ok && numberCandidates("41% of 2026-11-20").length === 0);
    assert("typed tables and long lists are removed", stripTypedLists("Here:\n| a | b |\n|---|---|\n| 1 | 2 |\n- A\n- B\n- C\n- D\nDone.") === "Here:\nDone.");
    assert("a short list stays", stripTypedLists("Two options:\n- yes\n- no") === "Two options:\n- yes\n- no");

    // ── search labels ────────────────────────────────────────────────────────
    console.log("\nSearch labels");
    let r = await searchProductsForAssistant({ companyId: co.id, queries: ["DOXYVET"] });
    assert("DOXYVET → MOXYVET is 'close', never 'exact'", r.verdict === "close" && r.results[0]?.productId === moxy.id, r);
    r = await searchProductsForAssistant({ companyId: co.id, queries: ["moxyvet"] });
    assert("the exact name → exact", r.verdict === "exact" && r.results[0].via.includes("exact_name"), r);
    r = await searchProductsForAssistant({ companyId: co.id, queries: [`mx-${s}`] });
    assert("the exact code → exact", r.verdict === "exact");
    r = await searchProductsForAssistant({ companyId: co.id, queries: ["completely-unknown-qq"] });
    assert("nothing → none", r.verdict === "none");
    const doxy = await prisma.product.create({ data: { companyId: other.id, name: "DOXYVET", createdAt: new Date("2026-01-01T00:00:00Z") } });
    await prisma.product.create({ data: { companyId: other.id, name: "MOXYVET", createdAt: new Date("2026-01-01T00:00:00Z") } });
    r = await searchProductsForAssistant({ companyId: other.id, queries: ["DOXYVET"] });
    assert("…and where DOXYVET exists it comes back exact, not MOXYVET", r.verdict === "exact" && r.results[0].productId === doxy.id, r);

    // every product the list tool shows is found by its exact name and code
    console.log("\nEvery listed product is findable (exact name and code)");
    const tricky = ["AD3E +CK", "FLOVET+", "FLOVET 10", "DCP 18%", "DOXYCOLINE - L", "SULFAVET-480", "VITA-C MAX 100%", "L-LYSINE HCL 98.5%", "B-COMPLEX", "VET PLUS", "UNI-CHOL 60%", "فيتامينول", "under_score"];
    for (const [i, name] of tricky.entries()) await prisma.product.create({ data: { companyId: co.id, name: `${name} ${s}`, productCode: `T${i}-${name.replace(/\s/g, "").slice(0, 6)}-${s}` } });
    const vetline = await prisma.company.findFirst({ where: { products: { some: {} }, NOT: { id: { in: [co.id, other.id] } } }, orderBy: { products: { _count: "desc" } } });
    const listAll = async (actor, scopeId) => {
      const rows = [];
      for (let page = 1; page < 50; page++) {
        const res = await runTool("list_products", { sort: "name", limit: 25, page }, { actor, scope: { companyId: scopeId }, companyExists: async () => true });
        rows.push(...res.data.items);
        if (!res.data.nextPage) break;
      }
      return rows;
    };
    for (const [label, actor, scopeId] of [
      ["admin, All companies", admin, null],
      ["a company user", { kind: "company", id: co.id, name: co.name, companyId: co.id }, co.id],
      ...(vetline ? [[`${vetline.name} (real local data) as its company`, { kind: "company", id: vetline.id, name: vetline.name, companyId: vetline.id }, vetline.id]] : []),
    ]) {
      const listed = await listAll(actor, scopeId);
      const missed = [];
      for (const row of listed) {
        const byName = await searchProductsForAssistant({ companyId: scopeId, queries: [row.name] });
        if (byName.verdict !== "exact" || !byName.results.some((x) => x.productId === row.id && x.via.includes("exact_name"))) missed.push(`name:${row.name}`);
        const spaced = await searchProductsForAssistant({ companyId: scopeId, queries: [row.name.toLowerCase().replace(/\s+/g, "")] });
        if (!spaced.results.some((x) => x.productId === row.id && x.via.includes("exact_name"))) missed.push(`nospace:${row.name}`);
        if (row.productCode) {
          const byCode = await searchProductsForAssistant({ companyId: scopeId, queries: [` ${row.productCode.toLowerCase()} `] });
          if (!byCode.results.some((x) => x.productId === row.id && x.via.includes("code"))) missed.push(`code:${row.productCode}`);
        }
      }
      assert(`${label}: all ${listed.length} listed products found exactly by name (any case, no spaces) and code`, listed.length > 0 && missed.length === 0, missed.slice(0, 10));
    }
    r = await searchProductsForAssistant({ companyId: co.id, queries: [`Prod 0 ${s}`] });
    assert("several similar names → close, with every candidate", r.verdict === "close" && r.results.length > 1);

    // ── counts: Cairo week, every company ───────────────────────────────────
    console.log("\nCounts");
    const now = new Date("2026-11-20T10:00:00Z"); // Friday in Cairo
    // a product of co inside that fixed week (the ones made above carry today's date, which moves on)
    await prisma.product.create({ data: { companyId: co.id, name: `week ${s}`, createdAt: new Date("2026-11-16T10:00:00Z") } });
    assert("this week (Cairo) = Sat 14 – Fri 20 Nov", JSON.stringify(periodRange("this_week", now)) === JSON.stringify(["2026-11-14", "2026-11-21"]));
    await prisma.product.create({ data: { companyId: other.id, name: `in ${s}`, createdAt: new Date("2026-11-13T22:30:00Z") } }); // Sat 00:30 Cairo (UTC+2)
    await prisma.product.create({ data: { companyId: other.id, name: `out ${s}`, createdAt: new Date("2026-11-13T21:30:00Z") } }); // Fri 23:30 Cairo
    const c1 = await countEntities(other.id, { entity: "products", period: "this_week", now });
    assert("the week boundary is midnight in Cairo, not UTC", c1.total === 1 && c1.from === "2026-11-14" && c1.timezone === "Africa/Cairo", c1);
    const c2 = await countEntities(null, { entity: "products", groupBy: "company", period: "this_week", now });
    assert("per company for All companies lists every company, zero included", c2.groups.some((g) => g.key === other.id && g.count === 1) && c2.groups.some((g) => g.key === co.id && g.count > 0) && c2.groups.some((g) => g.count === 0) && c2.groups.length === (await prisma.company.count()), { groups: c2.groups.length, companies: await prisma.company.count() });
    const c3 = await countEntities(co.id, { entity: "products", groupBy: "company", period: "this_week", now });
    assert("…and a company sees only its own row", c3.groups.length === 1 && c3.groups[0].key === co.id);
  } finally {
    await prisma.assistantConversation.deleteMany({ where: { ownerId: admin.id } });
    await prisma.assistantSetting.deleteMany({ where: { scopeKey: { in: [other.id] } } });
    await prisma.company.deleteMany({ where: { id: { in: [co.id, other.id] } } });
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
