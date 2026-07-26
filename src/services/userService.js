import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";
import { excludeFields } from "../utils/helpers.js";
import { addEmailJob } from "../lib/queue.js";

// Helper to exclude password from user object
const excludePassword = (user) => excludeFields(user, ["password"]);

/**
 * Create a new user
 */
export const createUser = async (userData) => {
  const { name, email, phone } = userData;
  let { username, password } = userData;

  // Check if email already exists
  const emailExists = await prisma.user.findUnique({ where: { email } });
  if (emailExists) {
    throw new AppError("Email is already registered!", 400);
  }

  // 1. Generate username from email if not provided
  if (!username) {
    let generatedUsername = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");
    if (generatedUsername.length < 3) {
      generatedUsername = generatedUsername.padEnd(3, "_");
    }
    let finalUsername = generatedUsername;
    let isUnique = false;
    let counter = 1;

    while (!isUnique) {
      const existing = await prisma.user.findUnique({ where: { username: finalUsername } });
      if (!existing) {
        isUnique = true;
      } else {
        finalUsername = `${generatedUsername}${counter}`;
        counter++;
      }
    }
    username = finalUsername;
  } else {
    // Check if username already exists
    const usernameExists = await prisma.user.findUnique({ where: { username } });
    if (usernameExists) {
      throw new AppError("Username is already taken!", 400);
    }
  }

  // 2. Generate random password if not provided
  if (!password) {
    password = crypto.randomBytes(8).toString("hex");
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  const newUser = await prisma.user.create({
    data: { name, email, username, password: hashedPassword, phone },
  });

  // Queue welcome email task in the background (TEMPORARILY DISABLED)
  /*
  addEmailJob({
    type: "welcome",
    to: email,
    data: { name, username, password },
  }).catch((err) => {
    console.error(`[UserService] Failed to queue welcome email for ${email}:`, err.message);
  });
  */

  const safeUser = excludePassword(newUser);
  safeUser.generatedPassword = password;
  
  return safeUser;
};

/**
 * Get all users with filtering, sorting, search, and pagination
 */
export const getAllUsers = async (queryString) => {
  const features = new PrismaFeatures(prisma.user, queryString)
    .filter()
    .search(["name", "email", "username"])
    .sort()
    .paginate();

  const result = await features.exec();

  return {
    meta: result.meta,
    users: result.data.map(excludePassword),
  };
};

/**
 * Get a user by ID
 */
export const getUserById = async (id) => {
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    throw new AppError("User not found!", 404);
  }

  return excludePassword(user);
};

/**
 * Update a user
 */
export const updateUser = async (id, updateData) => {
  const existingUser = await prisma.user.findUnique({ where: { id } });

  if (!existingUser) {
    throw new AppError("User not found!", 404);
  }

  const { name, email, username, password, phone, isActive } = updateData;
  const finalUpdateData = {};

  if (name) finalUpdateData.name = name;

  if (email && email !== existingUser.email) {
    const emailExists = await prisma.user.findUnique({ where: { email } });
    if (emailExists) throw new AppError("Email is already used by another user!", 400);
    finalUpdateData.email = email;
  }

  if (username && username !== existingUser.username) {
    const usernameExists = await prisma.user.findUnique({ where: { username } });
    if (usernameExists) throw new AppError("Username is already taken by another user!", 400);
    finalUpdateData.username = username;
  }

  if (phone !== undefined) finalUpdateData.phone = phone;
  if (isActive !== undefined) finalUpdateData.isActive = isActive;

  if (password) {
    finalUpdateData.password = await bcrypt.hash(password, 12);
  }

  const updatedUser = await prisma.user.update({
    where: { id },
    data: finalUpdateData,
  });

  return excludePassword(updatedUser);
};

/**
 * Delete a user (Hard Delete)
 */
export const deleteUser = async (id) => {
  const existingUser = await prisma.user.findUnique({ where: { id } });

  if (!existingUser) {
    throw new AppError("User not found!", 404);
  }

  await prisma.user.delete({ where: { id } });

  return null;
};
