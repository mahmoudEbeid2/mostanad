// Client report 24 Nov, item 3.
// Brands: a brand named the way people type it or print it ("Max Vet",
// "MAXVET®") is found (list_brands, and the brand printed on a reference
// label); several equally good → choices, kept on the reference and picked
// with PATCH /reference-labels/:id. Reference labels are tenant-scoped
// (list / read / change / delete). Categories: one level of parents, the main
// ones first; the mapping script plans without changing anything.
// Needs `npm run dev:test`.
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asAdmin, asCompany, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import { brandScore, matchBrands, resolveBrand } from "../src/services/brandMatch.js";
import { brandFromLabel } from "../src/services/referenceLabelService.js";
import * as registry from "../src/services/assistant/registry/index.js";
import { plan as categoryPlan, MAPPING } from "../scripts/categoryParents.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;

async function main() {
  console.log("🧪 Brands and categories\n");
  const coA = await createCompany(`bcA${s}`);
  const coB = await createCompany(`bcB${s}`);
  const made = [];
  try {
    console.log("Brand matching");
    assert("same name, any case / spacing / ® → exact", brandScore("Max Vet®", "MAXVET") === 1 && brandScore("maxvet", "MAXVET") === 1);
    assert("a brand inside the printed line → contains", brandScore("MAXVET Supplement Product", "MAXVET") === 0.9);
    assert("one letter off → close", brandScore("MAKVET", "MAXVET") === 0.8 && brandScore("MAXVTE", "MAXVET") === 0 && brandScore("MAXVETT", "MAXVET") >= 0.8);
    assert("a different brand → no match; short names only exact", brandScore("VETLINE", "MAXVET") === 0 && brandScore("AB", "AC") === 0);
    const list = [{ id: "1", name: "MAXVET" }, { id: "2", name: "MAXVET Pro" }, { id: "3", name: "Vetline" }];
    assert("best first: the exact name before one containing it", (await matchBrands(null, "maxvet", { brands: list })).map((b) => b.id).join() === "1,2");
    const two = await resolveBrand(null, "Vet", { brands: [{ id: "a", name: "VetOne" }, { id: "b", name: "VetTwo" }] });
    assert("a 3-letter fragment (\"Vet\") names no brand", two.brandId === null && two.candidates.length === 0, two);
    const tie = await resolveBrand(null, "MAXVET", { brands: [{ id: "a", name: "MAXVET" }, { id: "b", name: "Max-Vet" }] });
    assert("two brands the same name once spaces are ignored → choices", tie.brandId === null && tie.candidates.length === 2, tie);

    const [mx, mxPro, other] = await Promise.all([
      prisma.brand.create({ data: { companyId: coA.id, name: `MAXVET${s}` } }),
      prisma.brand.create({ data: { companyId: coA.id, name: `MAXVET${s} Pro` } }),
      prisma.brand.create({ data: { companyId: coB.id, name: `MAXVET${s}` } }),
    ]);

    console.log("\nlist_brands (assistant)");
    const ctx = (companyId) => ({ actor: { kind: "company", id: companyId, name: "c", companyId }, scope: { companyId }, conversationId: null, userTexts: [], propose: async () => ({ id: "card" }) });
    let t = await registry.runTool("list_brands", { q: `Max Vet${s}` }, ctx(coA.id));
    const items = t.data?.items || [];
    assert('"Max Vet…" finds MAXVET… (exact once spaces are ignored), then the Pro line (close)', t.status === "ok" && items[0]?.id === mx.id && items[0].match === "exact" && items[1]?.id === mxPro.id && items[1].match === "close", items);
    assert("only the caller's company's brands", !items.some((b) => b.id === other.id), items);
    t = await registry.runTool("list_brands", { q: `MAXVTE${s}` }, ctx(coA.id));
    assert("a typo still finds it, marked close", t.data?.items?.[0]?.id === mx.id && t.data.items[0].match === "close", t.data?.items);

    console.log("\nThe brand printed on a reference label");
    let b = await brandFromLabel(coA.id, { brand_name: `maxvet${s}®` });
    assert("one clear match → that brand", b.brandId === mx.id && b.match.chosen === mx.id, b);
    b = await brandFromLabel(coA.id, { brand_name: "Unknown Brand Co" });
    assert("no match → no brand, the printed name kept", b.brandId === null && b.match.printed === "Unknown Brand Co" && b.match.candidates.length === 0, b);
    b = await brandFromLabel(null, { brand_name: "MAXVET" });
    assert("a global reference has no brands to match", b.brandId === null);

    console.log("\nReference labels: brand choice and tenancy");
    const refA = await prisma.referenceLabel.create({ data: { name: `refA-${s}.pdf`, companyId: coA.id, country: "EG", extractedData: { brand_match: { printed: "MAXVET", candidates: [{ id: mx.id, name: mx.name, score: 0.9 }, { id: mxPro.id, name: mxPro.name, score: 0.9 }], chosen: null } } } });
    const refB = await prisma.referenceLabel.create({ data: { name: `refB-${s}.pdf`, companyId: coB.id, country: "EG" } });
    made.push(refA.id, refB.id);
    let r = await api("PATCH", `/reference-labels/${refA.id}`, asCompany(coA.id), { brandId: mxPro.id });
    assert("PATCH brand → set, and recorded as the chosen candidate", r.status === 200 && r.data.data.referenceLabel.brandId === mxPro.id && r.data.data.referenceLabel.extractedData.brand_match.chosen === mxPro.id, r.data);
    r = await api("PATCH", `/reference-labels/${refA.id}`, asCompany(coA.id), { brandId: other.id });
    assert("another company's brand → 400", r.status === 400, r.data);
    r = await api("PATCH", `/reference-labels/${refB.id}`, asCompany(coA.id), { brandId: null });
    assert("another company's reference → 404 (PATCH)", r.status === 404, r.status);
    r = await api("GET", `/reference-labels/${refB.id}`, asCompany(coA.id));
    assert("another company's reference → 404 (GET)", r.status === 404, r.status);
    r = await api("DELETE", `/reference-labels/${refB.id}`, asCompany(coA.id));
    assert("another company's reference → 404 (DELETE), still there", r.status === 404 && (await prisma.referenceLabel.count({ where: { id: refB.id } })) === 1, r.status);
    r = await api("GET", `/reference-labels?limit=500&search=${s}`, asCompany(coA.id));
    let ids = (r.data?.data?.referenceLabels || []).map((x) => x.id);
    assert("list → the caller's own references, not another company's", ids.includes(refA.id) && !ids.includes(refB.id), ids);
    r = await api("GET", `/reference-labels?limit=500&search=${s}&companyId=${coB.id}`, asCompany(coA.id));
    ids = (r.data?.data?.referenceLabels || []).map((x) => x.id);
    assert("?companyId= naming another company is ignored", !ids.includes(refB.id), ids);
    r = await api("GET", `/reference-labels?limit=500&search=${s}`, asAdmin);
    ids = (r.data?.data?.referenceLabels || []).map((x) => x.id);
    assert("a system user still sees every company's", ids.includes(refA.id) && ids.includes(refB.id), ids);

    console.log("\nCategories");
    const premix = await prisma.category.findFirst({ where: { name: { equals: "Premix", mode: "insensitive" } } });
    assert("Premix exists (added by the migration) and is a main category", !!premix && premix.sortOrder === 5 && premix.parentId === null, premix);
    const main = await prisma.category.create({ data: { name: `Main ${s}`, sortOrder: 99 } });
    made.push(main.id);
    r = await api("POST", "/categories", asAdmin, { name: `Child ${s}`, parentId: main.id });
    const child = r.data?.data?.category;
    if (child) made.push(child.id);
    assert("create under a main category → parentId set", r.status === 201 && child?.parentId === main.id, r.data);
    r = await api("POST", "/categories", asAdmin, { name: `Grandchild ${s}`, parentId: child?.id });
    assert("under a category that has a parent → 400 (one level only)", r.status === 400, r.data);
    r = await api("PATCH", `/categories/${main.id}`, asAdmin, { name: main.name, parentId: premix.id });
    assert("a category with others under it can't be moved under another → 400", r.status === 400, r.data);
    r = await api("PATCH", `/categories/${child.id}`, asAdmin, { name: child.name, parentId: "" });
    assert('parentId "" → back to no parent', r.status === 200 && r.data.data.category.parentId === null, r.data);
    r = await api("GET", "/categories?limit=200", asAdmin);
    const cats = r.data?.data?.categories || [];
    const firstPlain = cats.findIndex((c) => c.sortOrder === null);
    assert("GET /categories → the main ones first, in their order", firstPlain > 0 && cats.slice(0, firstPlain).every((c, i, a) => i === 0 || a[i - 1].sortOrder <= c.sortOrder) && cats.slice(firstPlain).every((c) => c.sortOrder === null), cats.map((c) => `${c.sortOrder}:${c.name}`).slice(0, 8));

    const rows = await categoryPlan();
    const before = await prisma.category.findMany({ select: { id: true, parentId: true } });
    assert("the mapping script plans every category and changes nothing without --apply", rows.length === before.length && rows.every((x) => ["set", "keep", "main", "not_mapped", "no_parent_found"].includes(x.action)) && JSON.stringify(await prisma.category.findMany({ select: { id: true, parentId: true } })) === JSON.stringify(before));
    const names = new Set(before.length ? (await prisma.category.findMany({ select: { name: true } })).map((c) => c.name.toLowerCase()) : []);
    assert("…a mapped category goes under its main one when that exists, and is left alone (listed) when it doesn't", rows.filter((x) => MAPPING[x.name]).every((x) => (names.has(MAPPING[x.name].toLowerCase()) ? ["set", "keep"].includes(x.action) && x.to === MAPPING[x.name] : x.action === "no_parent_found")), rows.filter((x) => MAPPING[x.name]));
    t = await registry.runTool("list_categories", { limit: 25 }, { ...ctx(coA.id), scope: { companyId: coA.id } });
    assert("list_categories (assistant): main ones first, marked main", t.status === "ok" && t.data.items[0]?.main === true, t.data?.items?.slice(0, 3));
  } finally {
    await prisma.referenceLabel.deleteMany({ where: { id: { in: made } } }).catch(() => {});
    await prisma.category.deleteMany({ where: { name: { in: [`Child ${s}`, `Grandchild ${s}`] } } }).catch(() => {});
    await prisma.category.deleteMany({ where: { id: { in: made } } }).catch(() => {});
    await cleanupCompany(coA.id).catch((e) => console.error(e.message));
    await cleanupCompany(coB.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
