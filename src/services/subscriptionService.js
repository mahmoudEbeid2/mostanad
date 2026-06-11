import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new subscription
 */
export const createSubscription = async (data) => {
  const { companyId, planId, startDate: inputStartDate, endDate: inputEndDate, status = "active" } = data;

  // 1. Verify company exists
  const companyExists = await prisma.company.findUnique({ where: { id: companyId } });
  if (!companyExists) {
    throw new AppError("Target company not found!", 404);
  }

  // 2. Verify plan exists
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) {
    throw new AppError("Target plan not found!", 404);
  }

  const startDate = inputStartDate ? new Date(inputStartDate) : new Date();
  let endDate;

  if (inputEndDate) {
    endDate = new Date(inputEndDate);
  } else {
    // Auto calculate endDate based on plan interval
    endDate = new Date(startDate);
    if (plan.interval === "year") {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      // default to month
      endDate.setMonth(endDate.getMonth() + 1);
    }
  }

  // Validate dates
  if (endDate <= startDate) {
    throw new AppError("End date must be after start date!", 400);
  }

  // 3. Subscription Tenant rule: only one subscription is active at a time
  if (status === "active") {
    await prisma.subscription.updateMany({
      where: { companyId, status: "active" },
      data: { status: "cancelled" },
    });
  }

  const subscription = await prisma.subscription.create({
    data: {
      companyId,
      planId,
      startDate,
      endDate,
      status,
    },
    include: {
      company: {
        select: { id: true, name: true, username: true }
      },
      plan: {
        select: { id: true, name: true, price: true, interval: true }
      }
    }
  });

  return subscription;
};

/**
 * Get all subscriptions with pagination, filtering, searching, sorting
 */
export const getAllSubscriptions = async (queryString) => {
  const features = new PrismaFeatures(prisma.subscription, queryString)
    .filter()
    .sort()
    .paginate();

  // Add relations include
  features.queryOptions.include = {
    company: {
      select: { id: true, name: true, username: true }
    },
    plan: {
      select: { id: true, name: true, price: true, interval: true }
    }
  };

  const result = await features.exec();

  return {
    meta: result.meta,
    subscriptions: result.data,
  };
};

/**
 * Get subscription by ID
 */
export const getSubscriptionById = async (id) => {
  const subscription = await prisma.subscription.findUnique({
    where: { id },
    include: {
      company: {
        select: { id: true, name: true, username: true }
      },
      plan: {
        select: { id: true, name: true, price: true, interval: true }
      }
    }
  });

  if (!subscription) {
    throw new AppError("Subscription not found!", 404);
  }

  return subscription;
};

/**
 * Update a subscription
 */
export const updateSubscription = async (id, data) => {
  const existingSub = await prisma.subscription.findUnique({ where: { id } });
  if (!existingSub) {
    throw new AppError("Subscription not found!", 404);
  }

  const { planId, endDate: inputEndDate, status } = data;
  const updateData = {};

  if (planId) {
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw new AppError("Target plan not found!", 404);
    }
    updateData.planId = planId;
  }

  if (status) {
    updateData.status = status;

    // Apply active status constraint: cancel other active subscriptions for this company
    if (status === "active" && existingSub.status !== "active") {
      await prisma.subscription.updateMany({
        where: {
          companyId: existingSub.companyId,
          status: "active",
          id: { not: id }
        },
        data: { status: "cancelled" },
      });
    }
  }

  if (inputEndDate !== undefined) {
    if (inputEndDate === null) {
      throw new AppError("End date cannot be null!", 400);
    }
    const newEndDate = new Date(inputEndDate);
    const startDate = existingSub.startDate;
    if (newEndDate <= startDate) {
      throw new AppError("End date must be after start date!", 400);
    }
    updateData.endDate = newEndDate;
  }

  const updatedSub = await prisma.subscription.update({
    where: { id },
    data: updateData,
    include: {
      company: {
        select: { id: true, name: true, username: true }
      },
      plan: {
        select: { id: true, name: true, price: true, interval: true }
      }
    }
  });

  return updatedSub;
};

/**
 * Delete subscription
 */
export const deleteSubscription = async (id) => {
  const existingSub = await prisma.subscription.findUnique({ where: { id } });
  if (!existingSub) {
    throw new AppError("Subscription not found!", 404);
  }

  await prisma.subscription.delete({ where: { id } });
  return null;
};
