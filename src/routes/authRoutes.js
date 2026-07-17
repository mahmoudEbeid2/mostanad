import express from "express";
import { login, getMe } from "../controllers/authController.js";
import { protect } from "../middleware/authMiddleware.js";
import { validate } from "../middleware/validateMiddleware.js";
import { loginSchema } from "../validators/authValidator.js";

const router = express.Router();

router.post("/login", validate(loginSchema), login);
router.get("/me", protect, getMe);

export default router;
