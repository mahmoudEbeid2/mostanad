// Covers the ingestion-overhaul additions that regulatory.ingestion.test.js
// doesn't: deterministic slugs + citation-verbatim discard (catalogExtractor),
// composer collision/discriminant-filtering/tenant-scoping (composer.js), the
// new/extended rule types (numeric_threshold, enumerated_values,
// external_match, forbidden_content's allow-list), the severity-downgrade
// ceiling (§7a confidence, decision-1 partial coverage), and the statistical
// downgrade tracker (§7b). No live Gemini calls — catalogs/rules are
// hand-built the same shape the real pipeline would produce, since
// slugify/citationSliceMatches/ruleValidator/composer are all pure/DB-only.
import crypto from "crypto";
import { prisma } from "../src/lib/prisma.js";
import { slugify, citationSliceMatches, locateCitation } from "../src/services/label/regulatory/catalogExtractor.js";
import { buildLabelSchema } from "../src/services/label/schema/composer.js";
import { run as runRules } from "../src/services/label/validation/ruleValidator.js";
import { recordOutcomes, serializeDiscriminants } from "../src/services/label/regulatory/ruleOutcomeTracker.js";
import { RULE_TYPE_TO_CONSTRAINT_KIND } from "../src/services/label/regulatory/ruleCompiler.js";

