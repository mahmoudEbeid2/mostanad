import express from "express";
import {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
} from "../controllers/userController.js";
import { validate } from "../middleware/validateMiddleware.js";
import {
  createUserSchema,
  updateUserSchema,
  getUserByIdSchema,
  deleteUserSchema,
} from "../validators/userValidator.js";

const router = express.Router();

router
  .route("/")
  .post(validate(createUserSchema), createUser)
  .get(getAllUsers);

router
  .route("/:id")
  .get(validate(getUserByIdSchema), getUserById)
  .patch(validate(updateUserSchema), updateUser)
  .delete(validate(deleteUserSchema), deleteUser);

export default router;
