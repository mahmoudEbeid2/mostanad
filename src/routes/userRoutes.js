import express from "express";
import {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
} from "../controllers/userController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission } from "../middleware/authMiddleware.js";
import {
  createUserSchema,
  updateUserSchema,
  getUserByIdSchema,
  deleteUserSchema,
} from "../validators/userValidator.js";

const router = express.Router();

router
  .route("/")
  .post(restrictToPermission("create_users"), validate(createUserSchema), createUser)
  .get(restrictToPermission("read_users"), getAllUsers);

router
  .route("/:id")
  .get(restrictToPermission("read_users"), validate(getUserByIdSchema), getUserById)
  .patch(restrictToPermission("update_users"), validate(updateUserSchema), updateUser)
  .delete(restrictToPermission("delete_users"), validate(deleteUserSchema), deleteUser);

export default router;
