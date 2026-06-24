import catchAsync from "../utils/catchAsync.js";
import { getDashboardStatsData } from "../services/dashboardService.js";

/**
 * Get system administration dashboard statistics
 */
export const getDashboardStats = catchAsync(async (req, res, next) => {
  const statsData = await getDashboardStatsData();

  res.status(200).json({
    status: "success",
    data: statsData,
  });
});
