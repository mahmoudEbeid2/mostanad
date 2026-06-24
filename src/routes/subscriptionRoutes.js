import express from "express";
import {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionById,
  updateSubscription,
  deleteSubscription,
} from "../controllers/subscriptionController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import {
  createSubscriptionSchema,
  updateSubscriptionSchema,
  getSubscriptionByIdSchema,
  deleteSubscriptionSchema,
} from "../validators/subscriptionValidator.js";

const router = express.Router();

router
  .route("/")
  .post(restrictToPermission("create_subscriptions"), validate(createSubscriptionSchema), createSubscription)
  .get(restrictToPermission("read_subscriptions"), getAllSubscriptions);

router
  .route("/:id")
  .get(restrictToPermission("read_subscriptions"), validate(getSubscriptionByIdSchema), getSubscriptionById)
  .patch(restrictToPermission("update_subscriptions"), validate(updateSubscriptionSchema), updateSubscription)
  .delete(restrictToPermission("delete_subscriptions"), validate(deleteSubscriptionSchema), deleteSubscription);

export default router;
