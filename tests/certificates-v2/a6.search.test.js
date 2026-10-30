// Certificate AI layers — Phase A6.6 (plan.md §15.6, §15.9 "Search"): catalogue
// search — Postgres FTS + pg_trgm, scoped to one company, and the catalogue as an
// extra candidate source for invoice matching (never an automatic match).
// The expected result sets are computed here from the blocks' own text, word by
// word, independently of Postgres.
import fs from "fs";
import path from "path";
import { api, asAdmin, asCompany, makeAssert, finish, createCompany, cleanupCompany, form, pollTask, prisma, readWholeCatalogue } from "./helpers.js";
import { runExtractJob } from "../../src/services/catalogues/extraction/extractionService.js";
import { matchInvoice } from "../../src/services/certificates/matching/productMatcher.js";

const { assert, counts } = makeAssert();
const pdf = fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf"));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "catalogues", "agrikima.golden.json"), "utf8"));
const co = await createCompany("a6s");
const other = await createCompany("a6s2");

const lineWith = (text, ...parts) => text.split("\n").find((l) => parts.every((p) => l.includes(p))) || null;
const extractModel = (goldenOf) => async (args) => {
  const payload = JSON.parse(args.contents[1].slice(args.contents[1].indexOf("\n") + 1));
  return {
    products: payload.blocks.map(({ blockId, text }) => {
      const g = goldenOf.get(blockId);
      if (!g) return { blockId, isProduct: false };
      return {
        blockId,
        isProduct: true,
        name: { value: g.name, quote: g.name },
        productCode: g.productCode ? { value: g.productCode, quote: lineWith(text, g.productCode) } : null,
        activeIngredients: g.activeIngredients.map((i) => ({ name: i.name, amountRaw: i.amountRaw, quote: lineWith(text, i.name, i.amountRaw.split(" ")[0]) || `${i.name} ${i.amountRaw}` })),
      };
    }),
    catalogue: null,
  };
};

