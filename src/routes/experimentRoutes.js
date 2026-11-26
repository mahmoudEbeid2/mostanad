import express from "express";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { protect } from "../middleware/authMiddleware.js";
import { experimentStatus, setExperiment, isSuperAdmin } from "../services/certificates/experiment/experimentMode.js";

// PART 3 (28 Nov): experiment mode. Anyone signed in reads it (every screen shows the banner); only the
// owner / super-admin turns it on or off — checked here, not only hidden in the UI. No env switch.
const router = express.Router();
router.use(protect);

router.get(
  "/",
  catchAsync(async (req, res) => {
    const companyId = req.company ? req.company.id : req.query.companyId || null;
    res.status(200).json({ status: "success", data: { ...(await experimentStatus(companyId)), canToggle: isSuperAdmin(req) } });
  })
);

router.post(
  "/",
  catchAsync(async (req, res, next) => {
    if (!isSuperAdmin(req)) return next(new AppError("Only the owner can turn experiment mode on or off", 403));
    const { scope, companyId = null, on, confirm = "" } = req.body || {};
    try {
      const data = await setExperiment({ scope, companyId, on: on === true, confirm }, req.user);
      res.status(200).json({ status: "success", data: { ...data, canToggle: true } });
    } catch (err) {
      return next(new AppError(err.message, err.statusCode || 400));
    }
  })
);

export default router;
