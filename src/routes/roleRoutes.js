import express from "express";
import {
  createRole,
  getAllRoles,
  getRoleById,
  updateRole,
  deleteRole,
} from "../controllers/roleController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import {
  createRoleSchema,
  updateRoleSchema,
  getRoleByIdSchema,
  deleteRoleSchema,
} from "../validators/roleValidator.js";

const router = express.Router();

router
  .route("/")
  .post(restrictToPermission("create_roles"), validate(createRoleSchema), createRole)
  .get(restrictToPermission("read_roles"), getAllRoles);

router
  .route("/:id")
  .get(restrictToPermission("read_roles"), validate(getRoleByIdSchema), getRoleById)
  .patch(restrictToPermission("update_roles"), validate(updateRoleSchema), updateRole)
  .delete(restrictToPermission("delete_roles"), validate(deleteRoleSchema), deleteRole);

export default router;
