import * as labelExtractor from "./label/extraction/labelExtractor.js";
import { validate } from "./label/validation/validationEngine.js";

// Engine unification (§4.2): an uploaded label and a generated label are judged
// by the exact same validationEngine. This function only orchestrates —
// extraction (labelExtractor) writes content, validationEngine writes the
// verdict. Neither writes both (Invariant #1).
//
// `companyId` is accepted (labelWorker.js's call site expects it) but unused —
// see labelExtractor.js: extraction has no tenant concept. It's kept here only
// so the RegulatoryRule lookup this will need once Phase 3 exists has a natural
// place to plug in without another signature change.
export const verifyProductLabel = async (fileBuffer, fileName, mimeType, country, companyId, onProgress) => {
  const { labelData, dbMatch } = await labelExtractor.extract(fileBuffer, fileName, mimeType, country, onProgress);

  // rules: [] until Phase 3's RegulatoryRule table + a real approved document for
  // `country` exist — ruleValidator reports that gap as UNVERIFIABLE, not a silent PASS.
  const report = validate(labelData, { rules: [] });

  if (typeof onProgress === "function") onProgress(95, "Validation complete");

  return {
    product: {
      extractedDetails: labelData,
      existsInDb: dbMatch.existsInDb,
      isExactMatch: dbMatch.isExactMatch,
      dbProduct: dbMatch.dbProduct,
    },
    validation: report,
  };
};
