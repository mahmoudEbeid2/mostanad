import catchAsync from "../utils/catchAsync.js";
import {
  createRole as createRoleService,
  getAllRoles as getAllRolesService,
  getRoleById as getRoleByIdService,
  updateRole as updateRoleService,
  deleteRole as deleteRoleService,
} from "../services/roleService.js";

// 1. CREATE ROLE
export const createRole = catchAsync(async (req, res, next) => {
  const role = await createRoleService(req.body);
  res.status(201).json({ status: "success", data: { role } });
});

// 2. GET ALL ROLES
export const getAllRoles = catchAsync(async (req, res, next) => {
  const { meta, roles } = await getAllRolesService(req.query);
  res.status(200).json({ status: "success", meta, data: { roles } });
});

// 3. GET ROLE BY ID
export const getRoleById = catchAsync(async (req, res, next) => {
  const role = await getRoleByIdService(req.params.id);
  res.status(200).json({ status: "success", data: { role } });
});

// 4. UPDATE ROLE
export const updateRole = catchAsync(async (req, res, next) => {
  const role = await updateRoleService(req.params.id, req.body);
  res.status(200).json({ status: "success", data: { role } });
});

// 5. DELETE ROLE
export const deleteRole = catchAsync(async (req, res, next) => {
  await deleteRoleService(req.params.id);
  res.status(204).json({ status: "success", data: null });
});
