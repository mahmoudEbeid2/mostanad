import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import * as rendererClient from "../../certificates/engine/rendererClient.js";
import { putFile, readFile } from "../../certificates/storage/fileStore.js";
import { getApprovedRulesForCountry } from "../regulatory/regulatoryDocumentService.js";
import { SIZE_PRESETS, SECTION_KEYS, DEFAULT_LAYOUT, DEFAULT_MIN_FONT_PT, resolveLayout, sizeLabel } from "./layoutSpec.js";
import { sectionsFromLabelData, buildLabelHtml } from "./labelHtml.js";
import { exactPageSize, textSizes, pageSizeMm } from "./labelPdf.js";
import { designsOfLabel } from "./designResizeService.js";

// Printable label layouts ("Layout & size"): the same label content at another
// page size. Every preview and save re-lays the label's CURRENT labelData out;
// a saved size is a new LabelLayout version with its PDF and preview image.
// Tenancy: like every label route — a company caller reaches its own labels only
// (another tenant's is 404).

/** → { presets, sections, defaults } (GET /labels/layout-sizes, list_label_sizes) */
export const listSizes = () => ({ presets: SIZE_PRESETS, sections: SECTION_KEYS, defaults: { ...DEFAULT_LAYOUT, minFontPt: DEFAULT_MIN_FONT_PT } });

async function loadLabel(labelId, companyId) {
  const label = await prisma.generatedLabel.findUnique({ where: { id: labelId }, select: { id: true, companyId: true, country: true, language: true, labelData: true, currentVersion: true, origin: true, productId: true, product: { select: { name: true } } } });
  if (!label || (companyId && label.companyId !== companyId)) throw new AppError("Label not found!", 404);
  return label;
}

/**
 * The smallest type a country allows, when one of its active regulatory rules
 * says so (ruleKey containing MIN_FONT, constraint { minPt | value }) — rules live
 * in the database (invariant 8). → { pt, ruleKey, citation } | null
 */
export async function minFontRule(country, companyId) {
  if (!country) return null;
  const rules = await getApprovedRulesForCountry(country, { companyId });
  const r = rules.find((x) => /MIN_?FONT/i.test(x.ruleKey) && Number(x.constraint?.minPt ?? x.constraint?.value) > 0);
  return r ? { pt: Number(r.constraint.minPt ?? r.constraint.value), ruleKey: r.ruleKey, citation: r.citation || null } : null;
}

const view = (row) =>
  row && {
    id: row.id,
    labelId: row.labelId,
    uploadId: row.uploadId,
    version: row.version,
    mode: row.mode,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    size: sizeLabel(row),
    settings: row.settings,
    fit: row.fit,
    hasPdf: !!row.pdfFileId,
    pdfUrl: row.pdfFileId ? `/label-layouts/${row.id}/pdf` : null,
    previewUrl: row.previewFileId ? `/label-layouts/${row.id}/preview.png` : null,
    labelVersion: row.labelVersion,
    createdAt: row.createdAt,
  };
export { view as layoutView };

/**
 * GET /labels/:id/layout → { label, current, versions, designs }
 * current/versions: the label laid out from its text ("new label from the text").
 * designs: the label's original design files and their saved sizes ("keep the design").
 */
export async function getLabelLayout(labelId, { companyId } = {}) {
  const label = await loadLabel(labelId, companyId);
  const [rows, designs] = await Promise.all([prisma.labelLayout.findMany({ where: { labelId: label.id }, orderBy: { version: "desc" }, take: 50 }), designsOfLabel(label.id, label.companyId)]);
  return { designs, label: { id: label.id, name: sectionsFromLabelData(label.labelData, { lang: label.language }).sections[0].lines[0] || label.product?.name || "Label", country: label.country, language: label.language, version: label.currentVersion }, current: view(rows[0]) || null, versions: rows.map(view) };
}

/**
 * Lays the label out at `input` (layoutSpec.layoutInput) and fits it. Nothing is saved.
 * → { layout, fit, pdf|null, png, empty, warnings }
 * fit: { fits, fontPt, columns, overflowMm, sections: [{ key, title, status: fits|reduced|overflow, overflowMm, message }], smallestTextPt }
 */
