import express from "express";
import {
  createSubscription,
  getAllSubscriptions,
  getSubscriptionById,
  updateSubscription,
  deleteSubscription,
} from "../controllers/subscriptionController.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createSubscriptionSchema,
  updateSubscriptionSchema,
  getSubscriptionByIdSchema,
  deleteSubscriptionSchema,
} from "../validators/subscriptionValidator.js";

const router = express.Router();

router
  .route("/")
  .post(validate(createSubscriptionSchema), createSubscription)
  .get(getAllSubscriptions);

router
  .route("/:id")
  .get(validate(getSubscriptionByIdSchema), getSubscriptionById)
  .patch(validate(updateSubscriptionSchema), updateSubscription)
  .delete(validate(deleteSubscriptionSchema), deleteSubscription);

export default router;
