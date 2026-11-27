// QA 27 Nov (re-test after the deploy):
//  2. pack variants are separate products: "FSC for OLIGOVET" asked "which one? OLIGOVET / OLIGOVET"
//  3. the same files dropped again made 4 identical ADDVET requests
//  4. drafts burnt certificate numbers (COC already at 080): the number is given on finalize
//  5. CURCUMARIN's COC: "missing composition basis" when its page prints no basis line
// Needs Postgres (no API).
import { makeAssert, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { resolveWithNeed, isBlocking, engineFlags } from "../../src/services/certificates/generation/batchService.js";
import { packsOfOne } from "../../src/services/assistant/productSearch.js";
import { partyFields, onlyPartyWords } from "../../src/services/certificates/templates/partyBlocks.js";
import { basisFact, mergeProduct } from "../../src/services/harvest/harvestService.js";
import { asPrinted } from "../../src/services/harvest/harvestAi.js";
import { compositionFrom } from "../../src/services/intake/intakeRules.js";
import { sameFilesRequest, createRequest } from "../../src/services/certificates/workflow/requestService.js";

const { assert, counts } = makeAssert();

async function main() {
  console.log("4. the certificate number on a draft");
  const numberField = { key: "doc_no", label: "Certificate No", required: true, source: { kind: "docnumber" } };
  const r = resolveWithNeed(numberField, { product: {} }, null);
  assert("a draft holds no number: empty, flagged «number_on_finalize»", r.value === "" && r.flags.includes("number_on_finalize"), r);
  assert("…which never blocks finalize", !r.flags.some(isBlocking), r.flags);
  // the renderer marks every empty required place "missing" — not this one (the CURCUMARIN draft on prod was blocked)
  assert("the engine's «missing» on the number place doesn't count", JSON.stringify(engineFlags(r, ["missing", "shrunk"])) === '["shrunk"]');
  const given = resolveWithNeed(numberField, { product: {}, docNumber: "COC-2026-0081" }, null);
  assert("a number given (on finalize) is printed", given.value === "COC-2026-0081", given);

  console.log("\n5. the composition basis");
  const basis = { key: "composition_basis", label: "Composition basis", required: true, role: "composition_basis", source: { kind: "product", path: "compositionBasis" } };
  const noBasis = resolveWithNeed(basis, { product: { activeIngredients: [{ name: "Curcumin", concentration: "10 g" }] } }, null);
  assert("composition read, no basis line on its page → optional, not blocking", noBasis.value === "" && !noBasis.flags.some(isBlocking), noBasis.flags);
  assert("…nor on a basis its page doesn't print", !engineFlags(noBasis, ["missing"]).includes("missing"));
  assert("a required place left empty by accident still counts as missing", engineFlags({ value: "", flags: [] }, ["missing"]).includes("missing"));
  const withBasis = resolveWithNeed(basis, { product: { compositionBasis: "Each 1 L contains:", activeIngredients: [{ name: "x" }] } }, null);
  assert("a basis the product has is printed", withBasis.value === "Each 1 L contains:", withBasis);

  console.log("\n5. a basis only from a COC / label line");
  const fact = (value, sourceType, certCode = null) => basisFact({ value, sourceType, certCode });
  assert("a COA's table label «Constituents (per Litre)» is no basis", !fact("Constituents (per Litre)", "certificate", "COA") && !fact("Constituents (per Litre)", "certificate", "COC"));
  assert("…whatever file it is on", !fact("Constituents (per gm)", "label"));
  assert("«Each 1 L contains:» on a COC or a label is", fact("Each 1 L contains:", "certificate", "COC") && fact("Each 1 mL contains", "label") && fact("Contains per mL:", "label"));
  assert("…but not taken from a COA", !fact("Each 1 L contains:", "certificate", "COA"));

  console.log("\nacceptance #3: an amount as its page prints it");
  assert("«2 %» read from «Silymarin 2%» → «2%»", asPrinted("2 %", "Silymarin 2% Plant extract (Boldo)") === "2%");
  assert("the page's spacing kept: «400,000 mg», «ad 1 L»", asPrinted("400,000 mg", "Sorbitol 400,000 mg") === "400,000 mg" && asPrinted("ad 1 L", "Carrier ad 1 L") === "ad 1 L");
  assert("no quote → as read", asPrinted("10 mg", null) === "10 mg");
  const parsed = compositionFrom("Trade Name: ADDHEPA Composition: Each 1 L contains: Sorbitol 400,000 mg Silymarin 2% Carrier ad 1 L Package Size: 1L").ingredients.map((i) => i.amountRaw);
  assert("the rules reader keeps «2%», «400,000 mg», «ad 1 L» as printed", parsed.join("|") === "400,000 mg|2%|ad 1 L", parsed);

  console.log("\n2. packs of one product in the chat");
  const hit = (id, name, pack, via = ["exact_name"]) => ({ productId: id, name, pack, via });
  const two = packsOfOne([hit("a", "OLIGOVET", "100 mL"), hit("b", "OLIGOVET", "1 L")]);
  assert("OLIGOVET 100 mL + OLIGOVET 1 L → one product in 2 packs", two?.ids.length === 2 && two.packs.join("|") === "100 mL|1 L", two);
  const named = packsOfOne([hit("a", "OLIGOVET", "100 mL"), hit("b", "OLIGOVET 1L", null, ["name_words"])]);
  assert("a variant named with its pack counts too", named?.ids.length === 2, named);
  assert("two different products → not packs of one", packsOfOne([hit("a", "OLIGOVET", "1 L"), hit("b", "H-RESPI", "1 L")]) === null);
  assert("the same pack twice → a real duplicate, still asked", packsOfOne([hit("a", "OLIGOVET", "1 L"), hit("b", "OLIGOVET", "1000 mL")]) === null);

  console.log("\nf3: a table's column header naming «EXPORTER COMPANY» is no party block (MAXVET COA)");
  const box = (x, y, w) => ({ x, y, w, h: 11 });
  const coaLines = [
    { id: "h", page: 1, text: "PRODUCT NAME EXPIRATION DATE EXPORTER COMPANY", box: box(136, 179, 494) },
    { id: "plus", page: 1, text: " +", box: box(201, 205, 11) },
    { id: "v", page: 1, text: "PHARMAVETDOXYPHARMA 09/2028", box: box(141, 203, 460) },
  ];
  assert("no exporter field on the product's value row", partyFields(coaLines, {}).length === 0, partyFields(coaLines, {}));
  assert("«EXPORTER | CONSIGNEE» and «Exporter Company Details» are still party headings", onlyPartyWords("EXPORTER | CONSIGNEE") && onlyPartyWords("Exporter Company Details") && onlyPartyWords("CONSIGNEE / BUYER"));

  const co = await createCompany("qa27re");
  try {
    const p100 = await prisma.product.create({ data: { companyId: co.id, name: "OLIGOVET", packaging: "100 mL" } });

    console.log("\nacceptance #3: a stored «2 %» takes the page's «2%» from a newer read");
    const ing = (amount) => [{ name: "Sorbitol", amountRaw: "400,000 mg", concentration: "400,000 mg" }, { name: "Silymarin", amountRaw: amount, concentration: amount }];
    const hepa = await prisma.product.create({ data: { companyId: co.id, name: "ADDHEPA", packaging: "1L", activeIngredients: ing("2 %"), fieldProvenance: { activeIngredients: { source: "harvest", sourceType: "certificate", tier: "D" } } } });
    const fact = (amount, at) => ({ companyId: co.id, entity: "product", productId: hepa.id, key: "activeIngredients", value: ing(amount).map((x) => ({ name: x.name, amountRaw: x.amountRaw })), valueNorm: `ing ${amount}`, sourceType: "certificate", certCode: "COC", fileName: "ADDVET OMAN COC 10-26.pdf", page: 10, extractor: "ai", reviewStatus: "confirmed", createdAt: at });
    await prisma.harvestedFact.createMany({ data: [fact("2 %", new Date(Date.now() - 86400_000)), fact("2%", new Date())] });
    await mergeProduct(hepa.id);
    const merged = await prisma.product.findUnique({ where: { id: hepa.id }, select: { activeIngredients: true, harvestConflicts: true } });
    assert("Silymarin is «2%» now, the rest untouched", merged.activeIngredients[1].amountRaw === "2%" && merged.activeIngredients[1].concentration === "2%" && merged.activeIngredients[0].amountRaw === "400,000 mg", merged.activeIngredients);
    assert("…and spacing alone is no conflict", !(merged.harvestConflicts || []).some((c) => c.key === "activeIngredients"), merged.harvestConflicts);


    console.log("\n3. the same files dropped again");
    const mkDrop = async (shas, requestId = null) => {
      const b = await prisma.intakeBatch.create({ data: { ownerType: "user", ownerId: "00000000-0000-4000-8000-000000000127", companyId: co.id, mode: "express", status: "done", express: requestId ? { generation: { requestId } } : {} } });
      for (const [i, sha] of shas.entries()) await prisma.intakeItem.create({ data: { batchId: b.id, name: `f${i}.pdf`, sizeBytes: 1, receivedBytes: 1, sha256: sha, status: "done" } });
      return b;
    };
    const req = await createRequest({ companyId: co.id, lines: [{ productId: p100.id }] });
    const first = await mkDrop(["s1", "s2"], req.request.id);
    const again = await mkDrop(["s2", "s1"]);
    const other = await mkDrop(["s1", "s3"]);
    assert("the same files (any order) → the earlier request", (await sameFilesRequest({ companyId: co.id, batchId: again.id }))?.id === req.request.id);
    assert("other files → no request reused", (await sameFilesRequest({ companyId: co.id, batchId: other.id })) === null);
    assert("another company → no request reused", (await sameFilesRequest({ companyId: "00000000-0000-4000-8000-000000000000", batchId: again.id })) === null);
    assert("older than the window → no request reused", (await sameFilesRequest({ companyId: co.id, batchId: again.id, hours: 0 })) === null);
    await prisma.intakeBatch.deleteMany({ where: { id: { in: [first.id, again.id, other.id] } } });
  } finally {
    await cleanupCompany(co.id);
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
