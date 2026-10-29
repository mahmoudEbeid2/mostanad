import { prisma } from "../../lib/prisma.js";
import { CertError, notFound } from "../certificates/errors.js";
import { scheduleDictionaryRebuild } from "../certificates/dictionary/rebuildScheduler.js";
import { catalogueRefOf } from "./catalogueService.js";
import { productFromBlock, onReadPages, readPagesWhere } from "./reviewService.js";
import { matchContext, matchBlock } from "./productMatch.js";

// The re-upload diff (plan.md §15.4, A6.5): what a catalogue version would change
// in the company's EXISTING products — computed on demand, never stored, so it
// always reflects the products as they are now.
//  - per block: the product it matches (productMatch) and per field old → new,
//    with the new value's quote; "new" blocks have no product (they go through
//    accept, A6.4); products linked to this catalogue that no block matches are
//    "removed" — listed, never deleted.
//  - an estimate only FILLS an empty field; it never replaces a value (so a
//    re-run of the same file, whose estimates are worded differently, is 0 changes).
//  - catalogue silence never clears a value.
//  - conflict = the product's current value was typed by a person (tier manual,
//    a confirmed estimate) or predates any catalogue (no provenance): never
//    overwritten unless the admin names that field.
//  - apply: per product (every non-conflict change) or per field; the product's
//    catalogueRef and the tier-C provenance of unchanged values move to this version.
//    A change the admin did not take is remembered as declined (that catalogue,
//    that value): it is not proposed again until the catalogue prints something else.

const DIFF_FIELDS = ["name", "productCode", "physicalForm", "description", "indications", "targetSpecies", "dosage", "mixingInstructions", "withdrawalPeriod", "contraindications", "userSafety", "storage", "packaging", "registrationNumber", "appearance", "origin", "producer", "activeIngredients", "specifications"];

const ws = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const empty = (v) => v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : typeof v === "object" ? !Object.keys(v.values || v).length : ws(v) === "");

/** The comparable form of a field value: what a reader of the product would see. */
function comparable(field, v) {
  if (empty(v)) return null;
  if (field === "activeIngredients") return JSON.stringify((Array.isArray(v) ? v : []).map((i) => [ws(i?.name).toLowerCase(), ws(i?.amountRaw ?? i?.concentration)]));
  if (field === "specifications") {
    const vals = v?.values || {};
    return JSON.stringify(Object.keys(vals).sort().map((k) => [ws(k).toLowerCase(), ws(vals[k])]));
  }
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => ws(x)));
  return ws(v);
}

/** Who wrote the product's current value → "catalogue" | "estimate" | "person" | "unknown" */
function authorOf(product, field) {
  const p = product.fieldProvenance?.[field];
  if (!p) return "unknown";
  if (p.tier === "C") return "catalogue";
  if (p.tier === "I" && p.estimated && !p.confirmedAt) return "estimate";
  return "person";
}

/** One block vs its product → { changes: [...], unchanged: [fields], declined: [fields] } */
export function diffBlock(block, product, catalogueId = block.version?.catalogueId) {
  const { data, fieldProvenance } = productFromBlock(block);
  const changes = [];
  const unchanged = [];
  const declined = [];
  for (const field of DIFF_FIELDS) {
    if (!(field in data)) continue; // the catalogue doesn't print it: nothing to propose, nothing cleared
    const next = data[field];
    const prov = fieldProvenance[field];
    const current = product[field];
    const isEstimate = prov?.tier === "I";
    if (comparable(field, current) === comparable(field, next)) {
      unchanged.push(field);
      continue;
    }
    if (isEstimate && !empty(current)) continue; // an estimate never replaces a value
    const no = product.fieldProvenance?.[field]?.declined;
    if (no && no.catalogueId === catalogueId && no.value === comparable(field, next)) {
      declined.push(field);
      continue;
    }
    const author = empty(current) ? "none" : authorOf(product, field);
    const conflict = author === "person" || author === "unknown";
    changes.push({
      field,
      old: empty(current) ? null : current,
      new: next,
      tier: prov?.tier || "C",
      ...(isEstimate ? { estimated: true, basis: prov.basis } : {}),
      quote: prov?.quote ?? null,
      page: prov?.page ?? block.page,
      conflict,
      reason: conflict ? (author === "person" ? "edited by a person after the import" : "entered before this catalogue was linked") : author === "none" ? "empty in the product" : author === "estimate" ? "replaces an estimate" : "the catalogue changed",
    });
  }
  return { changes, unchanged, declined, data, fieldProvenance };
}

async function loadVersion(versionId, companyScope) {
  const version = await prisma.catalogueVersion.findUnique({ where: { id: versionId }, include: { catalogue: true } });
  if (!version || (companyScope && version.companyId !== companyScope)) throw notFound("Catalogue version");
  return version;
}