const words = (s) => String(s || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
const body = (b) => `${b.title || ""} ${b.text}`;
const hasPhrase = (b, ...ws) => {
  const w = words(body(b));
  return w.some((_, i) => ws.every((x, k) => w[i + k] === x));
};
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

async function upload(companyId, extract) {
  const r = await api("POST", "/catalogues", asAdmin, form({ companyId, manufacturer: "Agrikima Sdn. Bhd.", extract: "false" }, { buffer: pdf, name: "agrikima.pdf", type: "application/pdf" }));
  await readWholeCatalogue(r.data.data.versionId);
  const versionId = r.data.data.versionId;
  if (extract) {
    const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" }, orderBy: { seq: "asc" } });
    await runExtractJob(versionId, undefined, { generate: extractModel(new Map(blocks.map((b, i) => [b.id, GOLDEN.products[i]]))), infer: false });
  }
  return { versionId, catalogueId: r.data.data.catalogueId };
}
const search = (headers, q, extra = "") => api("GET", `/catalogue-search?q=${encodeURIComponent(q)}${extra}`, headers);

try {
  const v1 = await upload(co.id, true);
  await api("PUT", `/catalogue-versions/${v1.versionId}/number-convention`, asAdmin, { dotGroup3: "thousands" });
  await api("POST", `/catalogue-versions/${v1.versionId}/accept-unflagged`, asAdmin);
  const otherUp = await upload(other.id, false); // another company holding the same catalogue
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId: v1.versionId } });
  const otherIds = new Set((await prisma.catalogueBlock.findMany({ where: { versionId: otherUp.versionId }, select: { id: true } })).map((b) => b.id));

  console.log("\n🔍 §15.9: “Vitamin E”");
  let r = await search(asCompany(co.id), "Vitamin E");
  const want = new Set(blocks.filter((b) => hasPhrase(b, "vitamin", "e")).map((b) => b.id));
  const gotPhrase = new Set(r.data.data.results.filter((x) => x.match === "phrase").map((x) => x.blockId));
  assert(`every block printing “Vitamin E” is returned as a phrase hit (${want.size}), and only those`, r.status === 200 && want.size >= 3 && sameSet(want, gotPhrase), { want: want.size, got: gotPhrase.size });
  assert("phrase hits rank before word-only hits", r.data.data.results.findIndex((x) => x.match !== "phrase") === -1 || r.data.data.results.findIndex((x) => x.match !== "phrase") >= gotPhrase.size);
  assert("company-scoped: nothing from the other company's identical catalogue", r.data.data.results.every((x) => !otherIds.has(x.blockId)));
  const hit = r.data.data.results[0];
  assert("a result carries product, page, version and a highlighted snippet", hit.page && hit.versionId === v1.versionId && hit.catalogueId === v1.catalogueId && /\[\[vitamin\]\]/i.test(hit.snippet) && hit.manufacturer, hit);
  assert("a linked block carries its product", r.data.data.results.some((x) => x.productId));

  console.log("\n🔍 Words, prefixes, fuzzy names");
  r = await search(asCompany(co.id), "withdrawal none");
  const wantWords = new Set(blocks.filter((b) => ["withdrawal", "none"].every((w) => words(body(b)).includes(w))).map((b) => b.id));
  assert(`“withdrawal none”: every block holding both words (${wantWords.size}), not as a phrase`, sameSet(wantWords, new Set(r.data.data.results.filter((x) => x.match !== "name").map((x) => x.blockId))) && wantWords.size >= 20, { want: wantWords.size, got: r.data.data.results.length });
  r = await search(asCompany(co.id), "AKS0");
  const wantPrefix = new Set(blocks.filter((b) => words(body(b)).some((w) => w.startsWith("aks0"))).map((b) => b.id));
  assert(`“AKS0”: every block printing a code starting AKS0 (${wantPrefix.size})`, sameSet(wantPrefix, new Set(r.data.data.results.filter((x) => x.match !== "name").map((x) => x.blockId))) && wantPrefix.size >= 5, { want: wantPrefix.size, got: r.data.data.results.length });
  r = await search(asCompany(co.id), "Agrivta");
  assert("a misspelt product name (“Agrivta”) still finds Agrivita by trigram similarity", r.data.data.results.some((x) => x.match === "name" && /^Agrivita/.test(x.name)), r.data.data.results.slice(0, 3));
  r = await search(asCompany(co.id), "zzqxv");
  assert("nothing printed → no results (200)", r.status === 200 && r.data.data.results.length === 0);

  console.log("\n✋ Scope and input");
  r = await search(asCompany(other.id), "Vitamin E");
  assert("the other company sees only its own blocks", r.status === 200 && r.data.data.results.length > 0 && r.data.data.results.every((x) => otherIds.has(x.blockId)));
  r = await search(asCompany(other.id), "Vitamin E", `&companyId=${co.id}`);
  assert("a company passing another companyId still gets only its own", r.data.data.results.every((x) => otherIds.has(x.blockId)));
  r = await search(asAdmin, "Vitamin E");
  assert("a system user without companyId → 400 COMPANY_REQUIRED", r.status === 400 && r.data.code === "COMPANY_REQUIRED");
  r = await search(asAdmin, "Vitamin E", `&companyId=${co.id}`);
  assert("a system user with companyId → that company", r.status === 200 && r.data.data.results.length === gotPhrase.size + r.data.data.results.filter((x) => x.match !== "phrase").length && r.data.data.results.every((x) => !otherIds.has(x.blockId)));
  r = await api("GET", "/catalogue-search?q=", asCompany(co.id));
  assert("an empty query → 400", r.status === 400);
  r = await search(asCompany(co.id), "'); DROP TABLE catalogue_blocks; --");
  assert("SQL in the query is just words (200, table intact)", r.status === 200 && (await prisma.catalogueBlock.count({ where: { versionId: v1.versionId } })) === blocks.length);

  console.log("\n📚 Latest edition by default");
  const v2 = await api("POST", `/catalogues/${v1.catalogueId}/versions`, asAdmin, form({ label: "again", extract: "false" }, { buffer: pdf, name: "again.pdf", type: "application/pdf" }));
  await readWholeCatalogue(v2.data.data.versionId);
  r = await search(asCompany(co.id), "Vitamin E");
  assert("after a new edition: results come from it only", r.data.data.results.length && r.data.data.results.every((x) => x.versionId === v2.data.data.versionId));
  r = await search(asCompany(co.id), "Vitamin E", "&allVersions=true");
  assert("allVersions=true: both editions", new Set(r.data.data.results.map((x) => x.versionId)).size === 2);

  console.log("\n🧾 Invoice matching: the catalogue as a candidate source");
  const calc = await prisma.product.findFirst({ where: { companyId: co.id, productCode: "AKS01" } });
  const inv = await prisma.invoice.create({ data: { companyId: co.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000a6", header: {}, headerExtracted: {} } });
  // the invoice names the product by its composition — nothing like "Agri-CalD3"
  await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: 1, data: { name: "Calcium Chloride Phosphoric Acid oral solution" }, dataExtracted: {}, matchStatus: "needs_match" } });
  const aiCalls = [];
  const res = await matchInvoice(inv.id, {
    generate: async (args) => {
      aiCalls.push(args);
      return { lines: [] };
    },
  });
  const item = await prisma.invoiceItem.findFirst({ where: { invoiceId: inv.id } });
  const cand = (item.matchCandidates || []).find((c) => c.productId === calc.id);
  assert("Agri-CalD3 becomes a candidate through its catalogue page (reason cites the page)", !!cand && cand.reasons.some((x) => /^catalogue p\.\d+/.test(x)), item.matchCandidates);
  assert("…a candidate only: the line still needs a person (never auto-matched by the catalogue)", item.matchStatus === "needs_match" && !item.productId);
  assert("the match summary reports the catalogue source", res.catalogue?.lines === 1 && !res.catalogue.failed, res.catalogue);
  const ai = aiCalls[0] ? JSON.parse(aiCalls[0].contents[1].slice(aiCalls[0].contents[1].indexOf("\n") + 1)) : null;
  assert("…and the AI's shortlist includes it", !aiCalls.length || JSON.stringify(ai).includes(calc.id), aiCalls.length);
} catch (e) {
  assert(`suite crashed: ${e.message}`, false, e.stack);
}

await finish(counts, async () => {
  await cleanupCompany(co.id);
  await cleanupCompany(other.id);
});
