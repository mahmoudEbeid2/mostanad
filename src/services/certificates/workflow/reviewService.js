import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import { isBlocking } from "../generation/batchService.js";
import { finalize, duplicate } from "../certificates/editService.js";

// Review → authorization → approval (client workflow §5): a draft with nothing missing is sent to
// review; the reviewer passes it on for authorization or RETURNS it with a field-specific comment;
// the authorizer approves it (the existing finalize: a frozen PDF, who and when). An approved
// certificate never changes — a correction is a new revision that shows what changed.

const now = () => new Date().toISOString();

async function load(id, companyId) {
  const c = await prisma.certificate.findUnique({ where: { id } });
  if (!c || (companyId && c.companyId !== companyId)) throw notFound("Certificate");
  return c;
}

/** "3.5–4.5", "3.5 - 4.5", "90-110%", "NLT 95%", "≥ 90", "NMT 0.5%", "≤ 2" → { min?, max? } | null */
export function specRange(text) {
  const t = String(text || "").replace(/,/g, ".");
  let m = t.match(/(-?\d+(?:\.\d+)?)\s*%?\s*(?:–|—|-|to)\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  if ((m = t.match(/(?:NLT|not\s+less\s+than|≥|>=|min\.?)\s*(-?\d+(?:\.\d+)?)/i))) return { min: Number(m[1]) };
  if ((m = t.match(/(?:NMT|not\s+more\s+than|≤|<=|max\.?)\s*(-?\d+(?:\.\d+)?)/i))) return { max: Number(m[1]) };
  return null;
}
const numberIn = (v) => {
  const m = String(v ?? "").replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/**
 * GET /certificates/:id/review-checks — what the reviewer must look at: values still missing, and
 * results outside their specification (the recorded value is kept as it is, never "fixed").
 * → { missing: [{ field, label }], outOfSpec: [{ field, label, value, spec }], comments: [...] }
 */
export async function reviewChecks(id, companyId) {
  const c = await load(id, companyId);
  const [v, fields] = await Promise.all([
    c.currentVersion ? prisma.certificateVersion.findFirst({ where: { certificateId: id, versionNumber: c.currentVersion }, select: { values: true } }) : null,
    prisma.templateField.findMany({ where: { versionId: c.templateVersionId }, select: { key: true, label: true, specFieldKey: true, isLabResult: true } }),
  ]);
  const values = v?.values || {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const missing = Object.entries(values).filter(([, x]) => (x.flags || []).some(isBlocking)).map(([k]) => ({ field: k, label: byKey.get(k)?.label || k }));
  const outOfSpec = [];
  for (const f of fields.filter((x) => x.specFieldKey)) {
    const value = values[f.key]?.value;
    const spec = values[f.specFieldKey]?.value;
    const range = specRange(spec);
    const n = numberIn(value);
    if (!range || n === null) continue;
    if ((range.min !== undefined && n < range.min) || (range.max !== undefined && n > range.max)) outOfSpec.push({ field: f.key, label: f.label, value, spec });
  }
  return { status: c.status, reviewStatus: c.reviewStatus, missing, outOfSpec, comments: c.reviewComments || [] };
}

/**
 * POST /certificates/:id/review { action: submit | pass | return | authorize, field?, comment?, expectedVersion? }
 *   submit    draft (nothing missing) → in review
 *   pass      in review → awaiting authorization
 *   return    in review / awaiting authorization → back to the draft, with a comment on ONE field
 *   authorize awaiting authorization → approved (finalize)
 */
export async function reviewAction(id, companyId, userId, { action, field = null, comment = null, expectedVersion } = {}) {
  const c = await load(id, companyId);
  if (c.status === "final") throw new CertError("CERTIFICATE_FINAL", "This certificate is approved — revise it to change it", 409);
  if (c.status !== "draft") throw new CertError("CERTIFICATE_NOT_READY", `This certificate is ${c.status}`, 409);
  const comments = [...(c.reviewComments || [])];
  const set = (data) => prisma.certificate.update({ where: { id }, data });
  if (action === "submit") {
    if (c.flagCount > 0) {
      const checks = await reviewChecks(id, companyId);
      throw new CertError("CERTIFICATE_FLAGGED", `Fill ${checks.missing.map((m) => m.label).join(", ")} before sending it to review`, 409, { missing: checks.missing });
    }
    if (![null, "returned"].includes(c.reviewStatus)) throw new CertError("REVIEW_STATE", `It is ${c.reviewStatus} already`, 409);
    // the comments of a return are answered by this submit
    return set({ reviewStatus: "in_review", reviewComments: comments.map((x) => (x.resolvedAt ? x : { ...x, resolvedAt: now(), resolvedByUserId: userId })) });
  }
  if (action === "pass") {
    if (c.reviewStatus !== "in_review") throw new CertError("REVIEW_STATE", "Only a certificate in review can be passed", 409);
    return set({ reviewStatus: "awaiting_authorization", reviewComments: [...comments, { action: "passed", byUserId: userId, at: now() }] });
  }
  if (action === "return") {
    if (!["in_review", "awaiting_authorization"].includes(c.reviewStatus)) throw new CertError("REVIEW_STATE", "Only a certificate in review can be returned", 409);
    if (!field || !String(comment || "").trim()) throw new CertError("COMMENT_REQUIRED", "Say which field and what to correct", 400);
    return set({ reviewStatus: "returned", reviewComments: [...comments, { field, comment: String(comment).trim().slice(0, 1000), byUserId: userId, at: now(), resolvedAt: null }] });
  }
  if (action === "authorize") {
    if (c.reviewStatus !== "awaiting_authorization") throw new CertError("REVIEW_STATE", "Pass the review first", 409);
    await finalize(id, companyId, userId, { expectedVersion: expectedVersion ?? c.currentVersion });
    return set({ reviewStatus: null, reviewComments: [...comments, { action: "authorized", byUserId: userId, at: now() }] });
  }
  // Phase 3: a result outside its specification is approved only with a written reason, for this version
  if (action === "override_spec") {
    if (!String(comment || "").trim()) throw new CertError("COMMENT_REQUIRED", "اكتب سبب اعتماد النتيجة اللي برّا المواصفة", 400);
    const { outOfSpec } = await reviewChecks(id, companyId);
    if (!outOfSpec.length) throw new CertError("NOTHING_OUT_OF_SPEC", "No result is outside its specification", 409);
    return set({ reviewComments: [...comments, { action: "spec_override", fields: outOfSpec.map((o) => o.field), comment: String(comment).trim().slice(0, 1000), version: c.currentVersion, byUserId: userId, at: now() }] });
  }
  throw new CertError("UNKNOWN_ACTION", "action must be submit, pass, return, authorize or override_spec", 400);
}

/**
 * POST /certificates/:id/revise — an approved certificate whose inputs changed: a NEW draft revision
 * (n+1) of the same document; the approved one stays retrievable as it was.
 */
export async function revise(id, companyId, userId) {
  const c = await load(id, companyId);
  if (c.status !== "final") throw new CertError("CERTIFICATE_NOT_FINAL", "Only an approved certificate is revised (a draft is simply edited)", 409);
  const later = await prisma.certificate.findFirst({ where: { revisionOfId: id }, select: { id: true } });
  if (later) throw new CertError("ALREADY_REVISED", "This revision was already revised — open the newest one", 409, { certificateId: later.id });
  const copy = await duplicate(id, companyId, userId);
  const copyId = copy.id || copy.certificateId || copy.certificate?.id;
  return prisma.certificate.update({ where: { id: copyId }, data: { revisionOfId: id, revisionNumber: c.revisionNumber + 1 } });
}

/** GET /certificates/:id/changes — a revision vs the approved revision it came from: [{ field, before, after }] */
export async function changes(id, companyId) {
  const c = await load(id, companyId);
  if (!c.revisionOfId) return { revision: c.revisionNumber, of: null, changes: [] };
  const prev = await load(c.revisionOfId, companyId);
  const [a, b] = await Promise.all([
    prisma.certificateVersion.findFirst({ where: { certificateId: prev.id, versionNumber: prev.currentVersion }, select: { values: true } }),
    prisma.certificateVersion.findFirst({ where: { certificateId: id, versionNumber: c.currentVersion }, select: { values: true } }),
  ]);
  const show = (x) => (x?.kind === "group" ? JSON.stringify(x.rows) : x?.value ?? "");
  const keys = [...new Set([...Object.keys(a?.values || {}), ...Object.keys(b?.values || {})])];
  return { revision: c.revisionNumber, of: { id: prev.id, revision: prev.revisionNumber, finalizedAt: prev.finalizedAt }, changes: keys.filter((k) => show(a?.values?.[k]) !== show(b?.values?.[k])).map((k) => ({ field: k, before: show(a?.values?.[k]), after: show(b?.values?.[k]) })) };
}