/** GET /catalogue-versions/:id/diff */
export async function versionDiff(versionId, companyScope) {
  const version = await loadVersion(versionId, companyScope);
  const blocks = (await prisma.catalogueBlock.findMany({ where: { versionId }, orderBy: { seq: "asc" } })).filter(onReadPages(version));
  const mctx = await matchContext(version, blocks);
  const productIds = new Set();
  const items = [];
  const summary = { new: 0, changed: 0, unchanged: 0, ambiguous: 0, removed: 0, changedFields: 0, conflicts: 0, applied: 0, notExtracted: 0 };
  for (const b of blocks) {
    if (b.kind !== "product" || b.status === "rejected") continue;
    if (b.status === "applied") {
      summary.applied++;
      if (b.productId) productIds.add(b.productId);
      continue;
    }
    if (!b.extracted) {
      summary.notExtracted++;
      continue;
    }
    const name = b.extracted.manual?.name?.value ?? b.extracted.record?.name ?? b.title;
    const match = matchBlock(mctx, b);
    if (!match) {
      summary.new++;
      items.push({ blockId: b.id, page: b.page, name, kind: "new" });
      continue;
    }
    if (!match.productId || match.takenByBlockId) {
      summary.ambiguous++;
      items.push({ blockId: b.id, page: b.page, name, kind: "ambiguous", match });
      continue;
    }
    productIds.add(match.productId);
    const product = await prisma.product.findUnique({ where: { id: match.productId } });
    const { changes, unchanged, declined } = diffBlock(b, product, version.catalogueId);
    const kind = changes.length ? "changed" : "unchanged";
    summary[kind]++;
    summary.changedFields += changes.length;
    summary.conflicts += changes.filter((c) => c.conflict).length;
    items.push({ blockId: b.id, page: b.page, name, kind, product: { id: product.id, name: product.name, productCode: product.productCode, catalogueRef: product.catalogueRef }, matchedBy: match.by, changes, unchanged, declined, flags: b.extracted.flags || [] });
  }
  // linked to this catalogue (an earlier version) and matched by nothing in this one
  const removed = mctx.products
    .filter((p) => p.catalogueRef?.catalogueId === version.catalogueId && p.catalogueRef.catalogueVersionId !== versionId && !productIds.has(p.id))
    .map((p) => ({ productId: p.id, name: p.name, productCode: p.productCode, catalogueVersionId: p.catalogueRef.catalogueVersionId, page: p.catalogueRef.page ?? null }));
  summary.removed = removed.length;
  return { version: { id: version.id, label: version.label, status: version.status, catalogue: { id: version.catalogue.id, manufacturer: version.catalogue.manufacturer } }, summary, items, removed };
}

async function applyOne(block, { fields = null, productId = null } = {}, userId, mctx) {
  if (block.kind !== "product") throw new CertError("NOT_A_PRODUCT_BLOCK", "Only a product block can be applied", 409);
  if (block.status !== "pending") throw new CertError("BLOCK_DECIDED", `This block is already ${block.status}`, 409);
  const ex = block.extracted;
  if (!ex) throw new CertError("NOT_EXTRACTED", "This block has no extracted record yet", 409);
  if ((ex.flags || []).some((f) => f.code === "ambiguous_number")) throw new CertError("CONFIRM_NUMBER_CONVENTION", 'Confirm how this catalogue writes "." + three digits first', 409);
  const match = matchBlock(mctx, block);
  // the admin may pick one of several candidates; never a product outside them
  const candidates = match ? (match.productId ? [match.productId] : match.ambiguous) : [];
  const target = productId || match?.productId;
  if (!target || !candidates.includes(target)) throw new CertError(match ? "PICK_PRODUCT" : "NO_EXISTING_PRODUCT", match ? "Several products match this block — pick one (productId)" : "No existing product matches this block — accept it as a new product instead", 409, { match });
  const takenBy = mctx.taken.get(target);
  if (takenBy && takenBy !== block.id) throw new CertError("PRODUCT_TAKEN", "Another block of this catalogue version is already applied to that product", 409, { blockId: takenBy });
  const product = await prisma.product.findUnique({ where: { id: target } });
  const { changes, unchanged, fieldProvenance } = diffBlock(block, product, block.version.catalogueId);
  const byField = new Map(changes.map((c) => [c.field, c]));
  if (fields) {
    const unknown = fields.filter((f) => !byField.has(f));
    if (unknown.length) throw new CertError("NOT_A_CHANGE", `Not a change of this diff: ${unknown.join(", ")}`, 400, { fields: unknown });
  }
  // per product: every non-conflict change; per field: exactly the named ones (a conflict only when named)
  const chosen = fields ? fields.map((f) => byField.get(f)) : changes.filter((c) => !c.conflict);
  const at = new Date().toISOString();
  const data = {};
  const prov = { ...(product.fieldProvenance || {}) };
  for (const c of chosen) {
    data[c.field] = c.new;
    prov[c.field] = { ...fieldProvenance[c.field], at, appliedByUserId: userId, replacedValue: c.old ?? null };
  }
  // values the catalogue still prints unchanged now cite this version (a typed value stays the person's)
  for (const f of unchanged) if (fieldProvenance[f]?.tier === "C" && (!prov[f] || prov[f].tier === "C")) prov[f] = { ...fieldProvenance[f], at };
  const catalogueRef = catalogueRefOf({ ...block, version: { catalogueId: block.version.catalogueId } });
  const keptConflicts = changes.filter((c) => c.conflict && !chosen.includes(c)).map((c) => c.field);
  const skipped = changes.filter((c) => !chosen.includes(c)).map((c) => c.field);
  // not taken = declined: the product keeps its value (a legacy value becomes the person's)
  for (const c of changes.filter((x) => !chosen.includes(x))) {
    prov[c.field] = { ...(prov[c.field] || { tier: "manual", at }), declined: { catalogueId: block.version.catalogueId, catalogueVersionId: block.versionId, value: comparable(c.field, c.new), byUserId: userId, at } };
  }
  const updated = await prisma.$transaction(async (tx) => {
    const { count } = await tx.catalogueBlock.updateMany({
      where: { id: block.id, status: "pending" },
      data: { status: "applied", productId: target, extracted: { ...ex, diffApplied: { productId: target, fields: chosen.map((c) => c.field), skipped, keptConflicts, byUserId: userId, at } } },
    });
    if (count !== 1) throw new CertError("BLOCK_DECIDED", "This block was decided meanwhile", 409);
    return tx.product.update({ where: { id: target }, data: { ...data, catalogueRef, fieldProvenance: prov } });
  });
  mctx.taken.set(target, block.id);
  return { blockId: block.id, productId: target, applied: chosen.map((c) => c.field), skipped, keptConflicts, product: updated };
}

