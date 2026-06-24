import express from "express";
import {
  createPlan,
  getAllPlans,
  getPlanById,
  updatePlan,
  deletePlan,
} from "../controllers/planController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import {
  createPlanSchema,
  updatePlanSchema,
  getPlanByIdSchema,
  deletePlanSchema,
} from "../validators/planValidator.js";

const router = express.Router();

router
  .route("/")
  .post(restrictToPermission("create_plans"), validate(createPlanSchema), createPlan)
  .get(restrictToPermission("read_plans"), getAllPlans);

router
  .route("/:id")
  .get(restrictToPermission("read_plans"), validate(getPlanByIdSchema), getPlanById)
  .patch(restrictToPermission("update_plans"), validate(updatePlanSchema), updatePlan)
  .delete(restrictToPermission("delete_plans"), validate(deletePlanSchema), deletePlan);

export default router;
