import * as labelExtractor from "./label/extraction/labelExtractor.js";
import { validate } from "./label/validation/validationEngine.js";
import { prisma } from "../lib/prisma.js";

// Engine unification (§4.2, §14.5): an uploaded label and a generated label are judged
// by the exact same validationEngine. This function only orchestrates —
// extraction (labelExtractor) writes content, validationEngine writes the
// verdict. Neither writes both (Invariant #1).
export const verifyProductLabel = async (fileBuffer, fileName, mimeType, country, companyId, onProgress) => {
  const { labelData, extractionMeta, dbMatch } = await labelExtractor.extract(fileBuffer, fileName, mimeType, country, companyId, onProgress);

  // Load approved regulatory rules for this country if any exist — same
  // resolution generation uses (§4.2 engine unification).
  const approvedDocuments = country
    ? await prisma.regulatoryDocument.findMany({
        where: { country: { equals: country, mode: "insensitive" }, status: "approved" },
        select: { id: true },
      })
    : [];
  const rules = approvedDocuments.length > 0
    ? await prisma.regulatoryRule.findMany({
        where: { documentId: { in: approvedDocuments.map((d) => d.id) }, status: "approved" },
      })
    : [];

  // §14.5.2 / item 4: comparing a label against a DIFFERENT product turns
  // every ordinary difference into a false data_mismatch failure. Only
  // "matched" (same product) is passed into the engine's 3-way comparison;
  // "similar" (closest candidate, a different product) and "none" (no
  // candidate) both get zero data_mismatch verdicts — never silently
  // substitute a similar product for the real one.
  const product = dbMatch.matchState === "matched" ? dbMatch.dbProduct : null;

  const report = await validate(labelData, {
    rules,
    product,
    extractionMeta,
    includePlausibility: false,
  });

  if (typeof onProgress === "function") onProgress(95, "Validation complete");

  const regulatoryStatus = rules.length > 0
    ? { status: "CHECKED", rulesetCount: rules.length, message: null }
    : {
        status: "UNVERIFIABLE",
        rulesetCount: 0,
        message: country
          ? `No approved regulatory ruleset exists for "${country}" — regulatory verdicts are UNVERIFIABLE, not PASS.`
          : "No country was provided — regulatory verdicts are UNVERIFIABLE, not PASS.",
      };

  const productMatchMessage = {
    matched: null,
    similar: "Closest match found, but not the same product — no data comparison was run against it. Correct the match if this is wrong.",
    none: "No matching product found for this label.",
  }[dbMatch.matchState];

  return {
    // Stated at the top, not buried under a "Detailed result" heading (§14.5.4).
    regulatoryStatus,
    productMatchStatus: {
      state: dbMatch.matchState,
      tier: dbMatch.matchTier,
      score: dbMatch.matchScore,
      candidate: dbMatch.dbProduct,
      message: productMatchMessage,
    },
    product: {
      extractedDetails: labelData,
      extractionMeta,
      existsInDb: dbMatch.existsInDb,
      isExactMatch: dbMatch.isExactMatch,
      matchState: dbMatch.matchState,
      dbProduct: dbMatch.dbProduct,
    },
    validation: report,
  };
};