export async function layOut(label, input = {}, { base } = {}) {
  const rule = await minFontRule(label.country, label.companyId);
  const layout = resolveLayout({ ...input, ...(rule && (input.minFontPt === undefined || input.minFontPt < rule.pt) ? { minFontPt: Math.max(rule.pt, input.minFontPt ?? 0) } : {}) }, base);
  const lang = label.language || "en";
  const { sections, empty } = sectionsFromLabelData(label.labelData, { lang });
  const html = buildLabelHtml({ sections, layout, lang });
  const r = await rendererClient.labelLayout(html, { widthMm: layout.widthMm, heightMm: layout.heightMm, startPt: layout.startFontPt, minPt: layout.minFontPt, maxColumns: layout.maxColumns });
  const titles = Object.fromEntries(sections.map((s) => [s.key, s.title]));
  const fit = {
    fits: r.fit.fits,
    fontPt: r.fit.fontPt,
    columns: r.fit.columns,
    overflowMm: r.fit.overflowMm,
    minFontPt: layout.minFontPt,
    minFontRule: rule,
    sections: r.fit.sections.map((s) => ({
      ...s,
      title: titles[s.key] || s.key,
      message: s.status === "overflow" ? `overflow: ${titles[s.key] || s.key} needs ${s.overflowMm} mm more` : s.status === "reduced" ? `font reduced to ${r.fit.fontPt} pt${r.fit.columns > 1 ? `, ${r.fit.columns} columns` : ""}` : "fits",
    })),
  };
  let pdf = null;
  if (r.pdf) {
    pdf = await exactPageSize(r.pdf, layout.widthMm, layout.heightMm);
    // measured, not assumed: the smallest text actually in the PDF
    const sizes = await textSizes(pdf);
    fit.smallestTextPt = sizes.smallestPt;
    if (sizes.smallestPt !== null && sizes.smallestPt < layout.minFontPt - 0.01) throw new AppError(`Layout error: text at ${sizes.smallestPt} pt is below the ${layout.minFontPt} pt minimum`, 500);
  }
  const warnings = [];
  if (!fit.fits) warnings.push(`Doesn't fit at ${sizeLabel(layout)} even at ${layout.minFontPt} pt${layout.maxColumns > 1 ? ` in ${layout.maxColumns} columns` : ""}: ${fit.sections.filter((s) => s.status === "overflow").map((s) => `${s.title} needs ${s.overflowMm} mm more`).join("; ")}. Choose a larger size, smaller margins or fewer sections — nothing is cut.`);
  if (empty.length) warnings.push(`Not on the label (empty in its data): ${empty.join(", ")}`);
  return { layout, fit, pdf, png: r.png, empty, warnings };
}

/** POST /labels/:id/layout/preview → the old (current saved) and new layout side by side, as data URLs. Nothing saved. */
export async function previewLabelLayout(labelId, input, { companyId } = {}) {
  const label = await loadLabel(labelId, companyId);
  const current = await prisma.labelLayout.findFirst({ where: { labelId: label.id }, orderBy: { version: "desc" } });
  const next = await layOut(label, input, { base: current?.settings ? { ...current.settings, widthMm: current.widthMm, heightMm: current.heightMm } : DEFAULT_LAYOUT });
  return {
    old: current ? { ...view(current), previewDataUrl: current.previewFileId ? await dataUrl(current.previewFileId, label.companyId) : null } : null,
    new: { size: sizeLabel(next.layout), widthMm: next.layout.widthMm, heightMm: next.layout.heightMm, settings: next.layout, fit: next.fit, warnings: next.warnings, empty: next.empty, previewDataUrl: `data:image/png;base64,${next.png.toString("base64")}`, pdfAvailable: !!next.pdf },
  };
}

async function dataUrl(fileId, companyId) {
  const { buffer, row } = await readFile(fileId, { companyId });
  return `data:${row.mimeType};base64,${buffer.toString("base64")}`;
}

/**
 * POST /labels/:id/layout — "Save size as new version": lays the label out
 * again (the content may have changed since the preview) and stores the layout,
 * its PDF (when it fits) and preview. → the new version's view
 */
export async function saveLabelLayout(labelId, input, { companyId, userId = null } = {}) {
  const label = await loadLabel(labelId, companyId);
  const current = await prisma.labelLayout.findFirst({ where: { labelId: label.id }, orderBy: { version: "desc" } });
  const out = await layOut(label, input, { base: current?.settings ? { ...current.settings, widthMm: current.widthMm, heightMm: current.heightMm } : DEFAULT_LAYOUT });
  const pdfFile = out.pdf ? await putFile({ companyId: label.companyId, kind: "label_pdf", buffer: out.pdf, mimeType: "application/pdf" }) : null;
  const pngFile = await putFile({ companyId: label.companyId, kind: "label_preview", buffer: out.png, mimeType: "image/png" });
  const { widthMm, heightMm, ...settings } = out.layout;
  const row = await prisma.labelLayout.create({
    data: {
      companyId: label.companyId,
      labelId: label.id,
      version: (current?.version || 0) + 1,
      mode: "layout",
      widthMm,
      heightMm,
      settings,
      fit: { ...out.fit, warnings: out.warnings, empty: out.empty },
      pdfFileId: pdfFile?.id ?? null,
      previewFileId: pngFile.id,
      labelVersion: label.currentVersion,
      createdByUserId: userId,
    },
  });
  return view(row);
}

/** A layout the caller may read (company caller: own company only). */
export async function loadLayout(layoutId, { companyId } = {}) {
  const row = await prisma.labelLayout.findUnique({ where: { id: layoutId } });
  if (!row || (companyId && row.companyId !== companyId)) throw new AppError("Layout not found!", 404);
  return row;
}

/** GET /label-layouts/:id/pdf → { buffer, filename } — refused when the label didn't fit (no PDF was made). */
export async function layoutPdf(layoutId, opts = {}) {
  const row = await loadLayout(layoutId, opts);
  if (!row.pdfFileId) throw new AppError("This size has no PDF: the label didn't fit (see the fit report). Nothing is cut, so no PDF is made.", 409);
  const { buffer } = await readFile(row.pdfFileId, { companyId: row.companyId });
  return { buffer, filename: `label-${Math.round(row.widthMm)}x${Math.round(row.heightMm)}mm-v${row.version}.pdf` };
}

export async function layoutPreview(layoutId, opts = {}) {
  const row = await loadLayout(layoutId, opts);
  if (!row.previewFileId) throw new AppError("No preview", 404);
  return (await readFile(row.previewFileId, { companyId: row.companyId })).buffer;
}

export { pageSizeMm };
