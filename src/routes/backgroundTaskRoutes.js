import express from "express";
import { prisma } from "../lib/prisma.js";
import catchAsync from "../utils/catchAsync.js";
import AppError from "../utils/appError.js";

const router = express.Router();

router.get("/:id", catchAsync(async (req, res, next) => {
  const task = await prisma.backgroundTask.findUnique({
    where: { id: req.params.id },
  });

  if (!task) {
    return next(new AppError("Background task not found", 404));
  }

  res.status(200).json({
    status: "success",
    data: task,
  });
}));

export default router;
