import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../../certificates/errors.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { getAiSettings, aiAllowed } from "../../certificates/ai/aiSettings.js";
import { verifyBlockQuote } from "../catalogueSections.js";
import { extractGroup, BLOCKS_PER_CALL, PROMPT_HASH as EXTRACT_HASH } from "./catalogueExtractor.js";
import { verifyRecord, renormalise, basisOf, compositionText } from "./recordVerifier.js";
import { estimateMissing, missingFields, FLAGGED_WHEN_ESTIMATED, PROMPT_HASH as INFER_HASH } from "./catalogueInference.js";
import { blockEvidence, majorityConvention } from "./numbers.js";
import { publicAiError } from "../../ai/aiErrorMessage.js";
import * as fileStore from "../../certificates/storage/fileStore.js";
import { readPdfLayout } from "../pdfLayout.js";
import { segment, bodySize } from "../segmenter.js";
import { splitPdf } from "../pages/pdfSplit.js";
import { selectionForExtraction } from "../pages/pageService.js";

// The catalogue extraction job (plan.md §15.3 steps 3–5; A6.3). Per version:
//  0. C1: the PDF is split on the server into ONLY the kept pages; the blocks read
//     for the AI come from that split file, stored under their ORIGINAL page numbers;
//  1. code reads each product block's own number evidence and the catalogue majority;
//  2. CATALOGUE_EXTRACT, whole pages per call up to BLOCKS_PER_CALL blocks (+ the
//     kept context blocks once) — every ledger row tagged with the catalogue and its pages;
//  3. code verifies every value against its own block (recordVerifier) and parses numbers;
//  4. producer / origin from the cover and back pages, verified there, applied to every product;
//  5. duplicate product codes flagged; a category is PROPOSED (matched to an existing one), never created;
//  6. CATALOGUE_INFER once for the fields still empty — stored apart as estimates;
//     a failed call leaves the verified values only;
//  7. block.extracted written, version → review. Nothing touches a product.
// A failed extraction call fails the job and the version goes back to "segmented"
// with the error (the blocks are kept; extract again from there).

const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const pagesOf = (blocks) => [...new Set(blocks.map((b) => b.page))].sort((a, b) => a - b);

/** Product blocks → call groups of whole pages, up to `size` blocks (a page with more is cut). */
export function pageGroups(blocks, size = BLOCKS_PER_CALL) {
  const byPage = new Map();
  for (const b of blocks) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b);
  }
  const groups = [];
  let cur = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(page);
    if (cur.length && cur.length + list.length > size) {
      groups.push(cur);
      cur = [];
    }
    if (list.length > size) {
      groups.push(...chunk(list, size));
      continue;
    }
    cur.push(...list);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const textsOf = (list) => list.map((x) => `${x.kind}|${x.text}`).sort().join("\n\n");

/**
 * C1: the kept pages, split out of the PDF and read again from the split file.
 * Blocks come back under their original page numbers. A kept page whose stored
 * blocks match what the split file gives — or that a person merged/split
 * (extraction.editedPages) — keeps its stored rows (same ids); any other kept
 * page gets the split file's blocks. Blocks on skipped pages are left as they
 * are and never read. → { pages, pageCount, kept, split: { pages, bytes } }
 */
