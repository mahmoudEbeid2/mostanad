import catchAsync from "../utils/catchAsync.js";
import { prisma } from "../lib/prisma.js";
import { saveLogo, deleteLogo } from "../utils/logoHelper.js";
import {
  createCompany as createCompanyService,
  getAllCompanies as getAllCompaniesService,
  getCompanyById as getCompanyByIdService,
  updateCompany as updateCompanyService,
  deleteCompany as deleteCompanyService,
} from "../services/companyService.js";

// 1. CREATE COMPANY
export const createCompany = catchAsync(async (req, res, next) => {
  if (req.file) {
    req.body.logoUrl = saveLogo(req.file.buffer, "companies", req.file.originalname);
  }
  const company = await createCompanyService(req.body);
  res.status(201).json({ status: "success", data: { company } });
});

// 2. GET ALL COMPANIES
export const getAllCompanies = catchAsync(async (req, res, next) => {
  const { meta, companies } = await getAllCompaniesService(req.query);
  res.status(200).json({ status: "success", meta, data: { companies } });
});

// 3. GET COMPANY BY ID
export const getCompanyById = catchAsync(async (req, res, next) => {
  const company = await getCompanyByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { company } });
});

// 4. UPDATE COMPANY
export const updateCompany = catchAsync(async (req, res, next) => {
  if (req.file) {
    const existing = await prisma.company.findUnique({ where: { id: req.params.id } });
    if (existing && existing.logoUrl) {
      deleteLogo(existing.logoUrl);
    }
    req.body.logoUrl = saveLogo(req.file.buffer, "companies", req.file.originalname);
  }
  const company = await updateCompanyService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { company } });
});

// 5. DELETE COMPANY
export const deleteCompany = catchAsync(async (req, res, next) => {
  const existing = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (existing && existing.logoUrl) {
    deleteLogo(existing.logoUrl);
  }
  await deleteCompanyService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
