// T15/T16 (§17): the six approval gates, the promotion carousel, revocation,
// and company-scoped-by-default (Invariant #13). No AI involved anywhere in
// this phase — approval is a human action — so this runs live against a real
// server + DB with no quota dependency.
import { prisma } from "../src/lib/prisma.js";
import * as versionService from "../src/services/label/versioning/versionService.js";
import { validate } from "../src/services/label/validation/validationEngine.js";

const BASE_URL = "http://127.0.0.1:3000/api/v1";
const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

const baseLabelData = {
  schemaVersion: "vet-label@2.0.0", productType: "supplement",
  productName: { translations: { en: "ApprovalTest" }, primary: "en" }, pharmaceuticalForm: null, strength: null,
  feedClassification: { translations: { en: "Supplement" }, primary: "en" },
  activeIngredients: [{ translations: { en: "Vitamin C" }, primary: "en", amount: "10mg", unit: null, normalizedName: "vitamin c" }],
  excipients: [], analysis: null,
  targetAnimalSpecies: { translations: { en: "Dog" }, primary: "en", list: ["Dog"], source: "confirmed" },
  aimOfUse: { translations: { en: "Support" }, primary: "en" }, indications: [], routeOfAdministration: null,
  directionOfUse: { translations: { en: "1g/L" }, primary: "en" }, contraindications: null, warnings: [], sideEffects: null,
  withdrawalPeriod: null, userSafety: [], storage: { translations: { en: "Cool" }, primary: "en" }, shelfLifeAfterOpening: null,
  disposal: null, netWeight: { translations: { en: "1kg" }, primary: "en" }, packaging: null, registrationNumber: null,
  marketingAuthorisationHolder: null, manufacturer: null, importer: null, countryOfProduction: null, batchNo: null,
  productionDate: null, expiryDate: null, prescriptionStatus: "NA", usageDeclaration: [], keepOutOfReachOfChildren: true, estimatedFields: [],
};

async function seedLabel(company, overrides = {}) {
  const labelData = { ...baseLabelData, ...overrides.labelData };
  const report = await validate(labelData, { includePlausibility: false });
  const label = await versionService.createInitial({
    companyId: company.id, createdByUserId: "creator-user-id", inputPayload: {},
    labelData, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "Egypt", language: "ar",
    matchTier: "none", generationMeta: {},
  });
  await prisma.validationReport.create({
    data: { labelId: label.id, versionNumber: 1, passed: report.passed, errorCount: report.errorCount, warningCount: report.warningCount, verdicts: report.verdicts, engineVersion: report.engineVersion, rulesetIds: [] },
  });
  await prisma.generatedLabel.update({ where: { id: label.id }, data: { riskScore: overrides.riskScore ?? 10, autonomyTier: overrides.autonomyTier ?? "auto_approve" } });
  return { label, report };
}

