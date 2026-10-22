import "dotenv/config";
import fs from "fs";
import path from "path";

// Live product-matching run (plan.md §7 acceptance, §10) — the real model on
// the golden supplier invoices (fixtures/certificates/matching/goldens.json).
// Opt-in and paid: RUN_LIVE_GEMINI=1, and the process must not have
// GEMINI_DISABLED set. Needs Postgres only (everything runs in THIS process).
// At most 2 CERT_PRODUCT_MATCH calls: invoice 1, then invoice 2 after a
// person confirmed invoice 1 as expected (should be 0 calls — aliases).
//
//   RUN_LIVE_GEMINI=1 npm run eval:cert-matching
//
// Bar: ≥ 95 % of lines correctly matched or correctly left for the user,
// 0 cross-tenant candidates, 0 AI calls on the second invoice. Writes
// golden/ai-eval-match-<date>.json; a drop of more than 2 points vs the
// previous matching scorecard exits 1. Cleans up its test companies.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
if (process.env.GEMINI_DISABLED === "true") {
  console.error("Refusing to run: GEMINI_DISABLED=true in this process.");
  process.exit(2);
}

const { seedMatchingCompanies, runMatching, GOLDEN } = await import("../tests/certificates-v2/matchingGoldenHarness.js");
const { cleanupCompany, prisma } = await import("../tests/certificates-v2/helpers.js");
const { updateItem } = await import("../src/services/certificates/invoices/invoiceService.js");
process.env.GEMINI_DISABLED = "false"; // helpers.js defaults tests to disabled; this run is the explicit exception

const DIR = path.join(process.cwd(), "golden");
const MAX_DROP = 0.02;
const seed = await seedMatchingCompanies("a3live");
const card = { date: new Date().toISOString(), invoices: {}, totals: {} };
const report = (label, g) => {
  console.log(`${label}: ${g.score.correct}/${g.score.total} correct (${g.score.leftCorrectly} left for the user correctly, ${g.score.suggestedCorrect} as suggestions), cross-tenant ${g.score.crossTenant}, AI calls ${g.res.ai.calls}${g.res.ai.unavailable ? ` (unavailable: ${g.res.ai.reason})` : ""}`);
  for (const l of g.score.perLine) console.log(`  ${l.ok ? "ok  " : "MISS"} ${l.lineNo} ${l.name} → ${l.got ? `${l.got} [${l.method}]` : l.suggested ? `suggests ${l.suggested} (${l.aiConfidence})` : "left"}; expected ${l.expect ?? "left for the user"}`);
};
try {
  const g1 = await runMatching(seed, 0);
  report(GOLDEN.invoices[0].name, g1);
  // a person confirms invoice 1 as the golden set says (the AI's pick when it is the right one)
  for (const it of g1.items) {
    const want = GOLDEN.invoices[0].lines[it.lineNo - 1].expect;
    if (!want || (it.matchStatus === "matched" && it.productId === seed.products[want].id)) continue;
    const ai = (it.matchCandidates || []).find((c) => c.ai && c.productId === seed.products[want].id)?.ai;
    await updateItem(g1.inv.id, it.id, seed.company.id, { productId: seed.products[want].id, ...(ai ? { aiSuggestionId: ai.suggestionId } : {}) });
  }
  const g2 = await runMatching(seed, 1);
  report(GOLDEN.invoices[1].name, g2);
  for (const [k, g] of [["invoice1", g1], ["invoice2", g2]]) {
    const run = await prisma.aiRun.findFirst({ where: { companyId: seed.company.id, entityId: g.inv.id, kind: "CERT_PRODUCT_MATCH" }, orderBy: { createdAt: "desc" } });
    card.invoices[k] = { ...g.score, aiCalls: g.res.ai.calls, aiUnavailable: g.res.ai.unavailable ? g.res.ai.reason : null, tokens: run ? { input: run.inputTokens, output: run.outputTokens, thinking: run.thinkingTokens } : null };
  }
  card.totals = {
    correctRate: (g1.score.correct + g2.score.correct) / (g1.score.total + g2.score.total),
    crossTenant: g1.score.crossTenant + g2.score.crossTenant,
    secondInvoiceCalls: g2.res.ai.calls,
  };
} finally {
  await cleanupCompany(seed.company.id);
  await cleanupCompany(seed.foreign.id);
}

fs.mkdirSync(DIR, { recursive: true });
const previous = fs.readdirSync(DIR).filter((f) => /^ai-eval-match-.*\.json$/.test(f)).sort().pop();
fs.writeFileSync(path.join(DIR, `ai-eval-match-${card.date.slice(0, 10)}.json`), JSON.stringify(card, null, 2));
console.log("totals", card.totals);
let failed = card.totals.correctRate < 0.95 || card.totals.crossTenant > 0 || card.totals.secondInvoiceCalls > 0;
if (failed) console.error("Below the plan.md §7 bar (≥ 95 % correctly matched or left, 0 cross-tenant candidates, 0 AI calls on the second invoice).");
if (previous) {
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, previous), "utf8")).totals;
  if (prev.correctRate - card.totals.correctRate > MAX_DROP) {
    console.error(`Regression on correctRate: ${prev.correctRate} → ${card.totals.correctRate} (previous scorecard ${previous})`);
    failed = true;
  }
}
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
