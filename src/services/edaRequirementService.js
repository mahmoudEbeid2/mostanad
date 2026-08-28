import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

// NOTE: processAndCreate (a synchronous upload+AI-structuring path) was removed here
// in Phase 0. It wrote a `title` column that exists in no migration — every call
// would have thrown PrismaClientValidationError — and it was never imported by any
// controller or route.
//
// Phase 3: eda_requirements the TABLE was renamed to regulatory_documents (§5.6) and
// gained RegulatoryRule as its real structured output. This file is now a thin shim
// over RegulatoryDocument so edaRequirementController.js (and whatever else imports
// these three functions) keeps working unchanged. The real ingestion path — upload,
// extract, compile rules, audit coverage, approve — lives in
// src/services/label/regulatory/regulatoryDocumentService.js.

export const getAll = async (queryString) => {
  const features = new PrismaFeatures(prisma.regulatoryDocument, queryString)
    .filter()
    .sort()
    .paginate();

  const { data: requirements, meta } = await features.exec();

  return { requirements, total: meta.total };
};

export const update = async (id, data) => {
  return await prisma.regulatoryDocument.update({
    where: { id },
    data,
  });
};

export const remove = async (id) => {
  const req = await prisma.regulatoryDocument.findUnique({ where: { id } });
  if (!req) throw new AppError("Requirement not found", 404);

  await prisma.regulatoryDocument.delete({ where: { id } });
  return true;
};