const colors = { green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (msg, color = "") => console.log(color ? `${colors[color]}${msg}${colors.reset}` : msg);
let passed = 0, failed = 0;
function assert(label, condition, details = "") {
  if (condition) { log(`  PASS: ${label}`, "green"); passed++; }
  else { log(`  FAIL: ${label}`, "red"); if (details) log(`     -> ${JSON.stringify(details)}`); failed++; }
}

const COUNTRY = "Fictionland-Catalog";

function citationFor(text, quote) {
  const startIndex = text.indexOf(quote);
  if (startIndex === -1) throw new Error(`test fixture bug: quote not found in text: "${quote}"`);
  return { section: "test", quote, startIndex, endIndex: startIndex + quote.length };
}

async function run() {
  log("\n=== Catalog extraction, composer, and rule-engine extensions ===\n", "bold");
  const cleanup = { companies: [], documents: [] };

  // ── Deterministic slugs ──────────────────────────────────────────────────
  log("-- Deterministic, script-agnostic slugs --", "cyan");
  assert("Same English text always slugifies identically", slugify("Batch Identification Code") === slugify("Batch Identification Code"));
  assert("Slug is lowercase, non-alnum collapsed to underscore", slugify("Batch Identification Code") === "batch_identification_code");
  assert("Arabic text slugifies deterministically without throwing", slugify("رقم التسجيل") === slugify("رقم التسجيل") && slugify("رقم التسجيل").length > 0);
  assert("Different wording produces a different slug", slugify("Batch Number") !== slugify("Expiry Date"));
  assert("Empty/garbage input never throws and never returns an empty string", slugify("!!!") === "field" && slugify("") === "field");

  // ── Citation-verbatim discard (§2's hard rule) ──────────────────────────
  log("\n-- Citation slice must match exactly, or the entry is discarded --", "cyan");
  const text = "The product shall state a withdrawal period of at least 7 days for food-producing species.";
  const goodCitation = citationFor(text, "withdrawal period of at least 7 days");
  assert("Exact slice match is accepted", citationSliceMatches(text, goodCitation));
  assert("Off-by-one startIndex is discarded, not tolerated", !citationSliceMatches(text, { ...goodCitation, startIndex: goodCitation.startIndex + 1 }));
  assert("A quote that doesn't match the slice at all is discarded", !citationSliceMatches(text, { ...goodCitation, quote: "something else entirely" }));
  assert("Out-of-bounds indices are discarded, not thrown", !citationSliceMatches(text, { quote: "x", startIndex: 9999, endIndex: 10000 }));
  assert("Missing citation fields are discarded", !citationSliceMatches(text, null) && !citationSliceMatches(text, {}));

  log("\n-- locateCitation: what the live pipeline actually uses (verify quote, compute index ourselves) --", "cyan");
  // Live-verified 2026-09-13: Gemini's self-reported startIndex/endIndex on
  // its own long output are not trustworthy (drift grows through the
  // document). locateCitation never trusts them — it looks the quote up
  // itself and returns the REAL offset, discarding only when the quote
  // genuinely isn't a substring of text at all.
  const wrongIndexCitation = { section: "test", quote: "withdrawal period of at least 7 days", startIndex: 9999, endIndex: 10036 };
  const repaired = locateCitation(text, wrongIndexCitation);
  assert("A citation with a WRONG self-reported index is still located (not discarded)", repaired !== null);
  assert("locateCitation computes the REAL index, ignoring the model's claimed one", repaired && repaired.startIndex === text.indexOf("withdrawal period of at least 7 days"));
  assert("The recomputed slice matches the quote exactly", repaired && text.slice(repaired.startIndex, repaired.endIndex) === repaired.quote);

  const fabricatedCitation = { section: "test", quote: "this text does not exist anywhere in the document", startIndex: 0, endIndex: 10 };
  assert("A quote that doesn't exist anywhere is still discarded, even with locateCitation's leniency", locateCitation(text, fabricatedCitation) === null);
  assert("Missing/empty quote is discarded", locateCitation(text, null) === null && locateCitation(text, { quote: "" }) === null);

  // ── Six rule types (§4) ──────────────────────────────────────────────────
  log("\n-- Six rule types map onto ruleValidator's constraint kinds --", "cyan");
  assert(
    "Section-4 names map onto the engine's constraint.kind vocabulary in one documented place",
    RULE_TYPE_TO_CONSTRAINT_KIND.prohibited_phrase === "forbidden_content" &&
      RULE_TYPE_TO_CONSTRAINT_KIND.required_languages === "language_set" &&
      RULE_TYPE_TO_CONSTRAINT_KIND.numeric_threshold === "numeric_threshold" &&
      RULE_TYPE_TO_CONSTRAINT_KIND.enumerated_values === "enumerated_values" &&
      RULE_TYPE_TO_CONSTRAINT_KIND.external_match === "external_match"
  );

  log("\n-- forbidden_content with a paired allow-list --", "cyan");
  // Two disjoint deny terms (never allow-listed) plus one deny pattern broad
  // enough to ALSO match an explicitly allow-listed exception — this exercises
  // the actual exemption logic (an allow match on the SAME matched substring
  // overrides the deny hit), not just "the allow-list is present but unused".
  const allowListRule = {
    id: "allow1", ruleKey: "FICT.FEED.NO_VEGETABLE_OIL", severity: "error", targetPath: "excipients",
    constraint: {
      kind: "forbidden_content", path: "excipients", flags: "i",
      patterns: ["\\bvegetable oils?\\b", "\\bmeat derivatives?\\b", "\\b\\w+\\s+grains?\\b"],
      allow: ["\\bsecondary grains?\\b"],
    },
    description: "Vegetable oils, meat derivatives, and non-secondary grains are prohibited; secondary grains are explicitly accepted.",
  };
  const deniedLabel = { excipients: [{ translations: { en: "contains vegetable oil as a carrier" }, primary: "en" }] };
  const deniedVerdicts = runRules(deniedLabel, [allowListRule]);
  assert("A genuinely forbidden phrase still fails", deniedVerdicts.some((v) => v.ruleKey === allowListRule.ruleKey && v.status === "FAIL"));

  const otherGrainsLabel = { excipients: [{ translations: { en: "made from imported grains" }, primary: "en" }] };
  const otherGrainsVerdicts = runRules(otherGrainsLabel, [allowListRule]);
  assert("A deny-pattern match that is NOT on the allow-list still fails, even though it's the same word family as the allowed term", otherGrainsVerdicts.some((v) => v.status === "FAIL"));

  const allowedLabel = { excipients: [{ translations: { en: "made from secondary grains only" }, primary: "en" }] };
  const allowedVerdicts = runRules(allowedLabel, [allowListRule]);
  assert("The SAME deny pattern's match is exempted when it lands on an allow-listed phrase", allowedVerdicts.every((v) => v.status !== "FAIL"));

  log("\n-- numeric_threshold --", "cyan");
  const thresholdRule = {
    id: "nt1", ruleKey: "FICT.FEED.MIN_WITHDRAWAL_DAYS", severity: "error", targetPath: "withdrawalPeriod",
    constraint: { kind: "numeric_threshold", path: "withdrawalPeriod", operator: ">=", bound: 5, unit: "days" },
    description: "Withdrawal period must be at least 5 days.",
  };
  const belowThreshold = runRules({ withdrawalPeriod: { translations: { en: "3 days" }, primary: "en" } }, [thresholdRule]);
  assert("A value below the numeric threshold FAILs", belowThreshold.some((v) => v.status === "FAIL"));
  const aboveThreshold = runRules({ withdrawalPeriod: { translations: { en: "10 days" }, primary: "en" } }, [thresholdRule]);
  assert("A value at/above the numeric threshold PASSes", aboveThreshold.some((v) => v.status === "PASS"));

  log("\n-- enumerated_values --", "cyan");
  const enumRule = {
    id: "ev1", ruleKey: "FICT.VET.PRESCRIPTION_STATUS_ENUM", severity: "error", targetPath: "prescriptionStatus",
    constraint: { kind: "enumerated_values", path: "prescriptionStatus", allowed: ["POM", "OTC", "VFD", "NA"] },
    description: "Prescription status must be one of the stated set.",
  };
  assert("An allowed enum value PASSes", runRules({ prescriptionStatus: "OTC" }, [enumRule]).some((v) => v.status === "PASS"));
  assert("A value outside the enumerated set FAILs", runRules({ prescriptionStatus: "MADE_UP" }, [enumRule]).some((v) => v.status === "FAIL"));

  log("\n-- external_match --", "cyan");
  const externalRule = {
    id: "em1", ruleKey: "FICT.VET.REGISTRATION_MATCH", severity: "error", targetPath: "registrationNumber",
    constraint: { kind: "external_match", path: "registrationNumber" },
    description: "Registration number must match the e-registration system.",
  };
  const externalVerdicts = runRules({ registrationNumber: "REG-123" }, [externalRule]);
  assert("external_match NEVER resolves to PASS/FAIL — it asks for confirmation", externalVerdicts.every((v) => v.status !== "PASS" && v.status !== "FAIL"));
  assert("external_match emits NEEDS_CONFIRMATION specifically (distinct from semantic's UNVERIFIABLE)", externalVerdicts.some((v) => v.status === "NEEDS_CONFIRMATION"));

  // ── Severity ceiling (§7a confidence, decision 1 partial coverage) ──────
  log("\n-- Severity ceiling: low confidence / partial-coverage document caps FAIL at NEEDS_REVIEW --", "cyan");
  const strictRule = {
    id: "sr1", ruleKey: "FICT.STRICT.REQUIRED", severity: "error", targetPath: "batchNo",
    constraint: { kind: "required_field", path: "batchNo" },
    description: "Batch number is required.",
  };
  const plainFail = runRules({ batchNo: "" }, [strictRule]);
  assert("Baseline: a normal rule with no downgrade reason still FAILs", plainFail.some((v) => v.status === "FAIL"));

  const lowConfidenceFail = runRules({ batchNo: "" }, [{ ...strictRule, confidence: 0.2 }]);
  assert("Low extraction confidence caps FAIL at NEEDS_REVIEW", lowConfidenceFail.some((v) => v.status === "NEEDS_REVIEW"));
  assert("The verdict records WHY it was downgraded", lowConfidenceFail.some((v) => Array.isArray(v.downgradeReasons) && v.downgradeReasons.length > 0));

  const partialDocFail = runRules({ batchNo: "" }, [{ ...strictRule, documentActivationMode: "partial" }]);
  assert("A source document activated at partial coverage caps FAIL at NEEDS_REVIEW too", partialDocFail.some((v) => v.status === "NEEDS_REVIEW"));

  const warningNeverEscalates = runRules({ batchNo: "" }, [{ ...strictRule, severity: "warning", confidence: 0.1 }]);
  assert("A 'warning'-severity rule stays WARN, never gets 're-downgraded' to NEEDS_REVIEW", warningNeverEscalates.some((v) => v.status === "WARN"));

  // ── Composer: discriminant filtering, collisions, tenant scoping ────────
  log("\n-- Composer: discriminant-based field filtering --", "cyan");
  const companyA = await prisma.company.create({ data: { name: "Test Co A", username: `test-co-a-${crypto.randomUUID()}`, password: "x" } });
  const companyB = await prisma.company.create({ data: { name: "Test Co B", username: `test-co-b-${crypto.randomUUID()}`, password: "x" } });
  cleanup.companies.push(companyA.id, companyB.id);

  const discCitationText = "This document applies different requirements to Compound Feed and to Premix products.";
  const discCitation = citationFor(discCitationText, "Compound Feed and to Premix");
  const catalogA = {
    catalogVersion: 1, authority: "FAHA", countryCode: COUNTRY, documentLanguages: ["en"],
    discriminants: [
      {
        key: "product_category", labelInDocument: "Product Category", confidence: 0.9, citation: discCitation,
        values: [
          { key: "compound_feed", labelInDocument: "Compound Feed", citation: discCitation },
          { key: "premix", labelInDocument: "Premix", citation: discCitation },
        ],
      },
    ],
    fields: [
      {
        key: "batch_identification_code", mapsToCoreField: false, labelInDocument: "Batch Identification Code",
        type: "string", requirement: "required", appliesWhen: null,
        appliesToDiscriminants: { product_category: ["compound_feed"] },
        formatSpec: null, requiredLanguages: [], confidence: 0.9,
        citation: citationFor(discCitationText, "Compound Feed and to Premix"),
      },
    ],
  };
  const docA = await prisma.regulatoryDocument.create({
    data: { title: "Doc A", authority: "FAHA", country: COUNTRY, status: "approved", activationMode: "full", companyId: companyA.id, extractedText: discCitationText, labelFieldSchema: catalogA },
  });
  cleanup.documents.push(docA.id);

  const composedForCompoundFeed = await buildLabelSchema({ countryCode: COUNTRY, companyId: companyA.id, discriminants: { product_category: "compound_feed" } });
  assert("A field scoped to a discriminant value IS included when that value is supplied", composedForCompoundFeed.fields.some((f) => f.key === "batch_identification_code"));

  const composedForPremix = await buildLabelSchema({ countryCode: COUNTRY, companyId: companyA.id, discriminants: { product_category: "premix" } });
  assert("The SAME field is EXCLUDED when a different discriminant value is supplied", !composedForPremix.fields.some((f) => f.key === "batch_identification_code"));

  const composedUnrecognized = await buildLabelSchema({ countryCode: COUNTRY, companyId: companyA.id, discriminants: { made_up_axis: "x" } });
  assert("An unrecognized discriminant key is reported, not silently ignored", composedUnrecognized.unrecognizedDiscriminantKeys.includes("made_up_axis"));

  const composedNoDiscriminants = await buildLabelSchema({ countryCode: COUNTRY, companyId: companyA.id });
  assert("Every core field is present even with zero discriminants supplied", composedNoDiscriminants.fields.some((f) => f.key === "productName" && f.isCore));

  log("\n-- Composer: tenant scoping --", "cyan");
  const composedForOtherCompany = await buildLabelSchema({ countryCode: COUNTRY, companyId: companyB.id, discriminants: { product_category: "compound_feed" } });
  assert("A company-scoped document's fields do NOT leak into a different company's composition", !composedForOtherCompany.fields.some((f) => f.key === "batch_identification_code"));
  assert("...and its document is not in sourceDocumentIds for the other tenant either", !composedForOtherCompany.sourceDocumentIds.includes(docA.id));

  log("\n-- Composer: collision resolution --", "cyan");
  const collisionText1 = "Field X requirement, first document version stating it is optional.";
  const collisionText2 = "Field X requirement, second document version stating it is mandatory.";
  const docCollision1 = await prisma.regulatoryDocument.create({
    data: {
      title: "Collision Doc 1", authority: "FAHA", country: COUNTRY, status: "approved", activationMode: "full", companyId: null,
      extractedText: collisionText1,
      labelFieldSchema: {
        catalogVersion: 1, authority: "FAHA", countryCode: COUNTRY, documentLanguages: ["en"], discriminants: [],
        fields: [{ key: "shared_field", mapsToCoreField: false, labelInDocument: "Field X", type: "string", requirement: "optional", appliesWhen: null, appliesToDiscriminants: null, formatSpec: null, requiredLanguages: [], confidence: 0.8, citation: citationFor(collisionText1, "requirement, first document") }],
      },
    },
  });
  cleanup.documents.push(docCollision1.id);
  const docCollision2 = await prisma.regulatoryDocument.create({
    data: {
      title: "Collision Doc 2", authority: "FAHA", country: COUNTRY, status: "approved", activationMode: "full", companyId: null,
      extractedText: collisionText2,
      labelFieldSchema: {
        catalogVersion: 1, authority: "FAHA", countryCode: COUNTRY, documentLanguages: ["en"], discriminants: [],
        fields: [{ key: "shared_field", mapsToCoreField: false, labelInDocument: "Field X", type: "string", requirement: "required", appliesWhen: null, appliesToDiscriminants: null, formatSpec: null, requiredLanguages: ["ar"], confidence: 0.85, citation: citationFor(collisionText2, "requirement, second document") }],
      },
    },
  });
  cleanup.documents.push(docCollision2.id);

  const composedCollision = await buildLabelSchema({ countryCode: COUNTRY, companyId: null });
  const sharedField = composedCollision.fields.find((f) => f.key === "shared_field");
  assert("Collision: strictest requirement wins (required beats optional)", sharedField?.requirement === "required");
  assert("Collision: requiredLanguages is the union across contributing documents", sharedField?.requiredLanguages.includes("ar"));
  assert("Collision: the composed field records BOTH contributing documents", sharedField?.contributedBy.length === 2);

  // Type mismatch must FAIL composition, naming both documents.
  const docTypeMismatch = await prisma.regulatoryDocument.create({
    data: {
      title: "Type Mismatch Doc", authority: "FAHA", country: COUNTRY, status: "approved", activationMode: "full", companyId: null,
      extractedText: "Field X must be a numeric code in this later document.",
      labelFieldSchema: {
        catalogVersion: 1, authority: "FAHA", countryCode: COUNTRY, documentLanguages: ["en"], discriminants: [],
        fields: [{ key: "shared_field", mapsToCoreField: false, labelInDocument: "Field X", type: "number", requirement: "required", appliesWhen: null, appliesToDiscriminants: null, formatSpec: null, requiredLanguages: [], confidence: 0.8, citation: citationFor("Field X must be a numeric code in this later document.", "Field X must be a numeric code") }],
      },
    },
  });
  cleanup.documents.push(docTypeMismatch.id);

  let typeMismatchThrew = null;
  try {
    await buildLabelSchema({ countryCode: COUNTRY, companyId: null });
  } catch (err) {
    typeMismatchThrew = err;
  }
  assert("A type mismatch across documents FAILS composition rather than picking one silently", typeMismatchThrew && typeMismatchThrew.statusCode === 409);
  assert("The error names the conflicting field", typeMismatchThrew && typeMismatchThrew.message.includes("shared_field"));
  assert("The error names both documents", typeMismatchThrew && typeMismatchThrew.message.includes(docCollision1.id) && typeMismatchThrew.message.includes(docTypeMismatch.id));

  // Remove the type-conflicting document so the remaining tests in this file
  // (and any other test run against the same country) see a consistent catalog.
  await prisma.regulatoryDocument.delete({ where: { id: docTypeMismatch.id } });
  cleanup.documents = cleanup.documents.filter((id) => id !== docTypeMismatch.id);

  // ── Statistical downgrade (§7b) ─────────────────────────────────────────
  log("\n-- Statistical downgrade: a rule failing most labels of one discriminant combo gets capped --", "cyan");
  const statDoc = await prisma.regulatoryDocument.create({
    data: { title: "Stat Doc", authority: "FAHA", country: COUNTRY, status: "approved", activationMode: "full", companyId: null, extractedText: "Statistical downgrade test document." },
  });
  cleanup.documents.push(statDoc.id);
  const statRule = await prisma.regulatoryRule.create({
    data: {
      documentId: statDoc.id, ruleKey: "FICT.STAT.RULE", ruleType: "required_field", severity: "error",
      targetPath: "batchNo", constraint: { kind: "required_field", path: "batchNo" },
      description: "Statistical downgrade test rule.", citation: "n/a", confidence: 1, status: "active",
    },
  });

  assert("serializeDiscriminants is deterministic regardless of key order", serializeDiscriminants({ b: "2", a: "1" }) === serializeDiscriminants({ a: "1", b: "2" }));
  assert("serializeDiscriminants of an empty map is the empty-string bucket", serializeDiscriminants({}) === "" && serializeDiscriminants() === "");

  const failVerdict = [{ layer: "regulatory_rule", ruleKey: statRule.ruleKey, status: "FAIL" }];
  const passVerdict = [{ layer: "regulatory_rule", ruleKey: statRule.ruleKey, status: "PASS" }];
  for (let i = 0; i < 18; i++) await recordOutcomes([statRule], failVerdict, { labelId: null, discriminants: {} });
  for (let i = 0; i < 2; i++) await recordOutcomes([statRule], passVerdict, { labelId: null, discriminants: {} });

  const afterStats = await prisma.regulatoryRule.findUnique({ where: { id: statRule.id } });
  assert("20 outcomes at 90% failure crosses the default threshold/sample size and auto-downgrades", afterStats.autoDowngraded === true);
  assert("observedFailureRate is recorded", Math.abs(afterStats.observedFailureRate - 0.9) < 1e-9);
  assert("observedSampleSize is recorded", afterStats.observedSampleSize === 20);
  assert("downgradeReason explains why", typeof afterStats.downgradeReason === "string" && afterStats.downgradeReason.length > 0);

  const postDowngradeVerdicts = runRules({ batchNo: "" }, [{ ...statRule, autoDowngraded: afterStats.autoDowngraded, downgradeReason: afterStats.downgradeReason }]);
  assert("ruleValidator honors the statistical downgrade: FAIL becomes NEEDS_REVIEW", postDowngradeVerdicts.some((v) => v.status === "NEEDS_REVIEW"));

  // ── Cleanup ──────────────────────────────────────────────────────────────
  log("\nCleaning up...", "cyan");
  await prisma.ruleEvaluationOutcome.deleteMany({ where: { ruleId: statRule.id } });
  await prisma.regulatoryRule.deleteMany({ where: { documentId: { in: cleanup.documents } } });
  await prisma.regulatoryDocument.deleteMany({ where: { id: { in: cleanup.documents } } });
  await prisma.company.deleteMany({ where: { id: { in: cleanup.companies } } });

  log(`\n  Summary: ${passed} passed / ${failed} failed / ${passed + failed} total\n`, failed === 0 ? "green" : "red");
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
