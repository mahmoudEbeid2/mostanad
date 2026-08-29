import * as labelExtractor from "./label/extraction/labelExtractor.js";
import { validate } from "./label/validation/validationEngine.js";
import { prisma } from "../lib/prisma.js";

// Engine unification (§4.2, §14.5): an uploaded label and a generated label are judged
// by the exact same validationEngine. This function only orchestrates —
// extraction (labelExtractor) writes content, validationEngine writes the
// verdict. Neither writes both (Invariant #1).
export const verifyProductLabel = async (fileBuffer, fileName, mimeType, country, companyId, onProgress) => {
  const { labelData, extractionMeta, dbMatch } = await labelExtractor.extract(fileBuffer, fileName, mimeType, country, onProgress);

  // Load approved regulatory rules for this country if any exist
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

  const report = await validate(labelData, {
    rules,
    product: dbMatch.dbProduct,
    extractionMeta,
    includePlausibility: false,
  });

  if (typeof onProgress === "function") onProgress(95, "Validation complete");

  return {
    product: {
      extractedDetails: labelData,
      extractionMeta,
      existsInDb: dbMatch.existsInDb,
      isExactMatch: dbMatch.isExactMatch,
      dbProduct: dbMatch.dbProduct,
    },
    validation: report,
  };
};
