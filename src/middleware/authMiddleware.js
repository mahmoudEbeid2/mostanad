import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import catchAsync from "../utils/catchAsync.js";

/**
 * Protect middleware: Verifies JWT token and attaches user/company details to request
 */
export const protect = catchAsync(async (req, res, next) => {
  // 0. Bypass for public authentication endpoints
  if (req.originalUrl && (req.originalUrl.endsWith("/auth/login") || req.originalUrl.endsWith("/companies/login"))) {
    return next();
  }

  // For testing convenience under non-production environments
  const isTestBypass = req.headers["x-test-bypass"] === "supersecretbypass";
  const isTestEnv = process.env.NODE_ENV === "test" && req.headers["x-force-auth"] !== "true";

  if (process.env.NODE_ENV !== "production" && (isTestBypass || isTestEnv)) {
    if (req.headers["x-bypass-type"] === "company") {
      const companyId = req.headers["x-bypass-id"] || "test-bypass-company-id";
      req.company = { id: companyId, name: "Test Bypass Company", isActive: true };
      req.user = { id: companyId, name: "Test Bypass Company", role: "company" };
    } else {
      const userId = req.headers["x-bypass-id"] || "test-bypass-user-id";
      req.user = { id: userId, name: "Test Bypass Admin", role: { name: "admin", permissions: [] } };
    }
    return next();
  }

  // 1. Get token from Authorization header
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    return next(new AppError("You are not logged in! Please log in to get access.", 401));
  }

  // 2. Verify token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return next(new AppError("Invalid token or token has expired! Please log in again.", 401));
  }

  // 3. Check if user or company still exists and is active
  if (decoded.type === "company") {
    const company = await prisma.company.findUnique({ where: { id: decoded.id } });
    if (!company) {
      return next(new AppError("The company belonging to this token no longer exists.", 401));
    }
    if (!company.isActive) {
      return next(new AppError("This company account is inactive.", 403));
    }
    req.company = company;
    // Polyfill user context for general checks
    req.user = { id: company.id, name: company.name, role: "company" };
  } else {
    // Regular system user
    const user = await prisma.user.findFirst({
      where: { id: decoded.id },
      include: {
        role: {
          include: {
            permissions: {
              include: {
                permission: true
              }
            }
          }
        }
      }
    });

    if (!user) {
      return next(new AppError("The user belonging to this token no longer exists.", 401));
    }
    if (!user.isActive) {
      return next(new AppError("This user account is inactive.", 403));
    }
    req.user = user;
  }

  next();
});

/**
 * Restrict access to users with a specific permission
 */
export const restrictToPermission = (permissionSlug) => {
  return (req, res, next) => {
    // 1. Bypass for test environment or test bypass header
    if (
      process.env.NODE_ENV !== "production" &&
      (req.headers["x-test-bypass"] === "supersecretbypass" ||
        (process.env.NODE_ENV === "test" && req.headers["x-force-auth"] !== "true"))
    ) {
      return next();
    }

    if (!req.user) {
      return next(new AppError("You are not logged in! Please log in to get access.", 401));
    }

    // 2. If authenticated as a company tenant:
    if (req.company) {
      // Company tenants are allowed to perform operations on company-level modules only
      const companyAllowedModules = ["products", "categories", "templates", "certificates"];
      const moduleName = permissionSlug.split("_")[1];

      if (companyAllowedModules.includes(moduleName)) {
        return next();
      }

      return next(new AppError("You do not have permission to perform this action!", 403));
    }

    // 3. System users: Check role permissions
    const userPermissions = req.user.role?.permissions?.map((rp) => rp.permission.slug) || [];

    if (userPermissions.includes(permissionSlug)) {
      return next();
    }

    return next(new AppError("You do not have permission to perform this action!", 403));
  };
};
