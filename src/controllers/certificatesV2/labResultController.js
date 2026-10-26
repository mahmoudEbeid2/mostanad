import catchAsync from "../../utils/catchAsync.js";
import * as grid from "../../services/certificates/labResults/resultsGrid.js";
import * as coas from "../../services/certificates/labResults/coaService.js";
import { startPrepare } from "../../services/certificates/prepare/prepareService.js";
import { scopeOf, actorId } from "./requestScope.js";

// Item 4 (owner, 2026-10-26): the invoice's results grid and its supplier COAs.

export const getGrid = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { grid: await grid.getGrid(req.params.id, scopeOf(req)) } });
});

export const saveGrid = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { grid: await grid.saveGrid(req.params.id, scopeOf(req), req.body.rows, actorId(req)) } });
});

export const uploadCoas = catchAsync(async (req, res) => {
  const data = await coas.uploadCoas({ invoiceId: req.params.id, companyScope: scopeOf(req), files: req.files, userId: actorId(req) });
  res.status(202).json({ status: "accepted", data: { taskId: data.taskId, coas: data.coas.map(grid.coaView) } });
});

// item 5: "Prepare certificates" — matching → product data → batch results → supplier COAs, in one job
export const prepare = catchAsync(async (req, res) => {
  res.status(202).json({ status: "accepted", data: await startPrepare(req.params.id, scopeOf(req), actorId(req)) });
});

export const deleteCoa = catchAsync(async (req, res) => {
  await coas.deleteCoa(req.params.id, req.params.coaId, scopeOf(req));
  res.status(204).send();
});
