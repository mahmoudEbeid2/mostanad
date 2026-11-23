// "Copy to another brand": every product-data field is copied, the registration
// number and everything batch/certificate/label/invoice-specific is not; copied
// fields carry "copied" provenance (an unconfirmed estimate stays an estimate);
// tenancy (a company copies only within itself, a system user across companies,
// the brand must belong to the target company); bulk; the source diff and
// "update from source" applying only the ticked fields; the assistant's copy
// tools only run from an approved card. Needs `npm run dev:test`.
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asCompany, asAdmin, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import * as registry from "../src/services/assistant/registry/index.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as actions from "../src/services/assistant/actions.js";
import { COPYABLE_FIELDS } from "../src/services/productCopyService.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;

const FULL = {
  description: "Broad-spectrum antibiotic powder",
  indications: "Respiratory infections in poultry",
  targetSpecies: ["Poultry", "Turkeys"],
  physicalForm: "Powder",
  appearance: "White to off-white powder",
  activeIngredients: [{ name: "Amoxicillin trihydrate", concentration: "20%" }],
  dosage: "1 g per 2 L drinking water for 5 days",
  mixingInstructions: "Dissolve in a little water first",
  withdrawalPeriod: "Meat: 3 days",
  contraindications: "Not for laying hens",
  userSafety: ["Wear gloves", "Avoid inhalation"],
  storage: "Below 25 °C, dry place",
  packaging: "100 g sachet",
  origin: "Egypt",
  producer: "Pharma Co",
  specifications: { type: "string", values: { pH: "5.5-7.0", Assay: "98-102%" } },
  routeOfAdmin: "Oral",
  dosageForm: "Water-soluble powder",
  strength: "200 mg/g",
  productType: "VET_DRUG",
  prescriptionStatus: "POM",
};

