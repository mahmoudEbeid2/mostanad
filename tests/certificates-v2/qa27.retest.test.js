// QA 27 Nov (re-test after the deploy):
//  2. pack variants are separate products: "FSC for OLIGOVET" asked "which one? OLIGOVET / OLIGOVET"
//  3. the same files dropped again made 4 identical ADDVET requests
//  4. drafts burnt certificate numbers (COC already at 080): the number is given on finalize
//  5. CURCUMARIN's COC: "missing composition basis" when its page prints no basis line
// Needs Postgres (no API).
import { makeAssert, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { resolveWithNeed, isBlocking } from "../../src/services/certificates/generation/batchService.js";
import { packsOfOne } from "../../src/services/assistant/productSearch.js";
import { sameFilesRequest, createRequest } from "../../src/services/certificates/workflow/requestService.js";

const { assert, counts } = makeAssert();

async function main() {
  console.log("4. the certificate number on a draft");
  const numberField = { key: "doc_no", label: "Certificate No", required: true, source: { kind: "docnumber" } };
  const r = resolveWithNeed(numberField, { product: {} }, null);
  assert("a draft holds no number: empty, flagged «number_on_finalize»", r.value === "" && r.flags.includes("number_on_finalize"), r);
  assert("…which never blocks finalize", !r.flags.some(isBlocking), r.flags);
  const given = resolveWithNeed(numberField, { product: {}, docNumber: "COC-2026-0081" }, null);
  assert("a number given (on finalize) is printed", given.value === "COC-2026-0081", given);

  console.log("\n5. the composition basis");
  const basis = { key: "composition_basis", label: "Composition basis", required: true, role: "composition_basis", source: { kind: "product", path: "compositionBasis" } };
  const noBasis = resolveWithNeed(basis, { product: { activeIngredients: [{ name: "Curcumin", concentration: "10 g" }] } }, null);
  assert("composition read, no basis line on its page → optional, not blocking", noBasis.value === "" && !noBasis.flags.some(isBlocking), noBasis.flags);
  const withBasis = resolveWithNeed(basis, { product: { compositionBasis: "Each 1 L contains:", activeIngredients: [{ name: "x" }] } }, null);
  assert("a basis the product has is printed", withBasis.value === "Each 1 L contains:", withBasis);

  console.log("\n2. packs of one product in the chat");
  const hit = (id, name, pack, via = ["exact_name"]) => ({ productId: id, name, pack, via });
  const two = packsOfOne([hit("a", "OLIGOVET", "100 mL"), hit("b", "OLIGOVET", "1 L")]);
  assert("OLIGOVET 100 mL + OLIGOVET 1 L → one product in 2 packs", two?.ids.length === 2 && two.packs.join("|") === "100 mL|1 L", two);
  const named = packsOfOne([hit("a", "OLIGOVET", "100 mL"), hit("b", "OLIGOVET 1L", null, ["name_words"])]);
  assert("a variant named with its pack counts too", named?.ids.length === 2, named);
  assert("two different products → not packs of one", packsOfOne([hit("a", "OLIGOVET", "1 L"), hit("b", "H-RESPI", "1 L")]) === null);
  assert("the same pack twice → a real duplicate, still asked", packsOfOne([hit("a", "OLIGOVET", "1 L"), hit("b", "OLIGOVET", "1000 mL")]) === null);

  const co = await createCompany("qa27re");
  try {
    const p100 = await prisma.product.create({ data: { companyId: co.id, name: "OLIGOVET", packaging: "100 mL" } });


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
