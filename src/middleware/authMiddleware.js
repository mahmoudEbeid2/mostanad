import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import catchAsync from "../utils/catchAsync.js";
import { isBypassed } from "./testBypass.js";

/**
 * Protect middleware: Verifies JWT token and attaches user/company details to request
 */
export const protect = catchAsync(async (req, res, next) => {
  // 0. Bypass for public authentication endpoints
  if (req.originalUrl && (req.originalUrl.endsWith("/auth/login") || req.originalUrl.endsWith("/companies/login"))) {
    return next();
  }

  // Test-only bypass — opt-in via ALLOW_TEST_BYPASS + TEST_BYPASS_SECRET, never
  // in production (see testBypass.js; the app refuses to boot otherwise)
  if (isBypassed(req)) {
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

// Modules a company tenant may act on. Matched against the FULL resource
// name of a permission slug (see permissionModule) — never just its 2nd word.
export const COMPANY_ALLOWED_MODULES = [
  "products",
  "categories",
  "templates",
  "certificates",
  "labels",
  "regulatory",
  "certificate_types",
  "certificate_templates",
  "invoices",
];

/**
 * The module a permission slug acts on: everything after the action verb.
 *   "create_certificate_templates" → "certificate_templates"
 *   "read_products"                → "products"
 * Taking only split("_")[1] turned every multi-word resource into its first
 * word ("certificate"), which matched nothing and blocked every company.
 */
export const permissionModule = (permissionSlug) => {
  const idx = permissionSlug.indexOf("_");
  return idx === -1 ? "" : permissionSlug.slice(idx + 1);
};

/**
 * Restrict access to users with a specific permission
 */
export const restrictToPermission = (permissionSlug) => {
  return (req, res, next) => {
    // 1. Test-only bypass (opt-in, never in production — testBypass.js)
    if (isBypassed(req)) {
      return next();
    }

    if (!req.user) {
      return next(new AppError("You are not logged in! Please log in to get access.", 401));
    }

    // 2. If authenticated as a company tenant:
    if (req.company) {
      // Company tenants are allowed to perform operations on company-level modules only
      if (COMPANY_ALLOWED_MODULES.includes(permissionModule(permissionSlug))) {
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
