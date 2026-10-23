// Certificate AI layers — Phase A6.3 (plan.md §15.3 steps 3–5, §15.9; owner rules):
// extraction quality on the Agrikima sample, with stand-in models (npm test never
// calls a paid API). The stand-in copies the hand-checked golden the way a correct
// model would, then the known failure modes are injected on purpose:
//   Toxinil's storage taken from Advice (the V1 bleed) · a placeholder amount
//   ("Extract") · an amount paired with the wrong row · a quote across two lines ·
//   a code that isn't one · a block it was not asked about · a hedged estimate ·
//   an estimate for a field the catalogue printed · a failed inference call.
// Proven: every product found; every productCode captured; for every active
// ingredient amountRaw equals the catalogue text; every ambiguous number flagged and
// none silently mis-parsed; 0 stored values without a verified quote; duplicates
// flagged; categories proposed, never created; estimates apart and flagged; the
// convention confirmed once re-reads every amount; a duplicated code never auto-matches.
import fs from "fs";
import path from "path";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma } from "./helpers.js";
import { runExtractJob, setNumberConvention } from "../../src/services/catalogues/extraction/extractionService.js";
import { verifyBlockQuote } from "../../src/services/catalogues/catalogueSections.js";
import { normaliseAmount, readNumber } from "../../src/services/catalogues/extraction/numbers.js";
import { cleanEstimate, NEVER_INFERRED, INFERABLE } from "../../src/services/catalogues/extraction/catalogueInference.js";
import { BLOCKS_PER_CALL } from "../../src/services/catalogues/extraction/catalogueExtractor.js";
import { matchLine, matchInvoice } from "../../src/services/certificates/matching/productMatcher.js";
import { MODELS } from "../../src/services/ai/modelRegistry.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "agrikima.golden.json"), "utf8"));
const co = await createCompany("a6e");

const lineWith = (text, ...parts) => text.split("\n").find((l) => parts.every((p) => l.includes(p))) || null;

