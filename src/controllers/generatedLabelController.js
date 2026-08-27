import * as generatedLabelService from "../services/label/generatedLabelService.js";
import catchAsync from "../utils/catchAsync.js";

// A company caller only ever sees its own labels. A system user may narrow by
// ?companyId=; omitting it lists across all tenants (internal/admin visibility).
const scopeFor = (req) => (req.company ? req.company.id : req.query.companyId);

export const getAllLabels = catchAsync(async (req, res) => {
  const { page, limit, productId } = req.query;
  const { labels, total } = await generatedLabelService.getAll({
    page,
    limit,
    productId,
    companyId: scopeFor(req),
  });

  res.status(200).json({
    status: "success",
    results: labels.length,
    total,
    data: { labels },
  });
});

export const getLabel = catchAsync(async (req, res) => {
  const result = await generatedLabelService.getById(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({
    status: "success",
    data: result,
  });
});

export const getLabelVersions = catchAsync(async (req, res) => {
  const versions = await generatedLabelService.getVersions(req.params.id, { companyId: scopeFor(req) });
  res.status(200).json({
    status: "success",
    results: versions.length,
    data: { versions },
  });
});
