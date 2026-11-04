// A new product from an unmatched invoice line (mockup D2).
// Proven here:
//  - the draft: prefill from the line, code only; neededFields = exactly the product paths this
//    line's selected templates read, tagged by type, following the chosen types, the line's brand
//    and the invoice's country; lab, batch and invoice values only in notAsked; similar products
//  - create: always in the invoice's company, line matched, alias only on rememberAlias, refused
//    for a matched / ignored line or a non-editable invoice, tenant isolation, permissions
//  - the plan and the data check follow; another line of the same name gets matched
//  - AI suggestions: empty shown fields only, marked estimated, never lab / batch / registration,
//    nothing stored until Create; a value kept as suggested stays an unconfirmed estimate
// The model is a stand-in; npm test never calls a paid API.
import bcrypt from "bcryptjs";
import { api, asCompany, form, fixture, makeAssert, finish, createCompany, cleanupCompany, prisma, BASE_URL } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { newProductDraft, suggestNewProduct, splitPackSize } from "../../src/services/certificates/invoices/newProductService.js";
import { computeNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { maskEstimates } from "../../src/services/catalogues/fieldProvenance.js";
import { closeQueues } from "../../src/services/certificates/jobs/queues.js";

const { assert, counts } = makeAssert();
const coA = await createCompany("d2a");
const coB = await createCompany("d2b");
const A = asCompany(coA.id);
const B = asCompany(coB.id);
const cid = coA.id;

const P = (key, label, path, o = {}) => ({ key, label, source: { kind: "product", path }, required: true, category: "product_data", ...o });
const pdf = () => ({ field: "invoice", buffer: fixture("outlined_text.pdf"), name: "inv.pdf", type: "application/pdf" });
const newInvoice = async (headers, company, fields = {}) => {
  const fd = form({ extract: "false", ...fields }, pdf());
  const r = await api("POST", "/invoices", headers, fd);
  return r.data.data.invoiceId;
};
const addLine = async (invoiceId, data, headers = A) => (await api("POST", `/invoices/${invoiceId}/items`, headers, { data })).data.data.item;
const byPath = (draft) => Object.fromEntries(draft.neededFields.map((f) => [f.path, f]));
const paths = (draft) => draft.neededFields.map((f) => f.path).sort().join();

/** Stand-in for CERT_PRODUCT_INFER: a typical answer for every gap it is asked, quoting the product's name. */
const typicalModel = (calls, name) => async (args) => {
  const gaps = JSON.parse(args.contents[2].slice("Gaps:\n".length));
  calls.push({ gaps, products: args.contents[1] });
  return { gaps: gaps.map((g) => ({ gapId: g.gapId, found: true, value: g.label === "First ingredient" ? "Vitamin A: 100,000 IU/ml; Vitamin E: 20 mg/ml" : `typical ${g.label}`, derivation: "typical", evidence: [{ path: "name", quote: name }], reasoning: "Usual for a product of this type", generalKnowledge: "Such products usually have this", confidence: 0.7 })) };
};

try {
  console.log("\n🧪 Pack size in the name");
  for (const [text, name, pack] of [
    ["MULTIVIT AD3E FORTE 1L x12", "MULTIVIT AD3E FORTE", "1L x12"],
    ["TOXINIL PREMIX 25KG", "TOXINIL PREMIX", "25KG"],
    ["Isozy powder 500 ml", "Isozy powder", "500 ml"],
    ["Selenium 12 x 1L", "Selenium", "12 x 1L"],
    ["VITAMIN E 200", "VITAMIN E 200", null],
    ["AD3E", "AD3E", null],
  ]) {
    const s = splitPackSize(text);
    assert(`"${text}" → "${name}" + ${pack}`, s.name === name && s.pack === pack, s);
  }

  console.log("\n🧪 Draft");
  const brand = await prisma.brand.create({ data: { companyId: cid, name: "Agrikima" } });
  const other = await prisma.brand.create({ data: { companyId: cid, name: "Other brand" } });
  const coa = await seedTemplate(cid, {
    typeName: "Certificate of Analysis",
    typeCode: "COA",
    scope: "per_product",
    name: "COA",
    fields: [
      P("pname", "Product name", "name"),
      P("storage", "Storage", "storage"),
      P("appearance", "Appearance", "appearance", { required: false }),
      P("ai1", "First ingredient", "activeIngredients[0].name"),
      P("life", "Shelf life", 'specifications.values["Shelf life"]'),
      P("batch", "Batch number", "batchNo", { source: { kind: "item", path: "batchNo" }, category: "invoice_line" }),
      P("invno", "Invoice no", "invoiceNumber", { source: { kind: "invoice", path: "invoiceNumber" }, category: "invoice_header" }),
      P("assay", "Assay result", "specifications.values.assay", { isLabResult: true, category: "batch_data" }),
      P("expiry", "Expiry date", "expiryDate"),
      { key: "co", label: "Company", source: { kind: "company", path: "name" } },
    ],
  });
  const fsc = await seedTemplate(cid, { typeName: "Free Sale Certificate", typeCode: "FSC", scope: "per_product", name: "FSC", fields: [P("storage2", "Storage conditions", "storage"), P("producer", "Manufacturer", "producer"), P("reg", "Registration no", "registrationNumber"), P("species", "Target species", "targetSpecies")] });
  // per invoice: reads a product value only through its list of invoice lines
  const coo = await seedTemplate(cid, { typeName: "Certificate of Origin", typeCode: "COO", scope: "per_invoice", name: "COO", fields: [{ key: "co2", label: "Company", source: { kind: "company", path: "name" } }] });
  await prisma.templateGroup.create({ data: { versionId: coo.versionId, key: "lines", label: "Lines", source: { kind: "invoice_lines" }, required: true } });
  await prisma.templateField.create({ data: { versionId: coo.versionId, key: "origin_cell", label: "Origin", lineId: "c1", charStart: 0, charEnd: 1, sampleValue: "x", source: { kind: "row", path: "product.origin" }, required: true, groupKey: "lines", sortOrder: 5 } });
  await prisma.templateField.create({ data: { versionId: coo.versionId, key: "batch_cell", label: "Batch", lineId: "c2", charStart: 0, charEnd: 1, sampleValue: "x", source: { kind: "row", path: "batchNo" }, required: true, groupKey: "lines", sortOrder: 6 } });

  const similar = await prisma.product.create({ data: { companyId: cid, name: "Multivit AD3E Plus", productCode: "MV-AD3E-2L", storage: "Dry" } });
  await prisma.product.create({ data: { companyId: cid, name: "Totally different name" } });
  const secretB = await prisma.product.create({ data: { companyId: coB.id, name: "Multivit AD3E Forte" } });

  const inv = await newInvoice(A, coA, { brandId: brand.id });
  const line = await addLine(inv, { name: "MULTIVIT AD3E FORTE 1L x12", code: "MV-AD3E-1L", batchNo: "MV0921", quantity: "120" });
  let r = await api("GET", `/invoices/${inv}/items/${line.id}/new-product-draft`, A);
  assert("draft → 200", r.status === 200, r.data);
  let d = r.data.data.draft;
  assert("prefill: name without pack size, code, packaging, the invoice's brand", d.prefill.name === "MULTIVIT AD3E FORTE" && d.prefill.productCode === "MV-AD3E-1L" && d.prefill.packaging === "1L x12" && d.prefill.brandId === brand.id && d.prefill.brandName === "Agrikima", d.prefill);
  assert("a packing column wins over the name", (await newProductDraft(inv, (await addLine(inv, { name: "X PRODUCT 1L", packing: "Box of 12" })).id, cid)).prefill.packaging === "Box of 12");
  assert("needed = exactly the paths the selected templates read", paths(d) === ["activeIngredients", "name", "origin", "producer", "registrationNumber", 'specifications.values["Shelf life"]', "appearance", "storage", "targetSpecies"].sort().join(), paths(d));
  let f = byPath(d);
  assert("a path read by two types is listed once, tagged by both", f.storage.types.sort().join() === "COA,FSC" && d.neededFields.filter((x) => x.path === "storage").length === 1, f.storage);
  assert("required as the field says; optional stays optional", f.storage.required === true && f.appearance.required === false);
  assert("ingredient paths are one composition input", f.activeIngredients.input === "ingredients" && f.activeIngredients.types.join() === "COA", f.activeIngredients);
  assert("a list of invoice lines reading the product counts", f.origin?.types.join() === "COO" && f.origin.required === true, f.origin);
  const not = Object.fromEntries(d.notAsked.map((n) => [n.label, n.from]));
  assert("batch, invoice and lab values are not asked, each says where it comes from", not["Batch number"] === "invoice line" && not["Invoice no"] === "invoice header" && not["Assay result"] === "results grid" && not["Expiry date"] === "invoice line" && not.Batch === "invoice line", not);
  assert("none of them in neededFields", !d.neededFields.some((x) => /batch|expiry|assay|invoice/i.test(x.label)), d.neededFields.map((x) => x.label));
  assert("a company value is neither", !d.neededFields.some((x) => x.label === "Company") && !d.notAsked.some((x) => x.label === "Company"));
  assert("type codes for the header", d.typeCodes.sort().join() === "COA,COO,FSC", d.typeCodes);
  assert("similar: the company's own products, up to 3, with a score", d.similar[0].productId === similar.id && d.similar[0].score > 0.3 && d.similar.length <= 3 && !d.similar.some((s) => s.productId === secretB.id), d.similar);
  assert("the full list has every product field", d.fullFields.length === 25 && d.fullFields.some((x) => x.path === "mixingInstructions") && !d.fullFields.some((x) => /batch|expiry/i.test(x.path)), d.fullFields.length);
  assert("no certificate message only when there is none", d.noCertificate === null);

  console.log("\n🧪 neededFields follow the choice");
  await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [fsc.typeId] });
  d = await newProductDraft(inv, line.id, cid);
  assert("only FSC: only its paths and tags", paths(d) === "producer,registrationNumber,storage,targetSpecies" && byPath(d).storage.types.join() === "FSC", paths(d));
  await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: [coa.typeId] });
  d = await newProductDraft(inv, line.id, cid);
  assert("only COA: only its paths", !byPath(d).producer && byPath(d).storage.types.join() === "COA");
  await api("PATCH", `/invoices/${inv}`, A, { certificateTypeIds: null });

  const branded = await seedTemplate(cid, { typeName: "Brand sheet", typeCode: "BS", scope: "per_product", name: "BS Other", brandId: other.id, fields: [P("indic", "Indications", "indications")] });
  d = await newProductDraft(inv, line.id, cid);
  assert("another brand's template isn't read", !byPath(d).indications, paths(d));
  const hinted = await addLine(inv, { name: "BRANDED THING" });
  await prisma.invoiceItem.update({ where: { id: hinted.id }, data: { data: { name: "BRANDED THING", extra: { Brand: "other BRAND" } } } });
  d = await newProductDraft(inv, hinted.id, cid);
  assert("the line's brand hint wins over the invoice's brand, and picks that template", d.prefill.brandId === other.id && !!byPath(d).indications, d.prefill);
  await prisma.certificateTemplate.update({ where: { id: branded.templateId }, data: { archivedAt: new Date() } });
  await prisma.invoiceItem.delete({ where: { id: hinted.id } });

  const egOnly = await createCompany("d2c");
  await seedTemplate(egOnly.id, { typeName: "EG only", typeCode: "EG", scope: "per_product", name: "EG", country: "EG", fields: [P("s", "Storage", "storage")] });
  const noTpl = await newInvoice(asCompany(egOnly.id), egOnly, { country: "SA" });
  const lonely = await addLine(noTpl, { name: "Lonely product" }, asCompany(egOnly.id));
  d = await newProductDraft(noTpl, lonely.id, egOnly.id);
  assert("no template for the line: empty, and it says so", d.neededFields.length === 0 && /no certificate/.test(d.noCertificate) && d.typeCodes.length === 0, d);
  await cleanupCompany(egOnly.id);

  console.log("\n🧪 AI suggestions");
  await prisma.templateField.updateMany({ where: { versionId: { in: [coa.versionId, fsc.versionId, coo.versionId] } }, data: { inferencePolicy: "product_facts_and_web" } });
  const before = await prisma.product.count({ where: { companyId: cid } });
  let calls = [];
  let s = await suggestNewProduct(inv, line.id, cid, { mode: "needed", values: { storage: "Below 25 C" } }, { generate: typicalModel(calls, "MULTIVIT AD3E FORTE") });
  const asked = calls[0].gaps.map((g) => g.label);
  assert("one call", calls.length === 1);
  assert("needed mode: empty required fields only", asked.includes("Manufacturer") && !asked.includes("Storage") && !asked.includes("Appearance"), asked);
  assert("registration never asked", !asked.some((l) => /registration/i.test(l)), asked);
  assert("batch, lab and invoice values never asked", !asked.some((l) => /batch|expiry|assay|invoice/i.test(l)), asked);
  assert("the model reads the line's own text", calls[0].products.includes("MULTIVIT AD3E FORTE") && calls[0].products.includes("Below 25 C"));
  assert("every value marked estimated with its reasoning", s.suggestions.length === asked.length && s.suggestions.every((x) => x.estimated === true && x.reasoning && x.suggestionId), s.suggestions[0]);
  const ingredients = s.suggestions.find((x) => x.path === "activeIngredients");
  assert("composition comes back as rows", ingredients.value.length === 2 && ingredients.value[1].name === "Vitamin E" && ingredients.value[1].concentration === "20 mg/ml", ingredients);
  const species = s.suggestions.find((x) => x.path === "targetSpecies");
  assert("a list comes back as a list", Array.isArray(species.value), species);
  assert("nothing stored by suggesting", (await prisma.product.count({ where: { companyId: cid } })) === before && (await prisma.invoiceItem.findUnique({ where: { id: line.id } })).matchStatus === "needs_match");
  const ledgerRun = await prisma.aiRun.findFirst({ where: { companyId: cid, kind: "CERT_PRODUCT_INFER" } });
  assert("logged as a CERT_PRODUCT_INFER run of this invoice", ledgerRun?.entityId === inv && ledgerRun.outcome === "ok", ledgerRun);

  await prisma.templateField.updateMany({ where: { versionId: fsc.versionId, key: "producer" }, data: { inferencePolicy: "never" } });
  calls = [];
  await suggestNewProduct(inv, line.id, cid, { mode: "needed", values: {} }, { generate: typicalModel(calls, "MULTIVIT AD3E FORTE") });
  assert("a field a person closed to inference isn't asked", !calls[0].gaps.some((g) => g.label === "Manufacturer"), calls[0].gaps);
  await prisma.templateField.updateMany({ where: { versionId: fsc.versionId, key: "producer" }, data: { inferencePolicy: "product_facts_and_web" } });

  calls = [];
  s = await suggestNewProduct(inv, line.id, cid, { mode: "full", values: {} }, { generate: typicalModel(calls, "MULTIVIT AD3E FORTE") });
  const fullAsked = calls[0].gaps.map((g) => g.label);
  assert("full mode: optional needed and other fields too", fullAsked.includes("Appearance") && fullAsked.includes("Mixing instructions") && fullAsked.includes("Dosage"), fullAsked);
  assert("full mode: never registration, identity or relations", !fullAsked.some((l) => /registration|brand|category|product code/i.test(l)), fullAsked);
  const refused = await suggestNewProduct(inv, line.id, cid, { mode: "needed", values: {} }, { generate: async () => ({ gaps: [{ gapId: "N1", found: true, value: "made up", derivation: "typical", evidence: [{ path: "name", quote: "NOT IN THE NAME" }], reasoning: "r", generalKnowledge: "g", confidence: 0.9 }] }) });
  assert("an answer whose quote isn't the product's is dropped", refused.suggestions.length === 0, refused);
  const failing = await suggestNewProduct(inv, line.id, cid, { mode: "needed", values: {} }, { generate: async () => { throw new Error("503 model overloaded"); } });
  assert("AI down: unavailable with a reason, nothing else", failing.unavailable === true && !!failing.reason && failing.suggestions.length === 0, failing);
  r = await api("POST", `/invoices/${inv}/items/${line.id}/new-product-suggest`, A, { mode: "needed", values: {} });
  assert("the route answers (AI is off in tests)", r.status === 200 && r.data.data.unavailable === true, r.data);
  await prisma.company.update({ where: { id: cid }, data: { aiSettings: { allowProductInference: false } } });
  calls = [];
  s = await suggestNewProduct(inv, line.id, cid, { mode: "needed", values: {} }, { generate: typicalModel(calls, "x") });
  assert("product inference off: no call", calls.length === 0 && s.unavailable === true, s);
  await prisma.company.update({ where: { id: cid }, data: { aiSettings: undefined } });
  await prisma.$executeRawUnsafe(`UPDATE companies SET ai_settings = NULL WHERE id = $1`, cid);

  console.log("\n🧪 Create");
  await api("POST", `/invoices/${inv}/data-needs`, A, { ai: false });
  let plan = (await api("GET", `/invoices/${inv}/generation-plan`, A)).data.data.plan;
  assert("before: no certificate for the line", plan.entries.length === 0);
  const twin = await addLine(inv, { name: "MULTIVIT AD3E FORTE 1L x12", batchNo: "OTHER" });
  r = await api("POST", `/invoices/${inv}/items/${line.id}/create-product`, A, { name: "Multivit AD3E Forte", storage: "Below 25 C", companyId: coB.id, rememberAlias: false, mode: "needed", pathValues: { 'specifications.values["Shelf life"]': "24 months" } });
  assert("create → 201", r.status === 201, r.data);
  const made = await prisma.product.findUnique({ where: { id: r.data.data.product.id } });
  assert("in the invoice's company, whatever the body says", made.companyId === cid);
  assert("needed mode: code, packaging and brand saved from the invoice", made.productCode === "MV-AD3E-1L" && made.packaging === "1L x12" && made.brandId === brand.id, made);
  assert("a named specification is written", made.specifications.values["Shelf life"] === "24 months" && made.specifications.type === "Specification", made.specifications);
  assert("empty fields stay empty", made.producer === null && made.activeIngredients === null);
  const matched = await prisma.invoiceItem.findUnique({ where: { id: line.id } });
  assert("line matched, by you", matched.matchStatus === "matched" && matched.productId === made.id && matched.matchMethod === "user", matched);
  assert("the response has the line and the product", r.data.data.item.id === line.id && r.data.data.item.productId === made.id && r.data.data.product.name === "Multivit AD3E Forte");
  assert("no alias without rememberAlias", (await prisma.productAlias.count({ where: { companyId: cid } })) === 0);
  assert("matching ran again", !!(await prisma.invoice.findUnique({ where: { id: inv } })).matchSummary);
  assert("a line with the same name is still open without an alias", (await prisma.invoiceItem.findUnique({ where: { id: twin.id } })).matchStatus === "needs_match");
  plan = (await api("GET", `/invoices/${inv}/generation-plan`, A)).data.data.plan;
  assert("the plan follows: COA + FSC for the line, COO for the invoice", plan.entries.length === 3, plan.entries.length);
  const needs = await prisma.certificateDataNeed.findMany({ where: { invoiceId: inv, invoiceItemId: line.id } });
  const need = (label) => needs.find((n) => n.label === label);
  assert("the data check follows: filled values resolved", need("Storage")?.status === "resolved" && need("Shelf life")?.status === "resolved", needs.map((n) => `${n.label}:${n.status}`));
  assert("… an empty required field shows as missing", need("Manufacturer")?.status === "missing", need("Manufacturer"));

  console.log("\n🧪 Refusals");
  r = await api("POST", `/invoices/${inv}/items/${line.id}/create-product`, A, { name: "Twice" });
  assert("a matched line is refused", r.status === 409 && r.data.code === "LINE_NOT_OPEN", r.data);
  await api("PATCH", `/invoices/${inv}/items/${twin.id}`, A, { ignored: true });
  r = await api("POST", `/invoices/${inv}/items/${twin.id}/create-product`, A, { name: "Ignored" });
  assert("an ignored line is refused", r.status === 409 && r.data.code === "LINE_NOT_OPEN", r.data);
  assert("… and no product was made", !(await prisma.product.findFirst({ where: { companyId: cid, name: { in: ["Twice", "Ignored"] } } })));
  await api("PATCH", `/invoices/${inv}/items/${twin.id}`, A, { ignored: false });
  r = await api("POST", `/invoices/${inv}/items/${twin.id}/create-product`, A, { name: "x" });
  assert("the schema still applies: name of 2+", r.status === 400, r.data);
  r = await api("POST", `/invoices/${inv}/items/${twin.id}/create-product`, A, { name: "Ok name", activeIngredients: [{ name: "No amount" }] });
  assert("… ingredients too, with the real message", r.status === 400 && /concentration/i.test(r.data.message), r.data);
  r = await api("POST", `/invoices/${inv}/items/${twin.id}/create-product`, A, { name: "Ok name", brandId: "00000000-0000-4000-8000-000000000000" });
  assert("another company's or an unknown brand is refused, nothing left behind", r.status === 400 && !(await prisma.product.findFirst({ where: { companyId: cid, name: "Ok name" } })), r.data);
  r = await api("POST", `/invoices/${inv}/items/${twin.id}/create-product`, A, { name: "Bad path", pathValues: { storage: "text column" } });
  assert("pathValues reach only values inside a JSON column", r.status === 400 && r.data.code === "INVALID_PATH", r.data);

  console.log("\n🧪 Alias, suggestions kept");
  calls = [];
  s = await suggestNewProduct(inv, twin.id, cid, { mode: "needed", values: {} }, { generate: typicalModel(calls, "MULTIVIT AD3E FORTE") });
  const pick = (path) => s.suggestions.find((x) => x.path === path);
  const third = await addLine(inv, { name: "Third line" });
  r = await api("POST", `/invoices/${inv}/items/${twin.id}/create-product`, A, { name: "Multivit twin", mode: "full", rememberAlias: true, storage: pick("storage").value, producer: "Edited by a person", suggestionIds: [pick("storage").suggestionId, pick("producer").suggestionId, pick("origin").suggestionId] });
  assert("create with suggestions", r.status === 201, r.data);
  const twinProduct = await prisma.product.findUnique({ where: { id: r.data.data.product.id } });
  assert("full mode: nothing filled in from the invoice", twinProduct.productCode === null && twinProduct.packaging === null && twinProduct.brandId === null, twinProduct);
  assert("a value kept as suggested is an estimate on the product", twinProduct.fieldProvenance.storage.estimated === true && twinProduct.fieldProvenance.storage.tier === "I" && !twinProduct.fieldProvenance.storage.confirmedAt, twinProduct.fieldProvenance);
  assert("a changed one is the person's", !twinProduct.fieldProvenance.producer);
  assert("certificates don't read an unconfirmed estimate", maskEstimates(twinProduct).storage === null);
  const dec = await prisma.aiSuggestion.findMany({ where: { id: { in: ["storage", "producer", "origin"].map((p) => pick(p).suggestionId) } } });
  const stat = (p) => dec.find((x) => x.id === pick(p).suggestionId).status;
  assert("the suggestions record what happened", stat("storage") === "accepted" && stat("producer") === "edited" && stat("origin") === "rejected", dec.map((x) => x.status));
  const alias = await prisma.productAlias.findFirst({ where: { companyId: cid } });
  assert("rememberAlias: the line's invoice name, confirmed", alias?.productId === twinProduct.id && !!alias.confirmedAt && alias.sourceInvoiceItemId === twin.id, alias);
  const inv2 = await newInvoice(A, coA);
  await addLine(inv2, { name: "multivit ad3e forte 1l x12" });
  await api("POST", `/invoices/${inv2}/rematch`, A);
  const learned = (await api("GET", `/invoices/${inv2}`, A)).data.data.invoice.items[0];
  assert("the next invoice matches by that name", learned.matchStatus === "matched" && learned.productId === twinProduct.id && learned.matchMethod === "alias", learned);
  const check = await computeNeeds(inv, cid, { ai: false });
  const est = check.certificates.flatMap((c) => c.needs || c.fields || []).find((n) => n.label === "Storage conditions" && n.status === "inferred") || (await prisma.certificateDataNeed.findFirst({ where: { invoiceId: inv, invoiceItemId: twin.id, label: "Storage" } }));
  assert("the data check asks a person to sign for the estimate", est?.status === "inferred", est);

  console.log("\n🧪 Other lines follow");
  const aliased = await newInvoice(A, coA);
  const a1 = await addLine(aliased, { name: "SHARED NAME 1L" });
  const a2 = await addLine(aliased, { name: "SHARED NAME 1L" });
  await api("POST", `/invoices/${aliased}/items/${a1.id}/create-product`, A, { name: "Shared", rememberAlias: true });
  const after = await prisma.invoiceItem.findUnique({ where: { id: a2.id } });
  assert("a line of the same name is matched by the re-run", after.matchStatus === "matched" && after.matchMethod === "alias", after);
  const open = await addLine(aliased, { name: "ANOTHER" });
  await api("PATCH", `/invoices/${aliased}/items/${open.id}`, A, { ignored: true });
  await api("POST", `/invoices/${aliased}/confirm`, A);
  assert("confirmed", (await prisma.invoice.findUnique({ where: { id: aliased } })).status === "ready");
  await api("PATCH", `/invoices/${aliased}/items/${open.id}`, A, { ignored: false });
  await api("POST", `/invoices/${aliased}/confirm`, A).catch(() => null);
  await prisma.invoice.update({ where: { id: aliased }, data: { status: "ready" } });
  r = await api("POST", `/invoices/${aliased}/items/${open.id}/create-product`, A, { name: "On a ready invoice" });
  assert("on a confirmed invoice: allowed, and it goes back to review like any line edit", r.status === 201 && (await prisma.invoice.findUnique({ where: { id: aliased } })).status === "review", r.data);

  console.log("\n🧪 Editable only, tenant isolation");
  await prisma.invoice.update({ where: { id: inv }, data: { status: "generated" } });
  r = await api("POST", `/invoices/${inv}/items/${third.id}/create-product`, A, { name: "Too late" });
  assert("a generated invoice is refused", r.status === 409 && r.data.code === "INVOICE_NOT_EDITABLE", r.data);
  r = await api("POST", `/invoices/${inv}/items/${third.id}/new-product-suggest`, A, {});
  assert("… suggesting too", r.status === 409, r.data);
  await prisma.invoice.update({ where: { id: inv }, data: { status: "review" } });
  for (const [method, path, body] of [["GET", "new-product-draft"], ["POST", "new-product-suggest", {}], ["POST", "create-product", { name: "Stolen" }]]) {
    r = await api(method, `/invoices/${inv}/items/${third.id}/${path}`, B, body);
    assert(`another company's invoice: ${path} is 404`, r.status === 404, r.data);
  }
  const invB = await newInvoice(B, coB);
  r = await api("POST", `/invoices/${invB}/items/${third.id}/create-product`, B, { name: "Mixed" });
  assert("a line of another invoice is 404", r.status === 404, r.data);
  assert("… nothing was created in either company", !(await prisma.product.findFirst({ where: { name: { in: ["Stolen", "Mixed"] } } })));

  console.log("\n🧪 Permissions (real JWT)");
  const ts = Date.now();
  const slugs = async (list) => (await prisma.permission.findMany({ where: { slug: { in: list } }, select: { id: true } })).map((p) => ({ permissionId: p.id }));
  const person = async (label, list) => {
    const role = await prisma.role.create({ data: { name: `d2_${label}_${ts}`, permissions: { create: await slugs(list) } } });
    const pw = `d2-${ts}`;
    const user = await prisma.user.create({ data: { name: `d2_${label}_${ts}`, username: `d2_${label}_${ts}`, email: `d2_${label}_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
    const login = await api("POST", "/auth/login", {}, { username: user.username, password: pw });
    return { role, user, token: login.data?.data?.token || login.data?.token };
  };
  const invoiceOnly = await person("inv", ["read_invoices", "update_invoices"]);
  const productOnly = await person("prod", ["create_products"]);
  const both = await person("both", ["read_invoices", "update_invoices", "create_products"]);
  const call = (who, method, path, body) => fetch(`${BASE_URL}/invoices/${inv}/items/${third.id}/${path}?companyId=${cid}`, { method, headers: { Authorization: `Bearer ${who.token}`, "x-force-auth": "true", "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  assert("invoice permission alone: create refused", (await call(invoiceOnly, "POST", "create-product", { name: "No perm" })).status === 403);
  assert("invoice permission alone: draft refused", (await call(invoiceOnly, "GET", "new-product-draft")).status === 403);
  assert("create_products alone: refused", (await call(productOnly, "POST", "create-product", { name: "No perm" })).status === 403);
  assert("both: draft works", (await call(both, "GET", "new-product-draft")).status === 200);
  assert("both: create works", (await call(both, "POST", "create-product", { name: "With perm" })).status === 201);
  for (const p of [invoiceOnly, productOnly, both]) {
    await prisma.user.delete({ where: { id: p.user.id } });
    await prisma.role.delete({ where: { id: p.role.id } });
  }
} catch (err) {
  assert(`unexpected error: ${err.message}`, false, err.stack);
} finally {
  await cleanupCompany(coA.id);
  await cleanupCompany(coB.id);
  await closeQueues();
}
await finish(counts);
