import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new product scoped to a company
 */
export const createProduct = async (companyId, data) => {
  const { categoryId, ...productData } = data;

  // Verify company exists
  const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
  if (!companyExists) {
    throw new AppError("Target company not found!", 404);
  }

  // Verify category exists if provided
  if (categoryId) {
    const categoryExists = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!categoryExists) {
      throw new AppError("Selected category not found!", 400);
    }
  }

  const product = await prisma.product.create({
    data: {
      ...productData,
      companyId,
      categoryId: categoryId || null,
    },
    include: {
      category: true,
    },
  });

  return product;
};

/**
 * Get all products scoped to a company with filtering, sorting, search, pagination
 */
export const getAllProducts = async (companyId, queryString) => {
  // Verify company exists
  const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
  if (!companyExists) {
    throw new AppError("Target company not found!", 404);
  }

  const features = new PrismaFeatures(prisma.product, queryString)
    .filter()
    .search(["name", "description", "productCode", "indications"])
    .sort()
    .paginate();

  // Enforce company scoping and include category details
  features.queryOptions.where.companyId = companyId;
  features.queryOptions.include = { category: true };

  const result = await features.exec();

  return {
    meta: result.meta,
    products: result.data,
  };
};

/**
 * Get a product by ID
 */
export const getProductById = async (id) => {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { category: true },
  });

  if (!product) {
    throw new AppError("Product not found!", 404);
  }

  return product;
};

/**
 * Update a product
 */
export const updateProduct = async (id, data) => {
  const existingProduct = await prisma.product.findUnique({ where: { id } });
  if (!existingProduct) {
    throw new AppError("Product not found!", 404);
  }

  const { categoryId, ...updateFields } = data;

  // Verify category exists if provided and is different
  if (categoryId && categoryId !== existingProduct.categoryId) {
    const categoryExists = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!categoryExists) {
      throw new AppError("Selected category not found!", 400);
    }
  }

  const updateData = { ...updateFields };
  if (categoryId !== undefined) {
    updateData.categoryId = categoryId || null;
  }

  const updatedProduct = await prisma.product.update({
    where: { id },
    data: updateData,
    include: { category: true },
  });

  return updatedProduct;
};

/**
 * Delete a product (Hard Delete)
 */
export const deleteProduct = async (id) => {
  const existingProduct = await prisma.product.findUnique({ where: { id } });
  if (!existingProduct) {
    throw new AppError("Product not found!", 404);
  }

  await prisma.product.delete({ where: { id } });
  return null;
};
