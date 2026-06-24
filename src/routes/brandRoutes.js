import express from "express";
import {
  createBrand,
  getAllBrands,
  getBrandById,
  updateBrand,
  deleteBrand,
} from "../controllers/brandController.js";
import { validate } from "../middleware/validateMiddleware.js";
import { restrictToPermission, protect } from "../middleware/authMiddleware.js";
import { uploadLogo } from "../middleware/uploadMiddleware.js";
import {
  createBrandSchema,
  updateBrandSchema,
  getBrandByIdSchema,
  deleteBrandSchema,
} from "../validators/brandValidator.js";

const router = express.Router();

// Protect all brand routes
router.use(protect);

router
  .route("/")
  .post(
    restrictToPermission("create_products"),
    uploadLogo.single("logo"),
    validate(createBrandSchema),
    createBrand
  )
  .get(restrictToPermission("read_products"), getAllBrands);

router
  .route("/:id")
  .get(restrictToPermission("read_products"), validate(getBrandByIdSchema), getBrandById)
  .patch(
    restrictToPermission("update_products"),
    uploadLogo.single("logo"),
    validate(updateBrandSchema),
    updateBrand
  )
  .delete(restrictToPermission("delete_products"), validate(deleteBrandSchema), deleteBrand);

export default router;
