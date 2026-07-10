import { prisma } from "../lib/prisma.js";

/**
 * Get all dashboard metrics and stats
 * @returns {Promise<Object>} The dashboard statistics payload
 */
export const getDashboardStatsData = async () => {
  // 1. Core counters
  const totalProducts = await prisma.product.count();
  const totalCompanies = await prisma.company.count();
  const totalUsers = await prisma.user.count();
  const totalPlans = await prisma.plan.count();

  // Growth calculations
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const calculateGrowth = async (modelDelegate) => {
    const currentPeriodCount = await modelDelegate.count({
      where: { createdAt: { gte: thirtyDaysAgo } }
    });
    const previousPeriodCount = await modelDelegate.count({
      where: { createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo } }
    });

    if (previousPeriodCount === 0) return currentPeriodCount > 0 ? 100 : 0;
    return Math.round(((currentPeriodCount - previousPeriodCount) / previousPeriodCount) * 100);
  };

  const usersGrowth = await calculateGrowth(prisma.user);
  const companiesGrowth = await calculateGrowth(prisma.company);
  const productsGrowth = await calculateGrowth(prisma.product);

  // 2. Active subscriptions and revenue calculation
  const activeSubscriptionsList = await prisma.subscription.findMany({
    where: { status: "active" },
    include: { plan: true },
  });

  const totalRevenue = activeSubscriptionsList.reduce((sum, sub) => {
    return sum + Number(sub.plan.price || 0);
  }, 0);

  const activeSubscriptionsCount = activeSubscriptionsList.length;

  const currentRevenueSubs = await prisma.subscription.findMany({
    where: { createdAt: { gte: thirtyDaysAgo }, status: "active" },
    include: { plan: true }
  });
  const prevRevenueSubs = await prisma.subscription.findMany({
    where: { createdAt: { gte: sixtyDaysAgo, lt: thirtyDaysAgo }, status: "active" },
    include: { plan: true }
  });
  
  const currentRev = currentRevenueSubs.reduce((sum, sub) => sum + Number(sub.plan.price || 0), 0);
  const prevRev = prevRevenueSubs.reduce((sum, sub) => sum + Number(sub.plan.price || 0), 0);
  
  let revenueGrowth = 0;
  if (prevRev === 0) {
    revenueGrowth = currentRev > 0 ? 100 : 0;
  } else {
    revenueGrowth = Math.round(((currentRev - prevRev) / prevRev) * 100);
  }

  // 3. Background tasks metrics
  const totalTasks = await prisma.backgroundTask.count();
  
  // Group tasks by status
  const tasksByStatus = await prisma.backgroundTask.groupBy({
    by: ["status"],
    _count: { id: true },
  });
  
  const taskStatusBreakdown = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
  };
  tasksByStatus.forEach((item) => {
    if (item.status in taskStatusBreakdown) {
      taskStatusBreakdown[item.status] = item._count.id;
    }
  });

  // Group tasks by type
  const tasksByType = await prisma.backgroundTask.groupBy({
    by: ["type"],
    _count: { id: true },
  });
  
  const taskTypeBreakdown = {
    catalog_upload: 0,
    label_verification: 0,
    certificate_generation: 0,
  };
  tasksByType.forEach((item) => {
    if (item.type in taskTypeBreakdown) {
      taskTypeBreakdown[item.type] = item._count.id;
    }
  });

  // 4. Recent activities (last 5 entries)
  const recentCompanies = await prisma.company.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      isActive: true,
    },
  });

  const recentTasks = await prisma.backgroundTask.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      status: true,
      createdAt: true,
    },
  });

  return {
    stats: {
      products: totalProducts,
      companies: totalCompanies,
      users: totalUsers,
      plans: totalPlans,
      activeSubscriptions: activeSubscriptionsCount,
      totalMonthlyRevenue: totalRevenue,
      growth: {
        users: usersGrowth,
        companies: companiesGrowth,
        products: productsGrowth,
        revenue: revenueGrowth,
      }
    },
    tasks: {
      total: totalTasks,
      byStatus: taskStatusBreakdown,
      byType: taskTypeBreakdown,
    },
    recentActivity: {
      companies: recentCompanies,
      tasks: recentTasks,
    },
  };
};
