// Optional is not "not applicable" (owner, 2026-11-05, certificate 53f9951d: Appearance printed
// blank, flagCount 0, "ready"). required = false means "may stay empty after we tried", not
// "don't try". Proven here:
//  - an optional, non-protected empty field goes through the pipeline and comes back estimated,
//    with reasoning and facts, a person can confirm it, and it prints flagged until they do
//  - the order DB → invoice → catalogue → web → inference, one inference call per product
//  - not_applicable only when the owner marked the field or a person skipped a protected field
//  - what stays empty is "missing (optional)": counted, shown, flagged on the certificate, never blocking
//  - required fields block as before; protected classes are never generated
// Stand-in models (npm test never calls a paid API). Needs the guarded stack (npm run dev:test).
import { makeAssert, finish, createCompany, cleanupCompany, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds, decideNeeds, getNeeds, webLookupNeeds, blockingCounts, usableNeeds, recheckCode, PRINTABLE } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { resolveWithNeed, isBlocking, countBlocking, emptyFlags } from "../../src/services/certificates/generation/batchService.js";
import { validateFieldList } from "../../src/services/certificates/templates/fieldService.js";
import { preparedView, runPrepareJob } from "../../src/services/certificates/prepare/prepareService.js";
import { scanTemplate } from "../../src/services/certificates/templates/repairScan.js";
import { suggestSource } from "../../src/services/certificates/templates/repairService.js";
import { resolveField } from "../../src/services/certificates/generation/valueResolver.js";
import { verifyInference } from "../../src/services/certificates/inference/productInference.js";
import { validateSource } from "../../src/services/certificates/templates/sourceCatalogue.js";

const { assert, counts } = makeAssert();
const co = await createCompany("e2a");

const AD3E = { name: "AD3E TEST", physicalForm: "Liquid", activeIngredients: [{ name: "Vitamin A", concentration: "25000 IU/ml" }, { name: "Vitamin K3", concentration: "20 mg/ml" }] };
const EMPTY = { name: "BARE TEST" };
const FIELDS = [
  { key: "product_name", label: "Product Name", source: { kind: "product", path: "name" }, category: "product_data" },
  { key: "appearance", label: "Appearance", source: { kind: "product", path: "appearance" }, category: "product_data", required: false },
  { key: "origin", label: "Origin", source: { kind: "product", path: "origin" }, category: "product_data", required: false },
  { key: "storage", label: "Storage", source: { kind: "product", path: "storage" }, category: "product_data" },
  { key: "not_used", label: "Customs stamp", source: { kind: "manual" }, category: "unknown", required: false },
  { key: "lot", label: "Lot No.", source: { kind: "manual" }, category: "unknown", required: false },
  { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true, required: false },
  { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line" },
];
const parseGaps = (args) => JSON.parse(args.contents[2].slice(args.contents[2].indexOf("\n") + 1));
const noGaps = async (args) => ({ gaps: JSON.parse(args.contents[3].slice(6)).map((g) => ({ gapId: g.gapId, found: false, evidence: [], confidence: 0 })) });
const estimate = (gapId, value) => ({ gapId, found: true, value, derivation: "typical", evidence: [{ path: "physicalForm", quote: "Liquid" }, { path: "activeIngredients", quote: "Vitamin A" }], reasoning: "An oral vitamin liquid with these ingredients.", generalKnowledge: "Oral fat-soluble vitamin liquids are typically clear yellow.", confidence: 0.7 });
const inferring = (calls, answer = (g) => (g.label === "Origin" ? { gapId: g.gapId, found: false, evidence: [], confidence: 0 } : estimate(g.gapId, "Clear yellow liquid"))) => async (args) => {
  calls.push(args);
  return { gaps: parseGaps(args).map(answer) };
};

async function seed(products, { number, marks = {} } = {}) {
  const made = [];
  for (const p of products) made.push(await prisma.product.create({ data: { ...p, name: `${p.name} ${number}`, companyId: co.id } }));
  const t = await seedTemplate(co.id, { name: `COA ${number}`, typeCode: `E${number}`, typeName: `Type ${number}`, scope: "per_product", fields: FIELDS });
  await prisma.templateField.updateMany({ where: { versionId: t.versionId }, data: { inferencePolicy: "product_facts_and_web" } });
  for (const [key, data] of Object.entries(marks)) await prisma.templateField.update({ where: { versionId_key: { versionId: t.versionId, key } }, data });
  const inv = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000e2", header: { invoiceNumber: `E2-${number}` }, headerExtracted: {}, textContent: "=== Page 1 ===\nINVOICE" } });
  for (const [i, p] of made.entries()) {
    const data = { name: p.name, extra: {} };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data, dataExtracted: data, productId: p.id, matchStatus: "matched", matchMethod: "user" } });
  }
  return { inv, products: made, ...t };
}
const needs = async (invoiceId) => Object.fromEntries((await prisma.certificateDataNeed.findMany({ where: { invoiceId } })).map((r) => [r.fieldKey, r]));

