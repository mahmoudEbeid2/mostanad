import catchAsync from "../utils/catchAsync.js";
import { prisma } from "../lib/prisma.js";
import { saveLogo, deleteLogo } from "../utils/logoHelper.js";
import {
  createBrand as createBrandService,
  getAllBrands as getAllBrandsService,
  getBrandById as getBrandByIdService,
  updateBrand as updateBrandService,
  deleteBrand as deleteBrandService,
} from "../services/brandService.js";

// 1. CREATE BRAND
export const createBrand = catchAsync(async (req, res, next) => {
    // Logo removed
  const brand = await createBrandService(req.body);
  res.status(201).json({
    status: "success",
    data: { brand },
  });
});

// 2. GET ALL BRANDS WITH FILTERS
export const getAllBrands = catchAsync(async (req, res, next) => {
  const { meta, brands } = await getAllBrandsService(req.query);
  res.status(200).json({
    status: "success",
    meta,
    data: { brands },
  });
});

// 3. GET BRAND BY ID
export const getBrandById = catchAsync(async (req, res, next) => {
  const brand = await getBrandByIdService(req.params.id);
  res.status(200).json({
    status: "success",
    data: { brand },
  });
});

// 4. UPDATE BRAND
export const updateBrand = catchAsync(async (req, res, next) => {
    // Logo removed
  const brand = await updateBrandService(req.params.id, req.body);
  res.status(200).json({
    status: "success",
    data: { brand },
  });
});

// 5. DELETE BRAND
export const deleteBrand = catchAsync(async (req, res, next) => {
    // Logo removed
  await deleteBrandService(req.params.id);
  res.status(204).json({
    status: "success",
    data: null,
  });
});
