// Covers T9/T11/T12 from MOSTANAD_ARCHITECTURE.md §17 in one file (consolidated —
// the underlying logic is one pipeline, see PROGRESS.md's Phase 3 entry for why).
// Tests the DETERMINISTIC parts of Phase 3 directly (no Gemini call, no quota
// needed): hash-based duplicate detection, citation-verification rejection,
// unknown-targetPath rejection, unknown-constraint-kind rejection, the
// NO_AUTHORITATIVE_REQUIREMENTS/UNVERIFIABLE fallback, coverage math, and the
// 95% approval gate. The AI-dependent steps (ruleCompiler.compile,
// coverageAuditor.auditDocument actually calling Gemini) are exercised
// separately via the live fixture upload — see PROGRESS.md for what that
// proved vs. what's blocked by quota.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prisma } from "../src/lib/prisma.js";
import * as regulatoryDocumentService from "../src/services/label/regulatory/regulatoryDocumentService.js";
import { validateProposedRule, citationExistsVerbatim, isValidTargetPath } from "../src/services/label/regulatory/ruleCompiler.js";
import { computeCoverage, MINIMUM_COVERAGE_PERCENT_FOR_APPROVAL } from "../src/services/label/regulatory/coverageAuditor.js";
import { run as runRules } from "../src/services/label/validation/ruleValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_TEXT = fs.readFileSync(path.join(__dirname, "..", "fixtures", "regulatory", "synthetic-authority-fixture.txt"), "utf-8");

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

