import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a template scoped to a company and brand
 */
export const createTemplate = async (companyId, data) => {
  const { name, type, htmlContent, brandId, isActive } = data;

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

  // 3. Enforce constraint: Only one template per type per brand per company
  const existingTemplate = await prisma.template.findFirst({
    where: {
      companyId,
      brandId: brandId || null,
      type,
    },
  });

  if (existingTemplate) {
    throw new AppError("A template of this type already exists for this company and brand. Please delete the existing template first.", 400);
  }

  // 4. Create template
  const template = await prisma.template.create({
    data: {
      name,
      type,
      htmlContent,
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
  // Verify company exists
  const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
  if (!companyExists) {
    throw new AppError("Target company not found!", 404);
  }

  const features = new PrismaFeatures(prisma.template, queryString)
    .filter()
    .search(["name", "type"])
    .sort()
    .paginate();

  // Enforce company scoping and include brand details
  features.queryOptions.where.companyId = companyId;
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

  const { name, type, htmlContent, brandId, isActive } = data;
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

  // Enforce constraint if type or brandId is updated
  const finalType = type !== undefined ? type : existingTemplate.type;
  const finalBrandId = brandId !== undefined ? brandId : existingTemplate.brandId;

  if (type !== undefined || brandId !== undefined) {
    const duplicateTemplate = await prisma.template.findFirst({
      where: {
        id: { not: id },
        companyId,
        brandId: finalBrandId || null,
        type: finalType,
      },
    });

    if (duplicateTemplate) {
      throw new AppError("A template of this type already exists for this company and brand. Please delete the existing template first.", 400);
    }
  }

  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (type !== undefined) updateData.type = type;
  if (htmlContent !== undefined) updateData.htmlContent = htmlContent;
  if (brandId !== undefined) updateData.brandId = brandId || null;
  if (isActive !== undefined) updateData.isActive = isActive;

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
