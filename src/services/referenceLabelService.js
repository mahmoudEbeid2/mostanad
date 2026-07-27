import { prisma } from "../config/db.js";
import AppError from "../utils/appError.js";
import PrismaFeatures from "../utils/PrismaFeatures.js";

export const getAll = async (queryString) => {
  const features = new PrismaFeatures(prisma.referenceLabel, queryString)
    .filter()
    .sort()
    .paginate();

  const labels = await features.query;
  const total = await prisma.referenceLabel.count({ where: features.query.where });

  return { labels, total };
};

export const getById = async (id) => {
  const label = await prisma.referenceLabel.findUnique({
    where: { id },
  });

  if (!label) {
    throw new AppError("No reference label found with that ID", 404);
  }

  return label;
};

export const deleteById = async (id) => {
  const label = await prisma.referenceLabel.findUnique({
    where: { id },
  });

  if (!label) {
    throw new AppError("No reference label found with that ID", 404);
  }

  await prisma.referenceLabel.delete({
    where: { id },
  });
};
