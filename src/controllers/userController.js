import catchAsync from "../utils/catchAsync.js";
import {
  createUser as createUserService,
  getAllUsers as getAllUsersService,
  getUserById as getUserByIdService,
  updateUser as updateUserService,
  deleteUser as deleteUserService,
  resetUserPassword as resetUserPasswordService,
} from "../services/userService.js";

// 1. CREATE USER
export const createUser = catchAsync(async (req, res, next) => {
  const newUser = await createUserService(req.body);

  res.status(201).json({
    status: "success",
    data: {
      user: newUser,
    },
  });
});

// 2. GET ALL USERS WITH FILTERING, SEARCH, SORT, PAGINATION
export const getAllUsers = catchAsync(async (req, res, next) => {
  const { meta, users } = await getAllUsersService(req.query);

  res.status(200).json({
    status: "success",
    meta,
    data: {
      users,
    },
  });
});

// 3. GET USER BY ID
export const getUserById = catchAsync(async (req, res, next) => {
  const user = await getUserByIdService(req.params.id);

  res.status(200).json({
    status: "success",
    data: {
      user,
    },
  });
});

// 4. UPDATE USER
export const updateUser = catchAsync(async (req, res, next) => {
  const updatedUser = await updateUserService(req.params.id, req.body);

  res.status(200).json({
    status: "success",
    data: {
      user: updatedUser,
    },
  });
});

// 5. DELETE USER (SOFT DELETE)
export const deleteUser = catchAsync(async (req, res, next) => {
  await deleteUserService(req.params.id);

  res.status(204).json({
    status: "success",
    data: null,
  });
});

// 6. RESET PASSWORD
export const resetPassword = catchAsync(async (req, res, next) => {
  const newPassword = await resetUserPasswordService(req.params.id);

  res.status(200).json({
    status: "success",
    message: "Password reset successfully",
    data: {
      generatedPassword: newPassword,
    },
  });
});
