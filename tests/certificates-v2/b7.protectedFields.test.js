// What the AI may generate (owner, 2026-10-27). Two PROTECTED classes are never generated, on any
// path: lab results (isLabResult) and batch facts (isBatchFact — batch / lot number, production /
// manufacturing / expiry date; pre-set by label, owner-editable in Mark fields). Everything else —
// specifications, appearance, description, storage, shelf life after opening, usage, warnings,
// manufacturer, origin, document wording — may be generated, from the product's data and general
// knowledge of its type ("typical"), always filled as estimated with its reasoning and facts.
// Proven here:
//  - the classes, in code: pre-sets, the owner's tick both ways, invoice-owned values stay out
//  - every path: inference (never in the prompt; a "typical" answer for a protected field is
//    rejected by code), the web (never in the query), the catalogue and the product profile (not
//    allowed), a product value for a batch fact (refused), the estimate offer
//  - every generated value carries its reasoning, the general fact and the facts of this product
//  - Mark fields: the batch-fact tick is stored, kept when a client leaves it out, pre-set for new fields
//  - tenant isolation: another company's product never reaches the prompt; its cache never counts
//  - the negative cache: an empty answer recorded under another prompt doesn't count
// Stand-in models (npm test never calls a paid API). Needs the guarded stack (npm run dev:test).
import { api, asCompany, makeAssert, finish, createCompany, cleanupCompany, uploadTemplate, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, webLookupNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { isProtected, isBatchFact, isLabResult, defaultPolicy, allowsInference, allowsWeb, allowsCatalogue } from "../../src/services/certificates/inference/policy.js";
import { profileAllowed } from "../../src/services/certificates/dataNeeds/productProfile.js";
import { verifyInference, PROMPT_HASH } from "../../src/services/certificates/inference/productInference.js";
import { knownEmpty, rememberEmpty, productFingerprint } from "../../src/services/certificates/dataNeeds/negativeCache.js";

const { assert, counts } = makeAssert();
const co = await createCompany("b7a");
const coB = await createCompany("b7b");

const PRODUCT = {
  name: "VITA SOL AD3E",
  dosageForm: "Oral solution",
  description: "Vitamin supplement for poultry, given in drinking water.",
  activeIngredients: [{ name: "Vitamin A", concentration: "80000 IU/ml" }, { name: "Vitamin D3", concentration: "40000 IU/ml" }, { name: "Vitamin E", concentration: "20 mg/ml" }],
  specifications: { values: { expiry: "12/2027" } }, // a value a batch fact must never take from the product
};
const FIELDS = [
  { key: "appearance", label: "Appearance", source: { kind: "product", path: "specifications.values.Appearance" }, category: "product_data" },
  { key: "usage", label: "Usage", source: { kind: "manual" }, category: "unknown" },
  { key: "storage_open", label: "Shelf life after opening", source: { kind: "product", path: "specifications.values.shelfLifeOpen" }, category: "product_data" },
  { key: "statement", label: "Certification statement", source: { kind: "manual" }, category: null },
  { key: "appearance_result", label: "Appearance result", source: { kind: "manual" }, category: "product_data", isLabResult: true },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
  { key: "lot", label: "Lot No.", source: { kind: "manual" }, category: "unknown" },
  { key: "expiry", label: "Expiry date", source: { kind: "product", path: "specifications.values.expiry" }, category: "product_data" },
  { key: "mfg", label: "Manufacturing date", source: { kind: "manual" }, category: "unknown" },
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
];
const PROTECTED_KEYS = ["appearance_result", "ph_result", "lot", "expiry", "mfg"];
const PROTECTED_LABELS = ["Appearance result", "pH result", "Lot No.", "Expiry date", "Manufacturing date"];
const f = (over) => ({ dataCategory: "product_data", source: { kind: "product", path: "specifications.values.x" }, ...over });
const parseGaps = (args) => JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
const typical = (over = {}) => ({ found: true, value: "Clear yellow liquid", derivation: "typical", evidence: [{ path: "dosageForm", quote: "Oral solution" }, { path: "activeIngredients", quote: "Vitamin A" }], reasoning: "An oral AD3E vitamin solution is a clear yellow liquid.", generalKnowledge: "Oral fat-soluble vitamin (A, D3, E) solutions are typically clear yellow liquids.", confidence: 0.7, ...over });
const noGaps = async (args) => ({ gaps: JSON.parse(args.contents[3].slice(6)).map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) });

