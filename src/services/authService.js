import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";

/**
 * Log in a user by username or email and return signed JWT + user metadata
 */
export const loginUser = async (usernameOrEmail, password) => {
  if (!usernameOrEmail || !password) {
    throw new AppError("Username/email and password are required!", 400);
  }

  // 1. Fetch user by username or email
  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { username: usernameOrEmail.trim() },
        { email: usernameOrEmail.trim() },
      ],
    },
    include: {
      role: {
        include: {
          permissions: {
            include: {
              permission: true,
            },
          },
        },
      },
    },
  });

  // 2. Verify user exists and check password
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new AppError("Incorrect username/email or password!", 401);
  }

  // 3. Verify user status
  if (!user.isActive) {
    throw new AppError("This account is inactive! Please contact your administrator.", 403);
  }

  // 4. Generate token
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "90d",
  });

  // 5. Structure permissions slugs list
  const permissions = user.role?.permissions.map(rp => rp.permission.slug) || [];

  // Remove password from user output object
  const userDetails = {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role ? { id: user.role.id, name: user.role.name, permissions } : null,
  };

  return {
    token,
    user: userDetails,
  };
};

/**
 * Log in a company by username or email and return signed JWT + company metadata
 */
export const loginCompany = async (usernameOrEmail, password) => {
  if (!usernameOrEmail || !password) {
    throw new AppError("Username/email and password are required!", 400);
  }

  // 1. Fetch company by username or email
  const company = await prisma.company.findFirst({
    where: {
      OR: [
        { username: usernameOrEmail.trim() },
        { email: usernameOrEmail.trim() },
      ],
    },
  });

  // 2. Verify company exists and check password
  if (!company || !(await bcrypt.compare(password, company.password))) {
    throw new AppError("Incorrect username/email or password!", 401);
  }

  // 3. Verify status
  if (!company.isActive) {
    throw new AppError("This company account is inactive! Please contact support.", 403);
  }

  // 4. Generate token with type: "company"
  const token = jwt.sign({ id: company.id, type: "company" }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "90d",
  });

  // Remove password from company details
  const companyDetails = {
    id: company.id,
    name: company.name,
    username: company.username,
    email: company.email,
    phone: company.phone,
    address: company.address,
    logoUrl: company.logoUrl,
  };

  return {
    token,
    company: companyDetails,
  };
};
