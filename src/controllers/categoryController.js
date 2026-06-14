import catchAsync from "../utils/catchAsync.js";
import {
  createCategory as createCategoryService,
  getAllCategories as getAllCategoriesService,
  getCategoryById as getCategoryByIdService,
  updateCategory as updateCategoryService,
  deleteCategory as deleteCategoryService,
} from "../services/categoryService.js";

// 1. CREATE CATEGORY
export const createCategory = catchAsync(async (req, res, next) => {
  const category = await createCategoryService(req.body);
  res.status(201).json({ status: "success", data: { category } });
});

// 2. GET ALL CATEGORIES
export const getAllCategories = catchAsync(async (req, res, next) => {
  const { meta, categories } = await getAllCategoriesService(req.query);
  res.status(200).json({ status: "success", meta, data: { categories } });
});

// 3. GET CATEGORY BY ID
export const getCategoryById = catchAsync(async (req, res, next) => {
  const category = await getCategoryByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { category } });
});

// 4. UPDATE CATEGORY
export const updateCategory = catchAsync(async (req, res, next) => {
  const category = await updateCategoryService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { category } });
});

// 5. DELETE CATEGORY
export const deleteCategory = catchAsync(async (req, res, next) => {
  await deleteCategoryService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
