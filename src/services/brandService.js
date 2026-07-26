import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new brand
 */
export const createBrand = async (data) => {
  const { name, companyId } = data;

  // Verify company exists
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) {
    throw new AppError("Target company not found!", 404);
  }

  // Create brand
  const newBrand = await prisma.brand.create({
    data: {
      name,
      companyId,
    },
  });

  return newBrand;
};

/**
 * Get all brands with filtering, sorting, search, and pagination
 */
export const getAllBrands = async (queryString) => {
  const features = new PrismaFeatures(prisma.brand, queryString)
    .filter()
    .search(["name"])
    .sort()
    .paginate();

  const result = await features.exec();

  return {
    meta: result.meta,
    brands: result.data,
  };
};

/**
 * Get a brand by ID
 */
export const getBrandById = async (id) => {
  const brand = await prisma.brand.findUnique({
    where: { id },
    include: { company: true },
  });

  if (!brand) {
    throw new AppError("Brand not found!", 404);
  }

  return brand;
};

/**
 * Update a brand
 */
export const updateBrand = async (id, data) => {
  const existingBrand = await prisma.brand.findUnique({ where: { id } });
  if (!existingBrand) {
    throw new AppError("Brand not found!", 404);
  }

  const { name, companyId, isActive } = data;
  const updateData = {};

  if (name !== undefined) updateData.name = name;
  
  if (companyId !== undefined) {
    const company = await prisma.company.findUnique({ where: { id: companyId } });
    if (!company) {
      throw new AppError("Target company not found!", 404);
    }
    updateData.companyId = companyId;
  }

  if (isActive !== undefined) updateData.isActive = isActive;

  const updatedBrand = await prisma.brand.update({
    where: { id },
    data: updateData,
  });

  return updatedBrand;
};

/**
 * Delete a brand
 */
export const deleteBrand = async (id) => {
  const existingBrand = await prisma.brand.findUnique({ where: { id } });
  if (!existingBrand) {
    throw new AppError("Brand not found!", 404);
  }

  await prisma.brand.delete({ where: { id } });
  return null;
};
