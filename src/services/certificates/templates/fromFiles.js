import { prisma } from "../../../lib/prisma.js";
import { CertError } from "../errors.js";
import { createType } from "../types/certificateTypeService.js";
import { createTemplateFromUpload, uploadNewVersion, detectSourceFormat } from "./templateService.js";

// A company's own certificate files (client report 24 Nov: MAXVET FSC.pdf,
// COC.pdf, HC.pdf, COA.pdf — "these are MAXVET's certificates") turned into
// certificate templates: each file → its certificate type (created for the
// company when missing) → the existing template upload (pdf2htmlEX convert job)
// → a draft version whose fields the person marks next. A slot that already
// has a template (same type, brand, country) gets the file as a new draft
// version instead. Nothing is activated here.

/** The certificate types a file name can name. COO and COC are one kind of document for the client. */
export const KNOWN_TYPES = {
  FSC: { name: "Free Sale Certificate", also: [] },
  COA: { name: "Certificate of Analysis", also: [] },
  HC: { name: "Health Certificate", also: [] },
  COO: { name: "Certificate of Origin", also: ["COC"] },
  COC: { name: "Certificate of Conformity", also: ["COO"] },
  GMP: { name: "Good Manufacturing Practice Certificate", also: [] },
  ISO: { name: "ISO Certificate", also: [] },
};
const WORDS = [
  [/free\s*sale/i, "FSC"],
  [/analysis/i, "COA"],
  [/health/i, "HC"],
  [/origin/i, "COO"],
  [/conformity|compliance/i, "COC"],
];

/** "MAXVET COA.pdf" → "COA"; null when the name doesn't say. */
export function typeCodeFromName(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  const tokens = base.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const hits = [...new Set(tokens.filter((t) => KNOWN_TYPES[t]))];
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return null; // "COA and FSC" — ask
  for (const [re, code] of WORDS) if (re.test(base)) return code;
  return null;
}

/** The company's type for a code: the code itself, else its alias (COO ⇄ COC). → type | null */
async function findType(companyId, code) {
  const types = await prisma.certificateType.findMany({ where: { companyId, isActive: true }, select: { id: true, code: true, name: true } });
  const want = [code, ...(KNOWN_TYPES[code]?.also || [])];
  for (const c of want) {
    const t = types.find((x) => x.code.toUpperCase() === c);
    if (t) return t;
  }
  return null;
}

/**
 * The plan, nothing saved. files: [{ name, code? }] (code: the person's choice,
 * else read from the file name). → [{ name, code, type: { id, code, name } | null, createType: bool, slot: "new" | "new_version", templateId?, problem? }]
 */
export async function planTemplatesFromFiles(companyId, files, { brandId = null, country = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const code = (f.code || typeCodeFromName(f.name) || "").toUpperCase() || null;
    if (!code) {
      out.push({ name: f.name, code: null, type: null, createType: false, slot: null, problem: "the file name doesn't say which certificate it is (FSC, COO/COC, HC, COA…) — ask" });
      continue;
    }
    const type = await findType(companyId, code);
    const key = `${type?.id || code}`;
    if (seen.has(key)) {
      out.push({ name: f.name, code, type, createType: false, slot: null, problem: `another file in this batch is already the ${code} template — one file per certificate type` });
      continue;
    }
    seen.add(key);
    const existing = type ? await prisma.certificateTemplate.findFirst({ where: { companyId, certificateTypeId: type.id, brandId: brandId || null, country: country || null, scope: "per_product", archivedAt: null }, select: { id: true, name: true } }) : null;
    out.push({ name: f.name, code: type?.code || code, type, createType: !type, slot: existing ? "new_version" : "new", templateId: existing?.id || null, templateName: existing?.name || null });
  }
  return out;
}

/**
 * Runs the plan: types created where missing, each file uploaded (new template,
 * or a new draft version of the slot's template). files: [{ file (multer shape), code? }].
 * → [{ name, code, typeId, typeCreated, templateId, versionId, taskId, link }]
 */
export async function createTemplatesFromFiles({ companyId, userId = null, files, brandId = null, country = null }) {
  const brand = brandId ? await prisma.brand.findFirst({ where: { id: brandId, companyId }, select: { id: true, name: true } }) : null;
  if (brandId && !brand) throw new CertError("NOT_FOUND", "Brand not found!", 404);
  for (const f of files) detectSourceFormat(f.file.originalname, f.file.buffer); // a file that can't be a template stops the whole card before anything is saved
  const plan = await planTemplatesFromFiles(companyId, files.map((f) => ({ name: f.file.originalname, code: f.code })), { brandId, country });
  const bad = plan.filter((p) => p.problem);
  if (bad.length) throw new CertError("TEMPLATE_FILES", bad.map((p) => `${p.name}: ${p.problem}`).join("; "), 400);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const p = plan[i];
    let type = p.type;
    let typeCreated = false;
    if (!type) {
      type = await createType(companyId, { name: KNOWN_TYPES[p.code]?.name || p.code, code: p.code });
      typeCreated = true;
    }
    const out =
      p.slot === "new_version"
        ? await uploadNewVersion({ templateId: p.templateId, companyId, userId, file: files[i].file })
        : await createTemplateFromUpload({ companyId, userId, file: files[i].file, settings: { certificateTypeId: type.id, brandId: brand?.id || null, country: country || null, scope: "per_product", name: `${brand ? `${brand.name} ` : ""}${type.code}` } });
    results.push({ name: p.name, code: type.code, typeId: type.id, typeCreated, newVersion: p.slot === "new_version", templateId: out.templateId, versionId: out.versionId, taskId: out.taskId, link: `/certificates/templates/${out.templateId}/versions/${out.versionId}` });
  }
  return results;
}
