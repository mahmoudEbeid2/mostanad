import catchAsync from "../../utils/catchAsync.js";
import * as reports from "../../services/ai/aiCostReports.js";
import { actorId } from "./requestScope.js";

// AI cost ledger reports (Certificates → AI page). A company sees only itself,
// whatever it passes; a system user sees every company, or the one it names.
const scope = (req) => (req.company ? req.company.id : req.query.companyId || null);

export const summary = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { summary: await reports.costSummary({ companyId: scope(req), from: req.query.from, to: req.query.to }) } });
});

export const top = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { operations: await reports.topOperations({ companyId: scope(req), from: req.query.from, to: req.query.to, limit: req.query.limit }) } });
});

export const entity = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { cost: await reports.entityCost({ type: req.query.type, id: req.query.id, companyId: scope(req) }) } });
});

export const exportCsv = catchAsync(async (req, res) => {
  const rows = reports.exportCsv({ companyId: scope(req), from: req.query.from, to: req.query.to });
  const first = await rows.next(); // validates the range before any header goes out
  const stamp = new Date().toISOString().slice(0, 10);
  res.status(200).set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="ai-costs-${stamp}.csv"`, "Cache-Control": "private, no-store" });
  res.write(first.value);
  for await (const chunk of rows) res.write(chunk);
  res.end();
});

export const reconciliation = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { months: await reports.reconciliation({ months: req.query.months }) } });
});

export const setBilled = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: { month: await reports.setBilledAmount(req.params.month, req.body, actorId(req)) } });
});
