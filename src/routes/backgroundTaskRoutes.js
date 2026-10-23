import express from "express";
import { prisma } from "../lib/prisma.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";
import { scopeFor, isVisibleTo } from "../utils/tenantScope.js";
import { presentError } from "../services/ai/aiErrorMessage.js";

const router = express.Router();

// Tenant-scoped (Certificates V2 Phase 0): a company caller only sees its own
// tasks; another tenant's task is a 404, same as one that doesn't exist.
router.get("/:id", catchAsync(async (req, res, next) => {
  const task = await prisma.backgroundTask.findUnique({
    where: { id: req.params.id },
  });

  if (!isVisibleTo(task, scopeFor(req))) {
    return next(new AppError("Background task not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: presentError(task), // P8: an AI failure reads as a sentence; the raw text stays in the row
  });
}));

export default router;
