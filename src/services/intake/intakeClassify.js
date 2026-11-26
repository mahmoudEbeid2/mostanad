import JSZip from "jszip";
import { prisma } from "../../lib/prisma.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { readPages } from "./intakeText.js";
import { classify, compositionFrom } from "./intakeRules.js";
import { classifyWithAi } from "./intakeAi.js";
import { readProductSheet } from "./productSheet.js";
import { loadScope, resolveDrop } from "./intakeResolve.js";
import { storeBuffer, ACCEPTED, MAX_FILE_BYTES } from "./intakeService.js";

// The `intakeClassify` job (certificate template worker): every file of a drop →
// what it is and whose. Cheap first: the file name, then the text layer; the AI
// only when those don't decide (deps.ai replaces it in tests; ai: false skips it).
// A .zip is unpacked into its files; a bundle of certificates (one per page) is
// split into one item per certificate. Then the whole drop is resolved at once.

const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
const AI_BELOW = 0.6;

async function unzip(batch, item, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  let n = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || /(^|\/)(__MACOSX|\.DS_Store)/.test(entry.name) || /\/\._/.test(entry.name)) continue;
    const name = entry.name.split("/").pop();
    if (!ACCEPTED.includes(extOf(name)) || extOf(name) === "zip") continue;
    const bytes = await entry.async("nodebuffer");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) continue;
    const child = await prisma.intakeItem.create({ data: { batchId: batch.id, parentId: item.id, name, relPath: entry.name, sizeBytes: bytes.length } });
    await storeBuffer(child, bytes, { batch });
    n++;
  }
  return n;
}

/** One file → its classification (rules, then the AI when they don't decide). */
async function classifyOne(item, buffer, { companyNames, ai, companyId }) {
  const ext = extOf(item.name);
  let pages = [];
  let pageCount = 0;
  if (["pdf", "ai"].includes(ext)) {
    try {
      ({ pages, pageCount } = await readPages(buffer, { maxPages: 40, maxChars: 4000 }));
    } catch (err) {
      return { docType: "other", confidence: 0.1, evidence: [{ from: "file", says: `can't be opened as a PDF: ${err.message}` }], question: "doc_type", ext, pageCount: 0, productNames: [], batches: [], companies: [] };
    }
  } else if (["html", "htm"].includes(ext)) {
    pages = [{ n: 1, text: buffer.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 4000) }];
    pageCount = 1;
  }
  const c = classify({ name: item.name, pages, pageCount, companyNames });
  c.pagesText = pages.map((p) => ({ n: p.n, text: p.text.slice(0, 600) })); // the evidence the card can show, not the whole file
  // each page's text, for splitting and for a COC's composition (not stored)
  Object.defineProperty(c, "pagesFull", { value: pages, enumerable: false });
  if (c.docType === "product_list") {
    try {
      const sheet = await readProductSheet(buffer, ext);
      c.sheet = { columns: sheet.columns, unknownColumns: sheet.unknownColumns, count: sheet.products.length, rows: sheet.products.slice(0, 500), error: sheet.error || null };
      c.productNames = sheet.products.map((p) => String(p.name).toUpperCase()).slice(0, 500);
      if (sheet.error) Object.assign(c, { confidence: 0.4, question: "doc_type" });
    } catch (err) {
      Object.assign(c, { confidence: 0.3, question: "doc_type", sheet: { error: err.message } });
    }
  }
  let aiCalls = 0;
  if (c.confidence < AI_BELOW && ai !== false && c.docType !== "product_list") {
    try {
      const answer = await (ai || classifyWithAi)({ item, pages, buffer, companyId });
      aiCalls = 1;
      c.ai = answer;
      if (answer.confidence > c.confidence) {
        c.docType = answer.docType === "certificate_template" && answer.filled ? "certificate_filled" : answer.docType;
        c.certCode = c.certCode || answer.certCode;
        c.confidence = Math.min(0.85, answer.confidence); // an AI answer is never "certain": the card shows it to check
        c.productNames = c.productNames?.length ? c.productNames : answer.productNames;
        c.country = c.country || answer.country;
        if (answer.companyName) c.companies = [...(c.companies || []), { name: answer.companyName, says: "read by AI" }];
        c.evidence = [...(c.evidence || []), { from: "ai", says: answer.reason }];
        c.question = c.confidence < AI_BELOW ? "doc_type" : null;
      }
    } catch (err) {
      c.evidence = [...(c.evidence || []), { from: "ai", says: `AI not available: ${err.message.slice(0, 120)}` }];
    }
  }
  return { c, aiCalls };
}

/**
 * Runs for one drop → { items, aiCalls }. deps: { ai: fn | false } (tests).
 */
