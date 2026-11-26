import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";
import { findVariableAreas, describeOpen, KIND_AR } from "./readinessCheck.js";

// Template readiness (26 Nov production test): a design makes certificates only when every
// place that looks variable (batch, dates, results, composition, product data) is a marked
// field or a person confirmed it "static on purpose". Checked on activation, on every
// generation path (they all go through batchService.startGeneration) and on finalize.

const linkOf = (v) => `/certificates/templates/${v.templateId}/versions/${v.id}`;

/** A loaded version (lines, staticAreas, templateId) → { ready, areas, open, message, link } */
export async function readinessOf(version, { fields = null, groups = null } = {}) {
  const [fs, gs] = await Promise.all([
    fields || prisma.templateField.findMany({ where: { versionId: version.id }, select: { lineId: true, charStart: true, charEnd: true, groupKey: true } }),
    groups || prisma.templateGroup.findMany({ where: { versionId: version.id }, select: { key: true, sampleRows: true, footerY: true } }),
  ]);
  const confirmed = (Array.isArray(version.staticAreas) ? version.staticAreas : []).map((a) => a.id);
  const { ready, areas } = findVariableAreas(version.lines || [], fs, { groups: gs, confirmed });
  const open = areas.filter((a) => !a.staticConfirmed);
  return {
    ready,
    areas: areas.map((a) => ({ ...a, kindAr: KIND_AR[a.kind] })),
    open: open.length,
    message: ready ? null : `القالب ده لسه فيه أماكن متغيرة مش متحددة: ${describeOpen(areas)} — حددها كحقول أو أكّد إنها ثابتة`,
    link: linkOf(version),
  };
}

async function loadForReadiness(versionId, companyId = null) {
  const v = await prisma.templateVersion.findUnique({ where: { id: versionId }, select: { id: true, templateId: true, lines: true, staticAreas: true, template: { select: { companyId: true, name: true } } } });
  if (!v || (companyId && v.template.companyId !== companyId)) throw notFound("Template version");
  return v;
}

/** GET /template-versions/:id/readiness */
export async function getReadiness(versionId, companyId) {
  return readinessOf(await loadForReadiness(versionId, companyId));
}

/** Throws TEMPLATE_NOT_READY (409) with the open areas when the version isn't ready. */
export async function assertReady(versionId, companyId = null) {
  const v = await loadForReadiness(versionId, companyId);
  const r = await readinessOf(v);
  if (r.ready) return r;
  throw new CertError("TEMPLATE_NOT_READY", `«${v.template.name}»: ${r.message}`, 409, { versionId, templateId: v.templateId, template: v.template.name, link: r.link, areas: r.areas.filter((a) => !a.staticConfirmed) });
}

/** Every version of a generation plan → throws for the first that isn't ready (all of them listed). */
export async function assertVersionsReady(versionIds) {
  const notReady = [];
  for (const id of [...new Set(versionIds)]) {
    try {
      await assertReady(id);
    } catch (err) {
      if (err.code !== "TEMPLATE_NOT_READY") throw err;
      notReady.push({ ...err.extra, message: err.message });
    }
  }
  if (notReady.length) throw new CertError("TEMPLATE_NOT_READY", notReady.map((n) => n.message).join(" · "), 409, { templates: notReady, ...notReady[0] });
}

/** Non-throwing: versionId → readiness, for plans and previews. */
export async function readinessMap(versionIds) {
  const out = {};
  for (const id of [...new Set(versionIds)]) out[id] = await readinessOf(await loadForReadiness(id));
  return out;
}

/**
 * POST /template-versions/:id/static-areas { ids, static: true|false } — a person says these
 * places print the same text on every certificate (or takes that back). Only areas the check
 * currently finds can be confirmed; who and when is kept.
 */
export async function setStaticAreas(versionId, companyId, { ids = [], isStatic = true } = {}, userId = null) {
  const v = await loadForReadiness(versionId, companyId);
  const r = await readinessOf(v);
  const byId = new Map(r.areas.map((a) => [a.id, a]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) throw new CertError("UNKNOWN_AREA", `Not a variable place of this design: ${unknown.join(", ")}`, 422, { unknown });
  let list = (Array.isArray(v.staticAreas) ? v.staticAreas : []).filter((a) => !ids.includes(a.id));
  if (isStatic) list = [...list, ...ids.map((id) => ({ id, text: byId.get(id).text, kind: byId.get(id).kind, byUserId: userId, at: new Date().toISOString() }))];
  await prisma.templateVersion.update({ where: { id: versionId }, data: { staticAreas: list } });
  return readinessOf({ ...v, staticAreas: list });
}
