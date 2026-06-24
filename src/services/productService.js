import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new product scoped to a company
 */
export const createProduct = async (companyId, data) => {
  const { categoryId, brandId, ...productData } = data;

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

  // Verify brand exists and belongs to company if brandId provided
  if (brandId) {
    const brandExists = await prisma.brand.findFirst({
      where: { id: brandId, companyId },
    });
    if (!brandExists) {
      throw new AppError("Selected brand not found or does not belong to this company!", 400);
    }
  }

  const product = await prisma.product.create({
    data: {
      ...productData,
      companyId,
      categoryId: categoryId || null,
      brandId: brandId || null,
    },
    include: {
      category: true,
      brand: true,
    },
  });

  return product;
};

/**
 * Get all products with filtering, sorting, search, pagination
 */
export const getAllProducts = async (queryString) => {
  // Verify company exists if companyId provided in query string
  if (queryString?.companyId) {
    const companyExists = await prisma.company.findUnique({ where: { id: queryString.companyId } });
    if (!companyExists) {
      throw new AppError("Target company not found!", 404);
    }
  }

  const features = new PrismaFeatures(prisma.product, queryString)
    .filter()
    .search(["name", "description", "productCode", "indications"])
    .sort()
    .paginate();

  features.queryOptions.include = { category: true, brand: true };

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
    include: { category: true, brand: true },
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

  const { categoryId, brandId, ...updateFields } = data;

  // Verify category exists if provided and is different
  if (categoryId && categoryId !== existingProduct.categoryId) {
    const categoryExists = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!categoryExists) {
      throw new AppError("Selected category not found!", 400);
    }
  }

  // Verify brand exists and belongs to company if brandId provided and is different
  if (brandId && brandId !== existingProduct.brandId) {
    const brandExists = await prisma.brand.findFirst({
      where: { id: brandId, companyId: existingProduct.companyId },
    });
    if (!brandExists) {
      throw new AppError("Selected brand not found or does not belong to this company!", 400);
    }
  }

  const updateData = { ...updateFields };
  if (categoryId !== undefined) {
    updateData.categoryId = categoryId || null;
  }
  if (brandId !== undefined) {
    updateData.brandId = brandId || null;
  }

  const updatedProduct = await prisma.product.update({
    where: { id },
    data: updateData,
    include: { category: true, brand: true },
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