async function blocksFromSplit(version) {
  const { pages, pageCount, selection } = await selectionForExtraction(version);
  const { buffer } = await fileStore.readFile(version.sourceFileId, { companyId: version.companyId });
  const split = await splitPdf(buffer, pages);
  const layout = await readPdfLayout(split.buffer);
  if (layout.pages.length !== pages.length) throw new CertError("SPLIT_MISMATCH", `The split file has ${layout.pages.length} pages but ${pages.length} were kept`, 500);
  // titles are found against the whole catalogue's body size, as at upload
  const body = version.extraction?.bodySize || bodySize((await readPdfLayout(buffer)).pages);
  const fresh = segment(layout, { bodySize: body }).blocks.map((b) => ({ ...b, page: split.pageMap[b.page - 1] }));
  const stored = await prisma.catalogueBlock.findMany({ where: { versionId: version.id }, orderBy: { seq: "asc" } });
  const edited = new Set(version.extraction?.editedPages || []);
  const create = [];
  const drop = new Set();
  for (const page of pages) {
    const mine = stored.filter((b) => b.page === page);
    const theirs = fresh.filter((b) => b.page === page);
    if (edited.has(page) || textsOf(mine) === textsOf(theirs)) continue;
    for (const b of mine) drop.add(b.id);
    create.push(...theirs);
  }
  if (create.length || drop.size) {
    // reading order: page, then the order within the page
    const order = [...stored.filter((b) => !drop.has(b.id)), ...create.map((b, i) => ({ fresh: b, page: b.page, seq: 1e6 + i }))].sort((a, b) => a.page - b.page || a.seq - b.seq);
    await prisma.$transaction([
      prisma.catalogueBlock.deleteMany({ where: { id: { in: [...drop] }, versionId: version.id, status: "pending", productId: null } }),
      ...order.map((o, seq) =>
        o.fresh
          ? prisma.catalogueBlock.create({ data: { versionId: version.id, companyId: version.companyId, seq, kind: o.fresh.kind, page: o.fresh.page, bbox: o.fresh.bbox, title: o.fresh.title, text: o.fresh.text, lines: o.fresh.lines } })
          : prisma.catalogueBlock.update({ where: { id: o.id }, data: { seq } })
      ),
    ]);
  }
  return { pages, pageCount, selection, kept: new Set(pages), split: { pages: split.pageMap.length, bytes: split.buffer.length }, replacedPages: [...new Set(create.map((b) => b.page))] };
}

/** The "." + three digits convention a block is read with. */
function conventionFor(block, evidence, majority, admin) {
  const own = evidence.get(block.id);
  if (own) return { dotGroup3: own.dotGroup3, source: "block", why: own.why };
  if (admin) return { dotGroup3: admin.dotGroup3, source: "admin" };
  return { dotGroup3: majority.dotGroup3, source: "majority" };
}

function numberContext(blocks, version) {
  const evidence = new Map();
  for (const b of blocks) {
    const e = blockEvidence(compositionText(b), basisOf(b));
    if (e) evidence.set(b.id, e);
  }
  const majority = majorityConvention([...evidence.values()]);
  const admin = version.numberConvention?.source === "admin" ? version.numberConvention : null;
  return { evidence, majority, admin };
}

async function assertUntouched(versionId, blockIds = null) {
  const touched = await prisma.catalogueBlock.count({ where: { versionId, ...(blockIds ? { id: { in: blockIds } } : {}), OR: [{ status: { not: "pending" } }, { productId: { not: null } }] } });
  if (touched) throw new CertError("BLOCKS_IN_USE", "Blocks of this version were already accepted or linked; it can't be extracted again", 409);
}

/** Producer / origin from the context blocks (cover, back page), verified against the block the model names. */
function contextFacts(catalogue, contextBlocks) {
  const out = {};
  for (const field of ["producer", "origin"]) {
    const e = catalogue?.[field];
    if (!e?.value) continue;
    const block = contextBlocks.find((b) => b.id === e.blockId) || null;
    const ok = block ? verifyBlockQuote(block, e.quote || e.value, e.value) : { ok: false };
    if (ok.ok) out[field] = { value: String(e.value).trim(), quote: { quote: ok.quote, start: ok.start, end: ok.end, blockId: block.id, page: block.page } };
  }
  return out;
}

/**
 * The catalogue worker's `extract` job. deps: { infer: false, blockIds } (from the job) and,
 * in tests, { generate, inferGenerate }. With blockIds only those pending blocks are read
 * (after a merge/split in the review); the rest of the version is left as it is.
 * → { versionId, products, flagged, calls, inference }
 */
