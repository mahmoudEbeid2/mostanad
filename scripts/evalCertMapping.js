import "dotenv/config";
import fs from "fs";
import path from "path";

// Live accuracy run for template field mapping (plan.md §5.4, §10) — the real
// model on the golden designs. Opt-in and paid: RUN_LIVE_GEMINI=1, and the
// process must not have GEMINI_DISABLED set. Needs the API (any stack, e.g.
// `npm run dev:test`: uploads and label proposals go through it; the model
// call is made in THIS process).
//
//   RUN_LIVE_GEMINI=1 npm run eval:cert-mapping
//
// Writes golden/ai-eval-<date>.json and compares it with the previous
// scorecard: a drop of more than 2 percentage points on any metric exits 1
// (CLAUDE.md invariant 11's spirit). Cleans up its test company.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
if (process.env.GEMINI_DISABLED === "true") {
  console.error("Refusing to run: GEMINI_DISABLED=true in this process.");
  process.exit(2);
}

const { seedMappingCompany, uploadGolden, runGolden } = await import("../tests/certificates-v2/mappingHarness.js");
const { cleanupCompany, prisma } = await import("../tests/certificates-v2/helpers.js");
process.env.GEMINI_DISABLED = "false"; // helpers.js defaults tests to disabled; this run is the explicit exception

const DIR = path.join(process.cwd(), "golden");
const MAX_DROP = 0.02;

const { company, products, typeId } = await seedMappingCompany("a1live");
const card = { date: new Date().toISOString(), templates: {}, totals: {} };
try {
  for (const [file, country, sample] of [["ADDVET_COA.ai", undefined, "ADD-E120"], ["PHARMAVET_COA.pdf", "TR", "DOXYPHARMA"]]) {
    const version = await uploadGolden(company.id, typeId, file, country);
    const t0 = Date.now();
    const g = await runGolden(company.id, version, file, { sampleProductId: products[sample].id });
    const run = await prisma.aiRun.findFirst({ where: { companyId: company.id, entityId: version.id, kind: "CERT_FIELD_MAP" }, orderBy: { createdAt: "desc" } });
    card.templates[file] = {
      exact: g.score.exact,
      total: g.score.total,
      batchCorrect: g.score.batchCorrect,
      batchTotal: g.score.batchTotal,
      invalid: g.score.invalid,
      aiCalls: g.out.ai.calls,
      aiUnavailable: g.out.ai.unavailable ? g.out.ai.reason : null,
      tokens: run ? { input: run.inputTokens, output: run.outputTokens, thinking: run.thinkingTokens, cached: run.cachedTokens } : null,
      ms: Date.now() - t0,
      fields: g.score.perField,
    };
    console.log(`${file}: ${g.score.exact}/${g.score.total} exact, batch ${g.score.batchCorrect}/${g.score.batchTotal}, invalid ${g.score.invalid}, AI calls ${g.out.ai.calls}${g.out.ai.unavailable ? ` (unavailable: ${g.out.ai.reason})` : ""}`);
    for (const f of g.score.perField) console.log(`  ${f.ok ? "ok " : "MISS"} ${f.key} [${f.origin} ${f.status} ${f.confidence}] ${JSON.stringify(f.got)}`);
  }
} finally {
  await prisma.fieldMappingMemory.deleteMany({ where: { companyId: company.id } });
  await cleanupCompany(company.id);
}

const t = Object.values(card.templates);
const sum = (k) => t.reduce((n, x) => n + x[k], 0);
card.totals = {
  exactRate: sum("exact") / sum("total"),
  batchRate: sum("batchTotal") ? sum("batchCorrect") / sum("batchTotal") : 1,
  invalid: sum("invalid"),
  aiCallsPerTemplate: sum("aiCalls") / t.length,
};
const previous = fs.readdirSync(DIR).filter((f) => /^ai-eval-\d{4}-\d{2}-\d{2}\.json$/.test(f)) // A2/A3 cards are ai-eval-gaps-* / ai-eval-match-*.sort().pop();
fs.writeFileSync(path.join(DIR, `ai-eval-${card.date.slice(0, 10)}.json`), JSON.stringify(card, null, 2));
console.log("totals", card.totals);

let failed = card.totals.exactRate < 0.9 || card.totals.batchRate < 1 || card.totals.invalid > 0;
if (failed) console.error("Below the plan.md §5.4 bar (≥ 90 % exact, 100 % batch_data, 0 invalid paths).");
if (previous) {
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, previous), "utf8")).totals;
  for (const k of ["exactRate", "batchRate"]) {
    if (prev[k] - card.totals[k] > MAX_DROP) {
      console.error(`Regression on ${k}: ${prev[k]} → ${card.totals[k]} (previous scorecard ${previous})`);
      failed = true;
    }
  }
}
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