export async function runClassify(batchId, ctx = {}, deps = {}) {
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId } });
  const progress = ctx.progress || (() => {});
  // .zip → its files
  for (const z of await prisma.intakeItem.findMany({ where: { batchId, status: "uploaded", parentId: null } })) {
    if (extOf(z.name) !== "zip") continue;
    const { buffer } = await fileStore.readFile(z.fileId);
    const n = await unzip(batch, z, buffer);
    await prisma.intakeItem.update({ where: { id: z.id }, data: { status: "classified", classification: { docType: "other", expanded: n, ext: "zip", evidence: [{ from: "file", says: `a .zip with ${n} files` }] } } });
  }
  const scope = await loadScope({ companyId: batch.companyId });
  const companyNames = [...scope.companies.map((c) => c.name), ...scope.brands.map((b) => b.name)];
  const todo = await prisma.intakeItem.findMany({ where: { batchId, status: "uploaded" }, orderBy: { createdAt: "asc" } });
  let aiTotal = 0;
  let done = 0;
  for (const item of todo) {
    progress(5 + Math.round((done / Math.max(todo.length, 1)) * 85), `Reading ${item.name}`);
    const { buffer } = await fileStore.readFile(item.fileId);
    const { c, aiCalls } = await classifyOne(item, buffer, { companyNames, ai: deps.ai, companyId: batch.companyId });
    aiTotal += aiCalls;
    // a Certificate of Composition prints the product's composition, pack and form: read by code (26 Nov)
    if (c.certCode === "COC" && !c.parts?.length && c.pagesFull?.length) c.composition = compositionFrom(c.pagesFull.map((p) => p.text).join(" ")) || undefined;
    await prisma.intakeItem.update({ where: { id: item.id }, data: { classification: c, status: "classified", aiCalls } });
    // a bundle: one item per certificate, read from its own page. A product name two
    // pages both print (a copy-paste in the document) is a question, never "fixed".
    const named = (c.parts || []).map((x) => x.product).filter(Boolean);
    const twice = new Set(named.filter((n, k) => named.indexOf(n) !== k));
    for (const part of c.parts || []) {
      const pages = (c.pagesFull || []).filter((p) => p.n >= part.from && p.n <= part.to);
      const pc = classify({ name: `${item.name} — p.${part.from}`, pages, pageCount: pages.length, companyNames });
      const repeated = part.product && twice.has(part.product);
      const partClass = {
        ...pc,
        docType: "certificate_filled",
        certCode: c.certCode,
        productNames: part.product ? [part.product] : pc.productNames,
        batches: part.batch ? [part.batch] : [],
        companies: c.companies,
        country: c.country,
        ext: c.ext,
        parts: null,
        pagesFull: undefined,
        pageText: pages.map((p) => p.text).join(" ").slice(0, 4000),
        ...(c.certCode === "COC" ? { composition: compositionFrom(pages.map((p) => p.text).join(" ")) || undefined } : {}),
        confidence: Math.min(c.confidence, part.product && !repeated ? 0.9 : 0.55),
        question: !part.product || repeated ? "product" : null,
        evidence: [
          { from: "text", page: part.from, says: `page ${part.from} of ${item.name}${part.product ? `: ${part.product}` : ""}` },
          ...(repeated ? [{ from: "text", page: part.from, says: `another page of this file also says ${part.product} — check which product this page is` }] : []),
        ],
      };
      await prisma.intakeItem.create({ data: { batchId, parentId: item.id, name: `${item.name} — ${part.product || `p.${part.from}`}`, sizeBytes: 0, receivedBytes: 0, fileId: item.fileId, sha256: item.sha256, mimeType: item.mimeType, pageFrom: part.from, pageTo: part.to, status: "classified", classification: partClass } });
    }
    done++;
  }
  progress(92, "Matching companies, brands and products");
  await resolveBatch(batchId);
  await prisma.intakeBatch.update({ where: { id: batchId }, data: { status: "review", aiCalls: { increment: aiTotal } } });
  return { items: done, aiCalls: aiTotal };
}

/** Proposals for every classified item of a drop (also after a company is chosen). */
export async function resolveBatch(batchId) {
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId } });
  const items = await prisma.intakeItem.findMany({ where: { batchId, status: { in: ["classified", "duplicate"] } } });
  const scope = await loadScope({ companyId: batch.companyId });
  // the same bytes already filed — in the same company only ("companyId|sha256"): another
  // company's identical file is not a duplicate. Any upload kind, or an earlier drop's file.
  const hashes = [...new Set(items.map((i) => i.sha256).filter(Boolean))];
  const existingHashes = new Map();
  if (hashes.length) {
    // never the drop's own files (26 Nov: ADDVET's 5 chat files were "duplicates" of themselves —
    // a chat attachment is stored in the company before it is classified): only files FILED before
    // this drop started, by an upload or a completed intake
    const own = [...new Set(items.map((i) => i.fileId).filter(Boolean))];
    const files = await prisma.storedFile.findMany({
      where: { sha256: { in: hashes }, companyId: batch.companyId || { not: null }, kind: { notIn: ["intake_file", "assistant_attachment"] }, id: { notIn: own }, createdAt: { lt: batch.createdAt } },
      select: { sha256: true, createdAt: true, kind: true, companyId: true },
    });
    for (const f of files) if (!existingHashes.has(`${f.companyId}|${f.sha256}`)) existingHashes.set(`${f.companyId}|${f.sha256}`, { at: f.createdAt, kind: f.kind });
    const earlier = await prisma.intakeItem.findMany({ where: { sha256: { in: hashes }, status: "done", parentId: null, batchId: { not: batchId }, companyId: batch.companyId || { not: null } }, select: { sha256: true, createdAt: true, companyId: true, name: true } });
    for (const e of earlier) if (!existingHashes.has(`${e.companyId}|${e.sha256}`)) existingHashes.set(`${e.companyId}|${e.sha256}`, { at: e.createdAt, name: e.name });
  }
  const { proposals } = await resolveDrop({ items, scope, sessionCompanyId: batch.ownerType === "company" ? batch.companyId : null, hintCompanyId: batch.ownerType === "user" ? batch.companyId : null, existingHashes });
  for (const i of items) {
    const p = proposals.get(i.id);
    if (!p) continue;
    await prisma.intakeItem.update({ where: { id: i.id }, data: { classification: { ...i.classification, proposal: p }, status: p.action === "duplicate" ? "duplicate" : "classified", revision: { increment: 1 } } });
  }
}