export async function runExtractJob(versionId, ctx = { progress: () => {} }, deps = {}) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  if (!version) throw notFound("Catalogue version");
  const only = Array.isArray(deps.blockIds) && deps.blockIds.length ? deps.blockIds : null;
  await assertUntouched(versionId, only);
  const settings = await getAiSettings(version.companyId);
  if (!aiAllowed(settings)) throw new CertError("AI_DISABLED", "AI is turned off for this company — the blocks are kept; extract them once it is on", 409);
  const started = Date.now();
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "extracting", error: null } });
  try {
    ctx.progress(4, "Splitting the PDF into the kept pages");
    // a full extraction reads only the kept pages (the split file); a partial one only the blocks it names
    const chosen = only ? null : await blocksFromSplit(version);
    const all = await prisma.catalogueBlock.findMany({ where: { versionId }, orderBy: { seq: "asc" } });
    const read = (b) => !chosen || chosen.kept.has(b.page);
    const allProducts = all.filter((b) => b.kind === "product" && read(b));
    const blocks = only ? allProducts.filter((b) => only.includes(b.id)) : allProducts;
    const others = only ? allProducts.filter((b) => !only.includes(b.id)) : [];
    const context = all.filter((b) => b.kind === "context" && read(b));
    const numbers = numberContext(allProducts, version);
    // every AI call is billed to the catalogue and the ORIGINAL pages it read
    const tag = (list) => ({ catalogueId: version.catalogueId, pages: pagesOf(list) });

    // AI structuring, a group at a time (the shared rate limiter queues them)
    const raws = new Map();
    let catalogueCtx = null;
    const runs = [];
    const groups = pageGroups(blocks);
    let done = 0;
    for (const [i, group] of groups.entries()) {
      const gp = pagesOf(group);
      ctx.progress(10 + Math.round((70 * i) / Math.max(groups.length, 1)), `Reading products ${done + 1}–${done + group.length} of ${blocks.length} (page${gp.length > 1 ? "s" : ""} ${gp.join(", ")})`);
      done += group.length;
      const withContext = i === 0 && context.length ? context : null;
      const res = await extractGroup({ companyId: version.companyId, versionId, blocks: group, context: withContext, meta: tag([...group, ...(withContext || [])]) }, { generate: deps.generate });
      if (res.run?.id) runs.push(res.run.id);
      const ids = new Set(group.map((b) => b.id));
      for (const p of res.result.products || []) if (p?.blockId && ids.has(p.blockId) && !raws.has(p.blockId)) raws.set(p.blockId, p); // only the blocks it was given, once
      if (i === 0) catalogueCtx = res.result.catalogue || null;
    }
    // a block the model skipped is asked once more, on its own (never guessed)
    let retries = 0;
    const skipped = blocks.filter((b) => !raws.has(b.id));
    if (skipped.length) {
      ctx.progress(80, `Asking again for ${skipped.length} product(s) the AI skipped`);
      const res = await extractGroup({ companyId: version.companyId, versionId, blocks: skipped, meta: tag(skipped) }, { generate: deps.generate });
      retries = 1;
      if (res.run?.id) runs.push(res.run.id);
      const ids = new Set(skipped.map((b) => b.id));
      for (const p of res.result.products || []) if (p?.blockId && ids.has(p.blockId) && !raws.has(p.blockId)) raws.set(p.blockId, p);
    }

    // verification + numbers, per block
    ctx.progress(82, "Checking every value against its own block");
    const facts = contextFacts(catalogueCtx, context);
    const out = new Map();
    for (const b of blocks) {
      const convention = conventionFor(b, numbers.evidence, numbers.majority, numbers.admin);
      const raw = raws.get(b.id);
      const v = verifyRecord(raw, b, { convention });
      if (!raw) v.flags.push({ code: "no_ai_answer", message: "The AI returned nothing for this block — enter the product by hand or extract again" });
      for (const [field, f] of Object.entries(facts)) {
        v.record[field] = f.value;
        v.quotes[field] = f.quote;
      }
      out.set(b.id, { ...v, convention });
    }

    // duplicate product codes inside this catalogue (the blocks just read and the ones already extracted)
    for (const b of others) if (b.extracted?.record) out.set(b.id, { record: b.extracted.record, flags: [], untouched: true });
    const byCode = new Map();
    for (const b of [...blocks, ...others.filter((x) => out.has(x.id))]) {
      const code = out.get(b.id).record.productCode;
      if (!code) continue;
      const k = code.toUpperCase();
      if (!byCode.has(k)) byCode.set(k, []);
      byCode.get(k).push(b);
    }
    for (const [code, list] of byCode) {
      if (list.length < 2) continue;
      for (const b of list) {
        if (out.get(b.id).untouched) continue; // a block extracted earlier keeps its own flags
        const names = list.filter((x) => x.id !== b.id).map((x) => out.get(x.id).record.name || x.title || `page ${x.page}`);
        out.get(b.id).flags.push({ code: "duplicate_code", field: "productCode", message: `Code ${code} is printed for ${list.length} products (${names.join(", ")}) — invoices with it are never matched automatically`, duplicateOf: list.filter((x) => x.id !== b.id).map((x) => x.id) });
      }
    }

    // categories: proposed, matched to an existing one, never created
    for (const b of others) out.delete(b.id);
    const categories = await prisma.category.findMany({ select: { id: true, name: true } });
    for (const v of out.values()) {
      if (!v.categoryProposal) continue;
      const hit = categories.find((c) => norm(c.name) === norm(v.categoryProposal));
      v.category = { proposal: v.categoryProposal, existingCategoryId: hit?.id || null, existingName: hit?.name || null };
    }

    // estimates for what the catalogue doesn't print (owner rule)
    let inference = { calls: 0, estimated: 0, refused: 0 };
    if (deps.infer !== false) {
      ctx.progress(88, "Estimating facts the catalogue doesn't print");
      const products = blocks.map((b) => {
        const r = out.get(b.id).record;
        return { blockId: b.id, name: r.name || b.title || null, known: { ...r, activeIngredients: (r.activeIngredients || []).map((x) => x.name) }, missing: r.name && !out.get(b.id).flags.some((f) => f.code === "no_ai_answer") ? missingFields(r) : [] }; // a block the AI didn't read gets no estimates: what it prints is unknown
      });
      try {
        const res = await estimateMissing({ companyId: version.companyId, versionId, products, meta: tag(blocks) }, { generate: deps.inferGenerate });
        inference = { calls: res.calls, estimated: 0, refused: res.refused, ...(res.run?.id ? { runId: res.run.id } : {}) };
        const at = new Date().toISOString();
        for (const [blockId, list] of res.estimates) {
          const v = out.get(blockId);
          v.estimated = {};
          for (const e of list) {
            v.estimated[e.field] = { value: e.value, basis: e.basis, modelId: MODELS.CATALOGUE_INFER.id, promptHash: INFER_HASH, at };
            inference.estimated++;
            if (FLAGGED_WHEN_ESTIMATED.has(e.field)) v.flags.push({ code: "estimated_withdrawal", field: e.field, message: `Withdrawal period not printed — estimated "${String(e.value).slice(0, 60)}"; review it` });
          }
        }
      } catch (err) {
        // owner rule: the product is still created with the verified values only — recorded, never silent
        inference = { calls: 1, estimated: 0, failed: true, reason: publicAiError(err) };
      }
    }

    const at = new Date().toISOString();
    await prisma.$transaction([
      ...blocks.map((b) => {
        const v = out.get(b.id);
        return prisma.catalogueBlock.update({
          where: { id: b.id },
          data: {
            extracted: {
              isProduct: v.isProduct,
              record: v.record,
              quotes: v.quotes,
              estimated: v.estimated || {},
              flags: v.flags,
              category: v.category || null,
              convention: v.convention,
              modelId: MODELS.CATALOGUE_EXTRACT.id,
              promptHash: EXTRACT_HASH,
              extractedAt: at,
              // values a person typed before this run (e.g. while AI was unavailable) are kept
              ...(b.extracted?.manual ? { manual: b.extracted.manual } : {}),
            },
          },
        });
      }),
      prisma.catalogueVersion.update({
        where: { id: versionId },
        data: {
          status: "review",
          // the pages read are this catalogue's remembered choice: its next version starts from them
          ...(chosen ? { pageSelection: { ...chosen.selection, pages: chosen.pages, savedAt: chosen.selection.savedAt || at, extractedAt: at } } : {}),
          extraction: {
            ...(version.extraction || {}),
            ...(only ? { lastPartial: { blockIds: only, pages: pagesOf(blocks), at: new Date().toISOString() } } : {}),
            // C1: the pages read, out of how many, and the split file they came from
            ...(chosen ? { pages: chosen.pages, pageCount: chosen.pageCount, split: chosen.split, replacedPages: chosen.replacedPages } : {}),
            grouping: "pages",
            modelId: MODELS.CATALOGUE_EXTRACT.id,
            promptHash: EXTRACT_HASH,
            blocksPerCall: BLOCKS_PER_CALL,
            calls: groups.length + retries,
            retriedBlocks: skipped.length,
            runIds: runs,
            numberConvention: { majority: numbers.majority, blocksWithEvidence: numbers.evidence.size, admin: numbers.admin ? numbers.admin.dotGroup3 : null },
            inference,
            ms: Date.now() - started,
            at,
          },
        },
      }),
    ]);
    const flagged = blocks.filter((b) => out.get(b.id).flags.length).length;
    ctx.progress(100, `${blocks.length} products read, ${flagged} with something to check`);
    return { versionId, products: blocks.length, flagged, calls: groups.length + retries + (inference.calls || 0), inference };
  } catch (err) {
    await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "segmented", error: err.code ? `${err.code}: ${err.message}` : err.message } });
    throw err;
  }
}

