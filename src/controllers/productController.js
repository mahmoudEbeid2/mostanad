import catchAsync from "../utils/catchAsync.js";
import {
  createProduct as createProductService,
  getAllProducts as getAllProductsService,
  getProductById as getProductByIdService,
  updateProduct as updateProductService,
  deleteProduct as deleteProductService,
} from "../services/productService.js";

// 1. CREATE PRODUCT
export const createProduct = catchAsync(async (req, res, next) => {
  const product = await createProductService(req.params.companyId, req.body);
  res.status(201).json({ status: "success", data: { product } });
});

// 2. GET ALL PRODUCTS (scoped to company)
export const getAllProducts = catchAsync(async (req, res, next) => {
  const { meta, products } = await getAllProductsService(req.params.companyId, req.query);
  res.status(200).json({ status: "success", meta, data: { products } });
});

// 3. GET PRODUCT BY ID
export const getProductById = catchAsync(async (req, res, next) => {
  const product = await getProductByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { product } });
});

// 4. UPDATE PRODUCT
export const updateProduct = catchAsync(async (req, res, next) => {
  const product = await updateProductService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { product } });
});

// 5. DELETE PRODUCT
export const deleteProduct = catchAsync(async (req, res, next) => {
  await deleteProductService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