async function afterApply(version) {
  const pending = await prisma.catalogueBlock.count({ where: { versionId: version.id, kind: "product", status: "pending", ...(await readPagesWhere(version.id)) } });
  if (!pending) await prisma.catalogueVersion.update({ where: { id: version.id }, data: { status: "applied", appliedAt: new Date() } });
  await scheduleDictionaryRebuild(version.companyId);
}

/** POST /catalogue-blocks/:id/apply-diff { fields?, productId? } */
export async function applyBlockDiff(blockId, companyScope, body = {}, userId = null) {
  const block = await prisma.catalogueBlock.findUnique({ where: { id: blockId }, include: { version: { include: { catalogue: true } } } });
  if (!block || (companyScope && block.companyId !== companyScope)) throw notFound("Catalogue block");
  if (body.productId) {
    const p = await prisma.product.findUnique({ where: { id: body.productId }, select: { companyId: true } });
    if (!p || p.companyId !== block.companyId) throw notFound("Product");
  }
  const result = await applyOne(block, body, userId, await matchContext(block.version));
  await afterApply(block.version);
  return result;
}

/**
 * POST /catalogue-versions/:id/apply-diff — every block that matches one product,
 * has no flag and no conflict: its changes are applied (or, unchanged, it is just
 * linked). Conflicts, flagged and ambiguous blocks wait for a per-field decision.
 */
export async function applyVersionDiff(versionId, companyScope, userId = null) {
  const version = await loadVersion(versionId, companyScope);
  const blocks = await prisma.catalogueBlock.findMany({ where: { versionId, kind: "product", status: "pending" }, include: { version: { include: { catalogue: true } } }, orderBy: { seq: "asc" } });
  const mctx = await matchContext(version);
  const applied = [];
  const skipped = { new: 0, ambiguous: 0, flagged: 0, conflicts: 0, notExtracted: 0 };
  for (const b of blocks) {
    if (!b.extracted) {
      skipped.notExtracted++;
      continue;
    }
    const match = matchBlock(mctx, b);
    if (!match) {
      skipped.new++;
      continue;
    }
    if (!match.productId || match.takenByBlockId) {
      skipped.ambiguous++;
      continue;
    }
    if ((b.extracted.flags || []).length) {
      skipped.flagged++;
      continue;
    }
    const product = await prisma.product.findUnique({ where: { id: match.productId } });
    if (diffBlock(b, product, version.catalogueId).changes.some((c) => c.conflict)) {
      skipped.conflicts++;
      continue;
    }
    const r = await applyOne(b, {}, userId, mctx);
    applied.push({ blockId: r.blockId, productId: r.productId, fields: r.applied });
  }
  if (applied.length) await afterApply(version);
  return { applied: applied.length, changedFields: applied.reduce((n, a) => n + a.fields.length, 0), products: applied, skipped };
}
