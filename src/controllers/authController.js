import catchAsync from "../utils/catchAsync.js";
import { loginUser, loginCompany } from "../services/authService.js";

export const getMe = catchAsync(async (req, res, next) => {
  let userData;

  if (req.company) {
    userData = {
      id: req.company.id,
      name: req.company.name,
      username: req.company.username,
      email: req.company.email,
      phone: req.company.phone,
      isCompany: true,
      company: { id: req.company.id, name: req.company.name },
      role: { name: "company", permissions: ["manage_company_brands", "create_certificates", "read_dashboard"] }
    };
  } else if (req.user) {
    const permissions = req.user.role?.permissions?.map(rp => rp.permission?.slug) || [];
    userData = {
      id: req.user.id,
      name: req.user.name,
      username: req.user.username,
      email: req.user.email,
      phone: req.user.phone,
      role: req.user.role ? { id: req.user.role.id, name: req.user.role.name, permissions } : null,
    };
  }

  res.status(200).json({
    status: "success",
    data: {
      user: userData,
    },
  });
});

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

