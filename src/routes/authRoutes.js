import express from "express";
import { login } from "../controllers/authController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { loginSchema } from "../validators/authValidator.js";

const router = express.Router();

router.post("/auth/login", validate(loginSchema), login);

export default router;