/** The stand-in CATALOGUE_EXTRACT: the golden record of each block, copied with quotes from that block's text. */
function extractModel(goldenOf, calls, { mutate = true } = {}) {
  return async (args) => {
    calls.push(args);
    const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
    const products = payload.blocks.map(({ blockId, text }) => {
      const g = goldenOf.get(blockId);
      if (!g) return { blockId, isProduct: false };
      const vq = (v) => (v ? { value: v, quote: v } : null);
      const rec = {
        blockId,
        isProduct: true,
        name: { value: g.name, quote: g.name },
        productCode: g.productCode ? { value: g.productCode, quote: lineWith(text, g.productCode) } : null,
        physicalForm: vq(g.physicalForm),
        packaging: vq(g.packaging),
        withdrawalPeriod: vq(g.withdrawalPeriod),
        storage: vq(g.storage),
        categoryProposal: /Liquid Oral Solution/.test(text) ? "Liquid Oral Solution" : /Soluble Powder/.test(text) ? "Soluble Powder" : null,
        activeIngredients: g.activeIngredients.map((i) => ({ name: i.name, amountRaw: i.amountRaw, quote: lineWith(text, i.name, i.amountRaw.split(" ")[0]) || `${i.name} ${i.amountRaw}` })),
      };
      if (mutate) {
        if (g.name === "Toxinil") rec.storage = { value: "It is recommended to store the product in its original packing in a cool and dry condition.", quote: "It is recommended to store the product in its original packing in a cool and dry condition." }; // Advice's text
        if (g.name === "Advice") rec.activeIngredients = [{ name: "Cinnamon", amountRaw: "Extract", quote: "natural extracts (Cinnamon, Garlic" }]; // a placeholder amount
        if (g.name === "Agrizec") {
          rec.activeIngredients = rec.activeIngredients.map((i) => (i.name === "Selenium" ? { ...i, amountRaw: "8500 mg" } : i)); // Zinc's amount on Selenium's line
          rec.activeIngredients.push({ name: "Zinc.", amountRaw: "8500 mg", quote: "Selenium\t2300 mg\nZinc.\t8500 mg" }); // a quote across two lines (a duplicate row too)
          rec.appearance = { value: "Not specified, likely a clear liquid", quote: "Not specified, likely a clear liquid" }; // the V1 hedging — not in the block
        }
        if (g.name === "MIX5") {
          rec.productCode = { value: "N/A", quote: "N/A" };
          rec.targetSpecies = { values: ["Poultry", "Pigeon", "Sheep", "Cattle", "Cows", "Camels"], quote: null }; // from several sentences; "Camels" is not printed
        }
        // a printed bullet list copied as running text (no "•"): the words are the printed ones
        if (g.name === "Mentholic") rec.indications = { value: "Improves respiration and air passage. Reduces mucus accumulation and discharge out of respiratory cavities.", quote: "Improves respiration and air passage. Reduces mucus accumulation and discharge out of respiratory cavities." };
        // the amount folded into the name
        if (g.name === "THERIONINE 65%") rec.activeIngredients = [{ name: "Threonine 65%", amountRaw: "65%", quote: "Threonine 65%" }];
        // the amount left out (seen live): code copies it from the ingredient's own composition line
        if (g.name === "CHOLINE CHLORIDE 70%") rec.activeIngredients = [{ name: "Choline chloride", amountRaw: null, quote: "Choline chloride 70% feed grade" }];
        // a long value with a short quote (seen live): the value itself is printed → kept; a made-up one → dropped
        if (g.name === "Antistrs-300") rec.dosage = { value: "500 gm per 1000 Litres of drinking water for 3-5 days.\nCattle : 8 g per animal, per day.", quote: "500 gm per 1000" };
        if (g.name === "Re-Cover") rec.dosage = { value: "Poultry: 2 litres per 1000 litre of drinking water", quote: "Poultry:" };
      }
      return rec;
    });
    // the model skips a block in a group (seen live: Growth 80) — it is asked again on its own
    if (mutate && products.length > 1 && products.some((p) => goldenOf.get(p.blockId)?.name === "Re-Cover")) products.splice(products.findIndex((p) => goldenOf.get(p.blockId)?.name === "Re-Cover"), 1);
    // an answer for a block it was not given → ignored
    products.push({ blockId: "00000000-0000-4000-8000-00000000dead", isProduct: true, name: { value: "Ghost", quote: "Ghost" } });
    const ctx = payload.contextBlocks || [];
    const back = ctx.find((b) => b.text.includes("Selangor"));
    return {
      products,
      catalogue: ctx.length ? { producer: { value: "Agrikima Sdn. Bhd.", quote: "Agrikima Sdn. Bhd.", blockId: back?.blockId }, origin: { value: "Malaysia", quote: "Selangor D.E., Malaysia.", blockId: back?.blockId } } : null,
    };
  };
}

/** The stand-in CATALOGUE_INFER: estimates for what's missing, plus answers it must not be allowed to give. */
const inferModel = (calls) => async (args) => {
  calls.push(args);
  const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return {
    products: payload.products.map((p) => {
      const estimates = [];
      if (p.missing.includes("appearance")) estimates.push({ field: "appearance", value: p.name === "Agrizec" ? "Probably a clear yellow liquid" : "Clear liquid", basis: "Oral solutions of this kind are clear liquids." }); // Agrizec's is hedged → refused
      if (p.missing.includes("withdrawalPeriod")) estimates.push({ field: "withdrawalPeriod", value: "0 days", basis: "Feed additives of this class carry no withdrawal period." });
      if (!p.missing.includes("storage")) estimates.push({ field: "storage", value: "Keep frozen", basis: "x" }); // a field the catalogue printed → refused
      return { blockId: p.blockId, estimates };
    }),
  };
};

