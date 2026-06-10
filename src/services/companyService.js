import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";
import { excludeFields } from "../utils/helpers.js";

const excludePassword = (company) => excludeFields(company, ["password"]);

/**
 * Create a new company
 */
export const createCompany = async (data) => {
  const { name, username, password, email, phone, address, logoUrl } = data;

  // Check unique username
  const usernameExists = await prisma.company.findUnique({ where: { username } });
  if (usernameExists) throw new AppError("Username is already taken!", 400);

  // Check unique email if provided
  if (email) {
    const emailExists = await prisma.company.findUnique({ where: { email } });
    if (emailExists) throw new AppError("Email is already registered!", 400);
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const company = await prisma.company.create({
    data: { name, username, password: hashedPassword, email, phone, address, logoUrl },
  });

  return excludePassword(company);
};

/**
 * Get all companies with filtering, sorting, search, pagination
 */
export const getAllCompanies = async (queryString) => {
  const features = new PrismaFeatures(prisma.company, queryString)
    .filter()
    .search(["name", "username", "email"])
    .sort()
    .paginate();

  const result = await features.exec();

  return {
    meta: result.meta,
    companies: result.data.map(excludePassword),
  };
};

/**
 * Get a company by ID
 */
export const getCompanyById = async (id) => {
  const company = await prisma.company.findUnique({ where: { id } });
  if (!company) throw new AppError("Company not found!", 404);
  return excludePassword(company);
};

/**
 * Update a company
 */
export const updateCompany = async (id, data) => {
  const existingCompany = await prisma.company.findUnique({ where: { id } });
  if (!existingCompany) throw new AppError("Company not found!", 404);

  const { name, username, password, email, phone, address, logoUrl, isActive } = data;
  const updateData = {};

  if (name) updateData.name = name;

  if (username && username !== existingCompany.username) {
    const usernameExists = await prisma.company.findUnique({ where: { username } });
    if (usernameExists) throw new AppError("Username is already taken by another company!", 400);
    updateData.username = username;
  }

  if (email !== undefined) {
    if (email && email !== existingCompany.email) {
      const emailExists = await prisma.company.findUnique({ where: { email } });
      if (emailExists) throw new AppError("Email is already used by another company!", 400);
    }
    updateData.email = email;
  }

  if (phone !== undefined) updateData.phone = phone;
  if (address !== undefined) updateData.address = address;
  if (logoUrl !== undefined) updateData.logoUrl = logoUrl;
  if (isActive !== undefined) updateData.isActive = isActive;

  if (password) {
    updateData.password = await bcrypt.hash(password, 12);
  }

  const updated = await prisma.company.update({ where: { id }, data: updateData });
  return excludePassword(updated);
};

/**
 * Delete a company (Hard Delete)
 */
export const deleteCompany = async (id) => {
  const existingCompany = await prisma.company.findUnique({ where: { id } });
  if (!existingCompany) throw new AppError("Company not found!", 404);

  await prisma.company.delete({ where: { id } });
  return null;
};