async function run() {
  log("\n=== Regulatory ingestion pipeline (T9/T11/T12) ===\n", "bold");
  const createdDocumentIds = [];

  // ── T11: hash-based duplicate detection ───────────────────────────────────
  log("-- Duplicate hash detection --", "cyan");
  const doc1 = await regulatoryDocumentService.createFromExtraction({
    title: "Fictional Veterinary Labeling Guide (test)",
    authority: "FAHA",
    country: "Fictionland",
    extractedText: FIXTURE_TEXT,
  });
  createdDocumentIds.push(doc1.id);
  assert("First upload creates a document", !!doc1.id);
  assert("documentHash computed", !!doc1.documentHash);
  assert("status is 'extracted'", doc1.status === "extracted");

  let duplicateRejected = false;
  try {
    await regulatoryDocumentService.createFromExtraction({ country: "Fictionland", extractedText: FIXTURE_TEXT });
  } catch (err) {
    duplicateRejected = err.statusCode === 409;
  }
  assert("Re-uploading identical text is refused (409)", duplicateRejected);

  // ── T11: citation verification ─────────────────────────────────────────────
  log("\n-- Citation verification (§7.4's own rule) --", "cyan");
  assert(
    "Verbatim citation from the fixture is accepted",
    citationExistsVerbatim("If the product's target animal species includes Cattle, Sheep, Goat, or Poultry, the label must state a withdrawal period", FIXTURE_TEXT)
  );
  assert(
    "A fabricated citation not in the document is rejected",
    !citationExistsVerbatim("The product must be stored at exactly negative forty degrees at all times", FIXTURE_TEXT)
  );

  const goodConditionalRule = {
    ruleKey: "FICT.VET.WITHDRAWAL.CONDITIONAL",
    ruleType: "conditional",
    severity: "error",
    targetPath: "withdrawalPeriod",
    constraint: {
      kind: "conditional",
      when: { path: "targetAnimalSpecies.list", anyOf: ["Cattle", "Sheep", "Goat", "Poultry"] },
      then: { kind: "required_field", path: "withdrawalPeriod" },
    },
    description: "Withdrawal period required for food-producing species.",
    citation: "If the product's target animal species includes Cattle, Sheep, Goat, or Poultry, the label must state a withdrawal period",
    confidence: 0.95,
  };
  assert("Valid conditional rule (real citation, valid targetPath) is accepted", validateProposedRule(goodConditionalRule, FIXTURE_TEXT).ok === true);

  const goodForbiddenContentRule = {
    ruleKey: "FICT.CLAIMS.NO_CURE",
    ruleType: "forbidden_content",
    severity: "error",
    targetPath: "aimOfUse",
    constraint: { kind: "forbidden_content", path: "aimOfUse", patterns: ["\\bcures?\\b", "\\btreats?\\b", "يعالج"], flags: "i" },
    description: "Feed additives must not claim to cure or treat disease.",
    citation: 'Feed additives and supplements must not use the words "cures", "treats", "heals"',
    confidence: 0.9,
  };
  assert("Valid forbidden_content rule is accepted", validateProposedRule(goodForbiddenContentRule, FIXTURE_TEXT).ok === true);

  const missingConfidenceRule = { ...goodConditionalRule, ruleKey: "FICT.BAD.NOCONFIDENCE", confidence: undefined };
  assert("Rule with no confidence is REJECTED", validateProposedRule(missingConfidenceRule, FIXTURE_TEXT).ok === false);

  const badCitationRule = { ...goodConditionalRule, ruleKey: "FICT.BAD.CITATION", citation: "This sentence does not appear anywhere in the fixture document." };
  const badCitationResult = validateProposedRule(badCitationRule, FIXTURE_TEXT);
  assert("Rule with a citation NOT found verbatim is REJECTED", badCitationResult.ok === false);
  assert("Rejection reason mentions citation", badCitationResult.reason.toLowerCase().includes("citation"));

  const badTargetPathRule = { ...goodConditionalRule, ruleKey: "FICT.BAD.TARGETPATH", targetPath: "someFieldThatDoesNotExist" };
  const badTargetPathResult = validateProposedRule(badTargetPathRule, FIXTURE_TEXT);
  assert("Rule with an unknown targetPath is REJECTED", badTargetPathResult.ok === false);
  assert("isValidTargetPath correctly rejects unknown field", !isValidTargetPath("someFieldThatDoesNotExist"));
  assert("isValidTargetPath correctly accepts a real labelSchema field", isValidTargetPath("withdrawalPeriod"));
  assert("isValidTargetPath accepts a real nested path (checks top segment)", isValidTargetPath("targetAnimalSpecies.list"));

  const badKindRule = { ...goodConditionalRule, ruleKey: "FICT.BAD.KIND", constraint: { kind: "made_up_kind" } };
  assert("Rule with an unsupported constraint.kind is REJECTED", validateProposedRule(badKindRule, FIXTURE_TEXT).ok === false);

  // ── T9: no rules yet -> UNVERIFIABLE, never a silent PASS ───────────────────
  log("\n-- No-authoritative-requirements fallback (§7.1 case 4) --", "cyan");
  const emptyRulesVerdicts = runRules({ aimOfUse: { translations: { en: "test" }, primary: "en" } }, []);
  assert("Empty rules array produces exactly one UNVERIFIABLE verdict, not silence", emptyRulesVerdicts.length === 1 && emptyRulesVerdicts[0].status === "UNVERIFIABLE");
  assert("That verdict is NOT coerced to PASS", emptyRulesVerdicts[0].status !== "PASS");

  // ── Approved rule actually fires via ruleValidator ──────────────────────────
  log("\n-- Compiled rule actually fires in validationEngine's ruleValidator --", "cyan");
  const labelWithCattleNoWithdrawal = {
    targetAnimalSpecies: { translations: { en: "Cattle" }, primary: "en", list: ["Cattle"], source: "confirmed" },
    withdrawalPeriod: null,
  };
  const fireVerdicts = runRules(labelWithCattleNoWithdrawal, [{ ...goodConditionalRule, id: "r1" }]);
  assert("Conditional rule fires FAIL when species matches and field is missing", fireVerdicts.some((v) => v.ruleKey === "FICT.VET.WITHDRAWAL.CONDITIONAL" && v.status === "FAIL"));

  const labelWithDogNoWithdrawal = {
    targetAnimalSpecies: { translations: { en: "Dog" }, primary: "en", list: ["Dog"], source: "confirmed" },
    withdrawalPeriod: null,
  };
  const noFireVerdicts = runRules(labelWithDogNoWithdrawal, [{ ...goodConditionalRule, id: "r1" }]);
  assert("Conditional rule does NOT fire for a non-listed species (exempt per clause 2.3)", !noFireVerdicts.some((v) => v.ruleKey === "FICT.VET.WITHDRAWAL.CONDITIONAL"));

  // ── T12: coverage math + automatic activation (decision 1) ─────────────────
  log("\n-- Coverage computation + automatic activation, severity not access (§7.5 + decision 1) --", "cyan");
  const fullCoverage = computeCoverage(14, [
    { reference: "1.1", isNormative: true, coveredByRuleKey: "R1" },
    { reference: "PREAMBLE", isNormative: false, coveredByRuleKey: null },
    { reference: "APPENDIX A", isNormative: false, coveredByRuleKey: null },
  ]);
  assert("Non-normative clauses (preamble/appendix) never count toward clauseTotal", fullCoverage.clauseTotal === 14);
  assert("100% coverage when nothing normative is uncovered", fullCoverage.coveragePercent === 100);

  const partialCoverage = computeCoverage(10, [
    { reference: "2.2", isNormative: true, coveredByRuleKey: null, reasonIfUncovered: "conditional clause missed" },
    { reference: "PREAMBLE", isNormative: false, coveredByRuleKey: null },
  ]);
  assert("Uncovered normative clause reduces coveragePercent below 100", partialCoverage.coveragePercent < 100);
  assert("uncoveredClauses lists the missed clause with its reference", partialCoverage.uncoveredClauses.some((c) => c.reference === "2.2"));
  assert(`Below ${MINIMUM_COVERAGE_PERCENT_FOR_APPROVAL}% is correctly identified as below the gate`, partialCoverage.coveragePercent < MINIMUM_COVERAGE_PERCENT_FOR_APPROVAL);

  await prisma.regulatoryDocument.update({ where: { id: doc1.id }, data: { clauseTotal: partialCoverage.clauseTotal, clauseCovered: partialCoverage.clauseCovered, coveragePercent: partialCoverage.coveragePercent, uncoveredClauses: partialCoverage.uncoveredClauses, coverageAuditedAt: new Date() } });

  // Decision 1: no human gate stands — below-threshold coverage still
  // ACTIVATES the document (status "approved"), it just sets activationMode
  // to "partial" so ruleValidator ceilings every FAIL from it to NEEDS_REVIEW.
  const partiallyActivated = await regulatoryDocumentService.approveDocument(doc1.id);
  assert("approveDocument ACTIVATES below-95%-coverage documents rather than refusing them", partiallyActivated.status === "approved");
  assert("...but marks activationMode 'partial'", partiallyActivated.activationMode === "partial");

  await regulatoryDocumentService.markClauseNonNormative(doc1.id, "2.2");
  const afterClear = await prisma.regulatoryDocument.findUnique({ where: { id: doc1.id } });
  assert("markClauseNonNormative removes the cleared clause from uncoveredClauses", afterClear.uncoveredClauses.length === 0);

  const approved = await regulatoryDocumentService.approveDocument(doc1.id, "test-user-id");
  assert("approveDocument still SUCCEEDS once all uncovered clauses are cleared", approved.status === "approved");
  assert("...now at full activationMode", approved.activationMode === "full");
  assert("reviewedByUserId recorded", approved.reviewedByUserId === "test-user-id");

  let unauditedBlocked = false;
  const doc2 = await regulatoryDocumentService.createFromExtraction({ country: "Fictionland", extractedText: FIXTURE_TEXT + "\nEXTRA UNIQUE LINE TO CHANGE THE HASH." });
  createdDocumentIds.push(doc2.id);
  try {
    await regulatoryDocumentService.approveDocument(doc2.id);
  } catch (err) {
    unauditedBlocked = err.statusCode === 400;
  }
  assert("approveDocument REFUSES a document that was never coverage-audited", unauditedBlocked);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  log("\nCleaning up...", "cyan");
  await prisma.regulatoryRule.deleteMany({ where: { documentId: { in: createdDocumentIds } } });
  await prisma.regulatoryDocument.deleteMany({ where: { id: { in: createdDocumentIds } } });

  log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
