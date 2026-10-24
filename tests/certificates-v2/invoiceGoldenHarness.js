// Shared by a2.dataNeeds.test.js (stand-in model) and scripts/evalCertGaps.js
// (live Gemini, opt-in): seeds a company with the golden-invoice products and
// two active templates (fields only — the data check renders nothing), loads
// the three golden invoices as extraction would have stored them, runs the
// certificate data check and scores it against INV_*.expected.json (plan.md §6.4).
// Not a test file itself (runAll only runs *.test.js).
import fs from "fs";
import path from "path";
import { createCompany, prisma, FIXTURES } from "./helpers.js";
import { computeNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";
import { normalizeEvidence } from "../../src/services/certificates/dataNeeds/evidenceVerifier.js";

const DIR = path.join(FIXTURES, "invoices");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
export const SETUP = read("setup.json");
export const INVOICES = ["INV_A", "INV_B", "INV_C"];
export const golden = (name) => ({ invoice: read(`${name}.json`), expected: read(`${name}.expected.json`) });

const FAKE_FILE = "00000000-0000-4000-8000-0000000000a2";

/** → { company, products: { name → row }, templates: { typeCode → { templateId, versionId } } } */
export async function seedGoldenCompany(label = "a2gold") {
  const company = await createCompany(label);
  const products = {};
  for (const p of SETUP.products) products[p.name] = await prisma.product.create({ data: { ...p, specifications: p.specifications ?? undefined, activeIngredients: p.activeIngredients ?? undefined, companyId: company.id } });
  const templates = {};
  for (const t of SETUP.templates) templates[t.typeCode] = await seedTemplate(company.id, t);
  return { company, products, templates };
}

/** An active template with these fields, straight into the DB (no design: the check doesn't render). */
export async function seedTemplate(companyId, t) {
  const type = await prisma.certificateType.create({ data: { companyId, name: t.typeName, code: t.typeCode } });
  const tpl = await prisma.certificateTemplate.create({ data: { companyId, certificateTypeId: type.id, scope: t.scope, name: t.name, country: t.country || null, brandId: t.brandId || null } });
  const v = await prisma.templateVersion.create({ data: { templateId: tpl.id, versionNumber: 1, status: "active", sourceFormat: "pdf", sourceFileId: FAKE_FILE } });
  await prisma.templateField.createMany({
    data: t.fields.map((f, i) => ({
      versionId: v.id,
      key: f.key,
      label: f.label,
      lineId: `l${i}`,
      charStart: 0,
      charEnd: 1,
      sampleValue: f.sample ?? "x",
      source: f.source,
      format: f.format ?? undefined,
      required: f.required ?? true,
      dataCategory: f.category || null,
      isLabResult: f.isLabResult ?? false,
      sortOrder: i,
    })),
  });
  await prisma.certificateTemplate.update({ where: { id: tpl.id }, data: { activeVersionId: v.id } });
  return { templateId: tpl.id, versionId: v.id, typeId: type.id };
}

/** The golden invoice as extraction leaves it: status review, lines matched to the fixture products. */
export async function loadGoldenInvoice(companyId, products, name, { status = "review" } = {}) {
  const { invoice } = golden(name);
  const inv = await prisma.invoice.create({
    data: { companyId, status, sourceFileId: FAKE_FILE, header: invoice.header, headerExtracted: invoice.header, textContent: invoice.textContent, country: invoice.header.customerCountry || null, extraction: { modelId: "golden", promptHash: "golden" } },
  });
  for (const [i, l] of invoice.lines.entries()) {
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data: l.data, dataExtracted: l.data, productId: products[l.product].id, matchStatus: "matched", matchMethod: "exact_name" } });
  }
  return prisma.invoice.findUnique({ where: { id: inv.id }, include: { items: { orderBy: { lineNo: "asc" } } } });
}

