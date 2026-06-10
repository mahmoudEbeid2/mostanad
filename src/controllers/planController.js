import catchAsync from "../utils/catchAsync.js";
import {
  createPlan as createPlanService,
  getAllPlans as getAllPlansService,
  getPlanById as getPlanByIdService,
  updatePlan as updatePlanService,
  deletePlan as deletePlanService,
} from "../services/planService.js";

// 1. CREATE PLAN
export const createPlan = catchAsync(async (req, res, next) => {
  const plan = await createPlanService(req.body);
  res.status(201).json({ status: "success", data: { plan } });
});

// 2. GET ALL PLANS
export const getAllPlans = catchAsync(async (req, res, next) => {
  const { meta, plans } = await getAllPlansService(req.query);
  res.status(200).json({ status: "success", meta, data: { plans } });
});

// 3. GET PLAN BY ID
export const getPlanById = catchAsync(async (req, res, next) => {
  const plan = await getPlanByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { plan } });
});

// 4. UPDATE PLAN
export const updatePlan = catchAsync(async (req, res, next) => {
  const plan = await updatePlanService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { plan } });
});

// 5. DELETE PLAN
export const deletePlan = catchAsync(async (req, res, next) => {
  await deletePlanService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
