import express from "express";
import { uploadRequirement, getRequirements, deleteRequirement, updateRequirement } from "../controllers/edaRequirementController.js";
import { protect } from "../middleware/authMiddleware.js";
import { upload } from "../middleware/uploadMiddleware.js";

const router = express.Router();

router.use(protect);

router
  .route("/")
  .get(getRequirements)
  .post(
    upload.single("file"),
    uploadRequirement
  );

router
  .route("/:id")
  .delete(deleteRequirement)
  .patch(updateRequirement);

export default router;
