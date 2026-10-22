// Shared by a1.mapping.test.js (stubbed model) and scripts/evalCertMapping.js
// (live Gemini, opt-in): seeds a company with the fixture products, uploads
// both golden designs, proposes labels the way the wizard does (code), maps
// every golden field and scores the result against fixtures/certificates/mapping
// (plan.md §5.4). Not a test file itself (runAll only runs *.test.js).
import fs from "fs";
import path from "path";
import { api, asCompany, createCompany, uploadTemplate, prisma, FIXTURES } from "./helpers.js";
import { mapFields } from "../../src/services/certificates/mapping/fieldMapper.js";
import { validateSource } from "../../src/services/certificates/templates/sourceCatalogue.js";
import { stableStringify } from "../../src/services/certificates/ai/aiRunLog.js";

export const GOLDEN_FIELDS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "golden-fields.json"), "utf8"));
export const MAPPING = {
  "ADDVET_COA.ai": JSON.parse(fs.readFileSync(path.join(FIXTURES, "mapping", "ADDVET_COA.json"), "utf8")),
  "PHARMAVET_COA.pdf": JSON.parse(fs.readFileSync(path.join(FIXTURES, "mapping", "PHARMAVET_COA.json"), "utf8")),
};
export const PRODUCTS = JSON.parse(fs.readFileSync(path.join(FIXTURES, "mapping", "products.json"), "utf8")).products;

export async function seedMappingCompany(label = "a1map") {
  const co = await createCompany(label);
  const products = {};
  for (const p of PRODUCTS) products[p.name] = await prisma.product.create({ data: { ...p, specifications: p.specifications ?? undefined, companyId: co.id } });
  const r = await api("POST", "/certificate-types", asCompany(co.id), { name: "Certificate of Analysis", code: "COA" });
  return { company: co, products, typeId: r.data.data.type.id };
}

export async function uploadGolden(companyId, typeId, file, country) {
  const u = await uploadTemplate(companyId, { file, certificateTypeId: typeId, country });
  return u.version;
}

/** The wizard's field drafts: offsets from golden-fields.json, labels from the label-proposal endpoint (code). */
export async function wizardFields(companyId, version, file) {
  const golden = GOLDEN_FIELDS[file];
  const probes = golden.map((g) => {
    const text = version.lines.find((l) => l.id === g.lineId).text;
    const start = g.occurrence === "last" ? text.lastIndexOf(g.sampleValue) : text.indexOf(g.sampleValue);
    return { lineId: g.lineId, charStart: start, charEnd: start + g.sampleValue.length, sampleValue: g.sampleValue };
  });
  const r = await api("POST", `/template-versions/${version.id}/label-proposals`, asCompany(companyId), { fields: probes });
  if (r.status !== 200) throw new Error(`label-proposals → ${r.status} ${JSON.stringify(r.data)}`);
  const proposals = r.data.data.proposals;
  return golden.map((g, i) => ({
    key: g.key,
    // the user types a label only when code proposes none (the fixture says which)
    label: proposals[i].label || MAPPING[file].fields[g.key]?.label || g.label,
    proposedLabel: proposals[i].label,
    lineId: g.lineId,
    charStart: probes[i].charStart,
    charEnd: probes[i].charEnd,
    sampleValue: g.sampleValue,
    labelContext: proposals[i].context,
  }));
}

const same = (a, b) => stableStringify(a) === stableStringify(b);

/** → { total, exact, batchTotal, batchCorrect, invalid, perField[] } */
export function score(file, mappings) {
  const expected = MAPPING[file].fields;
  const perField = [];
  let exact = 0;
  let batchTotal = 0;
  let batchCorrect = 0;
  let invalid = 0;
  for (const [key, exp] of Object.entries(expected)) {
    const got = mappings[key] || {};
    const ok = !!got.source && [exp.source, ...(exp.alsoAccept || [])].some((s) => same(s, got.source));
    if (ok) exact++;
    if (exp.category === "batch_data") {
      batchTotal++;
      if (got.category === "batch_data" && got.source?.kind === "manual") batchCorrect++;
    }
    if (got.source && validateSource(got.source).length) invalid++;
    perField.push({ key, ok, origin: got.origin, status: got.status, confidence: got.confidence, got: got.source, expected: exp.source });
  }
  return { total: Object.keys(expected).length, exact, batchTotal, batchCorrect, invalid, perField };
}

/** A stand-in model that answers what the golden set expects for every field it is asked about. */
export function goldenModel(file, { confidence = 0.8, calls = [] } = {}) {
  const expected = MAPPING[file].fields;
  return async (args) => {
    calls.push(args);
    const fieldsPart = args.contents[args.contents.length - 1];
    const { fields = [], groups = [] } = JSON.parse(fieldsPart.slice(fieldsPart.indexOf("\n") + 1));
    return {
      fields: fields.map((f) => {
        const exp = expected[f.key]?.source || { kind: "manual" };
        return {
          key: f.key,
          sourceKind: exp.kind,
          path: exp.path ? `${exp.kind}.${exp.path}` : null,
          template: exp.template || null,
          category: expected[f.key]?.category || "unknown",
          confidence,
          rationale: "golden stand-in",
        };
      }),
      groups: groups.map((g) => ({ key: g.key, collectionPath: null, cells: [], confidence: 0, rationale: "" })),
    };
  };
}

export async function runGolden(companyId, version, file, { generate, sampleProductId = null } = {}) {
  const fields = await wizardFields(companyId, version, file);
  const out = await mapFields(version.id, companyId, { fields, sampleProductId }, { generate });
  return { fields, out, score: score(file, out.mappings) };
}
