import { prisma } from "../../lib/prisma.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { readPages } from "../intake/intakeText.js";
import { brandScore } from "../brandMatch.js";
import { harvestPage, norm, normPack } from "./harvestRules.js";
import { recordConflicts } from "../catalogues/compositionReview.js";
import { parseBasis } from "../catalogues/compositionCompare.js";
import { countryCode } from "../assistant/countries.js";

// Harvest (28 Nov): read every file of a company — a drop, a chat upload, a template, a product import,
// or everything already stored (re-harvest) — keep every value with its evidence (harvested_facts),
// then fill the company's and products' DESCRIPTIVE fields by priority:
//   a person's value  >  an official document (certificate, registration)  >  a label  >  a catalogue
// A value never replaces a person's or a higher source's; files that disagree are kept once as a
// conflict with both sources, never silently overwritten. Per-batch facts (batch, dates, results) are
// stored but never put on a product — they are offered where a certificate asks for them.

export const PRIORITY = { user: 9, certificate: 4, registration: 4, lab: 3, mo: 3, label: 2, catalogue: 1, invoice: 1, list: 1, other: 0 };
// product fields filled from facts (key → column)
const PRODUCT_FIELDS = {
  physicalForm: "physicalForm",
  packaging: "packaging",
  validity: "validity",
  storage: "storage",
  indications: "indications",
  dosage: "dosage",
  withdrawalPeriod: "withdrawalPeriod",
  contraindications: "contraindications",
  appearance: "appearance",
  compositionBasis: "compositionBasis",
  origin: "origin",
  category: "productType", // a category name; linked to a shared category only when one exists by that name
};
// the same thing said differently is the same value: "JORDAN" = { code: "JO" }; "Each 1 mL contains" = "Contains per ml"
const comparable = (key, v) => {
  if (key === "packaging") return normPack(v);
  if (key === "origin") return v?.code || countryCode(String(v || "")) || norm(v);
  if (key === "compositionBasis") {
    const b = parseBasis(String(v || ""));
    return b ? `${b.amount}${b.unit}` : norm(v);
  }
  return norm(typeof v === "object" && v?.text ? v.text : v);
};
const sameValue = (key, a, b) => comparable(key, a) === comparable(key, b);
const show = (v) => (typeof v === "string" ? v : v?.text || v?.code || JSON.stringify(v));

/** What kind of document a file is, for the reader and the priority */
export function kindOf({ docType = null, certCode = null, fileKind = null, name = "" }) {
  if (docType === "label" || fileKind === "label_upload" || fileKind === "reference_label") return "label";
  if (docType === "catalogue" || fileKind === "catalogue_source") return "catalogue";
  if (docType === "invoice" || fileKind === "invoice_source") return "invoice";
  if (docType === "manufacturing_order") return "mo";
  if (fileKind === "supplier_coa") return "lab";
  if (/registration|license|licence/i.test(name)) return "registration";
  if (docType?.startsWith("certificate") || certCode || fileKind === "template_source") return "certificate";
  return "other";
}

/** Store a file's facts (idempotent: the same fact of the same page is kept once). → number stored */
export async function harvestFile({ companyId, fileId, fileName = null, kind, certCode = null, pageFrom = null, pageTo = null, productName = null, productId = null, knownProducts = null }) {
  if (!companyId || !fileId) return 0;
  let buffer;
  try {
    buffer = (await fileStore.readFile(fileId, { companyId })).buffer;
  } catch {
    return 0;
  }
  let pages;
  try {
    pages = (await readPages(buffer, { maxPages: 60, maxChars: 8000 })).pages;
  } catch {
    return 0; // not a PDF with a text layer (an image, a spreadsheet): nothing to read by code
  }
  const names = knownProducts || (await prisma.product.findMany({ where: { companyId }, select: { name: true }, take: 2000 })).map((p) => p.name);
  const rows = [];
  for (const p of pages) {
    if (pageFrom && (p.n < pageFrom || p.n > (pageTo || pageFrom))) continue;
    for (const f of harvestPage({ text: p.text, kind, certCode, product: productName, knownProducts: names })) {
      rows.push({
        companyId,
        entity: f.entity,
        productId: f.entity === "product" || f.entity === "batch" ? (f.productName && productName && norm(f.productName) !== norm(productName) ? null : productId) : null,
        productName: f.productName || null,
        pack: f.pack || null,
        key: f.key,
        value: f.value,
        valueNorm: norm(f.value).slice(0, 300),
        sourceType: kind,
        certCode: f.certCode || certCode || null,
        fileId,
        fileName,
        page: p.n,
        snippet: f.snippet ? String(f.snippet).slice(0, 400) : null,
        perBatch: !!f.perBatch,
        batchNo: f.batchNo || null,
      });
    }
  }
  if (!rows.length) return 0;
  const out = await prisma.harvestedFact.createMany({ data: rows, skipDuplicates: true });
  return out.count;
}