try {
  console.log("\n🔢 Number rules (code)");
  assert("space / comma / multi-dot groups → thousands, unambiguous", readNumber("100 000 000").value === 1e8 && readNumber("60,000").value === 60000 && readNumber("10.000.000").value === 1e7 && !readNumber("10.000.000").ambiguous);
  assert("a dot before 1–2 digits, or after 0 → a decimal", readNumber("13.6").value === 13.6 && readNumber("0.5").value === 0.5 && readNumber("0.250").value === 0.25 && readNumber("84.0").value === 84);
  assert("a dot before exactly three digits → ambiguous, not parsed without a convention", readNumber("70.000").ambiguous && readNumber("70.000").value === null && readNumber("70.000", "thousands").value === 70000 && readNumber("70.000", "decimal").value === 70);
  assert("placeholders are never amounts", normaliseAmount("Extract").placeholder && normaliseAmount("Not specified").amount === null && normaliseAmount("Added").flags[0].code === "placeholder_amount");
  assert("an amount bigger than its basis is flagged (70,000 g in 1 L), 70,000 mg is not", normaliseAmount("70,000 g", { basis: { quantity: 1, unit: "L" } }).flags.some((f) => f.code === "amount_exceeds_basis") && !normaliseAmount("70,000 mg", { basis: { quantity: 1, unit: "L" } }).flags.length);
  assert("estimates: hedging refused, lists split, never-fields not even allowed", cleanEstimate({ field: "appearance", value: "likely clear", basis: "b" }) === null && cleanEstimate({ field: "appearance", value: "Clear?", basis: "b" }) === null && cleanEstimate({ field: "targetSpecies", value: "Poultry, Cattle", basis: "b" }).value.length === 2 && NEVER_INFERRED.every((f) => !INFERABLE.includes(f)) && cleanEstimate({ field: "productCode", value: "AKS1", basis: "b" }) === null);

  console.log("\n📤 Segment (no AI yet) → extract with the stand-ins");
  const categoriesBefore = await prisma.category.count();
  let r = await api("POST", "/catalogues", asAdmin, form({ companyId: co.id, manufacturer: "Agrikima Sdn. Bhd.", extract: "false" }, { buffer: pdf, name: "agrikima.pdf", type: "application/pdf" }));
  const task = await pollTask(r.data.data.jobId, asAdmin);
  assert("extract=false → segmented, no extraction queued", task.status === "completed" && !task.result.extractJobId && (await prisma.catalogueVersion.findUnique({ where: { id: r.data.data.versionId } })).status === "segmented");
  const versionId = r.data.data.versionId;
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" }, orderBy: { seq: "asc" } });
  const goldenOf = new Map(blocks.map((b, i) => [b.id, GOLDEN.products[i]]));
  const byName = (n) => blocks[GOLDEN.products.findIndex((p) => p.name === n)];
  const eCalls = [];
  const iCalls = [];
  const res = await runExtractJob(versionId, undefined, { generate: extractModel(goldenOf, eCalls), inferGenerate: inferModel(iCalls) });
  assert(`${Math.ceil(29 / BLOCKS_PER_CALL)} extraction calls (${BLOCKS_PER_CALL} blocks each) + 1 retry for the skipped block + 1 inference call`, eCalls.length === Math.ceil(29 / BLOCKS_PER_CALL) + 1 && iCalls.length === 1 && res.calls === eCalls.length + 1, { e: eCalls.length, i: iCalls.length });
  assert("the retry asks for the skipped block alone", JSON.parse(eCalls[eCalls.length - 1].contents[1].slice(8)).blocks.length === 1);
  assert("the model id and thinking come from the registry (CATALOGUE_EXTRACT: thinking 0)", eCalls.every((c) => c.model === MODELS.CATALOGUE_EXTRACT.id && c.thinkingBudget === 0 && c.temperature === 0) && iCalls[0].model === MODELS.CATALOGUE_INFER.id);
  assert("the context blocks go once, with the first call", JSON.parse(eCalls[0].contents[1].slice(8)).contextBlocks?.length === 4 && eCalls.slice(1).every((c) => !JSON.parse(c.contents[1].slice(8)).contextBlocks));
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  assert("version → review, extraction recorded (model, prompt hash, calls, convention, inference)", version.status === "review" && version.extraction.modelId === MODELS.CATALOGUE_EXTRACT.id && version.extraction.promptHash && version.extraction.calls === eCalls.length && version.extraction.numberConvention.majority.dotGroup3 === "thousands" && version.extraction.inference.estimated > 0, version.extraction);
  const ext = new Map((await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" } })).map((b) => [b.id, b]));
  const E = (name) => ext.get(byName(name).id).extracted;
  const flagsOf = (name, code) => E(name).flags.filter((f) => f.code === code);

  console.log("\n✅ §15.9 on the sample");
  assert("every product found: 29 records", [...ext.values()].filter((b) => b.extracted?.record?.name).length === 29);
  const codesOk = GOLDEN.products.filter((g) => g.name !== "MIX5").every((g) => (g.productCode ? E(g.name).record.productCode === g.productCode : !E(g.name).record.productCode)); // MIX5's is corrupted on purpose (below)
  assert("every printed productCode captured, none invented for the 5 without", codesOk, GOLDEN.products.map((g) => [g.name, E(g.name).record.productCode]));
  let total = 0;
  const wrong = [];
  for (const g of GOLDEN.products) {
    if (["Advice", "Agrizec", "THERIONINE 65%", "CHOLINE CHLORIDE 70%"].includes(g.name)) continue; // mutated on purpose, checked below
    for (const i of g.activeIngredients) {
      total++;
      const got = (E(g.name).record.activeIngredients || []).find((x) => x.name === i.name);
      if (got?.amountRaw !== i.amountRaw) wrong.push([g.name, i.name, i.amountRaw, got?.amountRaw]);
    }
  }
  assert(`amountRaw equals the catalogue text for every active ingredient (${total})`, total > 160 && wrong.length === 0, wrong.slice(0, 5));
  const ambiguous = [...ext.values()].flatMap((b) => b.extracted.flags.filter((f) => f.code === "ambiguous_number").map((f) => [b.title, f.ingredient]));
  assert("exactly the ambiguous number is flagged: Agrizec · Vitamin E 200.000 mg", ambiguous.length === 1 && ambiguous[0][1] === "Vitamin E", ambiguous);
  for (const x of GOLDEN.expectedAmounts) {
    const got = (E(x.product).record.activeIngredients || []).find((i) => i.name === x.ingredient);
    assert(`${x.product} · ${x.ingredient} "${x.amountRaw}" → ${x.amount} ${x.unit} (raw kept)`, got?.amountRaw === x.amountRaw && got.amount === x.amount && got.unit === x.unit, got);
  }
  assert("Calcium-70 resolves \"70.000\" by its own basis (\"up to 1.000 mL\" per 1 Litre) — not flagged", E("Calcium-70").convention.source === "block" && !flagsOf("Calcium-70", "ambiguous_number").length);
  assert("Aminovital resolves by its own multi-dot numbers (10.000.000)", E("Aminovital").convention.source === "block");
  let unverified = 0;
  for (const b of ext.values()) {
    const { record, quotes } = b.extracted;
    for (const [field, value] of Object.entries(record)) {
      if (["producer", "origin"].includes(field)) continue; // verified against the context block (below)
      const qs = Array.isArray(value) ? quotes[field] : [quotes[field]];
      const ok = Array.isArray(qs) && qs.length && qs.every((q) => q && verifyBlockQuote(b, q.quote, q.quote).ok && b.text.slice(q.start, q.end) === q.quote);
      if (!ok) unverified++;
    }
  }
  assert("0 stored values without a verified quote (offsets point at the quote in the block)", unverified === 0, unverified);

  console.log("\n🛡️ The injected failures");
  assert("Toxinil: Advice's storage text is NOT kept (unverified, dropped)", E("Toxinil").record.storage === undefined && flagsOf("Toxinil", "unverified").some((f) => f.field === "storage"));
  assert("Advice: \"Extract\" is not stored as an amount; flagged placeholder", E("Advice").record.activeIngredients?.[0]?.amountRaw === null && flagsOf("Advice", "placeholder_amount").length === 1);
  const sel = E("Agrizec").record.activeIngredients.find((i) => i.name === "Selenium");
  assert("Agrizec: Zinc's amount on Selenium's line → amount dropped, flagged", sel && sel.amountRaw === null && flagsOf("Agrizec", "unverified").some((f) => f.ingredient === "Selenium"));
  assert("Agrizec: a quote across two lines → that row dropped", E("Agrizec").record.activeIngredients.filter((i) => i.name === "Zinc.").length === 1 && flagsOf("Agrizec", "unverified").some((f) => /several printed lines/.test(f.message)));
  assert("Agrizec: the V1 hedging (\"Not specified, likely …\") never stored", E("Agrizec").record.appearance === undefined);
  assert("MIX5: \"N/A\" as a code → dropped", E("MIX5").record.productCode === undefined);
  assert("MIX5: species checked one by one — the 5 printed kept, \"Camels\" (not printed) dropped", E("MIX5").record.targetSpecies.join() === "Poultry,Pigeon,Sheep,Cattle,Cows" && flagsOf("MIX5", "unverified").some((f) => /Camels/.test(f.message)) && E("MIX5").quotes.targetSpecies.length === 5);
  assert("Mentholic: a bullet list copied as running text verifies (same words), highlighted on the page", E("Mentholic").record.indications?.startsWith("Improves respiration") && E("Mentholic").quotes.indications.quote.includes("Reduces mucus") && !E("Mentholic").quotes.indications.quote.startsWith(" "));
  assert("Threonine: the amount folded into the name is split off (\"Threonine\" · 65%)", E("THERIONINE 65%").record.activeIngredients?.[0]?.name === "Threonine" && E("THERIONINE 65%").record.activeIngredients[0].amountRaw === "65%" && E("THERIONINE 65%").record.activeIngredients[0].amount === 65);
  assert("Re-Cover, skipped in its group, read on the retry", E("Re-Cover").record.productCode === "AKS2017015" && !flagsOf("Re-Cover", "no_ai_answer").length);
  assert("Choline chloride: the amount the model left out is copied by code from its own line (70%)", E("CHOLINE CHLORIDE 70%").record.activeIngredients?.[0]?.amountRaw === "70%");
  assert("a long value with a short quote is kept when the value itself is printed (Antistrs-300 dosage)", E("Antistrs-300").record.dosage?.startsWith("500 gm per 1000 Litres") && E("Antistrs-300").quotes.dosage.quote.includes("Cattle : 8 g"));
  assert("…and dropped when it isn't (Re-Cover \"2 litres\")", E("Re-Cover").record.dosage === undefined && flagsOf("Re-Cover", "unverified").some((f) => f.field === "dosage"));
  assert("an answer for a block it wasn't given → ignored", ![...ext.values()].some((b) => b.extracted.record.name === "Ghost"));
  assert("producer + origin from the back page, verified there, on every product", [...ext.values()].every((b) => b.extracted.record.producer === "Agrikima Sdn. Bhd." && b.extracted.record.origin === "Malaysia" && b.extracted.quotes.origin.blockId && b.extracted.quotes.origin.quote.includes("Malaysia")));
  assert("composition only in activeIngredients; specifications only from a SPECIFICATIONS table", !E("Calcium-70").record.specifications && E("BETAINE 50%").record.specifications.length === 5 && E("DL-METHIONINE").record.specifications.length === 10);
  assert("composition basis read by code (\"Each 1 Litre contains:\")", E("Calcium-70").record.compositionBasis === "Each 1 Litre contains:");
  const dup = [E("AD3E-CK"), E("AD3E-PLUS")].map((x) => x.flags.find((f) => f.code === "duplicate_code"));
  assert("AKS13 printed twice → both flagged duplicate_code, pointing at each other", dup.every(Boolean) && dup[0].duplicateOf[0] === byName("AD3E-PLUS").id && dup[1].duplicateOf[0] === byName("AD3E-CK").id);
  assert("categories: proposed (\"Liquid Oral Solution\"), none created", E("Agrizec").category?.proposal === "Liquid Oral Solution" && (await prisma.category.count()) === categoriesBefore);

  console.log("\n💡 Estimates (owner rule)");
  assert("only fields still empty are estimated, stored apart with basis/model/prompt", E("Toxinil").estimated.appearance?.value === "Clear liquid" && E("Toxinil").estimated.appearance.basis && E("Toxinil").estimated.appearance.modelId === MODELS.CATALOGUE_INFER.id && E("Toxinil").estimated.appearance.promptHash && E("Toxinil").record.appearance === undefined);
  assert("a hedged estimate is refused (Agrizec appearance stays empty)", !E("Agrizec").estimated?.appearance);
  assert("an estimate for a field the catalogue printed is refused (storage)", Object.values(Object.fromEntries(ext)).every((b) => !b.extracted.estimated?.storage || !b.extracted.record.storage));
  assert("withdrawal estimated only where not printed (5 feed additives) — and flagged", E("BETAINE 50%").estimated.withdrawalPeriod?.value === "0 days" && flagsOf("BETAINE 50%", "estimated_withdrawal").length === 1 && !E("Calcium-70").estimated.withdrawalPeriod);
  assert("the inference call never sees a never-field as missing", JSON.parse(iCalls[0].contents[1].slice(10)).products.every((p) => p.missing.every((f) => INFERABLE.includes(f))));

  console.log("\n🔁 Convention confirmed once → every amount re-read (no AI)");
  const conv = await setNumberConvention(versionId, co.id, { dotGroup3: "thousands" }, null);
  const after = (await prisma.catalogueBlock.findUnique({ where: { id: byName("Agrizec").id } })).extracted;
  assert("no ambiguous flag left; Agrizec Vitamin E = 200000 mg, raw \"200.000 mg\" kept", conv.numberConvention.source === "admin" && !after.flags.some((f) => f.code === "ambiguous_number") && after.record.activeIngredients.find((i) => i.name === "Vitamin E").amount === 200000 && after.record.activeIngredients.find((i) => i.name === "Vitamin E").amountRaw === "200.000 mg");
  await setNumberConvention(versionId, co.id, { dotGroup3: "decimal" }, null);
  const dec = (await prisma.catalogueBlock.findUnique({ where: { id: byName("Agrizec").id } })).extracted;
  const cal = (await prisma.catalogueBlock.findUnique({ where: { id: byName("Calcium-70").id } })).extracted;
  assert("\"decimal\" re-reads Agrizec as 200 mg; Calcium-70 keeps its own proof and is flagged convention_conflict", dec.record.activeIngredients.find((i) => i.name === "Vitamin E").amount === 200 && cal.record.activeIngredients.find((i) => i.name === "Calcium Chloride").amount === 70000 && cal.flags.some((f) => f.code === "convention_conflict"));
  r = await api("PUT", `/catalogue-versions/${versionId}/number-convention`, asAdmin, { dotGroup3: "thousands" });
  assert("PUT …/number-convention (API) → 200", r.status === 200 && r.data.data.numberConvention.dotGroup3 === "thousands", r.data);
  r = await api("PUT", `/catalogue-versions/${versionId}/number-convention`, asAdmin, { dotGroup3: "comma" });
  assert("an unknown convention → 400", r.status === 400);

  console.log("\n😵 Inference down → verified values kept");
  const r2 = await api("POST", `/catalogues/${version.catalogueId}/versions`, asAdmin, form({ extract: "false" }, { buffer: pdf, name: "v2.pdf", type: "application/pdf" }));
  await pollTask(r2.data.data.jobId, asAdmin);
  const blocks2 = await prisma.catalogueBlock.findMany({ where: { versionId: r2.data.data.versionId, kind: "product" }, orderBy: { seq: "asc" } });
  const golden2 = new Map(blocks2.map((b, i) => [b.id, GOLDEN.products[i]]));
  const down = await runExtractJob(r2.data.data.versionId, undefined, { generate: extractModel(golden2, [], { mutate: false }), inferGenerate: async () => { throw new Error("Gemini quota exhausted (daily/project limit)"); } });
  const v2 = await prisma.catalogueVersion.findUnique({ where: { id: r2.data.data.versionId } });
  const b2 = await prisma.catalogueBlock.findMany({ where: { versionId: v2.id, kind: "product" } });
  assert("the job completes, version in review, the failure recorded with the real reason", down.inference.failed && v2.status === "review" && /quota/.test(v2.extraction.inference.reason));
  assert("…every product keeps its verified values, no estimates", b2.every((b) => b.extracted.record.name && Object.keys(b.extracted.estimated).length === 0));
  // §15.9 on this clean run (a correct model, nothing injected): all 24 codes, all 176 amounts, nothing unverified
  const E2 = (name) => b2.find((b) => b.id === blocks2[GOLDEN.products.findIndex((p) => p.name === name)].id).extracted;
  assert("clean run: every printed productCode (24) captured exactly", GOLDEN.products.every((g) => (g.productCode ? E2(g.name).record.productCode === g.productCode : !E2(g.name).record.productCode)) && GOLDEN.products.filter((g) => g.productCode).length === 24);
  const miss2 = GOLDEN.products.flatMap((g) => g.activeIngredients.filter((i) => (E2(g.name).record.activeIngredients || []).find((x) => x.name === i.name)?.amountRaw !== i.amountRaw).map((i) => [g.name, i.name]));
  assert(`clean run: amountRaw equals the catalogue text for all ${GOLDEN.products.reduce((n, g) => n + g.activeIngredients.length, 0)} active ingredients`, miss2.length === 0, miss2);
  assert("clean run: no value dropped as unverified", b2.every((b) => !b.extracted.flags.some((f) => f.code === "unverified")), b2.flatMap((b) => b.extracted.flags.filter((f) => f.code === "unverified").map((f) => f.message)).slice(0, 5));

  console.log("\n💥 The extraction call fails → back to segmented, blocks kept");
  const r3 = await api("POST", `/catalogues/${version.catalogueId}/versions`, asAdmin, form({}, { buffer: pdf, name: "v3.pdf", type: "application/pdf" }));
  const t3 = await pollTask(r3.data.data.jobId, asAdmin);
  assert("without extract=false the segment job queues the extraction", !!t3.result?.extractJobId);
  const t3e = await pollTask(t3.result.extractJobId, asAdmin);
  const v3 = await prisma.catalogueVersion.findUnique({ where: { id: r3.data.data.versionId } });
  assert("…which fails loudly here (GEMINI_DISABLED), version back to segmented with the error", t3e.status === "failed" && /GEMINI_DISABLED/.test(t3e.error) && v3.status === "segmented" && /GEMINI_DISABLED/.test(v3.error) && (await prisma.catalogueBlock.count({ where: { versionId: v3.id } })) === 33, { t3e, status: v3.status });
  r = await api("POST", `/catalogue-versions/${v3.id}/extract`, asAdmin, {});
  assert("POST …/extract re-queues it (202)", r.status === 202 && r.data.data.jobId);
  await pollTask(r.data.data.jobId, asAdmin);
  await prisma.catalogueBlock.updateMany({ where: { versionId: v2.id, kind: "product" }, data: { status: "accepted" } });
  r = await api("POST", `/catalogue-versions/${v2.id}/extract`, asAdmin, {});
  assert("re-extracting a version whose blocks were accepted → 409 BLOCKS_IN_USE", r.status === 409 && r.data.code === "BLOCKS_IN_USE");
  r = await api("POST", `/catalogue-versions/${v3.id}/extract`, asCompany(co.id), {});
  assert("another… a company can't reach it unless it's theirs: same company bypass sees it (tenant ok)", [202, 409].includes(r.status));

  console.log("\n🔗 Invoice matching: a duplicated code never auto-matches");
  const cat = [{ id: "ck", name: "AD3E-CK", productCode: "AKS13" }, { id: "plus", name: "AD3E-PLUS", productCode: "AKS13" }, { id: "zec", name: "Agrizec", productCode: "AKS12" }];
  assert("a unique code → matched exact_code", matchLine({ name: "something else", code: "aks12" }, cat).matchMethod === "exact_code");
  const m = matchLine({ name: "AD3E-CK", code: "AKS13" }, cat);
  assert("a duplicated code → needs_match even with an exact name; both shown", m.matchStatus === "needs_match" && m.duplicateCode && m.matchCandidates.some((c) => c.productId === "ck") && m.matchCandidates.some((c) => c.productId === "plus"), m);
  assert("a learned alias (a person's earlier choice) still applies", matchLine({ name: "AD3E-CK", code: "AKS13" }, cat, { aliases: new Map([["ad3e ck", "ck"]]) }).matchMethod === "alias");
  await prisma.company.update({ where: { id: co.id }, data: { aiSettings: { autoAccept: true, autoAcceptThreshold: 0.5 } } });
  const ck = await prisma.product.create({ data: { companyId: co.id, name: "AD3E-CK", productCode: "AKS13" } });
  await prisma.product.create({ data: { companyId: co.id, name: "AD3E-PLUS", productCode: "AKS13" } });
  const inv = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000a7", header: {}, headerExtracted: {} } });
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: { name: "AD3E-CK", code: "AKS13" }, dataExtracted: {}, matchStatus: "needs_match" } });
  const sure = async (args) => ({ lines: JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1)).lines.map((l) => ({ lineNo: l.lineNo, productId: ck.id, confidence: 0.99, reasons: ["same name"] })) });
  const mr = await matchInvoice(inv.id, { generate: sure });
  const item = await prisma.invoiceItem.findFirst({ where: { invoiceId: inv.id } });
  const sug = await prisma.aiSuggestion.findFirst({ where: { companyId: co.id, kind: "product_match" }, orderBy: { createdAt: "desc" } });
  assert("…even a 0.99 AI pick with auto-accept on is only shown, waiting (suggestion pending)", item.matchStatus === "needs_match" && item.matchCandidates[0]?.productId === ck.id && item.matchCandidates[0].ai && sug.status === "pending" && mr.ai.autoAccepted === 0, { status: item.matchStatus, sug: sug?.status });
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
}

await finish(counts, async () => {
  await cleanupCompany(co.id);
});
