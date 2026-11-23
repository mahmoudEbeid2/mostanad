import "dotenv/config";
import fs from "fs";
import path from "path";

// Live assistant eval (2026-11-23, model choice): 10 questions — reads, an
// Arabic question, a product that doesn't exist, and two writes that must end
// as confirmation cards (function calling) — against a seeded company, with the
// real model (AI_MODEL_ASSISTANT / AI_MODEL_DEFAULT decide which). Opt-in and
// paid: RUN_LIVE_GEMINI=1. Needs Postgres only (everything runs in this process).
//
//   RUN_LIVE_GEMINI=1 node scripts/evalAssistant.js [--out file.json]
//
// A question passes when the expected tool was called (or a card proposed for a
// write), the answer matches, and nothing forbidden appears (an invented
// product, a claim that a write already happened). Cleans up its company.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
process.env.GEMINI_DISABLED = "false";
const { createCompany, cleanupCompany, prisma } = await import("../tests/certificates-v2/helpers.js");
process.env.GEMINI_DISABLED = "false"; // helpers.js defaults tests to disabled; this run is the explicit exception
const assistant = await import("../src/services/assistant/assistantService.js");
const { MODELS } = await import("../src/services/ai/modelRegistry.js");

const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? process.argv[outArg + 1] : path.join(process.cwd(), "golden", `ai-eval-assistant-${new Date().toISOString().slice(0, 10)}.json`);
const s = Date.now().toString(36);

const co = await createCompany(`asst-eval-${s}`);
const actor = { kind: "company", id: co.id, name: co.name, companyId: co.id };
const card = { date: new Date().toISOString(), model: MODELS.ASSISTANT.id, questions: [], totals: {} };
try {
  await assistant.updateSettings(co.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
  const [b1, b2] = await Promise.all([prisma.brand.create({ data: { companyId: co.id, name: "Vetcare" } }), prisma.brand.create({ data: { companyId: co.id, name: "Farmline" } })]);
  await prisma.product.create({ data: { companyId: co.id, brandId: b1.id, name: "AMOXIVET 20%", productCode: "AMX20", withdrawalPeriod: "Meat: 3 days", storage: "Below 25 °C, dry place", activeIngredients: [{ name: "Amoxicillin trihydrate", concentration: "20%" }], registrationNumber: "VR-1001" } });
  await prisma.product.create({ data: { companyId: co.id, brandId: b1.id, name: "Vitaminol AD3E", productCode: "VIT1", storage: "Cool dry place", activeIngredients: [{ name: "Vitamin A", concentration: "10 MIU/L" }, { name: "Vitamin D3", concentration: "2 MIU/L" }, { name: "Vitamin E", concentration: "10 g/L" }] } });
  await prisma.product.create({ data: { companyId: co.id, brandId: b2.id, name: "Toxi-Bind", productCode: "TB5", storage: "Dry place" } });
  await prisma.invoice.create({ data: { companyId: co.id, sourceFileId: "00000000-0000-4000-8000-00000000e0a1", status: "review", header: { invoiceNumber: "EVAL-INV-77" } } });

  const Q = [
    { q: "How many products do we have?", tools: ["search_products", "list_products", "count_products", "get_products_overview"], answer: /\b3\b|three/i },
    { q: "What is the withdrawal period of AMOXIVET 20%?", tools: ["search_products", "get_product"], answer: /3 days/i },
    { q: "ما هي مكونات فيتامينول؟", tools: ["search_products", "get_product"], answer: /Vitamin A|فيتامين (أ|ا)|A/i },
    { q: "Which brands do we have?", tools: ["list_brands"], answer: /Vetcare[\s\S]*Farmline|Farmline[\s\S]*Vetcare/i },
    { q: "Which products have no registration number?", tools: ["products_missing_data", "search_products", "list_products", "get_products_missing_data"], answer: /Vitaminol|Toxi/i },
    { q: "What's the storage condition for Zorbax 50?", tools: ["search_products"], answer: /(didn't|did not|couldn't|could not|no product|not find|isn't|not found|no match|closest)/i, forbid: /Zorbax[^.]*(store|storage)[^.]*(°C|place)/i },
    { q: "How should AMOXIVET be stored?", tools: ["search_products", "get_product"], answer: /25/ },
    { q: "Change the storage of Vitaminol AD3E to: Below 30 °C", write: "update_product_fields", forbid: /\b(updated|changed|saved|done)\b(?![^.]*card)/i },
    { q: "Which invoices are waiting for review?", tools: ["search_invoices", "list_invoices"], answer: /EVAL-INV-77/ },
    { q: "Copy AMOXIVET 20% to the Farmline brand as Farmamox 20%", write: "copy_product_to_brand" },
  ];
  for (const item of Q) {
    const conv = await assistant.createConversation(actor);
    const t0 = Date.now();
    let turn = null;
    let error = null;
    try {
      turn = await assistant.sendMessage(actor, conv.id, { text: item.q });
    } catch (err) {
      error = err.message;
    }
    const m = turn?.message || {};
    const called = (m.toolCalls || []).map((c) => c.name || c.tool).filter(Boolean);
    const cards = (m.actions || []).map((a) => a.tool);
    const text = m.text || "";
    const toolOk = item.write ? cards.includes(item.write) || called.includes(item.write) : item.tools.some((t) => called.includes(t));
    const answerOk = item.answer ? item.answer.test(text) : true;
    const clean = item.forbid ? !item.forbid.test(text) : true;
    const pass = !error && !m.error && toolOk && answerOk && clean;
    card.questions.push({ q: item.q, pass, toolOk, answerOk, clean, called, cards, text: text.slice(0, 600), error: error || m.error || null, ms: Date.now() - t0, modelCalls: m.modelCalls ?? null, costUsd: m.costUsd ?? null });
    console.log(`${pass ? "ok  " : "FAIL"} ${item.q}  [tools: ${called.join(", ") || "—"}${cards.length ? ` · cards: ${cards.join(", ")}` : ""}] ${Date.now() - t0} ms${error || m.error ? ` · ${error || m.error}` : ""}`);
  }
  const n = card.questions.length;
  card.totals = {
    passed: card.questions.filter((q) => q.pass).length,
    of: n,
    errors: card.questions.filter((q) => q.error).length,
    avgMs: Math.round(card.questions.reduce((a, q) => a + q.ms, 0) / n),
    modelCalls: card.questions.reduce((a, q) => a + (q.modelCalls || 0), 0),
    costUsd: card.questions.every((q) => q.costUsd !== null) ? card.questions.reduce((a, q) => a + q.costUsd, 0) : null,
  };
  console.log(`\n${card.totals.passed}/${n} passed · ${card.totals.errors} errors · avg ${card.totals.avgMs} ms · ${card.totals.modelCalls} model calls · cost ${card.totals.costUsd ?? "unpriced"}`);
  fs.writeFileSync(OUT, JSON.stringify(card, null, 2));
} finally {
  await cleanupCompany(co.id).catch((e) => console.error(e.message));
  await prisma.$disconnect();
}
