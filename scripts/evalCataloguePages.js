import "dotenv/config";
import fs from "fs";
import path from "path";

// Live proof of C1 (choose catalogue pages): the real extraction of one catalogue,
// every page against the pages kept by default, read back from the AI cost ledger.
// Opt-in and paid: RUN_LIVE_GEMINI=1; GEMINI_DISABLED must not be set; needs Postgres.
// Calls: about 7 per run (6 blocks per call + 1 inference), so about 14.
//
//   RUN_LIVE_GEMINI=1 npm run eval:catalogue-pages [-- <file.pdf>]
//
// Writes golden/ai-eval-catalogue-pages-<date>.json. Keeps its company and ledger rows
// on purpose: they are the history the "Choose pages" estimate averages.

if (process.env.RUN_LIVE_GEMINI !== "1") {
  console.error("Refusing to run: this calls the paid Gemini API. Set RUN_LIVE_GEMINI=1 to run it.");
  process.exit(2);
}
if (process.env.GEMINI_DISABLED === "true") {
  console.error("Refusing to run: GEMINI_DISABLED=true in this process.");
  process.exit(2);
}

const { createCompany, prisma } = await import("../tests/certificates-v2/helpers.js");
const fileStore = await import("../src/services/certificates/storage/fileStore.js");
const { runSegmentJob } = await import("../src/services/catalogues/catalogueService.js");
const { runExtractJob } = await import("../src/services/catalogues/extraction/extractionService.js");
const { saveSelection, listPages } = await import("../src/services/catalogues/pages/pageService.js");
process.env.GEMINI_DISABLED = "false";

const ROOT = process.cwd();
const file = process.argv[2] || path.join(ROOT, "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf");
const pdf = fs.readFileSync(file);
const co = await createCompany("c1proof");

/** One extraction of the file under its own catalogue (so no selection carries over). */
async function run(label, choose) {
  const stored = await fileStore.putFile({ companyId: co.id, kind: "catalogue_source", buffer: pdf, mimeType: "application/pdf", originalName: path.basename(file) });
  const catalogue = await prisma.catalogue.create({ data: { companyId: co.id, manufacturer: `C1 proof — ${label}` } });
  const version = await prisma.catalogueVersion.create({ data: { catalogueId: catalogue.id, companyId: co.id, label, sourceFileId: stored.id } });
  await runSegmentJob(version.id);
  const listed = await listPages(version.id, co.id);
  const pages = choose(listed.pages.map((p) => p.number), listed.selection.pages);
  await saveSelection(version.id, co.id, pages);
  const estimate = (await listPages(version.id, co.id)).estimate;
  const t0 = Date.now();
  await runExtractJob(version.id, { progress: (p, m) => console.log(`  [${label}] ${p}% ${m}`) }, { infer: true });
  const v = await prisma.catalogueVersion.findUnique({ where: { id: version.id } });
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId: version.id, kind: "product" }, orderBy: { seq: "asc" } });
  const read = blocks.filter((b) => pages.includes(b.page));
  const calls = await prisma.aiCall.findMany({ where: { parentType: "catalogue", parentId: catalogue.id }, orderBy: { createdAt: "asc" } });
  const sum = (k, list = calls) => list.reduce((s, c) => s + Number(c[k] || 0), 0);
  const ok = calls.filter((c) => c.outcome === "ok");
  return {
    label,
    versionId: version.id,
    pagesSent: pages.length,
    pages,
    ms: Date.now() - t0,
    ledger: {
      calls: calls.length,
      ok: ok.length,
      failed: calls.length - ok.length,
      byFeature: Object.fromEntries([...new Set(calls.map((c) => c.feature))].map((f) => [f, calls.filter((c) => c.feature === f).length])),
      inputTokens: sum("inputTokens"),
      cachedTokens: sum("cachedTokens"),
      outputTokens: sum("outputTokens"),
      thinkingTokens: sum("thinkingTokens"),
      costUsd: calls.every((c) => c.costUsd !== null) ? sum("costUsd") : null,
      unpricedCalls: calls.filter((c) => c.costUsd === null).length,
    },
    estimate: { selected: estimate.selected, basis: estimate.basis },
    extraction: { calls: v.extraction.calls, retriedBlocks: v.extraction.retriedBlocks, inference: v.extraction.inference, split: v.extraction.split, status: v.status, error: v.error },
    products: read.map((b) => ({
      page: b.page,
      title: b.title,
      name: b.extracted?.record?.name || null,
      code: b.extracted?.record?.productCode || null,
      producer: b.extracted?.record?.producer || null,
      origin: b.extracted?.record?.origin || null,
      ingredients: (b.extracted?.record?.activeIngredients || []).length,
      fields: Object.values(b.extracted?.record || {}).filter((x) => x !== null && x !== undefined && x !== "" && !(Array.isArray(x) && !x.length)).length,
      flags: (b.extracted?.flags || []).map((f) => f.code),
    })),
  };
}

// EVAL_ONLY=all: run the whole catalogue again and compare with today's saved product-pages run
const today = path.join(ROOT, "golden", `ai-eval-catalogue-pages-${new Date().toISOString().slice(0, 10)}.json`);
const all = await run("all pages", (every) => every);
const kept = process.env.EVAL_ONLY === "all" ? JSON.parse(fs.readFileSync(today, "utf8")).kept : await run("product pages", (_, auto) => auto);

const key = (p) => `${p.page}|${p.title}`;
const inKept = new Map(kept.products.map((p) => [key(p), p]));
const inAll = new Map(all.products.map((p) => [key(p), p]));
const found = (list) => list.filter((p) => p.name).length;
const diff = {
  missedBySelection: all.products.filter((p) => p.name && !inKept.get(key(p))?.name).map((p) => ({ page: p.page, name: p.name })),
  foundOnlyWithSelection: kept.products.filter((p) => p.name && !inAll.get(key(p))?.name).map((p) => ({ page: p.page, name: p.name })),
  blocksOnSkippedPages: all.products.filter((p) => !kept.pages.includes(p.page)).map((p) => ({ page: p.page, name: p.name })),
  producer: { all: all.products.filter((p) => p.producer).length, kept: kept.products.filter((p) => p.producer).length },
  origin: { all: all.products.filter((p) => p.origin).length, kept: kept.products.filter((p) => p.origin).length },
  fieldsFilled: { all: all.products.reduce((s, p) => s + p.fields, 0), kept: kept.products.reduce((s, p) => s + p.fields, 0) },
};
const card = { date: new Date().toISOString(), file: path.basename(file), companyId: co.id, all, kept, diff };
const out = today;
if (fs.existsSync(out)) fs.renameSync(out, out.replace(/\.json$/, `-before-${Date.now()}.json`)); // the earlier run stays on disk
fs.writeFileSync(out, JSON.stringify(card, null, 2));

const line = (r) => `${r.label}: ${r.pagesSent} pages · ${r.ledger.calls} AI calls (${r.ledger.failed} failed) · in ${r.ledger.inputTokens} · out ${r.ledger.outputTokens} + thinking ${r.ledger.thinkingTokens} · cost ${r.ledger.costUsd ?? `unpriced (${r.ledger.unpricedCalls} calls)`} · ${found(r.products)} products of ${r.products.length} blocks`;
console.log(`\n${line(all)}\n${line(kept)}`);
console.log(JSON.stringify(diff, null, 2));
console.log(`\n→ ${path.relative(ROOT, out)}`);
await prisma.$disconnect();
process.exit(0);
