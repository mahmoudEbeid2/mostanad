import catchAsync from "../utils/catchAsync.js";
import { loginUser, loginCompany } from "../services/authService.js";

export const login = catchAsync(async (req, res, next) => {
  const { username, password } = req.body;
  const result = await loginUser(username, password);

  res.status(200).json({
    status: "success",
    data: result,
  });
});

export const companyLogin = catchAsync(async (req, res, next) => {
  const { username, password } = req.body;
  const result = await loginCompany(username, password);

  res.status(200).json({
    status: "success",
    data: result,
  });
});

