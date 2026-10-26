// "Asked, came back empty" (owner, 2026-10-27). Stand-in models (no paid API). Proven here:
//  - a product fact the gap call / inference came back empty for is not asked again on the next
//    invoice of the same company + product + field (0 calls for it), and the reason is reported
//  - changing the product's data asks again
//  - another product, another field, or another company is asked as usual
//  - lab results are never cached: a new invoice (a new batch) may print them, so the gap call asks again
// In-process (no API needed).
import { makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { policyToStore } from "../../src/services/certificates/inference/policy.js";
import { NEGATIVE_KIND } from "../../src/services/certificates/dataNeeds/negativeCache.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b6a");
const coB = await createCompany("b6b");

const FIELDS = [
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "shelf_life", label: "Shelf life", source: { kind: "product", path: 'specifications.values["Shelf life"]' }, category: "product_data" },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
];
const asked = { gap: [], infer: [] };
// nothing is ever found: every answer comes back empty
const generate = async (args) => {
  const gaps = JSON.parse(args.contents[3].slice(6));
  asked.gap.push(gaps.map((g) => g.label).sort());
  return { gaps: gaps.map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) };
};
const inferGenerate = async (args) => {
  const gaps = JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
  asked.infer.push(gaps.map((g) => g.label).sort());
  return { gaps: gaps.map((g) => ({ gapId: g.gapId, found: false, confidence: 0 })) };
};
async function setup(c) {
  const tpl = await seedTemplate(c.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  for (const f of FIELDS) await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: f.key }, data: { inferencePolicy: policyToStore({ dataCategory: f.category, source: f.source, isLabResult: f.isLabResult, label: f.label }, "product_facts_and_web") } });
}
let n = 0;
async function invoice(c, product, batch) {
  const no = `B6-${++n}`;
  const inv = await prisma.invoice.create({ data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000b6", header: { invoiceNumber: no }, headerExtracted: {}, textContent: `=== Page 1 ===\nINVOICE ${no}\n1 | ${product.name} | ${batch}` } });
  const data = { name: product.name, batchNo: batch, extra: {} };
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data, dataExtracted: data, productId: product.id, matchStatus: "matched", matchMethod: "user" } });
  return inv;
}
const run = (c, inv) => computeNeeds(inv.id, c.id, { generate, inferGenerate });

try {
  await setup(co);
  const P = await prisma.product.create({ data: { companyId: co.id, name: "VITA E", description: "Oral solution." } });

  console.log("\n🧪 First invoice: asked, came back empty");
  await run(co, await invoice(co, P, "L-1"));
  assert("gap call asked Storage, Shelf life and the pH result; inference asked the two product facts", asked.gap.length === 1 && asked.gap[0].join() === "Shelf life,Storage,pH result" && asked.infer.length === 1 && asked.infer[0].join() === "Shelf life,Storage", asked);
  const rows = await prisma.externalKnowledgeCache.findMany({ where: { kind: NEGATIVE_KIND, lookupKey: { startsWith: `${co.id}|` } } });
  assert("remembered: 2 product facts × (gap call, inference) — never the lab result", rows.length === 4 && !rows.some((r) => /pH/.test(r.payload.label)), rows.map((r) => `${r.payload.step}:${r.payload.label}`));

  console.log("\n🧪 Next invoice, same product, unchanged data");
  let view = await run(co, await invoice(co, P, "L-2"));
  assert("the gap call asks only the new batch's lab result", asked.gap.length === 2 && asked.gap[1].join() === "pH result", asked.gap);
  assert("inference isn't called at all (0 calls)", asked.infer.length === 1, asked.infer);
  assert("the check says why: known empty for this product", view.ai.knownEmpty === 2 && view.ai.inference.knownEmpty === 2, view.ai);
  const needs = await prisma.certificateDataNeed.findMany({ where: { companyId: co.id, fieldKey: "storage" }, orderBy: { createdAt: "desc" } });
  assert("…and the value is still honestly missing (nothing invented)", needs[0].status === "missing" && needs[0].value === null, needs[0]);

  console.log("\n🧪 The product's data changes → asked again");
  await prisma.product.update({ where: { id: P.id }, data: { description: "Oral solution. Store below 25 °C." } });
  await run(co, await invoice(co, P, "L-3"));
  assert("gap call and inference ask the product facts again", asked.gap.length === 3 && asked.gap[2].join() === "Shelf life,Storage,pH result" && asked.infer.length === 2 && asked.infer[1].join() === "Shelf life,Storage", asked);
  await run(co, await invoice(co, P, "L-4"));
  assert("…and after that empty answer, the next invoice is quiet again", asked.gap[3].join() === "pH result" && asked.infer.length === 2, asked);

  console.log("\n🧪 Another product, another company");
  const P2 = await prisma.product.create({ data: { companyId: co.id, name: "VITA C", description: "Powder." } });
  await run(co, await invoice(co, P2, "L-5"));
  assert("another product is asked as usual", asked.gap.at(-1).join() === "Shelf life,Storage,pH result" && asked.infer.length === 3, asked);
  await setup(coB);
  const PB = await prisma.product.create({ data: { companyId: coB.id, name: "VITA E", description: "Oral solution." } });
  await run(coB, await invoice(coB, PB, "L-1"));
  assert("another company (same name, same data) is asked as usual", asked.gap.at(-1).join() === "Shelf life,Storage,pH result" && asked.infer.length === 4, asked);
} catch (err) {
  console.error(err);
  assert(`unexpected error: ${err.message}`, false);
} finally {
  await finish(counts, async () => {
    await cleanupCompany(co.id);
    await cleanupCompany(coB.id);
  });
}
