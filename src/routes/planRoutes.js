import express from "express";
import {
  createPlan,
  getAllPlans,
  getPlanById,
  updatePlan,
  deletePlan,
} from "../controllers/planController.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createPlanSchema,
  updatePlanSchema,
  getPlanByIdSchema,
  deletePlanSchema,
} from "../validators/planValidator.js";

const router = express.Router();

router
  .route("/")
  .post(validate(createPlanSchema), createPlan)
  .get(getAllPlans);

router
  .route("/:id")
  .get(validate(getPlanByIdSchema), getPlanById)
  .patch(validate(updatePlanSchema), updatePlan)
  .delete(validate(deletePlanSchema), deletePlan);

export default router;
