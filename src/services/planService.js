import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new plan
 */
export const createPlan = async (data) => {
  const { name, description, price, interval, features } = data;

  // Check unique name
  const nameExists = await prisma.plan.findUnique({ where: { name } });
  if (nameExists) throw new AppError("Plan name is already taken!", 400);

  const plan = await prisma.plan.create({
    data: {
      name,
      description,
      price,
      interval,
      features: features || [],
    },
  });

  return plan;
};

/**
 * Get all plans with filtering, sorting, search, pagination
 */
export const getAllPlans = async (queryString) => {
  const features = new PrismaFeatures(prisma.plan, queryString)
    .filter()
    .search(["name", "description"])
    .sort()
    .paginate();

  const result = await features.exec();

  return {
    meta: result.meta,
    plans: result.data,
  };
};

/**
 * Get a plan by ID
 */
export const getPlanById = async (id) => {
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) throw new AppError("Plan not found!", 404);
  return plan;
};

/**
 * Update a plan
 */
export const updatePlan = async (id, data) => {
  const existingPlan = await prisma.plan.findUnique({ where: { id } });
  if (!existingPlan) throw new AppError("Plan not found!", 404);

  const { name, description, price, interval, features, isActive } = data;
  const updateData = {};

  if (name && name !== existingPlan.name) {
    const nameExists = await prisma.plan.findUnique({ where: { name } });
    if (nameExists) throw new AppError("Plan name is already taken by another plan!", 400);
    updateData.name = name;
  }

  if (description !== undefined) updateData.description = description;
  if (price !== undefined) updateData.price = price;
  if (interval !== undefined) updateData.interval = interval;
  if (features !== undefined) updateData.features = features;
  if (isActive !== undefined) updateData.isActive = isActive;

  const updatedPlan = await prisma.plan.update({
    where: { id },
    data: updateData,
  });

  return updatedPlan;
};

/**
 * Delete a plan (Hard Delete)
 */
export const deletePlan = async (id) => {
  const existingPlan = await prisma.plan.findUnique({ where: { id } });
  if (!existingPlan) throw new AppError("Plan not found!", 404);

  // Check if plan has active subscriptions
  const activeSubscriptions = await prisma.subscription.findFirst({
    where: { planId: id },
  });

  if (activeSubscriptions) {
    throw new AppError("Plan cannot be deleted because it is associated with active subscriptions!", 400);
  }

  await prisma.plan.delete({ where: { id } });
  return null;
};
