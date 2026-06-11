import catchAsync from "../utils/catchAsync.js";
import {
  createSubscription as createSubscriptionService,
  getAllSubscriptions as getAllSubscriptionsService,
  getSubscriptionById as getSubscriptionByIdService,
  updateSubscription as updateSubscriptionService,
  deleteSubscription as deleteSubscriptionService,
} from "../services/subscriptionService.js";

// 1. CREATE SUBSCRIPTION
export const createSubscription = catchAsync(async (req, res, next) => {
  const subscription = await createSubscriptionService(req.body);
  res.status(201).json({ status: "success", data: { subscription } });
});

// 2. GET ALL SUBSCRIPTIONS
export const getAllSubscriptions = catchAsync(async (req, res, next) => {
  const { meta, subscriptions } = await getAllSubscriptionsService(req.query);
  res.status(200).json({ status: "success", meta, data: { subscriptions } });
});

// 3. GET SUBSCRIPTION BY ID
export const getSubscriptionById = catchAsync(async (req, res, next) => {
  const subscription = await getSubscriptionByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { subscription } });
});

// 4. UPDATE SUBSCRIPTION
export const updateSubscription = catchAsync(async (req, res, next) => {
  const subscription = await updateSubscriptionService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { subscription } });
});

// 5. DELETE SUBSCRIPTION
export const deleteSubscription = catchAsync(async (req, res, next) => {
  await deleteSubscriptionService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