/** Facts whose product isn't linked yet → the company's product of that name (fuzzy: SULFARIM = SULFAPRIM) */
async function linkProducts(companyId) {
  const products = await prisma.product.findMany({ where: { companyId }, select: { id: true, name: true, packaging: true } });
  const loose = await prisma.harvestedFact.findMany({ where: { companyId, productId: null, productName: { not: null } }, select: { id: true, productName: true, pack: true } });
  const byName = new Map();
  for (const f of loose) {
    if (!byName.has(f.productName)) {
      const exact = products.filter((p) => norm(p.name) === norm(f.productName));
      const close = exact.length ? exact : products.filter((p) => brandScore(f.productName, p.name) >= 0.8 || brandScore(p.name, f.productName) >= 0.8);
      // the same product in two packs: the fact's pack decides
      const pick = close.length === 1 ? close[0] : close.find((p) => f.pack && normPack(p.packaging) === normPack(f.pack)) || null;
      byName.set(f.productName, pick?.id || null);
    }
    const id = byName.get(f.productName);
    if (id) await prisma.harvestedFact.update({ where: { id: f.id }, data: { productId: id } });
  }
}

const provenanceOf = (f) => ({ tier: f.sourceType === "certificate" || f.sourceType === "registration" ? "D" : f.sourceType === "label" ? "L" : "C", source: "harvest", sourceType: f.sourceType, certCode: f.certCode, file: f.fileName, fileId: f.fileId, page: f.page, quote: f.snippet, at: new Date().toISOString() });
const rankOf = (prov) => (prov ? (prov.tier === "manual" || prov.by || prov.confirmedByUserId ? PRIORITY.user : PRIORITY[prov.sourceType] ?? (prov.tier === "C" ? PRIORITY.catalogue : 0)) : null);

/**
 * Fill one product from its facts. → { filled: [key], conflicts: [key] }
 * A field with a value and no provenance was typed by a person (or came before harvest): never replaced.
 */