async function seed(c, product) {
  const p = await prisma.product.create({ data: { ...product, companyId: c.id } });
  const t = await seedTemplate(c.id, { name: "COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  for (const x of FIELDS) await prisma.templateField.updateMany({ where: { versionId: t.versionId, key: x.key }, data: { inferencePolicy: defaultPolicy({ label: x.label, dataCategory: x.category, source: x.source, isLabResult: x.isLabResult }) } });
  const inv = await prisma.invoice.create({ data: { companyId: c.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000b7", header: { invoiceNumber: `B7-${c.id.slice(0, 4)}` }, headerExtracted: {}, textContent: "=== Page 1 ===\nINVOICE B7" } });
  const line = { name: product.name, batchNo: "B-1", extra: {} };
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: line, dataExtracted: line, productId: p.id, matchStatus: "matched", matchMethod: "user" } });
  return { product: p, inv, ...t };
}

try {
  console.log("\n🧪 The protected classes, decided by code");
  assert("lab results: the owner's tick, batch data, a ticked 'Appearance'", isLabResult(f({ label: "Appearance", isLabResult: true })) && isLabResult(f({ label: "Colour", dataCategory: "batch_data" })) && isProtected(f({ label: "pH result", isLabResult: true })));
  assert("batch facts pre-set by label: Batch No., Lot, Batch Size, Production / Manufacturing / Expiry / Exp. date, Best before", ["Batch No.", "Lot", "Lot No.", "Batch Size", "Production Date", "Manufacturing date", "MFG Date", "Expiry date", "Exp. date", "Best before"].every((label) => isBatchFact(f({ label }))));
  assert("…and by the invoice line's batch / date source, whatever the label", isBatchFact({ label: "EXP", source: { kind: "item", path: "expiryDate" } }) && isBatchFact({ label: "Code", source: { kind: "item", path: "batchNo" } }));
  assert("the owner's tick decides both ways: an unticked 'Batch No.' / a ticked 'Grade'", !isBatchFact(f({ label: "Batch No.", isBatchFact: false })) && isBatchFact(f({ label: "Grade", isBatchFact: true })));
  assert("not batch facts: Shelf life, Shelf life after opening, Manufacturer, Storage", !["Shelf life", "Shelf life after opening", "Manufacturer", "Storage"].some((label) => isBatchFact(f({ label }))));
  const open = ["Appearance", "Colour", "Odour", "Description", "Composition", "Storage", "Shelf life after opening", "Packaging", "Usage", "Warnings", "Manufacturer", "Origin"];
  assert("everything else may be generated (inference + web): " + open.join(", "), open.every((label) => allowsInference(f({ label })) && allowsWeb(f({ label }))));
  assert("…also with no category or a hand-typed source (document wording)", allowsInference({ label: "Certification statement", source: { kind: "manual" } }) && allowsInference({ label: "Usage", dataCategory: "unknown", source: { kind: "manual" } }));
  assert("invoice-owned values are not generated (invoice number, quantity)", !allowsInference({ label: "Invoice No.", dataCategory: "invoice_header", source: { kind: "invoice", path: "invoiceNumber" } }) && !allowsInference(f({ label: "Quantity" })));
  const prot = [f({ label: "Appearance result", isLabResult: true }), f({ label: "Expiry date" }), f({ label: "Batch No." }), f({ label: "Lot No." })];
  assert("protected → no inference, no web, no catalogue, no product profile, policy never", prot.every((x) => !allowsInference(x) && !allowsWeb(x) && !allowsCatalogue(x) && !profileAllowed(x) && defaultPolicy(x) === "never"));

  console.log("\n🧪 A 'typical' answer (general knowledge of the product type)");
  const P = { ...PRODUCT };
  let v = verifyInference(typical(), P, { field: f({ label: "Appearance" }) });
  assert("an allowed field: filled as an estimate with reasoning, the general fact and this product's facts", v.ok && v.estimated === true && v.provenance.derivation === "typical" && v.provenance.estimated === true && !!v.provenance.estimateBasis && !!v.provenance.generalKnowledge && v.provenance.evidence.length === 2 && v.provenance.evidence.every((e) => e.path && e.quote), v);
  assert("a lab result / a batch fact / no field → rejected by code", [f({ label: "Appearance result", isLabResult: true }), f({ label: "Expiry date" }), f({ label: "Lot No." }), null].every((field) => !verifyInference(typical(), P, { field }).ok));
  assert("no general fact / no reasoning → rejected", !verifyInference(typical({ generalKnowledge: "" }), P, { field: f({ label: "Appearance" }) }).ok && !verifyInference(typical({ reasoning: " " }), P, { field: f({ label: "Appearance" }) }).ok);
  assert("a fact that isn't this product's / a fact without its quote / no fact → rejected", ![{ evidence: [{ path: "dosageForm", quote: "Injectable suspension" }] }, { evidence: [{ path: "dosageForm" }] }, { evidence: [] }].some((o) => verifyInference(typical(o), P, { field: f({ label: "Appearance" }) }).ok));

  console.log("\n🧪 The data check: generated as estimates, protected never");
  const A = await seed(co, PRODUCT);
  const calls = [];
  const typicalForAll = async (args) => {
    calls.push(args);
    return { gaps: parseGaps(args).map((g) => typical({ gapId: g.gapId, value: { Appearance: "Clear yellow liquid", Usage: "Add to drinking water", "Shelf life after opening": "3 months", "Certification statement": "We certify the product complies with its specification." }[g.label] || "Clear yellow liquid" })) };
  };
  await computeNeeds(A.inv.id, co.id, { generate: noGaps, inferGenerate: typicalForAll });
  let n = Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId: A.inv.id } })).map((r) => [r.fieldKey, r]));
  assert("ONE inference call", calls.length === 1, calls.length);
  const sent = calls[0] ? parseGaps(calls[0]).map((g) => g.label) : [];
  assert("no protected field reaches the prompt (lab results, Lot, Expiry, Manufacturing date, Batch No.)", !sent.some((l) => PROTECTED_LABELS.includes(l) || l === "Batch No."), sent);
  assert("every non-protected gap is asked: Appearance, Usage, Shelf life after opening, Certification statement", ["Appearance", "Usage", "Shelf life after opening", "Certification statement"].every((l) => sent.includes(l)), sent);
  const generated = ["appearance", "usage", "storage_open", "statement"].map((k) => n[k]);
  assert("…each filled, estimated, waiting for a person", generated.every((r) => r.status === "inferred" && r.value && r.provenance?.estimated === true && r.provenance?.derivation === "typical"), generated.map((r) => [r.fieldKey, r.status, r.value]));
  assert("…each with its reasoning, general fact and the facts of this product", generated.every((r) => r.provenance.estimateBasis && r.provenance.generalKnowledge && r.provenance.evidence?.length && r.provenance.evidence.every((e) => e.path && e.quote)));
  assert("Appearance = 'Clear yellow liquid' from 'Oral solution' + its vitamins", n.appearance.value === "Clear yellow liquid" && n.appearance.provenance.evidence.some((e) => e.path === "product.dosageForm" && e.quote === "Oral solution"));
  assert("protected fields take no value: lab results, Lot, Expiry (even though the product holds '12/2027'), Manufacturing date", PROTECTED_KEYS.every((k) => !n[k].value && !["inferred", "resolved", "resolved_ai", "web_found", "catalogue_found"].includes(n[k].status)), PROTECTED_KEYS.map((k) => [k, n[k].status, n[k].value]));
  assert("Batch No. comes from the invoice line, as before", n.batch_no.status === "resolved" && n.batch_no.value === "B-1", [n.batch_no.status, n.batch_no.value]);
  const sug = await prisma.aiSuggestion.findMany({ where: { companyId: co.id, kind: "product_infer" } });
  assert("generated values are suggestions for a person (none auto-accepted)", sug.length === 4 && sug.every((s) => s.status === "pending"), sug.map((s) => s.status));

  console.log("\n🧪 The web: protected fields never in the query");
  // reopen the generated rows so the web is asked for them too, then look at the query
  await prisma.certificateDataNeed.updateMany({ where: { invoiceId: A.inv.id, fieldKey: { in: ["appearance", "usage"] } }, data: { status: "missing", value: null, provenance: null, suggestionId: null } });
  const searches = [];
  await webLookupNeeds(A.inv.id, co.id, { search: async (a) => (searches.push(a), { fields: [] }), fetchPage: async () => ({ ok: false, status: 404 }) });
  const q = searches.map((s) => JSON.stringify(s.contents)).join(" ");
  assert("one web call, for the generatable fields only", searches.length === 1 && q.includes("Appearance") && !PROTECTED_LABELS.some((l) => q.includes(l)) && !q.includes("Batch No."), q.slice(0, 400));
  n = Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId: A.inv.id } })).map((r) => [r.fieldKey, r]));
  assert("protected fields still take no value", PROTECTED_KEYS.every((k) => !n[k].value));

  console.log("\n🧪 Mark fields: the batch-fact tick");
  // a real converted design (fields are measured in it): the ADDVET COA, in its own slot (country)
  const up = await uploadTemplate(co.id, { file: "ADDVET_COA.ai", name: "ADDVET (b7)", certificateTypeId: A.typeId, country: "EG" });
  const draft = up.version;
  assert("ADDVET design converted to a draft", draft?.status === "draft", up.task?.error || up.status);
  const mk = (key, label, sample, extra = {}) => {
    const line = (draft?.lines || []).find((l) => l.text.includes(sample));
    const start = line ? line.text.indexOf(sample) : 0;
    return { key, label, lineId: line?.id, charStart: start, charEnd: start + sample.length, sampleValue: sample, source: { kind: "manual" }, dataCategory: "unknown", ...extra };
  };
  let r = await api("PUT", `/template-versions/${draft?.id}/fields`, asCompany(co.id), { fields: [mk("bn", "Batch No.", "AVVS1122005", { isBatchFact: false }), mk("prod", "Production Date", "11/2022"), mk("origin", "Origin", "JORDAN", { isBatchFact: true })] });
  let stored = Object.fromEntries((await prisma.templateField.findMany({ where: { versionId: draft?.id } })).map((x) => [x.key, x]));
  assert("PUT stores the owner's ticks (Batch No. unticked, Origin ticked) and the pre-set for a new 'Production Date'", r.status === 200 && stored.bn?.isBatchFact === false && stored.origin?.isBatchFact === true && stored.prod?.isBatchFact === true, [r.status, r.data?.message, stored.bn?.isBatchFact, stored.origin?.isBatchFact, stored.prod?.isBatchFact]);
  assert("…and the policy follows: the unticked Batch No. may be generated, the ticked Origin may not", stored.bn?.inferencePolicy === "product_facts_and_web" && stored.origin?.inferencePolicy === "never", [stored.bn?.inferencePolicy, stored.origin?.inferencePolicy]);
  r = await api("PUT", `/template-versions/${draft?.id}/fields`, asCompany(co.id), { fields: [mk("bn", "Batch No.", "AVVS1122005"), mk("prod", "Production Date", "11/2022"), mk("origin", "Origin", "JORDAN")] });
  stored = Object.fromEntries((await prisma.templateField.findMany({ where: { versionId: draft?.id } })).map((x) => [x.key, x]));
  assert("a client that leaves the tick out keeps what is stored", r.status === 200 && stored.bn?.isBatchFact === false && stored.origin?.isBatchFact === true && stored.prod?.isBatchFact === true);
  r = await api("GET", `/template-versions/${draft?.id}`, asCompany(co.id));
  const listed = Object.fromEntries((r.data?.data?.fields || r.data?.data?.version?.fields || []).map((x) => [x.key, x.isBatchFact]));
  assert("GET the version returns each field's tick as it applies", listed.bn === false && listed.origin === true && listed.prod === true, listed);

  console.log("\n🧪 Tenant isolation");
  const B = await seed(coB, { ...PRODUCT, name: "VITA SOL AD3E", description: "COMPANY-B-ONLY description" });
  const bCalls = [];
  await computeNeeds(B.inv.id, coB.id, { generate: noGaps, inferGenerate: async (args) => (bCalls.push(args), { gaps: parseGaps(args).map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) }) });
  assert("company A's prompt never carried company B's product", !JSON.stringify(calls[0].contents).includes("COMPANY-B-ONLY"));
  assert("company B's prompt carries its own product only (its own call, A's answers not reused)", bCalls.length === 1 && JSON.stringify(bCalls[0].contents).includes("COMPANY-B-ONLY"));
  const nB = await prisma.certificateDataNeed.findMany({ where: { invoiceId: B.inv.id } });
  assert("company B got none of company A's generated values", nB.every((x) => x.status !== "inferred" && !(x.value || "").includes("Clear yellow")), nB.map((x) => [x.fieldKey, x.status]));
  const field = { key: "appearance", label: "Appearance", dataCategory: "product_data", source: { kind: "product", path: "specifications.values.Appearance" } };
  const known = await knownEmpty(coB.id, "I", [{ productId: B.product.id, field, fingerprint: productFingerprint(B.product) }], { promptHash: PROMPT_HASH });
  assert("B's empty answer is B's: A's negative cache has no entry for it", (await knownEmpty(co.id, "I", [{ productId: B.product.id, field, fingerprint: productFingerprint(B.product) }], { promptHash: PROMPT_HASH })).size === 0 && known.size === 1, known.size);

  console.log("\n🧪 Negative cache: an empty answer under another prompt doesn't count");
  const fp = productFingerprint(A.product);
  await rememberEmpty(co.id, "I", A.product.id, field, fp, { invoiceId: A.inv.id, reason: "not found", promptHash: "old-rule" });
  assert("recorded under the old rule → asked again", (await knownEmpty(co.id, "I", [{ productId: A.product.id, field, fingerprint: fp }], { promptHash: PROMPT_HASH })).size === 0);
  await rememberEmpty(co.id, "I", A.product.id, field, fp, { invoiceId: A.inv.id, reason: "not found", promptHash: PROMPT_HASH });
  assert("recorded under the current rule → not asked again", (await knownEmpty(co.id, "I", [{ productId: A.product.id, field, fingerprint: fp }], { promptHash: PROMPT_HASH })).size === 1);
} finally {
  await finish(counts, async () => {
    for (const c of [co.id, coB.id]) await cleanupCompany(c);
  });
}