/** The need row an expected gap refers to. */
export function needFor(check, inv, templates, gap) {
  if (gap.line === null) {
    const cert = check.certificates.find((c) => c.planKey === `${templates.FSC.versionId}:invoice`);
    return cert?.needs.find((n) => n.fieldKey === gap.field);
  }
  const item = inv.items.find((i) => i.lineNo === gap.line);
  const cert = check.certificates.find((c) => c.planKey === `${templates.COA.versionId}:${item.id}`);
  return cert?.needs.find((n) => n.fieldKey === gap.field);
}

const same = (a, b) => normalizeEvidence(a) === normalizeEvidence(b);

/**
 * check (the view) + expected → { resolvable, filled, wrong, falseFills, unverified, codeResolved, perGap[] }
 *   filled     — a resolvable gap now holds the right value with verified evidence
 *   wrong      — a resolvable gap holds a different value
 *   falseFills — a gap that ISN'T in the data got a value (must be 0)
 *   unverified — an AI value whose suggestion isn't evidence-verified (must be 0)
 */
export async function scoreCheck(check, inv, templates, expected) {
  const out = { resolvable: 0, filled: 0, wrong: 0, falseFills: 0, unverified: 0, codeResolved: 0, codeExpected: 0, perGap: [] };
  for (const g of expected.gaps) {
    const n = needFor(check, inv, templates, g);
    const aiFilled = n && ["needs_confirmation", "resolved_ai"].includes(n.status);
    if (aiFilled) {
      const s = n.suggestionId ? await prisma.aiSuggestion.findUnique({ where: { id: n.suggestionId } }) : null;
      if (!s?.evidenceVerified) out.unverified++;
    }
    let ok;
    if (g.resolvable) {
      out.resolvable++;
      ok = aiFilled && same(n.value, g.stored ?? g.value);
      if (ok) out.filled++;
      else if (aiFilled) out.wrong++;
    } else {
      ok = n?.status === "missing";
      if (aiFilled) out.falseFills++;
    }
    out.perGap.push({ line: g.line, field: g.field, resolvable: g.resolvable, ok, status: n?.status ?? "absent", value: n?.value ?? null, expected: g.resolvable ? g.stored ?? g.value : null });
  }
  // code's part: these resolve without any AI
  for (const key of expected.resolvedByCode || []) {
    for (const c of check.certificates) {
      const n = c.needs.find((x) => x.fieldKey === key);
      if (!n) continue;
      out.codeExpected++;
      if (n.status === "resolved") out.codeResolved++;
    }
  }
  return out;
}

/**
 * A stand-in model that answers every gap it is asked with the expected
 * evidence (the "correct model"). `override(gap, expectedGap)` may return a
 * different answer (adversarial tests).
 */
export function goldenModel(expected, { calls = [], override = null } = {}) {
  return async (args) => {
    calls.push(args);
    const part = args.contents[args.contents.length - 1];
    const gaps = JSON.parse(part.slice(part.indexOf("\n") + 1));
    return {
      gaps: gaps.map((gap) => {
        const exp = expected.gaps.find((e) => e.field === gap.fieldKey && (e.line ?? null) === (gap.lineNo ?? null));
        if (override) {
          const o = override(gap, exp);
          if (o) return { gapId: gap.gapId, ...o };
        }
        if (!exp?.resolvable) return { gapId: gap.gapId, found: false, evidence: [], confidence: 0.2, note: "not written anywhere" };
        return { gapId: gap.gapId, found: true, value: exp.value, evidence: [{ ...exp.evidence, page: 1 }], confidence: 0.92, note: "golden stand-in" };
      }),
    };
  };
}

export async function runGoldenInvoice(seed, name, { generate } = {}) {
  const inv = await loadGoldenInvoice(seed.company.id, seed.products, name);
  const check = await computeNeeds(inv.id, seed.company.id, { generate });
  const fresh = await prisma.invoice.findUnique({ where: { id: inv.id }, include: { items: { orderBy: { lineNo: "asc" } } } });
  return { inv: fresh, check, score: await scoreCheck(check, fresh, seed.templates, golden(name).expected) };
}