export async function mergeProduct(productId) {
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (!p) return { filled: [], conflicts: [] };
  const facts = (await prisma.harvestedFact.findMany({ where: { productId, entity: "product", perBatch: false } })).sort((a, b) => (PRIORITY[b.sourceType] || 0) - (PRIORITY[a.sourceType] || 0) || a.createdAt - b.createdAt);
  const prov = { ...(p.fieldProvenance || {}) };
  const data = {};
  const filled = [];
  const conflicts = [...(p.harvestConflicts || [])];
  const keys = [...new Set(facts.map((f) => f.key))];
  for (const key of keys) {
    const list = facts.filter((f) => f.key === key);
    const best = list[0];
    // every distinct value the files give, once each, with its source — one per file (a label prints
    // its sections twice, in slightly different words: the fuller one stands for that file)
    const perFile = new Map();
    for (const f of list) {
      const k = f.fileId || f.id;
      const cur = perFile.get(k);
      if (!cur || JSON.stringify(f.value).length > JSON.stringify(cur.value).length) perFile.set(k, f);
    }
    const distinct = [];
    for (const f of [...perFile.values()].sort((a, b) => (PRIORITY[b.sourceType] || 0) - (PRIORITY[a.sourceType] || 0))) if (!distinct.some((d) => sameValue(key, d.value, f.value))) distinct.push(f);
    if (key === "activeIngredients") {
      const has = Array.isArray(p.activeIngredients) && p.activeIngredients.length;
      if (!has) {
        const basis = facts.find((f) => f.key === "compositionBasis" && f.fileId === best.fileId && f.page === best.page)?.value || null;
        data.activeIngredients = best.value.map((x) => ({ name: x.name, concentration: x.amountRaw, amountRaw: x.amountRaw, amount: x.amount ?? null, unit: x.unit ?? null, basis }));
        prov.activeIngredients = provenanceOf(best);
        filled.push(key);
      }
      // a different composition elsewhere is the reviewer's to settle (both kept), never applied
      for (const f of distinct.slice(has ? 0 : 1)) await recordConflicts({ ...p, ...data, fieldProvenance: prov }, { ingredients: f.value, basis: null, source: provenanceOf(f) });
      continue;
    }
    if (key.startsWith("spec:")) {
      const test = key.slice(5);
      const values = { ...(p.specifications?.values || {}), ...(data.specifications?.values || {}) };
      if (!values[test]) {
        data.specifications = { type: p.specifications?.type || "string", values: { ...values, [test]: show(best.value) } };
        prov[`specifications.${test}`] = provenanceOf(best);
        filled.push(key);
      }
      continue;
    }
    const col = PRODUCT_FIELDS[key];
    if (!col) continue;
    const current = p[col];
    const value = key === "packaging" ? normPack(best.value) : show(best.value);
    const currentRank = current ? rankOf(prov[col]) ?? PRIORITY.user : -1;
    if (!current || (currentRank < (PRIORITY[best.sourceType] || 0) && prov[col]?.source === "harvest")) {
      data[col] = value;
      prov[col] = provenanceOf(best);
      filled.push(key);
    } else if (current && !sameValue(key, current, best.value) && !distinct.some((d) => sameValue(key, d.value, current))) {
      distinct.unshift({ value: current, sourceType: prov[col] ? prov[col].sourceType || "user" : "user", fileName: prov[col]?.file || null, page: prov[col]?.page || null, snippet: null });
    }
    // two sources disagree: shown once, with both (and the person decides); nothing is overwritten
    if (distinct.length > 1 && !conflicts.some((c) => c.key === key && !c.decision)) {
      conflicts.push({ key, values: distinct.slice(0, 4).map((d) => ({ value: show(d.value), sourceType: d.sourceType, file: d.fileName, page: d.page, quote: d.snippet })), at: new Date().toISOString(), decision: null });
    }
  }
  // the category, when the shared list has one of that name
  const cat = facts.find((f) => f.key === "category");
  if (cat && !p.categoryId) {
    const row = await prisma.category.findFirst({ where: { name: { equals: show(cat.value), mode: "insensitive" } }, select: { id: true } });
    if (row) {
      data.categoryId = row.id;
      prov.categoryId = provenanceOf(cat);
    }
  }
  const producer = await prisma.harvestedFact.findFirst({ where: { companyId: p.companyId, entity: "company", key: "producerName" }, orderBy: { createdAt: "asc" } });
  if (!p.producer && producer) {
    data.producer = show(producer.value);
    prov.producer = provenanceOf(producer);
    filled.push("producer");
  }
  if (Object.keys(data).length || conflicts.length !== (p.harvestConflicts || []).length) {
    await prisma.product.update({ where: { id: p.id }, data: { ...data, fieldProvenance: prov, harvestConflicts: conflicts } });
  }
  return { filled, conflicts: conflicts.filter((c) => !c.decision).map((c) => c.key) };
}

/** The company's profile from its facts: producer, registration, address, contacts, numbering, date format */
export async function mergeCompany(companyId) {
  const c = await prisma.company.findUnique({ where: { id: companyId } });
  if (!c) return null;
  const facts = await prisma.harvestedFact.findMany({ where: { companyId, entity: { in: ["company", "document"] } }, orderBy: { createdAt: "asc" } });
  const first = (key) => facts.filter((f) => f.key === key).sort((a, b) => (PRIORITY[b.sourceType] || 0) - (PRIORITY[a.sourceType] || 0))[0];
  const profile = { ...(c.profile || {}) };
  const sources = { ...(profile.sources || {}) };
  for (const key of ["producerName", "registrationNo", "website", "country", "address", "email", "phone"]) {
    const f = first(key);
    if (f && !profile[key]) {
      profile[key] = show(f.value);
      sources[key] = provenanceOf(f);
    }
  }
  const numbering = { ...(profile.numbering || {}) };
  for (const f of facts.filter((x) => x.key === "numbering" && x.value?.certCode)) {
    const cur = numbering[f.value.certCode];
    if (!cur || (f.value.pattern === cur.pattern && f.value.seq > cur.lastSeq)) numbering[f.value.certCode] = { pattern: f.value.pattern, prefix: f.value.prefix, lastSeq: Math.max(cur?.lastSeq || 0, f.value.seq || 0), file: f.fileName };
  }
  profile.numbering = numbering;
  if (!profile.dateFormat && first("dateFormat")) profile.dateFormat = show(first("dateFormat").value);
  profile.sources = sources;
  const data = { profile };
  // the company's own columns only when empty (a login email is never touched)
  if (!c.address && profile.address) data.address = profile.address;
  if (!c.phone && profile.phone) data.phone = profile.phone;
  await prisma.company.update({ where: { id: companyId }, data });
  return profile;
}

