import catchAsync from "../../utils/catchAsync.js";
import * as invoiceService from "../../services/certificates/invoices/invoiceService.js";
import { companyFor, scopeOf, actorId } from "./requestScope.js";

export const uploadInvoice = catchAsync(async (req, res) => {
  const data = await invoiceService.uploadInvoice({
    companyId: companyFor(req),
    userId: actorId(req),
    file: req.file,
    brandId: req.body.brandId,
    country: req.body.country,
  });
  res.status(202).json({ status: "accepted", data });
});

export const listInvoices = catchAsync(async (req, res) => {
  const { total, invoices } = await invoiceService.listInvoices(companyFor(req), req.validatedQuery || {});
  res.status(200).json({ status: "success", results: invoices.length, total, data: { invoices } });
});

export const getInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.getInvoice(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data: { invoice } });
});

export const getSource = catchAsync(async (req, res) => {
  const { row, buffer } = await invoiceService.getSource(req.params.id, scopeOf(req));
  res
    .set({ "Content-Type": row.mimeType, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "private, max-age=300" })
    .send(buffer);
});

export const updateInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.updateInvoice(req.params.id, scopeOf(req), req.body);
  res.status(200).json({ status: "success", data: { invoice } });
});

export const addItem = catchAsync(async (req, res) => {
  const item = await invoiceService.addItem(req.params.id, scopeOf(req), req.body, actorId(req));
  res.status(201).json({ status: "success", data: { item } });
});

export const updateItem = catchAsync(async (req, res) => {
  const item = await invoiceService.updateItem(req.params.id, req.params.itemId, scopeOf(req), req.body, actorId(req));
  res.status(200).json({ status: "success", data: { item } });
});

export const deleteItem = catchAsync(async (req, res) => {
  await invoiceService.deleteItem(req.params.id, req.params.itemId, scopeOf(req));
  res.status(204).send();
});

export const rematch = catchAsync(async (req, res) => {
  const data = await invoiceService.rematch(req.params.id, scopeOf(req));
  res.status(200).json({ status: "success", data });
});

export const confirmInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.confirmInvoice(req.params.id, scopeOf(req), actorId(req));
  res.status(200).json({ status: "success", data: { invoice } });
});

export const startManualEntry = catchAsync(async (req, res) => {
  const invoice = await invoiceService.startManualEntry(req.params.id, scopeOf(req), actorId(req));
  res.status(200).json({ status: "success", data: { invoice } });
});

export const retryExtraction = catchAsync(async (req, res) => {
  const data = await invoiceService.retryExtraction(req.params.id, scopeOf(req));
  res.status(202).json({ status: "accepted", data });
});
