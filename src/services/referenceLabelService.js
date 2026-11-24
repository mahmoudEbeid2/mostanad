import { resolveBrand } from "./brandMatch.js";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";

// Tenancy (CLAUDE.md invariant 10): a company caller (companyId set) reads its
// own references plus the global ones, and changes only its own. null = a
// system user, who sees every company's.

export const getAll = async (queryString, { companyId = null } = {}) => {
  const { page = 1, limit = 100, sort, search, ...filters } = queryString;
  const where = {};

  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "") where[key] = value;
  });
  if (companyId) {
    delete where.companyId; // ?companyId= naming another company is ignored
    where.AND = [{ OR: [{ companyId }, { companyId: null }] }];
  }

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

export const getById = async (id, { companyId = null } = {}) => {
  const label = await prisma.referenceLabel.findUnique({
    where: { id },
    include: {
      category: true,
      company: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
    },
  });

  if (!label || (companyId && label.companyId && label.companyId !== companyId)) {
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

export const deleteById = async (id, { companyId = null } = {}) => {
  const label = await prisma.referenceLabel.findUnique({
    where: { id },
  });

  // a company deletes only its own references (never a global one)
  if (!label || (companyId && label.companyId !== companyId)) {
    throw new AppError("No reference label found with that ID", 404);
  }

  await prisma.referenceLabel.delete({
    where: { id },
  });
};

/**
 * The brand printed on a reference label (extractedData.brand_name) matched
 * against the company's brands (brandMatch). → { brandId | null, match }
 * match = { printed, candidates: [{ id, name, score }], chosen: id | null } —
 * kept on the reference so several candidates can be offered as choices.
 * A global reference (no company) has no brands to match.
 */
export async function brandFromLabel(companyId, extractedData) {
  const printed = typeof extractedData?.brand_name === "string" ? extractedData.brand_name.trim() : "";
  if (!companyId || !printed) return { brandId: null, match: printed ? { printed, candidates: [], chosen: null } : null };
  const r = await resolveBrand(companyId, printed);
  return { brandId: r.brandId, match: { printed, candidates: r.candidates, chosen: r.brandId } };
}

/**
 * PATCH /reference-labels/:id { brandId } — the person picks the brand (one of
 * the candidates read from the label, or any brand of the reference's
 * company; null clears it). Tenant-scoped: a company caller only its own.
 */
export async function setBrand(id, brandId, { companyId = null } = {}) {
  const ref = await prisma.referenceLabel.findUnique({ where: { id }, select: { id: true, companyId: true, extractedData: true } });
  if (!ref || (companyId && ref.companyId !== companyId)) throw new AppError("Reference label not found!", 404);
  if (brandId) {
    const brand = await prisma.brand.findUnique({ where: { id: brandId }, select: { companyId: true } });
    if (!brand || brand.companyId !== ref.companyId) throw new AppError("That brand is not one of this reference's company's brands", 400);
  }
  const extractedData = ref.extractedData?.brand_match ? { ...ref.extractedData, brand_match: { ...ref.extractedData.brand_match, chosen: brandId || null } } : ref.extractedData;
  return prisma.referenceLabel.update({ where: { id }, data: { brandId: brandId || null, extractedData }, include: { brand: { select: { id: true, name: true } } } });
}
