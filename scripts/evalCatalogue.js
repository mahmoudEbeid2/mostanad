import "dotenv/config";
import fs from "fs";
import path from "path";

// Live run of A6.3 (plan.md §15.9 "Live eval"): the real CATALOGUE_EXTRACT (+
// CATALOGUE_INFER) on fixtures/catalogues/Agrikima_Catalogue_2022-new_-_feed.pdf,
// scored against the hand-checked golden fixtures/catalogues/agrikima.golden.json.
// Opt-in and paid: RUN_LIVE_GEMINI=1; GEMINI_DISABLED must not be set; needs Postgres.
// Calls: ceil(29 / CATALOGUE_BLOCKS_PER_CALL) extraction calls (5 at the default 6) + 1
// inference call (set EVAL_INFER=0 to skip it).
//
//   RUN_LIVE_GEMINI=1 npm run eval:catalogue
//
// Bar (§15.9): 29/29 products, every printed productCode captured, amountRaw equal to
// the catalogue text for every active ingredient, every ambiguous number flagged and
// none silently mis-parsed, 0 stored values without a verified quote. Writes
// golden/ai-eval-catalogue-<date>.json; cleans up its throwaway company.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
if (process.env.GEMINI_DISABLED === "true") {
  console.error("Refusing to run: GEMINI_DISABLED=true in this process.");
  process.exit(2);
}

const { createCompany, cleanupCompany, prisma } = await import("../tests/certificates-v2/helpers.js");
const { uploadCatalogue } = await import("../src/services/catalogues/catalogueService.js");
const { saveSelection } = await import("../src/services/catalogues/pages/pageService.js");
const { runExtractJob } = await import("../src/services/catalogues/extraction/extractionService.js");
const { verifyBlockQuote } = await import("../src/services/catalogues/catalogueSections.js");
process.env.GEMINI_DISABLED = "false";

const ROOT = process.cwd();
const pdf = fs.readFileSync(path.join(ROOT, "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const G = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", "catalogues", "agrikima.golden.json"), "utf8"));
const co = await createCompany("a6live");
const card = { date: new Date().toISOString(), products: [], totals: {} };
let exitCode = 0;
try {
  // the real upload, then every page kept (the golden covers the whole catalogue)
  const { version, pageCount } = await uploadCatalogue({ companyId: co.id, manufacturer: "Agrikima Sdn. Bhd.", label: "eval", file: { buffer: pdf, originalname: "agrikima.pdf" } });
  await saveSelection(version.id, co.id, Array.from({ length: pageCount }, (_, i) => i + 1));
  const t0 = Date.now();
  await runExtractJob(version.id, { progress: (p, m) => console.log(`  ${p}% ${m}`) }, { infer: process.env.EVAL_INFER !== "0" });
  const v = await prisma.catalogueVersion.findUnique({ where: { id: version.id } });
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId: version.id, kind: "product" }, orderBy: { seq: "asc" } });
  const t = { products: 0, codes: 0, codesExpected: 0, ingredients: 0, amountRawOk: 0, ambiguousFlagged: 0, ambiguousExpected: G.expectedAmbiguous.length, misparsed: 0, unverifiedStored: 0, droppedAsUnverified: 0, estimated: 0 };
  for (const [i, g] of G.products.entries()) {
    const b = blocks[i];
    const e = b?.extracted || { record: {}, quotes: {}, flags: [] };
    const row = { name: g.name, page: g.page, found: !!e.record.name, code: { want: g.productCode, got: e.record.productCode ?? null }, ingredients: [], flags: e.flags.map((f) => `${f.code}: ${f.message}`), estimated: Object.keys(e.estimated || {}), extractedIngredients: (e.record.activeIngredients || []).map((x) => [x.name, x.amountRaw]) };
    if (e.record.name) t.products++;
    if (g.productCode) {
      t.codesExpected++;
      if (e.record.productCode === g.productCode) t.codes++;
    }
    for (const ing of g.activeIngredients) {
      t.ingredients++;
      const got = (e.record.activeIngredients || []).find((x) => x.name === ing.name || x.name?.toLowerCase() === ing.name.toLowerCase());
      const ok = got?.amountRaw === ing.amountRaw;
      if (ok) t.amountRawOk++;
      row.ingredients.push({ name: ing.name, want: ing.amountRaw, got: got?.amountRaw ?? null, amount: got?.amount ?? null, ok });
    }
    for (const amb of G.expectedAmbiguous.filter((x) => x.product === g.name)) {
      if (e.flags.some((f) => f.code === "ambiguous_number" && f.ingredient?.toLowerCase() === amb.ingredient.toLowerCase())) t.ambiguousFlagged++;
    }
    for (const x of G.expectedAmounts.filter((y) => y.product === g.name)) {
      const got = (e.record.activeIngredients || []).find((i2) => i2.name === x.ingredient);
      if (got && got.amount !== null && got.amount !== x.amount && !e.flags.some((f) => f.code === "ambiguous_number" && f.ingredient === x.ingredient)) t.misparsed++;
    }
    for (const [field, q] of Object.entries(e.quotes || {})) {
      if (["producer", "origin"].includes(field)) continue;
      for (const one of Array.isArray(q) ? q : [q]) if (!one || !verifyBlockQuote(b, one.quote, one.quote).ok) t.unverifiedStored++;
    }
    t.droppedAsUnverified += e.flags.filter((f) => f.code === "unverified").length;
    t.estimated += row.estimated.length;
    card.products.push(row);
  }
  card.totals = { ...t, ms: Date.now() - t0, calls: (v.extraction?.calls || 0) + (v.extraction?.inference?.calls || 0), inference: v.extraction?.inference, convention: v.extraction?.numberConvention };
  card.bar = {
    allProducts: t.products === 29,
    allCodes: t.codes === t.codesExpected,
    allAmountRaw: t.amountRawOk === t.ingredients,
    ambiguousFlagged: t.ambiguousFlagged === t.ambiguousExpected,
    noneMisparsed: t.misparsed === 0,
    zeroUnverifiedStored: t.unverifiedStored === 0,
  };
  const pass = Object.values(card.bar).every(Boolean);
  if (!pass) exitCode = 1;
  fs.mkdirSync(path.join(ROOT, "golden"), { recursive: true });
  const out = path.join(ROOT, "golden", `ai-eval-catalogue-${card.date.slice(0, 10)}.json`);
  fs.writeFileSync(out, JSON.stringify(card, null, 2));
  console.log(JSON.stringify(card.totals, null, 2));
  console.log(JSON.stringify(card.bar, null, 2));
  console.log(`${pass ? "PASS" : "FAIL"} — scorecard: ${out}`);
} finally {
  await cleanupCompany(co.id);
  await prisma.$disconnect();
}
process.exit(exitCode);