try {
  console.log("\n🧪 An optional, non-protected field goes through the pipeline");
  const A = await seed([AD3E], { number: 1, marks: { not_used: { notApplicable: true } } });
  let calls = [];
  let view = await computeNeeds(A.inv.id, co.id, { generate: noGaps, inferGenerate: inferring(calls) });
  let n = await needs(A.inv.id);
  assert("the bug: optional Appearance reaches inference", parseGaps(calls[0]).some((g) => g.label === "Appearance"), calls[0] && parseGaps(calls[0]));
  assert("filled, estimated, waiting for a person", n.appearance.status === "inferred" && n.appearance.value === "Clear yellow liquid" && n.appearance.provenance?.estimated === true, n.appearance);
  assert("with its reasoning and the facts it rests on", !!n.appearance.provenance.estimateBasis && !!n.appearance.provenance.generalKnowledge && n.appearance.provenance.evidence.length === 2);
  assert("still optional: an estimate on it doesn't block", n.appearance.required === false && (await blockingCounts(A.inv.id)).needsConfirmation === 1, await blockingCounts(A.inv.id));

  console.log("\n🧪 not_applicable only when someone said so");
  assert("the owner's tick: not_applicable", n.not_used.status === "not_applicable");
  assert("…and it is never looked for", !parseGaps(calls[0]).some((g) => g.label === "Customs stamp"));
  assert("no tick and nothing found: missing, optional", n.origin.status === "missing" && n.origin.required === false, n.origin);
  assert("a protected optional field isn't quietly not_applicable either", n.lot.status === "missing" && n.ph_result.status === "missing", [n.lot.status, n.ph_result.status]);

  console.log("\n🧪 The data check counts");
  const s = view.summary;
  assert("missing counts the required ones", s.missing === 1, s);
  assert("missingOptional: Origin, Lot, pH result", s.missingOptional === 3, s);
  assert("notApplicable: the ticked one only", s.notApplicable === 1, s);
  assert("blocking: required missing (Batch No.) + required estimate (Storage)", s.blocking === 2 && (await blockingCounts(A.inv.id)).missing === 1, s);
  const prep = await preparedView(A.inv);
  assert("Prepare lists what stays empty", prep.missing === 1 && prep.missingOptional.map((x) => x.label).sort().join() === "Lot No.,Origin,pH result", prep.missingOptional);

  console.log("\n🧪 Protected classes are never generated");
  const asked = calls.flatMap((c) => parseGaps(c).map((g) => g.label));
  assert("Lot No., pH result, Batch No. are never in the prompt", !asked.some((l) => ["Lot No.", "pH result", "Batch No."].includes(l)), asked);
  assert("…and take no value", [n.lot, n.ph_result, n.batch_no].every((r) => r.value === null));

  console.log("\n🧪 A person decides what stays empty");
  await decideNeeds(A.inv.id, co.id, [{ needId: n.lot.id, action: "skip" }], null);
  n = await needs(A.inv.id);
  assert("skip: a protected optional field becomes not_applicable", n.lot.status === "not_applicable" && n.lot.provenance?.kind === "skipped", n.lot);
  await recheckCode(A.inv.id, co.id);
  assert("the skip survives a recheck", (await needs(A.inv.id)).lot.status === "not_applicable");
  const skipNot = async (id) => decideNeeds(A.inv.id, co.id, [{ needId: id, action: "skip" }], null).catch((e) => e.code);
  assert("a non-protected field can't be skipped: it is estimated or marked by the owner", (await skipNot(n.origin.id)) === "CANNOT_SKIP");
  assert("a required one can't be skipped", (await skipNot(n.batch_no.id)) === "CANNOT_SKIP");
  await decideNeeds(A.inv.id, co.id, [{ needId: n.lot.id, action: "reset" }], null);
  assert("reset takes the skip back", (await needs(A.inv.id)).lot.status === "missing");
  await decideNeeds(A.inv.id, co.id, [{ needId: n.appearance.id, action: "reject" }], null);
  n = await needs(A.inv.id);
  assert("a rejected estimate on an optional field: missing (optional), not not_applicable", n.appearance.status === "missing" && n.appearance.value === null, n.appearance);
  calls = [];
  await computeNeeds(A.inv.id, co.id, { generate: noGaps, inferGenerate: inferring(calls) });
  assert("…and it is not offered again", (await needs(A.inv.id)).appearance.status === "missing" && !calls.flatMap(parseGaps).some((g) => g.label === "Appearance"));

  console.log("\n🧪 What generation prints");
  const appearance = await prisma.templateField.findUnique({ where: { versionId_key: { versionId: A.versionId, key: "appearance" } } });
  const need = { id: "n", status: "inferred", value: "Clear yellow liquid", provenance: { estimated: true }, decidedByUserId: null, decidedAt: null };
  let r = resolveWithNeed(appearance, { product: {} }, need);
  assert("an estimate prints, flagged unconfirmed", r.value === "Clear yellow liquid" && r.flags.includes("unconfirmed"), r);
  assert("unconfirmed refuses finalize", isBlocking("unconfirmed") && countBlocking({ appearance: { flags: r.flags } }) === 1);
  r = resolveWithNeed(appearance, { product: {} }, { ...need, status: "resolved_ai", provenance: { estimated: true, confirmedByUserId: "u" } });
  assert("once a person confirmed it: no flag", r.value === "Clear yellow liquid" && !r.flags.includes("unconfirmed"), r);
  r = resolveWithNeed(appearance, { product: {} }, null);
  assert("never blank silently: an empty optional value is flagged", r.value === "" && r.flags.includes("empty_optional"), r);
  assert("…informational, finalize isn't refused for it", !isBlocking("empty_optional"));
  assert("no flag on a field the owner marked, or a required one (that is `missing`)", !emptyFlags({ notApplicable: true }, "").length && !emptyFlags({ required: true }, "").length && !emptyFlags({}, "x").length);
  assert("the check hands generation its estimates too", ["inferred", "web_found", "catalogue_found", "needs_confirmation", "resolved_ai", "provided", "reused"].every((st) => PRINTABLE.includes(st)) && !PRINTABLE.includes("missing"));

  console.log("\n🧪 The order: web before inference, one inference call per product");
  const B = await seed([AD3E, EMPTY], { number: 2 });
  calls = [];
  view = await computeNeeds(B.inv.id, co.id, { generate: noGaps, inferGenerate: inferring(calls), webFirst: true });
  assert("web first: nothing the web can answer is inferred yet", calls.length === 0 && view.tiers.webEligible > 0, [calls.length, view.tiers]);
  const order = [];
  const search = async () => {
    order.push("web");
    return { fields: [] };
  };
  // an almost empty product has only its name to quote; an answer citing what it lacks is refused by code
  const byName = (g) => ({ ...estimate(g.gapId, "Clear yellow liquid"), evidence: [{ path: "name", quote: "TEST" }] });
  const inferGenerate = async (args) => {
    order.push("infer");
    return inferring(calls, byName)(args);
  };
  await webLookupNeeds(B.inv.id, co.id, { search, fetchPage: async () => ({ ok: false, status: 404 }), thenInfer: true, inferGenerate }).catch((err) => order.push(`error: ${err.message}`));
  assert("the web runs first, inference after it", order.indexOf("web") === 0 && order.lastIndexOf("infer") === order.length - 1 && order.includes("infer"), order);
  assert("one inference call per product", calls.length === 2, calls.length);
  const records = calls.map((c) => JSON.parse(c.contents[1].slice(c.contents[1].indexOf("\n") + 1)));
  assert("each call holds that product only, with all its empty fields", records.every((x) => x.length === 1) && calls.every((c) => parseGaps(c).length === 4 && parseGaps(c).some((g) => g.label === "Appearance")), calls.map((c) => parseGaps(c).map((g) => g.label)));
  n = (await getNeeds(B.inv.id, co.id)).certificates.flatMap((c) => c.needs).filter((x) => x.fieldKey === "appearance");
  assert("an empty product's optional field is inferred too", n.length > 0 && n.every((x) => x.status === "inferred"), n.map((x) => x.status));
  assert("usable for generation", [...(await usableNeeds(B.inv.id)).values()].every((m) => m.has("appearance")));

  console.log("\n🧪 One product's failed call stays with that product");
  const C = await seed([AD3E, EMPTY], { number: 3 });
  let tries = 0;
  view = await computeNeeds(C.inv.id, co.id, {
    generate: noGaps,
    inferGenerate: async (args) => {
      if (++tries === 1) throw new Error("model down");
      return { gaps: parseGaps(args).map((g) => estimate(g.gapId, "Clear yellow liquid")) };
    },
  });
  assert("the other product is still asked; the failure is reported", tries === 2 && view.ai.inference.calls === 1 && view.ai.inference.unavailable === true, view.ai.inference);

  console.log("\n🧪 What production's first run showed (invoice ZYIV25001)");
  const P = { name: "VITAMIN ES", physicalForm: "Liquid" };
  const quotedName = (value) => ({ found: true, value, derivation: "quoted", evidence: [{ path: "name", quote: "VITAMIN ES" }], confidence: 0.9 });
  const spec = { label: "Identification", source: { kind: "product", path: "specifications.values.Identification" } };
  assert("the name is never another field's value (Identification = the product's name)", !verifyInference(quotedName("VITAMIN ES"), P, { field: spec }).ok);
  assert("…nor a piece of it (Category = VITAMIN)", !verifyInference(quotedName("VITAMIN"), P, { field: { label: "Category", source: { kind: "product", path: "category.name" } } }).ok);
  assert("…the name field itself may quote it", verifyInference(quotedName("VITAMIN ES"), P, { field: { label: "Product Name", source: { kind: "product", path: "name" } } }).ok);
  const typicalAnswer = { found: true, value: "Clear liquid", derivation: "typical", evidence: [{ path: "record.physicalForm", quote: "Liquid" }], reasoning: "A vitamin liquid.", generalKnowledge: "Such liquids are clear.", confidence: 0.6 };
  assert("a path written as record.physicalForm is the product's physicalForm", verifyInference(typicalAnswer, P, { field: { label: "Appearance", source: { kind: "product", path: "appearance" } } }).ok);
  const listed = { ...typicalAnswer, evidence: [{ path: "activeIngredients.0.name", quote: "Vitamin A" }] };
  assert("a list item written activeIngredients.0.name is activeIngredients[0].name", verifyInference(listed, AD3E, { field: { label: "Appearance", source: { kind: "product", path: "appearance" } } }).ok);
  const stopped = await seed([AD3E], { number: 5 });
  const quota = await runPrepareJob({ invoiceId: stopped.inv.id }, {}, { generate: noGaps, search: async () => ({ fields: [] }), fetchPage: async () => ({ ok: false, status: 404 }), inferGenerate: async () => { throw new Error("Gemini quota exhausted (daily/project limit, not per-minute)"); } });
  const stage = quota.stages.find((x) => x.key === "product_data");
  assert("Prepare says so when the AI stopped halfway", stage.status === "failed" && stage.ai.unavailable && !!stage.error, stage);
  assert("…and those needs are asked again next time, not marked asked", (await needs(stopped.inv.id)).appearance.aiAskedBasis?.includes("I") !== true, (await needs(stopped.inv.id)).appearance.aiAskedBasis);
  const D = await seed([AD3E], { number: 4 });
  await prisma.templateField.update({ where: { versionId_key: { versionId: D.versionId, key: "ph_result" } }, data: { specFieldKey: "storage" } });
  calls = [];
  await computeNeeds(D.inv.id, co.id, { generate: noGaps, inferGenerate: inferring(calls) });
  const roles = Object.fromEntries(calls.flatMap(parseGaps).map((g) => [g.label, g.role]));
  assert("a field a lab result names as its specification is sent as one", roles.Storage === "specification" && !roles.Appearance, roles);

  console.log("\n🧪 Fix this template: a value repeated in the wording, a number per certificate");
  const scan = scanTemplate({ lines: [{ id: "a", text: "Category:  SUPPLEMENT" }, { id: "b", text: "It is a qualified product to be used as supplement." }, { id: "c", text: "Origin:  JORDAN" }, { id: "d", text: "Jordan - Al-Zarqa - A Jordanian Organization" }] });
  const wording = scan.items.filter((i) => i.where === "wording");
  assert("the word in the sentence is offered, at its exact place", wording.some((i) => i.field.lineId === "b" && i.field.sampleValue === "supplement" && i.field.charEnd - i.field.charStart === 10), wording);
  assert("never ticked for the owner: “Jordan” may be the company's address", wording.length === 2 && wording.every((i) => i.default === false), wording);
  assert("part of a word isn't one (“Jordanian”)", !wording.some((i) => i.field.charStart > 0 && i.field.lineId === "d"));
  const memo = { companyId: co.id, typeId: A.typeId, entries: [], batchSample: null };
  const word = await suggestSource({ label: wording[0].sameAs, sample: "supplement", where: "label_value" }, memo);
  assert("its source follows the printed label, in lower case", word.source.path === "category.name" && word.format?.case === "lower", word);
  const number = { kind: "template", template: "COA-{{invoice.invoiceNumber}}-{{item.lineNo}}" };
  assert("the number scheme is a valid source", validateSource(number).length === 0, validateSource(number));
  assert("two lines of one invoice get two numbers", ["1", "2"].map((lineNo) => resolveField({ source: number, required: true }, { invoice: { invoiceNumber: "ZY1" }, item: { lineNo } }).value).join() === "COA-ZY1-1,COA-ZY1-2");

  console.log("\n🧪 The owner's setting");
  const lines = [{ id: "l1", page: 1, text: "Stamp: x" }];
  const base = { key: "stamp", label: "Stamp", lineId: "l1", charStart: 7, charEnd: 8, sampleValue: "x", source: { kind: "manual" } };
  let v = validateFieldList([{ ...base, notApplicable: true }], lines);
  assert("not applicable can't be required", v.fields[0].required === false && v.fields[0].notApplicable === true, v.fields[0]);
  v = validateFieldList([base], lines);
  assert("a client that leaves it out keeps what is stored", v.fields[0].notApplicable === undefined && v.fields[0].required === true);
} finally {
  await finish(counts, async () => cleanupCompany(co.id));
}
