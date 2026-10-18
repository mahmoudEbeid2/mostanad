import catchAsync from "../../utils/catchAsync.js";
import * as typeService from "../../services/certificates/types/certificateTypeService.js";
import { companyFor, scopeOf } from "./requestScope.js";

export const listTypes = catchAsync(async (req, res) => {
  const types = await typeService.listTypes(companyFor(req), { includeInactive: req.query.includeInactive === "true" });
  res.status(200).json({ status: "success", results: types.length, data: { types } });
});

export const createType = catchAsync(async (req, res) => {
  const type = await typeService.createType(companyFor(req), req.body);
  res.status(201).json({ status: "success", data: { type } });
});

export const updateType = catchAsync(async (req, res) => {
  const type = await typeService.updateType(req.params.id, scopeOf(req), req.body);
  res.status(200).json({ status: "success", data: { type } });
});

export const deleteType = catchAsync(async (req, res) => {
  await typeService.deleteType(req.params.id, scopeOf(req));
  res.status(204).send();
});
