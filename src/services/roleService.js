import { prisma } from "../lib/prisma.js";
import AppError from "../utils/appError.js";
import { PrismaFeatures } from "../utils/PrismaFeatures.js";

/**
 * Create a new Role
 */
export const createRole = async (data) => {
  const { name, description, permissions, permissionSlugs } = data;

  // Check if role name exists
  const existingRole = await prisma.role.findUnique({ where: { name } });
  if (existingRole) {
    throw new AppError("Role with this name already exists!", 400);
  }

  let permissionIds = [];

  if (permissions && permissions.length > 0) {
    permissionIds = [...permissions];
  }

  if (permissionSlugs && permissionSlugs.length > 0) {
    const dbPerms = await prisma.permission.findMany({
      where: { slug: { in: permissionSlugs } },
      select: { id: true },
    });
    const foundIds = dbPerms.map((p) => p.id);
    permissionIds = [...new Set([...permissionIds, ...foundIds])];
  }

  const role = await prisma.role.create({
    data: {
      name,
      description,
      permissions: {
        create: permissionIds.map((id) => ({
          permissionId: id,
        })),
      },
    },
    include: {
      permissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  return role;
};

/**
 * Get all Roles with pagination/filter/sort
 */
export const getAllRoles = async (queryString) => {
  const features = new PrismaFeatures(prisma.role, queryString)
    .filter()
    .search(["name", "description"])
    .sort()
    .paginate();

  features.queryOptions.include = {
    permissions: {
      include: {
        permission: true,
      },
    },
  };

  const result = await features.exec();

  return {
    meta: result.meta,
    roles: result.data,
  };
};

/**
 * Get Role by ID
 */
export const getRoleById = async (id) => {
  const role = await prisma.role.findUnique({
    where: { id },
    include: {
      permissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  if (!role) {
    throw new AppError("Role not found!", 404);
  }

  return role;
};

/**
 * Update Role
 */
export const updateRole = async (id, data) => {
  const existingRole = await prisma.role.findUnique({ where: { id } });
  if (!existingRole) {
    throw new AppError("Role not found!", 404);
  }

  const { name, description, permissions, permissionSlugs } = data;

  if (name && name !== existingRole.name) {
    const nameConflict = await prisma.role.findUnique({ where: { name } });
    if (nameConflict) {
      throw new AppError("Role with this name already exists!", 400);
    }
  }

  // Build update data
  const updateData = {};
  if (name !== undefined) updateData.name = name;
  if (description !== undefined) updateData.description = description;

  // Handle permission updates if provided
  if (permissions !== undefined || permissionSlugs !== undefined) {
    // Delete existing links
    await prisma.rolePermission.deleteMany({ where: { roleId: id } });

    let permissionIds = [];

    if (permissions && permissions.length > 0) {
      permissionIds = [...permissions];
    }

    if (permissionSlugs && permissionSlugs.length > 0) {
      const dbPerms = await prisma.permission.findMany({
        where: { slug: { in: permissionSlugs } },
        select: { id: true },
      });
      const foundIds = dbPerms.map((p) => p.id);
      permissionIds = [...new Set([...permissionIds, ...foundIds])];
    }

    updateData.permissions = {
      create: permissionIds.map((permId) => ({
        permissionId: permId,
      })),
    };
  }

  const updatedRole = await prisma.role.update({
    where: { id },
    data: updateData,
    include: {
      permissions: {
        include: {
          permission: true,
        },
      },
    },
  });

  return updatedRole;
};

/**
 * Delete Role
 */
export const deleteRole = async (id) => {
  const existingRole = await prisma.role.findUnique({ where: { id } });
  if (!existingRole) {
    throw new AppError("Role not found!", 404);
  }

  await prisma.role.delete({ where: { id } });
  return null;
};
