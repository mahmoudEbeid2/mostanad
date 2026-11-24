import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import {
  createProduct as createProductService,
  getAllProducts as getAllProductsService,
  getProductById as getProductByIdService,
  updateProduct as updateProductService,
  deleteProduct as deleteProductService,
} from "../services/productService.js";
import { assertCompanyAccess } from "../utils/tenantScope.js";
import { copyProduct as copyProductService, copyProductsBulk, copyInfo, diffFromSource, updateFromSource, COPY_FIELD_GROUPS, NEVER_COPIED } from "../services/productCopyService.js";

// Tenancy: a company caller only ever sees and changes its own products —
// another tenant's product is a 404 (never 403), a ?companyId= / body companyId
// naming another company is ignored (list) or refused (create). A system user
// keeps the global view (and may filter with ?companyId=).
const ownCompanyId = (req) => req.company?.id;

// 1. CREATE PRODUCT
export const createProduct = catchAsync(async (req, res, next) => {
  const { companyId, ...productData } = req.body;
  assertCompanyAccess(req, companyId);
  const product = await createProductService(ownCompanyId(req) || companyId, productData);
  res.status(201).json({ status: "success", data: { product } });
});

// 2. GET ALL PRODUCTS (global with query filters)
export const getAllProducts = catchAsync(async (req, res, next) => {
  const own = ownCompanyId(req);
  const query = own ? Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== "companyId")) : req.query;
  const { meta, products } = await getAllProductsService(query, own);
  res.status(200).json({ status: "success", meta, data: { products } });
});

// 3. GET PRODUCT BY ID
export const getProductById = catchAsync(async (req, res, next) => {
  const product = await getProductByIdService(req.params.id, ownCompanyId(req));
  // "Copied from <A> · <brand>" / "Used by: <copies>" (another tenant's side is never named)
  product.copyInfo = await copyInfo(product, ownCompanyId(req));
  res.status(200).json({ status: "success", data: { product } });
});

// 4. UPDATE PRODUCT
export const updateProduct = catchAsync(async (req, res, next) => {
  const product = await updateProductService(req.params.id, req.body, ownCompanyId(req));
  res.status(200).json({ status: "success", data: { product } });
});

// Copy to another brand (productCopyService). A company caller copies within its
// own company; a system user may name another company's brand.
const copyActor = (req) => ({ scopeCompanyId: ownCompanyId(req) || null, userId: req.user?.id || null });

export const getCopyFields = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { groups: COPY_FIELD_GROUPS, neverCopied: NEVER_COPIED } });
});

export const copyProduct = catchAsync(async (req, res) => {
  const out = await copyProductService(req.params.id, req.body, copyActor(req));
  res.status(201).json({ status: "success", data: out });
});

export const copyProductsBulkCtrl = catchAsync(async (req, res) => {
  const out = await copyProductsBulk(req.body, copyActor(req));
  res.status(out.copied ? 201 : 400).json({ status: out.copied ? "success" : "fail", data: out });
});

export const getSourceDiff = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await diffFromSource(req.params.id, ownCompanyId(req)) });
});

export const updateFromSourceCtrl = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await updateFromSource(req.params.id, req.body.fields, copyActor(req)) });
});

// 5. DELETE PRODUCT
export const deleteProduct = catchAsync(async (req, res, next) => {
  await deleteProductService(req.params.id, ownCompanyId(req));
  res.status(204).json({ status: "success", data: null });
});

import { Queue } from "bullmq";
import { getRedisConfig } from "../lib/redis.js";
import { prisma } from "../lib/prisma.js";

const productAiQueue = new Queue("productAiQueue", { connection: getRedisConfig() });

// 6. EXTRACT PRODUCT VIA AI
export const extractProductAi = catchAsync(async (req, res, next) => {
  const { rawText, companyId, brandId, categoryId } = req.body;
  
  if (!rawText) {
    return next(new AppError("Please provide the raw text to extract from.", 400));
  }

  // a company caller extracts into its own catalogue only (another tenant → 404)
  assertCompanyAccess(req, companyId || req.company?.id);
  let finalCompanyId = null;
  if (req.company) {
    finalCompanyId = req.company.id;
  } else if (companyId !== undefined) {
    finalCompanyId = companyId || null;
  }

  // 1. Create a BackgroundTask record
  const task = await prisma.backgroundTask.create({
    data: {
      type: "product_ai_extraction",
      status: "pending",
      companyId: finalCompanyId,
      brandId: brandId || null,
    },
  });

  // 2. Add to Queue
  await productAiQueue.add(
    "processProductAi",
    {
      rawText,
      companyId: finalCompanyId,
      brandId: brandId || null,
      categoryId: categoryId || null,
      taskId: task.id,
    },
    {
      jobId: task.id,
      removeOnComplete: true,
      removeOnFail: 100,
    }
  );

  res.status(202).json({
    status: "success",
    message: "Product AI extraction queued.",
    data: {
      taskId: task.id,
    },
  });
});
