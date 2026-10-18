// Certificates V2 — templateSelector (CERTIFICATES_V2_PLAN.md §10.1, §16.3, §20 I15/I16).
// Pure function: brand/country specificity matrix, never a foreign brand or
// country, unassigned lines, per_invoice grouping, one certificate per LINE.
import { selectTemplates } from "../../src/services/certificates/generation/templateSelector.js";
import { makeAssert } from "./helpers.js";

const { assert, counts } = makeAssert();
const T = (id, o = {}) => ({ id, name: id, certificateTypeId: "COA", certificateType: { code: "COA", name: "Certificate of Analysis" }, brandId: null, country: null, scope: "per_product", activeVersionId: `${id}-v`, ...o });
const line = (n, productId, brandId = null, o = {}) => ({ id: `it${n}`, lineNo: n, matchStatus: "matched", productId, product: { id: productId, name: `P-${productId}`, brandId, brand: brandId ? { name: `Brand ${brandId}` } : null }, data: { batchNo: `B${n}` }, ...o });
const pick = (plan, itemId) => plan.entries.filter((e) => e.invoiceItemIds.includes(itemId)).map((e) => e.templateId);

try {
  console.log("\n🧪 Specificity matrix (brand beats brandless, country beats countryless)");
  const all = [T("any"), T("brandA", { brandId: "A" }), T("SA", { country: "SA" }), T("brandA-SA", { brandId: "A", country: "SA" })];
  const cases = [
    [{ country: "SA" }, "A", "brandA-SA"],
    [{ country: "SA" }, null, "SA"],
    [{ country: "EG" }, "A", "brandA"],
    [{ country: null }, "A", "brandA"],
    [{ country: "EG" }, null, "any"],
    [{ country: "SA" }, "B", "SA"],
  ];
  for (const [inv, brand, want] of cases) {
    const plan = selectTemplates({ invoice: inv, items: [line(1, "p1", brand)], templates: all });
    assert(`country=${inv.country ?? "∅"} brand=${brand ?? "∅"} → ${want}`, pick(plan, "it1").join() === want, pick(plan, "it1"));
  }
  let plan = selectTemplates({ invoice: { country: "SA", brandId: "A" }, items: [line(1, "p1", null)], templates: all });
  assert("invoice brand hint used when the product has no brand", pick(plan, "it1").join() === "brandA-SA", pick(plan, "it1"));
  plan = selectTemplates({ invoice: { country: "SA", brandId: "B" }, items: [line(1, "p1", "A")], templates: all });
  assert("the product's own brand wins over the invoice hint", pick(plan, "it1").join() === "brandA-SA");

  console.log("\n🧪 Never a foreign country or brand; gaps and unassigned");
  plan = selectTemplates({ invoice: { country: "EG" }, items: [line(1, "p1", "B")], templates: [T("SA", { country: "SA" }), T("brandA", { brandId: "A" })] });
  assert("no applicable template → no entry", plan.entries.length === 0);
  assert("…the line is unassigned", plan.unassigned.map((u) => u.lineNo).join() === "1", plan.unassigned);
  assert("…and the type gap names brand + country", plan.gaps.length === 1 && plan.gaps[0].typeCode === "COA" && plan.gaps[0].brandName === "Brand B" && plan.gaps[0].country === "EG", plan.gaps);
  plan = selectTemplates({ invoice: { country: null }, items: [line(1, "p1")], templates: [T("SA", { country: "SA" })] });
  assert("an invoice without a country never gets a country template", plan.entries.length === 0);
  plan = selectTemplates({ invoice: {}, items: [line(1, "p1")], templates: [T("draft", { activeVersionId: null })] });
  assert("a template without an active version is ignored", plan.entries.length === 0);

  console.log("\n🧪 Lines considered");
  plan = selectTemplates({
    invoice: {},
    items: [line(1, "p1"), line(2, "p2", null, { matchStatus: "ignored" }), line(3, null, null, { matchStatus: "needs_match" })],
    templates: [T("any")],
  });
  assert("only matched lines (ignored / unmatched skipped)", plan.entries.length === 1 && plan.entries[0].lineNos.join() === "1" && plan.unassigned.length === 0);

  console.log("\n🧪 One certificate per line (I15) and per_invoice grouping (A2)");
  plan = selectTemplates({ invoice: {}, items: [line(1, "p1"), line(2, "p1")], templates: [T("any")] });
  assert("same product on two lines → two certificates", plan.entries.length === 2 && new Set(plan.entries.map((e) => e.planKey)).size === 2, plan.entries.map((e) => e.planKey));
  assert("planKey = versionId:itemId", plan.entries[0].planKey === "any-v:it1");
  const coll = T("FSC-all", { certificateTypeId: "FSC", certificateType: { code: "FSC", name: "Free Sale" }, scope: "per_invoice" });
  const collA = T("FSC-A", { certificateTypeId: "FSC", certificateType: { code: "FSC", name: "Free Sale" }, scope: "per_invoice", brandId: "A" });
  plan = selectTemplates({ invoice: {}, items: [line(1, "p1", "A"), line(2, "p2", "B"), line(3, "p3", "A")], templates: [coll, collA] });
  const fsc = plan.entries.filter((e) => e.typeCode === "FSC");
  assert("per_invoice: one certificate per resolved template version", fsc.length === 2, fsc);
  assert("…brand A lines grouped, in line order", fsc.find((e) => e.templateId === "FSC-A")?.lineNos.join() === "1,3");
  assert("…productId null, planKey versionId:invoice", fsc.every((e) => e.productId === null && e.planKey.endsWith(":invoice")));

  console.log("\n🧪 Per (type, scope) — I16");
  plan = selectTemplates({ invoice: {}, items: [line(1, "p1"), line(2, "p2")], templates: [T("COA-each"), T("COA-all", { scope: "per_invoice" })] });
  assert("per_product and per_invoice of the same type both apply", plan.entries.filter((e) => e.scope === "per_product").length === 2 && plan.entries.filter((e) => e.scope === "per_invoice").length === 1);
  assert("summary counts per template version", plan.summary.find((s) => s.templateId === "COA-each")?.count === 2 && plan.summary.find((s) => s.templateId === "COA-all")?.lines === 2, plan.summary);
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
}

console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
