import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new category
 */
export const createCategory = async (data) => {
  const { name } = data;
  const trimmedName = name.trim();

  // Check unique name
  const nameExists = await prisma.category.findUnique({
    where: { name: trimmedName },
  });
  if (nameExists) throw new AppError("Category name is already taken!", 400);

  const category = await prisma.category.create({
    data: { name: trimmedName },
  });

  return category;
};

/**
 * Get all categories with filtering, sorting, search, pagination
 */
export const getAllCategories = async (queryString) => {
  const features = new PrismaFeatures(prisma.category, queryString)
    .filter()
    .search(["name"])
    .sort()
    .paginate();

  const result = await features.exec();

  return {
    meta: result.meta,
    categories: result.data,
  };
};

/**
 * Get a category by ID
 */
export const getCategoryById = async (id) => {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw new AppError("Category not found!", 404);
  return category;
};

/**
 * Update a category
 */
export const updateCategory = async (id, data) => {
  const existingCategory = await prisma.category.findUnique({ where: { id } });
  if (!existingCategory) throw new AppError("Category not found!", 404);

  const { name } = data;
  const trimmedName = name.trim();
  const updateData = {};

  if (trimmedName && trimmedName !== existingCategory.name) {
    const nameExists = await prisma.category.findUnique({
      where: { name: trimmedName },
    });
    if (nameExists) throw new AppError("Category name is already taken by another category!", 400);
    updateData.name = trimmedName;
  }

  const updatedCategory = await prisma.category.update({
    where: { id },
    data: updateData,
  });

  return updatedCategory;
};

/**
 * Delete a category (Hard Delete)
 */
export const deleteCategory = async (id) => {
  const existingCategory = await prisma.category.findUnique({ where: { id } });
  if (!existingCategory) throw new AppError("Category not found!", 404);

  // Check if category has associated products
  const productsCount = await prisma.product.count({
    where: { categoryId: id },
  });

  if (productsCount > 0) {
    throw new AppError("Category cannot be deleted because it is associated with active products!", 400);
  }

  await prisma.category.delete({ where: { id } });
  return null;
};
