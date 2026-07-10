import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a template scoped to a company and brand
 */
export const createTemplate = async (companyId, data) => {
  const { name, type, htmlContent, brandId, isActive, fields, isGlobal, productId } = data;

  // 1. Verify company exists
  const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
  if (!companyExists) {
    throw new AppError("Target company not found!", 404);
  }

  // 2. Verify brand exists and belongs to the company if brandId provided
  if (brandId) {
    const brandExists = await prisma.brand.findFirst({
      where: { id: brandId, companyId },
    });
    if (!brandExists) {
      throw new AppError("Selected brand not found or does not belong to this company!", 400);
    }
  }

  const finalIsGlobal = isGlobal !== undefined ? isGlobal : true;

  // 3. Verify product details if template is product-scoped
  if (!finalIsGlobal) {
    if (!productId) {
      throw new AppError("Product ID is required for a product-scoped template.", 400);
    }
    const productExists = await prisma.product.findFirst({
      where: { id: productId, companyId },
    });
    if (!productExists) {
      throw new AppError("Selected product not found or does not belong to this company!", 400);
    }
  }

  // 4. Enforce constraint:
  // - Global: Only one global template per type per brand per company
  // - Product-scoped: Only one template per type per product per company
  let existingTemplate;
  if (finalIsGlobal) {
    existingTemplate = await prisma.template.findFirst({
      where: {
        companyId,
        brandId: brandId || null,
        isGlobal: true,
        type,
      },
    });
    if (existingTemplate) {
      throw new AppError("A template of this type already exists for this company and brand. Please delete the existing template first.", 400);
    }
  } else {
    existingTemplate = await prisma.template.findFirst({
      where: {
        companyId,
        productId,
        isGlobal: false,
        type,
      },
    });
    if (existingTemplate) {
      throw new AppError("A template of this type already exists for this company and product. Please delete the existing template first.", 400);
    }
  }

  // 5. Create template
  const template = await prisma.template.create({
    data: {
      name,
      type,
      htmlContent,
      fields: fields !== undefined ? fields : null,
      isGlobal: finalIsGlobal,
      productId: finalIsGlobal ? null : productId,
      companyId,
      brandId: brandId || null,
      isActive: isActive !== undefined ? isActive : true,
    },
    include: {
      brand: true,
    },
  });

  return template;
};

/**
 * Get all templates scoped to a company with query filtering
 */
export const getAllTemplates = async (companyId, queryString) => {
  // Verify company exists if companyId is provided
  if (companyId) {
    const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
    if (!companyExists) {
      throw new AppError("Target company not found!", 404);
    }
  }

  const features = new PrismaFeatures(prisma.template, queryString)
    .filter()
    .search(["name", "type"])
    .sort()
    .paginate();

  // Enforce company scoping and include brand details
  if (companyId) {
    features.queryOptions.where = { ...features.queryOptions.where, companyId };
  }
  features.queryOptions.include = { brand: true };

  const result = await features.exec();

  return {
    meta: result.meta,
    templates: result.data,
  };
};

/**
 * Get a template by ID
 */
export const getTemplateById = async (id) => {
  const template = await prisma.template.findUnique({
    where: { id },
    include: { brand: true },
  });

  if (!template) {
    throw new AppError("Template not found!", 404);
  }

  return template;
};

/**
 * Update a template
 */
export const updateTemplate = async (id, data) => {
  const existingTemplate = await prisma.template.findUnique({ where: { id } });
  if (!existingTemplate) {
    throw new AppError("Template not found!", 404);
  }

  const { name, type, htmlContent, brandId, isActive, fields, isGlobal, productId } = data;
  const companyId = existingTemplate.companyId;

  // Validate brand if updating
  if (brandId && brandId !== existingTemplate.brandId) {
    const brandExists = await prisma.brand.findFirst({
      where: { id: brandId, companyId },
    });
    if (!brandExists) {
      throw new AppError("Selected brand not found or does not belong to this company!", 400);
    }
  }

  const finalIsGlobal = isGlobal !== undefined ? isGlobal : existingTemplate.isGlobal;
  const finalProductId = productId !== undefined ? productId : existingTemplate.productId;
  const finalType = type !== undefined ? type : existingTemplate.type;
  const finalBrandId = brandId !== undefined ? brandId : existingTemplate.brandId;

  // Validate product if template is product-scoped
  if (!finalIsGlobal) {
    if (!finalProductId) {
      throw new AppError("Product ID is required for a product-scoped template.", 400);
    }
    const productExists = await prisma.product.findFirst({
      where: { id: finalProductId, companyId },
    });
    if (!productExists) {
      throw new AppError("Selected product not found or does not belong to this company!", 400);
    }
  }

  // Enforce uniqueness constraints if template scoping, type or brand changes
  if (
    type !== undefined ||
    isGlobal !== undefined ||
    productId !== undefined ||
    brandId !== undefined
  ) {
    let duplicateTemplate;
    if (finalIsGlobal) {
      duplicateTemplate = await prisma.template.findFirst({
        where: {
          id: { not: id },
          companyId,
          brandId: finalBrandId || null,
          isGlobal: true,
          type: finalType,
        },
      });
      if (duplicateTemplate) {
        throw new AppError("A template of this type already exists for this company and brand. Please delete the existing template first.", 400);
      }
    } else {
      duplicateTemplate = await prisma.template.findFirst({
        where: {
          id: { not: id },
          companyId,
          productId: finalProductId,
          isGlobal: false,
          type: finalType,
        },
      });
      if (duplicateTemplate) {
        throw new AppError("A template of this type already exists for this company and product. Please delete the existing template first.", 400);
      }
    }
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (type !== undefined) updateData.type = type;
  if (htmlContent !== undefined) updateData.htmlContent = htmlContent;
  if (brandId !== undefined) updateData.brandId = brandId || null;
  if (isActive !== undefined) updateData.isActive = isActive;
  if (fields !== undefined) updateData.fields = fields;
  
  if (isGlobal !== undefined) {
    updateData.isGlobal = isGlobal;
    if (isGlobal) {
      updateData.productId = null;
    } else if (productId !== undefined) {
      updateData.productId = productId;
    }
  } else if (productId !== undefined) {
    updateData.productId = finalIsGlobal ? null : productId;
  }

  const updatedTemplate = await prisma.template.update({
    where: { id },
    data: updateData,
    include: { brand: true },
  });

  return updatedTemplate;
};

/**
 * Delete a template
 */
export const deleteTemplate = async (id) => {
  const existingTemplate = await prisma.template.findUnique({ where: { id } });
  if (!existingTemplate) {
    throw new AppError("Template not found!", 404);
  }

  await prisma.template.delete({ where: { id } });
  return null;
};
