import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * `parentId` from a request → undefined (not sent), null (none) or the id of a
 * main category. One level only: the parent must itself have no parent, and a
 * category that has categories under it can't be put under another.
 */
async function checkParent(parentId, selfId) {
  if (parentId === undefined) return undefined;
  if (parentId === null || parentId === "") return null;
  if (parentId === selfId) throw new AppError("A category can't be its own parent", 400);
  const parent = await prisma.category.findUnique({ where: { id: parentId }, select: { parentId: true } });
  if (!parent) throw new AppError("Parent category not found!", 404);
  if (parent.parentId) throw new AppError("The parent must be a main category (one that has no parent itself)", 400);
  if (selfId && (await prisma.category.count({ where: { parentId: selfId } }))) throw new AppError("This category has categories under it, so it can't be put under another one", 400);
  return parentId;
}

/**
 * Create a new category
 */
export const createCategory = async (data) => {
  const { name } = data;
  const trimmedName = name.trim();
  const parentId = await checkParent(data.parentId, null);

  // Check unique name
  const nameExists = await prisma.category.findUnique({
    where: { name: trimmedName },
  });
  if (nameExists) throw new AppError("Category name is already taken!", 400);

  const category = await prisma.category.create({
    data: { name: trimmedName, ...(parentId !== undefined ? { parentId } : {}) },
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
  // no explicit sort: the main categories first (in their order), then the rest by name
  if (!queryString.sort) features.queryOptions.orderBy = [{ sortOrder: { sort: "asc", nulls: "last" } }, { name: "asc" }];

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
  const trimmedName = (name || "").trim();
  const updateData = {};

  const parentId = await checkParent(data.parentId, id);
  if (parentId !== undefined) updateData.parentId = parentId;

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
