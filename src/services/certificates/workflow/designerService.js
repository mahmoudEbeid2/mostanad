import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { experimentFor } from "../experiment/experimentMode.js";

// The designer's panel (client workflow §4): the product's data in the order the designer copies it
// into Illustrator — Product Name → Packing Size → Type → Form → Composition Basis → Ingredients →
// Quantities → Appearance / Color → pH — with tab-separated text whose name and quantity columns stay
// row-aligned when copied separately. Appearance / pH may be a designer's ESTIMATE: kept apart
// (product.designEstimates), marked «تقدير», and never a COA result (certificates can't read it).
// Every value says where it came from (file / page / catalogue) so the reviewer can open it.

const clean = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());

/** A provenance entry → { label, link } the UI opens (the file's page, or the catalogue page) */
export function evidenceOf(prov) {
  if (!prov) return null;
  if (prov.fileId) return { label: `${prov.file || "file"}${prov.page ? ` · p.${prov.page}` : ""}`, link: `/api/v1/evidence-files/${prov.fileId}${prov.page ? `#page=${prov.page}` : ""}`, quote: prov.quote || null };
  if (prov.catalogueVersionId) return { label: `catalogue${prov.page ? ` · p.${prov.page}` : ""}`, link: `/catalogues/versions/${prov.catalogueVersionId}${prov.page ? `?page=${prov.page}` : ""}`, quote: prov.quote || null };
  if (prov.tier === "manual" || prov.by) return { label: "typed by a person", link: null, quote: null };
  if (prov.source) return { label: prov.source, link: null, quote: prov.quote || null };
  return null;
}

/** GET /products/:id/designer?requestId= → { fields[], ingredients[], tsv: { table, names, quantities, shipment? }, shipment[] } */
export async function designerData(productId, companyId, { requestId = null } = {}) {
  const p = await prisma.product.findFirst({ where: { id: productId, ...(companyId ? { companyId } : {}) }, include: { category: { select: { name: true } } } });
  if (!p) throw new AppError("Product not found!", 404);
  const prov = p.fieldProvenance || {};
  const est = p.designEstimates || {};
  const ph = clean(p.specifications?.values?.pH) || clean(p.specifications?.values?.ph);
  const f = (key, label, value, source, extra = {}) => ({ key, label, value: value ?? null, evidence: evidenceOf(source), ...extra });
  const ingredients = (Array.isArray(p.activeIngredients) ? p.activeIngredients : []).map((i) => ({ name: i.name, quantity: i.amountRaw ?? i.concentration ?? "", basis: i.basis ?? null }));
  const basis = p.compositionBasis || ingredients.find((i) => i.basis)?.basis || null;
  const fields = [
    f("name", "Product Name", p.name, prov.name),
    f("packaging", "Packing Size", p.packaging, prov.packaging),
    f("type", "Type", p.productType || p.category?.name || null, prov.productType || prov.categoryId),
    f("form", "Form", p.physicalForm || p.dosageForm || null, prov.physicalForm || prov.dosageForm),
    f("compositionBasis", "Composition Basis", basis, prov.compositionBasis || prov.activeIngredients),
    f("ingredients", "Ingredients", ingredients.map((i) => i.name).join("\n") || null, prov.activeIngredients),
    f("quantities", "Quantities", ingredients.map((i) => i.quantity).join("\n") || null, prov.activeIngredients),
    p.appearance ? f("appearance", "Appearance / Color", p.appearance, prov.appearance) : f("appearance", "Appearance / Color", clean(est.appearance), null, est.appearance ? { estimate: true, assumptions: est.assumptions || null } : {}),
    ph ? f("ph", "pH", ph, prov.specifications) : f("ph", "pH", clean(est.ph), null, est.ph ? { estimate: true, assumptions: est.assumptions || null } : {}),
  ];
  // the shipment attachment: the request's lines of this product (description, pack, lot, lot size with its unit)
  let shipment = [];
  if (requestId) {
    const lines = await prisma.invoiceItem.findMany({ where: { invoiceId: requestId, productId: p.id, invoice: { companyId: p.companyId } }, orderBy: { lineNo: "asc" } });
    shipment = lines.map((l) => ({ lineNo: l.lineNo, description: l.data?.name || p.name, packing: l.data?.packing || p.packaging || "", lot: l.data?.batchNo || "", lotSize: [l.data?.extra?.lotSize, l.data?.extra?.lotUnit].filter(Boolean).join(" ") }));
  }
  const tab = (rows) => rows.map((r) => r.join("\t")).join("\n");
  // PART 3: under experiment mode everything copied says it is a sample (never pasted into a real design unmarked)
  const experiment = await experimentFor(p.companyId);
  const result = {
    productId: p.id,
    experiment: experiment.on,
    fields,
    ingredients,
    tsv: {
      // one row per ingredient: copying either column alone keeps the same row count and order
      table: tab(ingredients.map((i) => [i.name, i.quantity])),
      names: ingredients.map((i) => i.name).join("\n"),
      quantities: ingredients.map((i) => i.quantity).join("\n"),
      ...(shipment.length ? { shipment: tab([["Description", "Packing size", "Lot", "Lot size"], ...shipment.map((s) => [s.description, s.packing, s.lot, s.lotSize])]) } : {}),
    },
    shipment,
  };
  if (experiment.on) for (const k of Object.keys(result.tsv)) if (result.tsv[k]) result.tsv[k] = `SAMPLE – NOT VALID (AI-generated test data)\n${result.tsv[k]}`;
  return result;
}

/** PUT /products/:id/design-estimates { appearance?, ph?, assumptions } — design fields only, marked as an estimate */
export async function saveDesignEstimates(productId, companyId, { appearance = null, ph = null, assumptions = null }, userId) {
  const p = await prisma.product.findFirst({ where: { id: productId, ...(companyId ? { companyId } : {}) }, select: { id: true } });
  if (!p) throw new AppError("Product not found!", 404);
  if ((clean(appearance) || clean(ph)) && !clean(assumptions)) throw new AppError("Write what the estimate assumes (the vehicle, dilution, the phase measured)", 400);
  const designEstimates = clean(appearance) || clean(ph) ? { appearance: clean(appearance), ph: clean(ph), assumptions: clean(assumptions), estimate: true, byUserId: userId || null, at: new Date().toISOString() } : null;
  await prisma.product.update({ where: { id: p.id }, data: { designEstimates } });
  return designerData(p.id, companyId);
}