/**
 * PUT /catalogue-versions/:id/number-convention { dotGroup3 } — the admin's
 * once-per-catalogue answer to "is '.' + three digits a thousands separator
 * here?". Every amount is re-read from its amountRaw (no AI); a block with its
 * own contrary evidence keeps it and is flagged.
 */
export async function setNumberConvention(versionId, companyScope, { dotGroup3 }, userId = null) {
  if (!["thousands", "decimal"].includes(dotGroup3)) throw new CertError("INVALID_CONVENTION", 'dotGroup3 must be "thousands" or "decimal"', 400);
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId } });
  if (!version || (companyScope && version.companyId !== companyScope)) throw notFound("Catalogue version");
  const numberConvention = { dotGroup3, source: "admin", confirmedByUserId: userId, at: new Date().toISOString() };
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product" } });
  const updates = [];
  let reread = 0;
  for (const b of blocks) {
    if (!b.extracted) continue;
    const own = blockEvidence(compositionText(b), basisOf(b));
    const convention = own ? { dotGroup3: own.dotGroup3, source: "block", why: own.why } : { dotGroup3, source: "admin" };
    const next = renormalise(b.extracted, b, convention);
    next.flags = next.flags.filter((f) => f.code !== "convention_conflict");
    if (own && own.dotGroup3 !== dotGroup3) next.flags.push({ code: "convention_conflict", message: `This page itself reads "." as ${own.dotGroup3} (${own.why}), unlike the catalogue setting — check its amounts` });
    next.convention = convention;
    reread += (next.record.activeIngredients || []).filter((i) => i.amountRaw).length;
    updates.push(prisma.catalogueBlock.update({ where: { id: b.id }, data: { extracted: next } }));
  }
  await prisma.$transaction([...updates, prisma.catalogueVersion.update({ where: { id: versionId }, data: { numberConvention } })]);
  return { numberConvention, blocks: updates.length, amountsReread: reread };
}
