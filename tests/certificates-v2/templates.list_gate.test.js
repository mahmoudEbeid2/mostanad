// Certificates V2 — GET /certificate-templates card numbers (mockup A1:
// "8 fields · round-trip 0.018 %"). Each listed template carries `fieldCount`
// and `pixelDiffPct` of its active version, else of its latest `ready` one,
// both null otherwise. Additive: every field the list returned before is unchanged.
import { listTemplates } from "../../src/services/certificates/templates/templateService.js";
import { putFile } from "../../src/services/certificates/storage/fileStore.js";
import { api, asCompany, cleanupCompany, createCompany, finish, makeAssert, prisma } from "./helpers.js";

const { assert, counts } = makeAssert();
const company = await createCompany("list_gate");

try {
  const type = await prisma.certificateType.create({ data: { companyId: company.id, name: "Certificate of Analysis", code: "COA" } });
  const src = await putFile({ companyId: company.id, kind: "template_source", buffer: Buffer.from("%PDF-1.4\n"), mimeType: "application/pdf" });
  const template = (name, country) => prisma.certificateTemplate.create({ data: { companyId: company.id, certificateTypeId: type.id, name, country } });
  const version = async (templateId, versionNumber, status, { fields = 0, pct } = {}) => {
    const v = await prisma.templateVersion.create({
      data: { templateId, versionNumber, status, sourceFormat: "pdf", sourceFileId: src.id, prepareReport: pct === undefined ? undefined : { passed: true, pixelDiffPct: pct } },
    });
    for (let i = 0; i < fields; i++) {
      await prisma.templateField.create({ data: { versionId: v.id, key: `f${i}`, label: `F${i}`, lineId: `p1-l${i}`, charStart: 0, charEnd: 1, sampleValue: "x", source: { kind: "manual" } } });
    }
    return v;
  };

  // A: active v1 (3 fields, 0.0107 %) and a newer ready v2 (1 field) → the active one
  const a = await template("A active", "SA");
  const a1 = await version(a.id, 1, "active", { fields: 3, pct: 0.0107 });
  await version(a.id, 2, "ready", { fields: 1, pct: 0.02 });
  await prisma.certificateTemplate.update({ where: { id: a.id }, data: { activeVersionId: a1.id } });
  // B: no active version; v1 ready (2 fields), v2 ready (4 fields), v3 draft → the latest ready (v2)
  const b = await template("B ready", "EG");
  await version(b.id, 1, "ready", { fields: 2, pct: 0.03 });
  await version(b.id, 2, "ready", { fields: 4, pct: 0.0042 });
  await version(b.id, 3, "draft", { fields: 5 });
  // C: never passed the gate → null, null
  const c = await template("C draft", "JO");
  await version(c.id, 1, "draft", { fields: 2 });
  // D: active version whose report has no pixel number → fieldCount, pixelDiffPct null
  const d = await template("D no report", "AE");
  const d1 = await version(d.id, 1, "active", { fields: 1 });
  await prisma.certificateTemplate.update({ where: { id: d.id }, data: { activeVersionId: d1.id } });

  console.log("\n🧪 Service: fieldCount + pixelDiffPct per template");
  const { templates } = await listTemplates(company.id, {});
  const by = Object.fromEntries(templates.map((t) => [t.name, t]));
  assert("active version wins over a newer ready one (3 · 0.0107)", by["A active"].fieldCount === 3 && by["A active"].pixelDiffPct === 0.0107, by["A active"]);
  assert("no active → the latest ready version (4 · 0.0042)", by["B ready"].fieldCount === 4 && by["B ready"].pixelDiffPct === 0.0042, by["B ready"]);
  assert("never ready → both null", by["C draft"].fieldCount === null && by["C draft"].pixelDiffPct === null, by["C draft"]);
  assert("active without a pixel number → count, null", by["D no report"].fieldCount === 1 && by["D no report"].pixelDiffPct === null, by["D no report"]);

  console.log("\n🧪 Additive: the existing shape is unchanged");
  const summaryKeys = ["createdAt", "error", "hasThumbnail", "id", "sourceFormat", "status", "versionNumber"].join();
  assert("versions[] summaries keep exactly their keys (no _count leaked)", by["B ready"].versions.every((v) => Object.keys(v).sort().join() === summaryKeys), by["B ready"].versions[0]);
  assert("latestVersion / activeVersion unchanged", by["B ready"].latestVersion.versionNumber === 3 && by["B ready"].activeVersion === null && by["A active"].activeVersion.versionNumber === 1);
  assert("type + brand includes unchanged", by["A active"].certificateType.code === "COA" && by["A active"].brand === null);

  console.log("\n🧪 HTTP: GET /certificate-templates");
  const r = await api("GET", "/certificate-templates", asCompany(company.id));
  const http = Object.fromEntries((r.data?.data?.templates || []).map((t) => [t.name, t]));
  assert("200, 4 templates", r.status === 200 && r.data.total === 4, r.status);
  assert(
    "the API returns the same numbers",
    http["A active"]?.fieldCount === 3 && http["A active"].pixelDiffPct === 0.0107 && http["B ready"]?.pixelDiffPct === 0.0042 && http["C draft"]?.fieldCount === null && http["C draft"].pixelDiffPct === null,
    http["A active"]
  );
} finally {
  await finish(counts, () => cleanupCompany(company.id));
}
