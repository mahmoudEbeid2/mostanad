import "dotenv/config";
import fs from "fs";
import path from "path";

// Live gap-fill run for the certificate data check (plan.md §6.4, §10) — the
// real model on the three golden invoices (fixtures/certificates/invoices).
// Opt-in and paid: RUN_LIVE_GEMINI=1, and the process must not have
// GEMINI_DISABLED set. Needs Postgres (the API is not used: the check runs in
// THIS process). Three CERT_INVOICE_GAPS calls in total, one per invoice.
//
//   RUN_LIVE_GEMINI=1 npm run eval:cert-gaps
//
// Bar (§6.4): ≥ 80 % of the invoice-resolvable gaps filled with verified
// evidence; 0 unverified values; and 0 gaps filled that are not written
// anywhere. Writes golden/ai-eval-gaps-<date>.json; a drop of more than 2
// points vs the previous gaps scorecard exits 1. Cleans up its test company.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
if (process.env.GEMINI_DISABLED === "true") {
  console.error("Refusing to run: GEMINI_DISABLED=true in this process.");
  process.exit(2);
}

const { seedGoldenCompany, runGoldenInvoice, INVOICES } = await import("../tests/certificates-v2/invoiceGoldenHarness.js");
const { cleanupCompany, prisma } = await import("../tests/certificates-v2/helpers.js");
process.env.GEMINI_DISABLED = "false"; // helpers.js defaults tests to disabled; this run is the explicit exception

const DIR = path.join(process.cwd(), "golden");
const MAX_DROP = 0.02;

const seed = await seedGoldenCompany("a2live");
const card = { date: new Date().toISOString(), invoices: {}, totals: {} };
try {
  for (const name of INVOICES) {
    const t0 = Date.now();
    const { inv, check, score } = await runGoldenInvoice(seed, name);
    const run = await prisma.aiRun.findFirst({ where: { companyId: seed.company.id, entityId: inv.id, kind: "CERT_INVOICE_GAPS" }, orderBy: { createdAt: "desc" } });
    card.invoices[name] = {
      resolvable: score.resolvable,
      filled: score.filled,
      wrong: score.wrong,
      falseFills: score.falseFills,
      unverified: score.unverified,
      rejectedByVerifier: check.ai?.rejected ?? null,
      aiCalls: check.ai?.calls ?? 0,
      aiUnavailable: check.ai?.unavailable ? check.ai.reason : null,
      tokens: run ? { input: run.inputTokens, output: run.outputTokens, thinking: run.thinkingTokens, cached: run.cachedTokens } : null,
      ms: Date.now() - t0,
      gaps: score.perGap,
    };
    console.log(`${name}: filled ${score.filled}/${score.resolvable}, wrong ${score.wrong}, false fills ${score.falseFills}, unverified ${score.unverified}, refused by the verifier ${check.ai?.rejected ?? 0}, AI calls ${check.ai?.calls ?? 0}${check.ai?.unavailable ? ` (unavailable: ${check.ai.reason})` : ""}`);
    for (const g of score.perGap) console.log(`  ${g.ok ? "ok  " : "MISS"} line ${g.line ?? "-"} ${g.field} [${g.status}] ${JSON.stringify(g.value)}${g.resolvable ? ` expected ${JSON.stringify(g.expected)}` : " (not in the data)"}`);
  }
} finally {
  await cleanupCompany(seed.company.id);
}

const t = Object.values(card.invoices);
const sum = (k) => t.reduce((n, x) => n + x[k], 0);
card.totals = {
  fillRate: sum("resolvable") ? sum("filled") / sum("resolvable") : 1,
  wrong: sum("wrong"),
  falseFills: sum("falseFills"),
  unverified: sum("unverified"),
  aiCallsPerInvoice: sum("aiCalls") / t.length,
};
fs.mkdirSync(DIR, { recursive: true });
const previous = fs.readdirSync(DIR).filter((f) => /^ai-eval-gaps-.*\.json$/.test(f)).sort().pop();
fs.writeFileSync(path.join(DIR, `ai-eval-gaps-${card.date.slice(0, 10)}.json`), JSON.stringify(card, null, 2));
console.log("totals", card.totals);

let failed = card.totals.fillRate < 0.8 || card.totals.unverified > 0 || card.totals.falseFills > 0 || card.totals.aiCallsPerInvoice > 1;
if (failed) console.error("Below the plan.md §6.4 bar (≥ 80 % gap fill with verified evidence, 0 unverified, 0 false fills, ≤ 1 call per invoice).");
if (previous) {
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, previous), "utf8")).totals;
  if (prev.fillRate - card.totals.fillRate > MAX_DROP) {
    console.error(`Regression on fillRate: ${prev.fillRate} → ${card.totals.fillRate} (previous scorecard ${previous})`);
    failed = true;
  }
}
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