async function main() {
  console.log("🧪 Products — copy to another brand\n");
  const coA = await createCompany(`copyA${s}`);
  const coB = await createCompany(`copyB${s}`);
  const A = asCompany(coA.id);
  const B = asCompany(coB.id);
  const category = await prisma.category.create({ data: { name: `Copy cat ${s}` } });
  const [brandA1, brandA2, brandB1] = await Promise.all([
    prisma.brand.create({ data: { name: `Brand A1 ${s}`, companyId: coA.id } }),
    prisma.brand.create({ data: { name: `Brand A2 ${s}`, companyId: coA.id } }),
    prisma.brand.create({ data: { name: `Brand B1 ${s}`, companyId: coB.id } }),
  ]);
  const src = await prisma.product.create({
    data: {
      ...FULL,
      companyId: coA.id,
      brandId: brandA1.id,
      categoryId: category.id,
      name: `Amoxi 20 ${s}`,
      productCode: `AMX-${s}`,
      registrationNumber: `REG-${s}`,
      catalogueRef: { catalogueId: crypto.randomUUID(), page: 3 },
      fieldProvenance: {
        storage: { tier: "C", page: 3, quote: "Below 25 °C", at: "2026-01-01T00:00:00Z" },
        withdrawalPeriod: { tier: "I", estimated: true, basis: "similar products", at: "2026-01-01T00:00:00Z" },
        "specifications.values.Assay": { tier: "C", page: 4, quote: "98-102%", at: "2026-01-01T00:00:00Z" },
      },
    },
  });
  await prisma.productAlias.create({ data: { productId: src.id, companyId: coA.id, aliasNorm: `amoxi alias ${s}`, origin: "user_confirmed", confirmedAt: new Date() } });
  const other = await prisma.product.create({ data: { companyId: coA.id, brandId: brandA1.id, name: `Other ${s}`, storage: "Cool" } });
  const foreign = await prisma.product.create({ data: { companyId: coB.id, brandId: brandB1.id, name: `Foreign ${s}`, storage: "x" } });

  try {
    let r = await api("GET", "/products/copy-fields", A);
    const groups = r.data?.data?.groups || [];
    assert("copy-fields: the groups list every copyable field and offer no registration number", r.status === 200 && groups.flatMap((g) => g.fields).length === COPYABLE_FIELDS.length && !JSON.stringify(groups).includes("registrationNumber") && r.data.data.neverCopied.includes("registrationNumber"), r.data);

    console.log("\nCopy one product");
    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandA2.id, name: `Vetamox ${s}`, productCode: `VMX-${s}` });
    const copy = r.data?.data?.product;
    assert("201 → a new product in the target brand with the new name and code", r.status === 201 && copy?.brandId === brandA2.id && copy.name === `Vetamox ${s}` && copy.productCode === `VMX-${s}` && copy.companyId === coA.id, r.data);
    const row = await prisma.product.findUnique({ where: { id: copy.id } });
    const differ = COPYABLE_FIELDS.filter((f) => f !== "categoryId" && JSON.stringify(row[f]) !== JSON.stringify(FULL[f]));
    assert(`every product-data field copied (${COPYABLE_FIELDS.length})`, !differ.length && row.categoryId === category.id, differ);
    assert("registration number NOT copied (empty) and flagged 'needs its own registration number'", row.registrationNumber === null && row.fieldProvenance.registrationNumber?.reason === "needs its own registration number" && r.data.data.needsRegistrationNumber === true);
    assert("catalogue ref not copied", row.catalogueRef === null);
    const aliasCount = await prisma.productAlias.count({ where: { productId: copy.id } });
    assert("aliases not copied", aliasCount === 0);
    const [labels, certVals, batches] = await Promise.all([prisma.generatedLabel.count({ where: { productId: copy.id } }), prisma.productCertificateValue.count({ where: { productId: copy.id } }), prisma.batchResult.count({ where: { productId: copy.id } })]);
    assert("no labels, certificate values or batch results on the copy", labels + certVals + batches === 0);
    const fp = row.fieldProvenance;
    assert("provenance of each copied field: tier 'copied', sourceProductId, at, byUserId", ["description", "activeIngredients", "dosage", "userSafety"].every((f) => fp[f]?.tier === "copied" && fp[f].sourceProductId === src.id && fp[f].at && "byUserId" in fp[f]), fp);
    assert("…keeping the source's own entry under `from` (catalogue quote)", fp.storage?.from?.tier === "C" && fp.storage.from.quote === "Below 25 °C" && fp["specifications.values.Assay"]?.tier === "copied");
    assert("an unconfirmed estimate stays an estimate in the copy", fp.withdrawalPeriod?.estimated === true && fp.withdrawalPeriod.from?.tier === "I");
    assert("linked: sourceProductId set", row.sourceProductId === src.id);
    const srcAfter = await prisma.product.findUnique({ where: { id: src.id } });
    assert("the original is unchanged", srcAfter.registrationNumber === `REG-${s}` && srcAfter.brandId === brandA1.id && srcAfter.updatedAt.getTime() === src.updatedAt.getTime());

    r = await api("GET", `/products/${copy.id}`, A);
    assert("copy page: 'Copied from <A> · <brand>'", r.data?.data?.product?.copyInfo?.source?.id === src.id && r.data.data.product.copyInfo.source.brand.name === brandA1.name && r.data.data.product.copyInfo.needsRegistrationNumber === true, r.data?.data?.product?.copyInfo);
    r = await api("GET", `/products/${src.id}`, A);
    assert("source page: 'Used by: <copies>'", r.data?.data?.product?.copyInfo?.copies?.some((c) => c.id === copy.id && c.brand.name === brandA2.name));

    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandA2.id, name: `Partial ${s}`, fieldsToCopy: ["composition_form", "storage_packaging"], keepLinked: false });
    const partial = await prisma.product.findUnique({ where: { id: r.data?.data?.product?.id } });
    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandA2.id, name: `Fields ${s}`, fieldsToCopy: ["storage"] });
    const onlyStorage = await prisma.product.findUnique({ where: { id: r.data?.data?.product?.id } });
    assert("a field name means that field only (storage, not packaging)", onlyStorage?.storage === FULL.storage && onlyStorage.packaging === null, onlyStorage);
    assert("fieldsToCopy (groups): only those groups; keepLinked false → no link", partial?.storage === FULL.storage && partial.strength === FULL.strength && partial.dosage === null && partial.indications === null && partial.sourceProductId === null, partial);
    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandA2.id, name: `Reg ${s}`, fieldsToCopy: ["registrationNumber"] });
    assert("asking to copy the registration number → 400 with the reason", r.status === 400 && /registration number/i.test(r.data?.message), r.data);
    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandA2.id, name: `Bad ${s}`, fieldsToCopy: ["batchNo"] });
    assert("an unknown field → 400", r.status === 400);
    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandA2.id, name: "x" });
    assert("a name under 2 characters → 400", r.status === 400);

    console.log("\nTenancy");
    r = await api("POST", `/products/${src.id}/copy`, A, { targetBrandId: brandB1.id, name: `Leak ${s}` });
    assert("company user → another company's brand: refused (400, brand not in this company)", r.status === 400 && /brand/i.test(r.data?.message));
    r = await api("POST", `/products/${src.id}/copy`, A, { targetCompanyId: coB.id, targetBrandId: brandB1.id, name: `Leak2 ${s}` });
    assert("company user naming another company → 404", r.status === 404);
    r = await api("POST", `/products/${foreign.id}/copy`, A, { targetBrandId: brandA2.id, name: `Steal ${s}` });
    assert("company user copying another tenant's product → 404", r.status === 404);
    assert("…nothing created in either company", (await prisma.product.count({ where: { name: { in: [`Leak ${s}`, `Leak2 ${s}`, `Steal ${s}`] } } })) === 0);
    r = await api("POST", `/products/${src.id}/copy`, asAdmin, { targetCompanyId: coB.id, targetBrandId: brandB1.id, name: `Cross ${s}` });
    const cross = r.data?.data?.product;
    assert("system admin → another company's brand: 201, in that company", r.status === 201 && cross?.companyId === coB.id && cross.brandId === brandB1.id, r.data);
    r = await api("POST", `/products/${src.id}/copy`, asAdmin, { targetCompanyId: coB.id, targetBrandId: brandA2.id, name: `Mismatch ${s}` });
    assert("system admin: a brand that isn't in the target company → 400", r.status === 400);
    r = await api("GET", `/products/${cross.id}`, B);
    assert("company B sees its copy but not A's product behind it", r.status === 200 && r.data.data.product.copyInfo.source === null && r.data.data.product.copyInfo.sourceInOtherCompany === true);
    r = await api("GET", `/products/${src.id}`, A);
    assert("company A's 'Used by' doesn't list B's copy", !r.data.data.product.copyInfo.copies.some((c) => c.id === cross.id));
    r = await api("GET", `/products/${cross.id}/source-diff`, B);
    assert("company B can't read A's product through the diff → 404", r.status === 404);

    console.log("\nBulk");
    r = await api("POST", "/products/copy-bulk", A, { productIds: [src.id, other.id, foreign.id], targetBrandId: brandA2.id, names: [{ productId: src.id, name: `Bulk one ${s}`, productCode: `B1-${s}` }, { productId: other.id, name: `Bulk two ${s}` }] });
    const res = r.data?.data?.results || [];
    assert("bulk: two copied, the other tenant's product reported as not found (one per product)", r.status === 201 && r.data.data.copied === 2 && r.data.data.failed === 1 && res.find((x) => x.productId === foreign.id)?.status === 404 && res.find((x) => x.productId === src.id)?.product?.name === `Bulk one ${s}`, r.data);
    const bulkOne = await prisma.product.findFirst({ where: { name: `Bulk one ${s}` } });
    assert("bulk copies follow the same rules (no registration number, copied provenance)", bulkOne.registrationNumber === null && bulkOne.productCode === `B1-${s}` && bulkOne.fieldProvenance.dosage?.tier === "copied");

    console.log("\nUpdate from source: only the ticked fields");
    await prisma.product.update({ where: { id: src.id }, data: { storage: "Below 30 °C", dosage: "2 g per 2 L", indications: "Changed indications" } });
    await prisma.product.update({ where: { id: copy.id }, data: { packaging: "Copy's own packaging" } });
    r = await api("GET", `/products/${copy.id}/source-diff`, A);
    const diff = r.data?.data;
    const changed = (diff?.fields || []).filter((f) => !f.same).map((f) => f.field).sort();
    assert("diff lists exactly the fields that differ", r.status === 200 && JSON.stringify(changed) === JSON.stringify(["dosage", "indications", "packaging", "storage"]), changed);
    r = await api("POST", `/products/${copy.id}/update-from-source`, A, { fields: ["storage", "dosage"] });
    const upd = await prisma.product.findUnique({ where: { id: copy.id } });
    assert("only the ticked fields take the source's value", r.status === 200 && upd.storage === "Below 30 °C" && upd.dosage === "2 g per 2 L" && upd.indications === FULL.indications && upd.packaging === "Copy's own packaging", upd);
    assert("…their provenance is 'copied' again (new time); the registration number untouched", upd.fieldProvenance.storage.tier === "copied" && upd.fieldProvenance.storage.at > row.fieldProvenance.storage.at && upd.registrationNumber === null);
    r = await api("POST", `/products/${copy.id}/update-from-source`, A, { fields: ["registrationNumber"] });
    assert("update-from-source never takes the registration number (400)", r.status === 400);
    r = await api("POST", `/products/${copy.id}/update-from-source`, A, { fields: [] });
    assert("nothing ticked → 400", r.status === 400);
    r = await api("POST", `/products/${other.id}/update-from-source`, A, { fields: ["storage"] });
    assert("a product that isn't a linked copy → 400", r.status === 400);

    console.log("\nAssistant: copy tools only through an approved card");
    const actorA = { kind: "company", id: coA.id, name: coA.name, companyId: coA.id };
    await assistant.updateSettings(coA.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
    const conv = await assistant.createConversation(actorA);
    const ctx = (texts) => ({ actor: actorA, scope: { companyId: coA.id }, conversationId: conv.id, userTexts: texts, propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor: actorA, ...p }) });
    let t = await registry.runTool("copy_product_to_brand", { sourceProductId: src.id, targetBrandId: brandA2.id, name: `Chat copy ${s}` }, ctx([`copy it as Chat copy ${s}`]));
    let card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    const details = Object.fromEntries((card?.preview?.details || []).map((d) => [d.label, d.value]));
    assert("the model's call makes a card and creates nothing", t.status === "needs_confirmation" && card?.status === "pending" && (await prisma.product.count({ where: { name: `Chat copy ${s}` } })) === 0, t);
    assert("card: source → target brand, new name, fields copied, 'registration number not copied'", details.From?.includes(src.name) && details["To brand"]?.includes(brandA2.name) && details["New name"] === `Chat copy ${s}` && /fields/.test(details["Fields copied"]) && /not copied/.test(details["Registration number"]), details);
    const ran = await actions.approveAction(actorA, card.id);
    const chatCopy = await prisma.product.findFirst({ where: { name: `Chat copy ${s}` } });
    assert("after Run: the copy exists, without a registration number", ran.status === "done" && chatCopy?.brandId === brandA2.id && chatCopy.registrationNumber === null && chatCopy.sourceProductId === src.id, ran);

    t = await registry.runTool("copy_product_to_brand", { sourceProductId: foreign.id, targetBrandId: brandA2.id, name: `Chat steal ${s}` }, ctx([]));
    assert("chat: another tenant's product can't be copied (no card)", !t.data?.actionId, t.data);
    t = await registry.runTool("copy_product_to_brand", { sourceProductId: src.id, targetBrandId: brandB1.id, name: `Chat leak ${s}` }, ctx([]));
    assert("chat: another tenant's brand can't be the target (no card)", !t.data?.actionId, t.data);

    t = await registry.runTool("copy_products_to_brand", { targetBrandId: brandA2.id, products: [{ productId: src.id, name: `Chat bulk 1 ${s}` }, { productId: other.id, name: `Chat bulk 2 ${s}` }] }, ctx([`copy them as Chat bulk 1 ${s} and Chat bulk 2 ${s}`]));
    card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    assert("bulk: one card listing each product → its new name, nothing created yet", card?.preview?.details?.some((d) => d.value === `→ Chat bulk 1 ${s}`) && (await prisma.product.count({ where: { name: { startsWith: `Chat bulk` } } })) === 0, card?.preview || t.data);
    const bulkRan = await actions.approveAction(actorA, card.id);
    assert("bulk after Run: both copied", bulkRan.status === "done" && bulkRan.result.copied === 2, bulkRan.result);

    t = await registry.runTool("get_copy_source_diff", { productId: chatCopy.id }, ctx([]));
    assert("get_copy_source_diff is a read (runs now, changes nothing)", t.status === "ok" && Array.isArray(t.data.differences));
    await prisma.product.update({ where: { id: src.id }, data: { contraindications: "New contraindications" } });
    t = await registry.runTool("update_copy_from_source", { productId: chatCopy.id, fields: ["contraindications"] }, ctx(["update the contraindications from the original"]));
    card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    assert("update_copy_from_source: a card with copy → original per field, nothing changed yet", card?.preview?.details?.[0]?.value === `${FULL.contraindications} → New contraindications` && (await prisma.product.findUnique({ where: { id: chatCopy.id } })).contraindications === FULL.contraindications, card?.preview);
    await actions.approveAction(actorA, card.id);
    assert("…after Run only that field changed", (await prisma.product.findUnique({ where: { id: chatCopy.id } })).contraindications === "New contraindications");
    let err = null;
    try {
      await registry.executeApproved("copy_product_to_brand", { sourceProductId: src.id, targetBrandId: brandA2.id, name: "x y" }, { actor: actorA, companyId: coB.id });
    } catch (e) {
      err = e;
    }
    assert("a card can't run in another company than the session's", !!err);
  } finally {
    await prisma.product.deleteMany({ where: { companyId: { in: [coA.id, coB.id] }, sourceProductId: { not: null } } }).catch(() => null);
    await cleanupCompany(coA.id).catch((e) => console.error(e.message));
    await cleanupCompany(coB.id).catch((e) => console.error(e.message));
    await prisma.category.delete({ where: { id: category.id } }).catch(() => null);
  }
  const { passed, failed } = counts;
  console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
