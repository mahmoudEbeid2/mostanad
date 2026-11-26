// 29 Nov backfill: a product's PHYSICAL form (Liquid, Powder…) apart from what a certificate prints as its
// "Product Form" (ADDVET's COC: "Antibiotic", "Supplement" — which had become the products' physical form
// and printed in the HC's FORM column). Idempotent; a dry run unless --apply.
//   1 products: a physical form that isn't one, filled automatically (harvest / intake, never a person's),
//     moves to productForm (its evidence kept); the products are merged again from their harvested facts,
//     so the files' real form (e.g. the HC's "LIQUID") fills physicalForm
//   2 template fields reading product.physicalForm whose place is labelled "Product Form" read productForm
//     (sources only: spans unchanged, a prepared / active version stays valid — fieldsHash ignores sources)
//   3 products still without a physical form: estimated (descriptive, marked «مستنتج») — only with --infer
// Usage: node scripts/splitProductForm.js [--apply] [--infer] [--company <id>]
import { prisma } from "../src/lib/prisma.js";
import { isPhysicalForm } from "../src/services/harvest/productForm.js";
import { mergeProduct } from "../src/services/harvest/harvestService.js";
import { rowLabel } from "../src/services/certificates/templates/autoMap.js";

const APPLY = process.argv.includes("--apply");
const INFER = process.argv.includes("--infer");
const companyId = process.argv.includes("--company") ? process.argv[process.argv.indexOf("--company") + 1] : null;
const AUTOMATIC = new Set(["harvest", "intake"]);
const scope = companyId ? { companyId } : {};

// 1 · products
const wrong = (await prisma.product.findMany({ where: { ...scope, physicalForm: { not: null } }, select: { id: true, companyId: true, name: true, physicalForm: true, productForm: true, fieldProvenance: true } })).filter(
  (p) => !isPhysicalForm(p.physicalForm) && AUTOMATIC.has(p.fieldProvenance?.physicalForm?.source),
);
console.log(`${wrong.length} product(s) with a "physical form" that is a label${APPLY ? "" : " (dry run)"}`);
for (const p of wrong) {
  if (APPLY) {
    const prov = { ...(p.fieldProvenance || {}) };
    const data = {};
    if (!p.productForm) {
      data.productForm = p.physicalForm;
      prov.productForm = prov.physicalForm;
    }
    await prisma.product.update({ where: { id: p.id }, data: { ...data, fieldProvenance: prov } });
    await mergeProduct(p.id); // the files' real physical form, or the label cleared
  }
  const after = APPLY ? await prisma.product.findUnique({ where: { id: p.id }, select: { physicalForm: true, productForm: true } }) : null;
  console.log(`  ${p.name}: "${p.physicalForm}" → productForm${after ? ` "${after.productForm}", physicalForm ${after.physicalForm ? `"${after.physicalForm}"` : "(none — to estimate)"}` : ""}`);
}

// 2 · template fields
// a place is the certificate's «Product Form» when its label says so, or when the page prints "Product Form"
// before it on its line (ADDVET's active COC: a field labelled just "Form" on "Product Form: Supplement")
const candidates = (await prisma.templateField.findMany({ where: { source: { path: ["path"], equals: "physicalForm" }, ...(companyId ? { version: { template: { companyId } } } : {}) }, select: { id: true, label: true, source: true, versionId: true, lineId: true, charStart: true, version: { select: { lines: true } } } })).filter((f) => f.source?.kind === "product");
// (the label printed before it on its line, left of it on its row, or stacked right above it — rowLabel)
const fields = candidates.filter((f) => {
  if (/Product\s*form/i.test(f.label || "")) return true;
  const lines = f.version?.lines || [];
  const line = lines.find((l) => l.id === f.lineId);
  if (line && /Product\s*Form\s*:?\s*$/i.test(String(line.text).slice(0, f.charStart))) return true;
  return rowLabel({ lineId: f.lineId }, lines) === "Product form";
});
console.log(`${fields.length} template field(s) labelled "Product Form" reading the physical form`);
for (const f of fields) {
  if (APPLY) await prisma.templateField.update({ where: { id: f.id }, data: { source: { ...f.source, path: "productForm" } } });
  console.log(`  ${f.versionId} "${f.label}" → product.productForm`);
}

// 3 · estimates
if (INFER) {
  const { inferProductGaps } = await import("../src/services/harvest/harvestInfer.js");
  const missing = await prisma.product.findMany({ where: { ...scope, physicalForm: null, id: { in: wrong.map((p) => p.id) } }, select: { id: true, companyId: true } });
  const byCompany = new Map();
  for (const p of missing) byCompany.set(p.companyId, [...(byCompany.get(p.companyId) || []), p.id]);
  for (const [cid, productIds] of byCompany) {
    const out = APPLY ? await inferProductGaps({ companyId: cid, productIds }) : null;
    console.log(`  estimated for ${productIds.length} product(s)${out ? `: ${JSON.stringify(out.filled ?? out).slice(0, 200)}` : " (dry run)"}`);
  }
}
await prisma.$disconnect();
process.exit(0);
