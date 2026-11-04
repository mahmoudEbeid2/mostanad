import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";

// Company-scoped certificate catalogue ("COA", "Free Sale", …) — plan §4, §12.

const normCode = (code) => String(code).trim().toUpperCase();

async function load(id, companyId) {
  const row = await prisma.certificateType.findUnique({ where: { id } });
  if (!row || (companyId && row.companyId !== companyId)) throw notFound("Certificate type");
  return row;
}

/** Each type carries its active templates: `activeTemplates` (count) and `scopes`; a type with none can't make anything yet. */
export async function listTypes(companyId, { includeInactive = false } = {}) {
  const [types, templates] = await Promise.all([
    prisma.certificateType.findMany({
      where: { companyId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: { name: "asc" },
      include: { _count: { select: { templates: true } } },
    }),
    prisma.certificateTemplate.findMany({ where: { companyId, archivedAt: null, activeVersionId: { not: null } }, select: { certificateTypeId: true, scope: true } }),
  ]);
  return types.map((t) => {
    const own = templates.filter((x) => x.certificateTypeId === t.id);
    return { ...t, activeTemplates: own.length, scopes: [...new Set(own.map((x) => x.scope))] };
  });
}

/** A chosen list of types → the same ids once each; every id must be an active type of this company. null passes (all types). */
export async function assertChosenTypes(companyId, ids) {
  if (ids === null) return null;
  const unique = [...new Set(ids)];
  if (!unique.length) throw new CertError("NO_CERTIFICATE_TYPES", "Pick at least one certificate", 422);
  const found = await prisma.certificateType.count({ where: { id: { in: unique }, companyId, isActive: true } });
  if (found !== unique.length) throw new CertError("INVALID_CERTIFICATE_TYPE", "That isn't an active certificate type of this company", 422);
  return unique;
}

/** The company's saved choice, without types switched off since; nothing left = all types. → string[] | null */
export async function defaultTypes(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { defaultCertificateTypeIds: true } });
  const ids = company?.defaultCertificateTypeIds;
  if (!Array.isArray(ids) || !ids.length) return null;
  const rows = await prisma.certificateType.findMany({ where: { id: { in: ids }, companyId, isActive: true }, select: { id: true } });
  return rows.length ? ids.filter((id) => rows.some((r) => r.id === id)) : null;
}

export async function createType(companyId, { name, code, description }) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw notFound("Company");
  try {
    return await prisma.certificateType.create({
      data: { companyId, name: name.trim(), code: normCode(code), description: description || null },
    });
  } catch (err) {
    if (err.code === "P2002") throw new CertError("TYPE_CODE_TAKEN", `A certificate type with code "${normCode(code)}" already exists`, 409);
    throw err;
  }
}

export async function updateType(id, companyId, patch) {
  await load(id, companyId);
  const data = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.code !== undefined) data.code = normCode(patch.code);
  if (patch.description !== undefined) data.description = patch.description || null;
  if (patch.isActive !== undefined) data.isActive = patch.isActive;
  try {
    return await prisma.certificateType.update({ where: { id }, data });
  } catch (err) {
    if (err.code === "P2002") throw new CertError("TYPE_CODE_TAKEN", `A certificate type with code "${data.code}" already exists`, 409);
    throw err;
  }
}

/** Delete only when no template uses the type (plan §12). */
export async function deleteType(id, companyId) {
  await load(id, companyId);
  const used = await prisma.certificateTemplate.count({ where: { certificateTypeId: id } });
  if (used > 0) {
    throw new CertError("TYPE_IN_USE", `This type is used by ${used} template(s); archive or deactivate it instead`, 409, { templates: used });
  }
  await prisma.certificateType.delete({ where: { id } });
}

export const getType = load;