async function run() {
  log("\n=== Phase 7: approval gates, promotion, revocation ===\n", "bold");

  const company = await prisma.company.create({ data: { name: `Approval Test Co ${Date.now()}`, username: `approval_test_${Date.now()}`, password: "x" } });
  const headers = { "x-test-bypass": "supersecretbypass", "x-bypass-type": "company", "x-bypass-id": company.id, "Content-Type": "application/json" };
  const cleanupLabelIds = [];
  const cleanupReferenceIds = [];

  // ── Gate 3: unacknowledged UNVERIFIABLE blocks approval ─────────────────────
  log("-- Gate 3: unacknowledged UNVERIFIABLE --", "cyan");
  const { label: l1 } = await seedLabel(company);
  cleanupLabelIds.push(l1.id);
  const noAckRes = await fetch(`${BASE_URL}/labels/${l1.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: [] }) });
  assert("Approval refused (422) when an UNVERIFIABLE verdict isn't acknowledged", noAckRes.status === 422);

  // ── Successful approval + promotion (§12.1/§12.3) ───────────────────────────
  log("\n-- Successful approval + promotion --", "cyan");
  const approveRes = await fetch(`${BASE_URL}/labels/${l1.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"], note: "test" }) });
  const approveData = await approveRes.json();
  assert("Approval succeeds (201) once acknowledged", approveRes.status === 201, approveData);
  assert("A LabelApproval was created", !!approveData.data?.approval?.id);
  assert("A reference was promoted", !!approveData.data?.reference?.id);
  assert("Promoted reference is company-scoped by DEFAULT, not global (Invariant #13)", approveData.data.reference.companyId === company.id);
  assert("Promoted reference carries the label's own structured activeIngredients (zero extraction)", approveData.data.reference.activeIngredients?.[0]?.normalizedName === "vitamin c");
  assert("Promoted reference is marked approved/quality 1.0-worthy", approveData.data.reference.isApproved === true);

  const labelAfterApprove = await prisma.generatedLabel.findUnique({ where: { id: l1.id } });
  assert("Label status is 'approved'", labelAfterApprove.status === "approved");
  cleanupReferenceIds.push(approveData.data.reference.id);

  // ── Re-approval of an already-approved version is refused ───────────────────
  log("\n-- Re-approval guard (found live, fixed) --", "cyan");
  const reapproveRes = await fetch(`${BASE_URL}/labels/${l1.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"] }) });
  assert("Re-approving an already-approved version is refused (409), not silently duplicated", reapproveRes.status === 409);
  const approvalsAfterReattempt = await prisma.labelApproval.count({ where: { labelId: l1.id } });
  assert("Exactly one LabelApproval exists — the refused re-attempt created nothing", approvalsAfterReattempt === 1);

  // ── Gate 4: unsigned estimated field blocks approval ────────────────────────
  log("\n-- Gate 4: unsigned estimated field --", "cyan");
  const { label: l2 } = await seedLabel(company, { labelData: { estimatedFields: ["directionOfUse"] } });
  cleanupLabelIds.push(l2.id);
  const unsignedRes = await fetch(`${BASE_URL}/labels/${l2.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"] }) });
  assert("Approval refused (422) when an estimated field isn't signed", unsignedRes.status === 422);
  const signedRes = await fetch(`${BASE_URL}/labels/${l2.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: ["directionOfUse"], acknowledgedUnverifiable: ["_regulatory"] }) });
  const signedData = await signedRes.json();
  assert("Approval succeeds once the estimated field is signed", signedRes.status === 201);
  if (signedData.data?.reference?.id) cleanupReferenceIds.push(signedData.data.reference.id);

  // ── Gate 5: separation of duties ─────────────────────────────────────────────
  log("\n-- Gate 5: separation of duties (high risk, self-approval) --", "cyan");
  const { label: l3 } = await seedLabel(company, { riskScore: 80 });
  cleanupLabelIds.push(l3.id);
  await prisma.generatedLabel.update({ where: { id: l3.id }, data: { createdByUserId: company.id } }); // company's own id doubles as its actor id
  const selfApproveRes = await fetch(`${BASE_URL}/labels/${l3.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"] }) });
  assert("High-risk label cannot be approved by its own creator (403)", selfApproveRes.status === 403);

  // ── Gate 5b: dual_review requires a second approver ─────────────────────────
  log("\n-- Gate 5: dual_review requires a second approver --", "cyan");
  const { label: l4 } = await seedLabel(company, { autonomyTier: "dual_review" });
  cleanupLabelIds.push(l4.id);
  const noSecondRes = await fetch(`${BASE_URL}/labels/${l4.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"] }) });
  assert("dual_review label without a second approver is refused (422)", noSecondRes.status === 422);
  const withSecondRes = await fetch(`${BASE_URL}/labels/${l4.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"], secondApproverUserId: "second-reviewer-id" }) });
  const withSecondData = await withSecondRes.json();
  assert("dual_review label WITH a second approver succeeds", withSecondRes.status === 201);
  if (withSecondData.data?.reference?.id) cleanupReferenceIds.push(withSecondData.data.reference.id);

  // ── Global scope requires a separate permission (Invariant #13) ────────────
  log("\n-- Global scope is a separate permission --", "cyan");
  const { label: l5 } = await seedLabel(company);
  cleanupLabelIds.push(l5.id);
  const globalAsCompanyRes = await fetch(`${BASE_URL}/labels/${l5.id}/approve`, { method: "POST", headers, body: JSON.stringify({ expectedVersion: 1, scope: "global", signedEstimatedFields: [], acknowledgedUnverifiable: ["_regulatory"] }) });
  assert("A company account can never promote globally (403), regardless of scope requested", globalAsCompanyRes.status === 403);

  // ── Revocation (§12.5) ───────────────────────────────────────────────────────
  log("\n-- Revocation --", "cyan");
  const approvalId = approveData.data.approval.id;
  const referenceId = approveData.data.reference.id;
  const revokeRes = await fetch(`${BASE_URL}/labels/${l1.id}/approvals/${approvalId}/revoke`, { method: "POST", headers, body: JSON.stringify({ reason: "found an error" }) });
  assert("Revocation succeeds (200)", revokeRes.status === 200);

  const labelAfterRevoke = await prisma.generatedLabel.findUnique({ where: { id: l1.id } });
  const referenceAfterRevoke = await prisma.referenceLabel.findUnique({ where: { id: referenceId } });
  assert("Label status becomes 'revoked'", labelAfterRevoke.status === "revoked");
  assert("Promoted reference still EXISTS (never deleted — history stays)", !!referenceAfterRevoke);
  assert("Promoted reference is no longer usable (isApproved: false)", referenceAfterRevoke.isApproved === false);

  const doubleRevokeRes = await fetch(`${BASE_URL}/labels/${l1.id}/approvals/${approvalId}/revoke`, { method: "POST", headers, body: JSON.stringify({ reason: "again" }) });
  assert("Revoking an already-revoked approval is refused (400), not silently repeated", doubleRevokeRes.status === 400);

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  await prisma.labelApproval.deleteMany({ where: { labelId: { in: cleanupLabelIds } } });
  await prisma.validationReport.deleteMany({ where: { labelId: { in: cleanupLabelIds } } });
  await prisma.referenceLabel.deleteMany({ where: { id: { in: cleanupReferenceIds } } });
  await prisma.generatedLabel.deleteMany({ where: { id: { in: cleanupLabelIds } } });
  await prisma.company.delete({ where: { id: company.id } });

  log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