/** Link the facts to products, fill every product of the company and the company's profile. → summary */
export async function mergeAll(companyId, { productIds = null } = {}) {
  await linkProducts(companyId);
  const ids = productIds || (await prisma.harvestedFact.findMany({ where: { companyId, productId: { not: null } }, distinct: ["productId"], select: { productId: true } })).map((r) => r.productId);
  let filled = 0;
  let conflicts = 0;
  for (const id of ids) {
    const r = await mergeProduct(id);
    filled += r.filled.length;
    conflicts += r.conflicts.length;
  }
  await mergeCompany(companyId);
  const batchMissing = await prisma.harvestedFact.count({ where: { companyId, perBatch: true } });
  return { products: ids.length, filled, conflicts, batchFacts: batchMissing };
}

// the stored files worth reading, by their kind
const READABLE = ["intake_file", "assistant_attachment", "template_source", "label_upload", "catalogue_source", "invoice_source", "supplier_coa", "direct_request"];

/**
 * The re-harvest job: every file already stored for a company, read again (facts are idempotent), then
 * merged — existing products get filled without anyone uploading again. ctx.progress reports it.
 */
export async function reharvestCompany(companyId, ctx = {}) {
  const files = await prisma.storedFile.findMany({ where: { companyId, kind: { in: READABLE.filter((k) => k !== "direct_request") }, mimeType: "application/pdf" }, select: { id: true, kind: true, originalName: true }, orderBy: { createdAt: "asc" } });
  // what a drop said about each file: its kind, and the product of the file (a label) or of each page (a bundle)
  const items = await prisma.intakeItem.findMany({ where: { companyId, fileId: { in: files.map((f) => f.id) } }, select: { fileId: true, name: true, parentId: true, pageFrom: true, pageTo: true, classification: true, result: true } });
  const products = await prisma.product.findMany({ where: { companyId }, select: { id: true, name: true } });
  const names = products.map((p) => p.name);
  const productOf = (it) => {
    const ids = it?.result?.plan?.productIds || [];
    return ids.length === 1 ? products.find((p) => p.id === ids[0]) || null : null;
  };
  let stored = 0;
  for (const [i, f] of files.entries()) {
    ctx.progress?.(Math.round((i / Math.max(files.length, 1)) * 90), `Reading ${f.originalName || f.id}`);
    const mine = items.filter((x) => x.fileId === f.id);
    const top = mine.find((x) => !x.parentId);
    const pages = mine.filter((x) => x.parentId && x.pageFrom);
    const certCode = top?.classification?.certCode || (/\b(COA|COC|HC|FSC|COO)\b/i.exec(f.originalName || "")?.[1]?.toUpperCase() ?? null);
    const kind = kindOf({ docType: top?.classification?.docType || null, certCode, fileKind: f.kind, name: f.originalName || top?.name || "" });
    const fileName = f.originalName || top?.name || null;
    if (pages.length) {
      for (const pg of pages) {
        const p = productOf(pg);
        stored += await harvestFile({ companyId, fileId: f.id, fileName, kind, certCode, pageFrom: pg.pageFrom, pageTo: pg.pageTo, productName: p?.name || null, productId: p?.id || null, knownProducts: names });
      }
    } else {
      const p = productOf(top);
      stored += await harvestFile({ companyId, fileId: f.id, fileName, kind, certCode, productName: p?.name || null, productId: p?.id || null, knownProducts: names });
    }
  }
  ctx.progress?.(95, "Filling the products");
  const merged = await mergeAll(companyId);
  return { files: files.length, facts: stored, ...merged };
}

/** The review card's line: "قريت 14 ملف — ملّيت 212 قيمة — 3 تعارضات — 6 خانات باتش ناقصة" */
export const summaryAr = ({ files, filled, conflicts, batchMissing }) => `قريت ${files} ملف — ملّيت ${filled} قيمة — ${conflicts} تعارضات — ${batchMissing} خانات باتش ناقصة`;

/**
 * Read one uploaded file in the background (a template, a chat file, a product import) and fill what
 * it says; never delays or fails the upload. certCode: the certificate type, when known.
 */
export function harvestSoon({ companyId, fileId, fileName = null, kind = "other", certCode = null }) {
  if (!companyId || !fileId) return;
  setImmediate(async () => {
    try {
      if (await harvestFile({ companyId, fileId, fileName, kind, certCode })) await mergeAll(companyId);
    } catch (err) {
      console.error(`[harvest] ${fileName || fileId}: ${err.message}`);
    }
  });
}
