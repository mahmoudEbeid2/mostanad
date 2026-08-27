import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

// NOTE: processAndCreate (a synchronous upload+AI-structuring path) was removed here.
// It wrote a `title` column that exists in no migration — every call would have thrown
// PrismaClientValidationError — and it was never imported by any controller or route.
// The real, working ingestion path is the async one: edaRequirementController ->
// edaRequirementQueue -> edaRequirementWorker.js.

export const getAll = async (queryString) => {
  // Extract companyId if it exists in query string to filter explicitly
  // PrismaFeatures handles standard equality filters automatically if we pass it in query
  const features = new PrismaFeatures(prisma.edaRequirement, queryString)
    .filter()
    .sort()
    .paginate();

  const { data: requirements, meta } = await features.exec();

  return { requirements, total: meta.total };
};

export const update = async (id, data) => {
  return await prisma.edaRequirement.update({
    where: { id },
    data,
  });
};

export const remove = async (id) => {
  const req = await prisma.edaRequirement.findUnique({ where: { id } });
  if (!req) throw new AppError("Requirement not found", 404);
  
  await prisma.edaRequirement.delete({ where: { id } });
  return true;
};
