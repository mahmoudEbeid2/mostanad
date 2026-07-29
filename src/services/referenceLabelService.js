import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";

export const getAll = async (queryString) => {
  const { page = 1, limit = 100, sort, search, ...filters } = queryString;
  const where = {};

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") where[key] = value;
  });

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { country: { contains: search, mode: "insensitive" } },
      { manualCategoryName: { contains: search, mode: "insensitive" } },
      { fullText: { contains: search, mode: "insensitive" } },
    ];
  }

  const orderBy = sort
    ? sort.split(",").map((field) => field.startsWith("-") ? { [field.slice(1)]: "desc" } : { [field]: "asc" })
    : { createdAt: "desc" };

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const [labels, total] = await Promise.all([
    prisma.referenceLabel.findMany({
      where,
      orderBy,
      skip,
      take,
      include: {
        category: true,
        company: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
      },
    }),
    prisma.referenceLabel.count({ where }),
  ]);

  return { labels, total };
};

export const getById = async (id) => {
  const label = await prisma.referenceLabel.findUnique({
    where: { id },
    include: {
      category: true,
      company: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
    },
  });

  if (!label) {
    throw new AppError("No reference label found with that ID", 404);
  }

  return label;
};

export const createManual = async (data) => {
  const {
    name,
    fullText,
    country,
    companyId,
    brandId,
    categoryId,
    manualCategoryName,
    extractedData,
  } = data;

  if (!name?.trim()) throw new AppError("Reference name is required.", 400);
  if (!fullText?.trim()) throw new AppError("Full reference text is required.", 400);
  if (!country?.trim()) throw new AppError("Country is required.", 400);

  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) throw new AppError("Selected category was not found.", 404);
  }

  return prisma.referenceLabel.create({
    data: {
      name: name.trim(),
      fullText: fullText.trim(),
      country: country.trim(),
      sourceType: "manual",
      companyId: companyId || null,
      brandId: brandId || null,
      categoryId: categoryId || null,
      manualCategoryName: manualCategoryName?.trim() || null,
      extractedData: extractedData || {
        source: "manual",
        sections: {
          full_text: fullText.trim(),
        },
      },
    },
    include: {
      category: true,
      company: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
    },
  });
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
