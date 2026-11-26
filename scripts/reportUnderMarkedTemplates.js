// Read-only report (26 Nov production test): templates that still print unmarked batch /
// date / result / product text, and the certificates made from them. Nothing is changed or
// deleted — the owner decides what to do with each draft.
//   node scripts/reportUnderMarkedTemplates.js [--json] [--company <id>]
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { readinessOf } from "../src/services/certificates/templates/readinessService.js";

const json = process.argv.includes("--json");
const ci = process.argv.indexOf("--company");
const companyId = ci > 0 ? process.argv[ci + 1] : null;

const versions = await prisma.templateVersion.findMany({
  where: { status: { in: ["ready", "active", "superseded"] }, ...(companyId ? { template: { companyId } } : {}) },
  select: { id: true, templateId: true, versionNumber: true, status: true, lines: true, staticAreas: true, template: { select: { name: true, companyId: true, company: { select: { name: true } }, certificateType: { select: { code: true } } } } },
});

const report = [];
for (const v of versions) {
  const r = await readinessOf(v);
  if (r.ready) continue;
  const certs = await prisma.certificate.findMany({
    where: { templateVersionId: v.id },
    select: { id: true, status: true, createdAt: true, finalizedAt: true, product: { select: { name: true } }, invoice: { select: { origin: true, header: true } } },
    orderBy: { createdAt: "asc" },
  });
  report.push({
    company: v.template.company?.name,
    companyId: v.template.companyId,
    template: v.template.name,
    type: v.template.certificateType?.code,
    versionId: v.id,
    version: v.versionNumber,
    versionStatus: v.status,
    link: r.link,
    unmarked: r.areas.filter((a) => !a.staticConfirmed).map((a) => ({ label: a.label, kind: a.kind, text: a.text })),
    certificates: certs.map((c) => ({ id: c.id, status: c.status, product: c.product?.name || null, origin: c.invoice?.origin || "invoice", invoiceNo: c.invoice?.header?.invoiceNumber || null, createdAt: c.createdAt, finalizedAt: c.finalizedAt })),
  });
}

if (json) console.log(JSON.stringify(report, null, 1));
else {
  for (const t of report) {
    console.log(`\n${t.company} · ${t.type} · «${t.template}» v${t.version} (${t.versionStatus}) — ${t.link}`);
    console.log(`  unmarked: ${t.unmarked.map((a) => `${a.label} "${a.text}"`).join(" | ")}`);
    const drafts = t.certificates.filter((c) => c.status === "draft");
    const finals = t.certificates.filter((c) => c.status === "final");
    console.log(`  certificates: ${t.certificates.length} (${drafts.length} draft, ${finals.length} final${finals.length ? " — ALREADY APPROVED, check them" : ""})`);
    for (const c of t.certificates) console.log(`    ${c.id}  ${c.status.padEnd(7)} ${c.product || "(per invoice)"}  ${c.origin}${c.invoiceNo ? ` #${c.invoiceNo}` : ""}  ${c.createdAt.toISOString().slice(0, 10)}`);
  }
  const all = report.flatMap((t) => t.certificates);
  console.log(`\n${report.length} template version(s) not ready · ${all.length} certificate(s) made from them (${all.filter((c) => c.status === "draft").length} draft, ${all.filter((c) => c.status === "final").length} final). Nothing was changed.`);
}
await prisma.$disconnect();
