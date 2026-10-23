import "dotenv/config";
import fs from "fs";
import path from "path";

// Live run of A5 (plan.md §14.6): tier I (inference from product data) and
// tier W (web lookup, real Google-Search grounding, real page fetches) on the
// golden product-fact gaps in fixtures/certificates/inference/goldens.json.
// Opt-in and paid: RUN_LIVE_GEMINI=1; GEMINI_DISABLED must not be set; needs
// Postgres and internet access. Calls: 1 inference call + 1 web call per web
// product (2) = 3, then a second pass that must make 0 web calls (cache).
//
//   RUN_LIVE_GEMINI=1 npm run eval:cert-inference
//
// Bar (§14.6): ≥ 70 % of the gaps filled with verified evidence, 0 false
// values (a filled value that fails the gap's `accept` patterns), 0 web calls
// on the second pass. Writes golden/ai-eval-inference-<date>.json (with every
// citation, for a person to review). Cleans up its test company and cache rows.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API and the internet. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
if (process.env.GEMINI_DISABLED === "true") {
  console.error("Refusing to run: GEMINI_DISABLED=true in this process.");
  process.exit(2);
}

const { createCompany, cleanupCompany, prisma, FIXTURES } = await import("../tests/certificates-v2/helpers.js");
const { seedTemplate } = await import("../tests/certificates-v2/invoiceGoldenHarness.js");
const { computeNeeds, webLookupNeeds } = await import("../src/services/certificates/dataNeeds/dataNeedsService.js");
const { updateAiSettings } = await import("../src/services/certificates/ai/aiSettings.js");
process.env.GEMINI_DISABLED = "false";

const G = JSON.parse(fs.readFileSync(path.join(FIXTURES, "inference", "goldens.json"), "utf8"));
const DIR = path.join(process.cwd(), "golden");
const co = await createCompany("a5live");
const card = { date: new Date().toISOString(), gaps: [], totals: {} };
const noGaps = async (args) => ({ gaps: JSON.parse(args.contents[3].slice(6)).map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) }); // A2 isn't measured here
try {
  await updateAiSettings(co.id, { allowProductInference: true, allowWebLookup: true });
  const t = await seedTemplate(co.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: G.fields.map((f) => ({ key: f.key, label: f.label, source: { kind: "product", path: f.path }, category: "product_data" })) });
  await prisma.templateField.updateMany({ where: { versionId: t.versionId }, data: { inferencePolicy: "product_facts_and_web" } });
  const invoices = {};
  for (const p of G.products) {
    const brand = await prisma.brand.create({ data: { companyId: co.id, name: p.brand } });
    const product = await prisma.product.create({ data: { ...p.data, companyId: co.id, brandId: brand.id } });
    const inv = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000a5", header: { invoiceNumber: `EVAL-${p.key}` }, headerExtracted: {}, textContent: `=== Page 1 ===\n1 | ${product.name}` } });
    const data = { name: product.name, extra: {} };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
    invoices[p.key] = { inv, product };
  }
  const runs = async () => prisma.aiRun.groupBy({ by: ["kind"], where: { companyId: co.id, outcome: "ok" }, _count: { _all: true } });
  for (const p of G.products) await computeNeeds(invoices[p.key].inv.id, co.id, { generate: noGaps }); // tier I runs inside the check
  for (const p of G.products.filter((x) => G.gaps.some((g) => g.product === x.key && g.tier === "W"))) await webLookupNeeds(invoices[p.key].inv.id, co.id);
  const firstPass = await runs();
  for (const g of G.gaps) {
    const n = await prisma.certificateDataNeed.findFirst({ where: { invoiceId: invoices[g.product].inv.id, fieldKey: g.field } });
    const filled = ["inferred", "web_found"].includes(n?.status);
    const ok = filled && g.accept.every((re) => new RegExp(re, "i").test(n.value));
    const s = n?.suggestionId ? await prisma.aiSuggestion.findUnique({ where: { id: n.suggestionId } }) : null;
    const refused = s?.status === "rejected" ? s.finalValue : null;
    card.gaps.push({ product: g.product, field: g.field, expectedTier: g.tier, status: n?.status, tier: n?.provenance?.tier ?? null, value: n?.value ?? null, filled, correct: ok, falseValue: filled && !ok, provenance: n?.provenance ?? null, modelAnswer: s?.proposal?.answer ?? null, refusedBecause: refused });
    console.log(`${ok ? "ok   " : filled ? "FALSE" : "MISS "} ${g.product}.${g.field} [${n?.status}] ${JSON.stringify(n?.value)}${refused ? `  — refused: ${refused.reason}` : ""}`);
    if (n?.provenance?.citations) for (const c of n.provenance.citations) console.log(`        ${c.sourceType} ${c.finalUrl || c.url} “${c.quote}”${c.warning ? ` ⚠ ${c.warning}` : ""}`);
  }
  // second pass: same facts → the cache (0 web calls)
  for (const p of G.products.filter((x) => G.gaps.some((g) => g.product === x.key && g.tier === "W"))) {
    const inv2 = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000a5", header: { invoiceNumber: `EVAL2-${p.key}` }, headerExtracted: {} } });
    await prisma.invoiceItem.create({ data: { invoiceId: inv2.id, lineNo: 1, data: { name: p.data.name, extra: {} }, dataExtracted: {}, productId: invoices[p.key].product.id, matchStatus: "matched", matchMethod: "user" } });
    await computeNeeds(inv2.id, co.id, { ai: false });
    await webLookupNeeds(inv2.id, co.id);
  }
  const secondPass = await runs();
  const webCalls = (rs) => rs.find((r) => r.kind === "CERT_WEB_LOOKUP")?._count._all || 0;
  const filled = card.gaps.filter((g) => g.correct).length;
  card.totals = {
    gaps: card.gaps.length,
    filledVerified: filled,
    fillRate: filled / card.gaps.length,
    falseValues: card.gaps.filter((g) => g.falseValue).length,
    calls: Object.fromEntries(firstPass.map((r) => [r.kind, r._count._all])),
    secondPassWebCalls: webCalls(secondPass) - webCalls(firstPass),
  };
} finally {
  await prisma.externalKnowledgeCache.deleteMany({ where: { kind: "cert_product_fact", lookupKey: { startsWith: `${co.id}|` } } });
  await cleanupCompany(co.id);
}
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, `ai-eval-inference-${card.date.slice(0, 10)}.json`), JSON.stringify(card, null, 2));
console.log("totals", card.totals);
const failed = card.totals.fillRate < 0.7 || card.totals.falseValues > 0 || card.totals.secondPassWebCalls > 0;
if (failed) console.error("Below the plan.md §14.6 bar (≥ 70 % filled with verified evidence, 0 false values, 0 web calls on the second pass).");
await prisma.$disconnect();
process.exit(failed ? 1 : 0);
