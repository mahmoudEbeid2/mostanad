import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { id } from "./common.js";
import { loadAttachment, attachmentFile } from "../../attachments.js";
import { listSizes, getLabelLayout, layOut, saveLabelLayout } from "../../../label/layout/layoutService.js";
import { uploadLabelFile, getUpload, confirmRebuild, REVIEW_FIELDS } from "../../../label/layout/labelUploadService.js";
import { SIZE_PRESETS, sizeLabel, resolveLayout } from "../../../label/layout/layoutSpec.js";

// Label size from the chat ("same label, other dimensions"): read the sizes and
// a label's layout; resize a stored label; upload a label file and resize it
// (rebuild — read into a label, the person confirms the fields, then laid out —
// or scale). Every write is behind a confirmation card. The finished card links
// to the label's Layout & size tab and carries the layout (PDF + preview).

const userIdOf = (ctx) => (ctx.actor.kind === "user" ? ctx.actor.id : null);
const PRESET_KEYS = SIZE_PRESETS.map((p) => p.key);
const sizeArgs = {
  preset: z.enum(PRESET_KEYS).optional().describe(`A standard size (width × height mm): ${SIZE_PRESETS.map((p) => `${p.key} = ${p.label}`).join(", ")}`),
  widthMm: z.number().min(20).max(400).optional().describe("Custom width in mm (10 cm = 100). With heightMm, instead of a preset."),
  heightMm: z.number().min(20).max(400).optional().describe("Custom height in mm (12 cm = 120)."),
  minFontPt: z.number().min(4).max(16).optional().describe("Smallest text allowed (default 6 pt, or the country's rule)"),
};
const sizeOf = (a) => ({ ...(a.preset ? { preset: a.preset } : {}), ...(a.widthMm ? { widthMm: a.widthMm } : {}), ...(a.heightMm ? { heightMm: a.heightMm } : {}), ...(a.minFontPt ? { minFontPt: a.minFontPt } : {}) });
function needSize(a) {
  if (!a.preset && !(a.widthMm && a.heightMm)) throw new ToolError("Which size? A preset (e.g. 100x120) or both widthMm and heightMm.", "size_required");
}
const layoutResult = (l, labelId) => ({ id: l.id, version: l.version, size: l.size, widthMm: l.widthMm, heightMm: l.heightMm, fits: l.fit?.fits !== false, hasPdf: l.hasPdf, previewUrl: l.previewUrl, pdfUrl: l.pdfUrl, fit: fitSummary(l.fit), labelId });
function fitSummary(fit = {}) {
  if (fit.mode === "scale") return { scalePct: fit.scalePct, smallestTextPt: fit.smallestTextPt, textMeasurable: fit.textMeasurable, warnings: fit.warnings };
  return { fits: fit.fits, fontPt: fit.fontPt, columns: fit.columns, smallestTextPt: fit.smallestTextPt ?? null, overflow: (fit.sections || []).filter((s) => s.status === "overflow").map((s) => s.message), warnings: fit.warnings || [] };
}
async function labelOf(labelId, ctx) {
  const l = await prisma.generatedLabel.findFirst({ where: { id: labelId, companyId: ctx.companyId }, select: { id: true } });
  if (!l) throw new ToolError("Label not found!", "not_found");
  return l;
}

defineTool({
  name: "list_label_sizes",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Reading the label sizes",
  description: "The standard printable label sizes (presets, width × height in mm), the label sections in their default order, and the default margins and minimum text size (6 pt unless a country rule says otherwise).",
  args: z.object({}),
  companyArg: false,
  run: async () => listSizes(),
});

defineTool({
  name: "get_label_layout",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Reading the label's layout",
  description: "A stored label's printable layout: its current size, every saved size version, and each one's fit (font size used, columns, sections that didn't fit), with links to the PDF and preview. Use it before resize_label to say the old size.",
  args: z.object({ labelId: id("label") }),
  run: async (a, ctx) => {
    const out = await getLabelLayout(a.labelId, { companyId: ctx.companyId || undefined });
    return { label: out.label, current: out.current ? layoutResult(out.current, a.labelId) : null, versions: out.versions.map((v) => ({ version: v.version, size: v.size, fits: v.fit?.fits !== false, createdAt: v.createdAt })), ref: { type: "label", id: a.labelId, name: out.label.name } };
  },
});

defineTool({
  name: "resize_label",
  module: "labels",
  risk: "write",
  permissions: ["update_labels"],
  label: "Changing the label's size",
  description:
    "Proposes laying a stored label out at a new size (the same content, re-laid out): preset (e.g. 100x120 for 10×12 cm) or widthMm + heightMm. The card shows old size → new size, whether it fits, the font used and the smallest text. " +
    "Text is never cut or set below the minimum: if it doesn't fit, the card says which section needs how many mm more and no PDF is made. Saved as a new layout version with its PDF.",
  args: z.object({ labelId: id("label"), ...sizeArgs }),
  guard: (a) => needSize(a),
  preview: async (a, ctx) => {
    needSize(a);
    await labelOf(a.labelId, ctx);
    const current = await getLabelLayout(a.labelId, { companyId: ctx.companyId });
    const label = await prisma.generatedLabel.findUnique({ where: { id: a.labelId }, select: { id: true, companyId: true, country: true, language: true, labelData: true, currentVersion: true } });
    const base = current.current ? { ...current.current.settings, widthMm: current.current.widthMm, heightMm: current.current.heightMm } : undefined;
    const r = await layOut(label, sizeOf(a), { base });
    return {
      title: `Resize ${current.label.name} to ${sizeLabel(r.layout)}`,
      summary: r.fit.fits
        ? `The label is laid out again at ${sizeLabel(r.layout)}${r.fit.fontPt < r.layout.startFontPt || r.fit.columns > 1 ? ` (font ${r.fit.fontPt} pt${r.fit.columns > 1 ? `, ${r.fit.columns} columns` : ""})` : ""} and saved as a new version with its PDF.`
        : `It does NOT fit at ${sizeLabel(r.layout)} even at ${r.layout.minFontPt} pt — no PDF would be made. Choose a larger size.`,
      runLabel: "Save size",
      details: [
        { label: "Label", value: current.label.name },
        { label: "Size", value: `${current.current ? current.current.size : "no saved size yet"} → ${sizeLabel(r.layout)}` },
        { label: "Fit", value: r.fit.fits ? `fits · ${r.fit.fontPt} pt${r.fit.columns > 1 ? ` · ${r.fit.columns} columns` : ""}` : r.fit.sections.filter((s) => s.status === "overflow").map((s) => s.message).join("; ") },
        { label: "Smallest text", value: r.fit.smallestTextPt ? `${r.fit.smallestTextPt} pt (minimum ${r.layout.minFontPt} pt)` : `— (minimum ${r.layout.minFontPt} pt)` },
        ...(r.empty.length ? [{ label: "Not on the label (empty)", value: r.empty.join(", ") }] : []),
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    await labelOf(a.labelId, ctx);
    const l = await saveLabelLayout(a.labelId, sizeOf(a), { companyId: ctx.companyId, userId: userIdOf(ctx) });
    return { labelLayout: layoutResult(l, a.labelId), link: `/labels/detail/${a.labelId}?tab=layout`, ref: { type: "label", id: a.labelId, name: `label ${l.size}` } };
  },
});

defineTool({
  name: "upload_label_and_resize",
  module: "labels",
  risk: "write",
  permissions: ["update_labels"],
  label: "Uploading the label",
  description:
    "Proposes resizing a label FILE the user attached (PDF, PNG or JPEG) — only when the user asks to change its size; a label they only want to keep or use as a reference goes to upload_label. " +
    "mode: scale (default — the original design placed on the new page, proportions kept; reports the scale and the smallest text size; stretch only if the user insists, it distorts the text) " +
    "or rebuild (only on the user's explicit choice — the text is read by AI and re-typed in a plain layout WITHOUT the original design; the user checks the fields, then it is laid out at the new size). " +
    "Default scale. After a rebuild upload finishes, call get_label_upload, show the user the fields read and the empty ones, and ask them to confirm before confirm_label_upload.",
  args: z.object({
    attachmentId: z.string().uuid().describe("The id of the label file attached in this conversation"),
    mode: z.enum(["rebuild", "scale"]).optional(),
    ...sizeArgs,
    stretch: z.boolean().optional().describe("scale only: fill the page, distorting the text (only on the user's explicit request)"),
    productId: z.string().uuid().optional().describe("Optional: the product the label is for (search_products)"),
    country: z.string().length(2).optional().describe("Optional: the label's country (ISO alpha-2), for its minimum text size rule"),
  }),
  guard: (a) => needSize(a),
  preview: async (a, ctx) => {
    needSize(a);
    const att = await loadAttachment(a.attachmentId, { conversationId: ctx.conversationId, companyId: ctx.companyId });
    if (!["application/pdf", "image/png", "image/jpeg"].includes(att.mimeType)) throw new ToolError(`${att.name} is ${att.mimeType}; a label to resize must be a PDF, PNG or JPEG`, "bad_type");
    const target = resolveLayout(sizeOf(a));
    const company = await prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } });
    const product = a.productId ? await prisma.product.findFirst({ where: { id: a.productId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.productId && !product) throw new ToolError("Product not found!", "not_found");
    const mode = a.mode || "scale";
    return {
      title: `Resize ${att.name} to ${sizeLabel(target)}`,
      summary:
        mode === "rebuild"
          ? "The label's text is read by AI and re-typed in a plain layout — the original design (artwork, colours, logo) is NOT kept. Nothing is filled in that the file doesn't show; you check the fields next, then it is laid out at the new size."
          : `The original design is placed on a ${sizeLabel(target)} page, proportions kept${a.stretch ? " — STRETCHED to fill: the text will be distorted" : ""}.`,
      runLabel: mode === "rebuild" ? "Read the label" : "Scale",
      details: [
        { label: "File", value: att.name },
        { label: "Mode", value: mode === "rebuild" ? "Rebuild — re-typed without the original design" : a.stretch ? "Scale — stretch to fill (distorts text)" : "Keep the original design, just scale" },
        { label: "Size", value: sizeLabel(target) },
        { label: "Company", value: company?.name || ctx.companyId },
        ...(product ? [{ label: "Product", value: product.name }] : []),
      ],
      aiCalls: mode === "rebuild" ? "Reads the label · about 1 AI call" : null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const att = await loadAttachment(a.attachmentId, { conversationId: ctx.conversationId, companyId: ctx.companyId });
    const file = await attachmentFile(att);
    const out = await uploadLabelFile({ buffer: file.buffer, originalName: att.name, mimeType: att.mimeType, companyId: ctx.companyId, productId: a.productId || null, mode: a.mode || "scale", layout: sizeOf(a), stretch: !!a.stretch, country: a.country || null, userId: userIdOf(ctx) });
    if (out.layout) return { uploadId: out.upload.id, labelLayout: layoutResult(out.layout, null), note: "Scaled. Tell the user the scale %, the smallest text size (or that it can't be measured) and any warning." };
    return { uploadId: out.upload.id, taskId: out.taskId, note: "Reading the label. When it finishes, call get_label_upload and show the user the fields read and the empty ones; ask them to confirm (or correct) before confirm_label_upload." };
  },
});

defineTool({
  name: "get_label_upload",
  module: "labels",
  risk: "read",
  permissions: ["read_labels"],
  label: "Reading the uploaded label",
  description: "An uploaded label to resize: its status (extracting / review / ready / failed), the fields read from the file (rebuild) — each with its value — the fields the file didn't show (empty, listed), and the layouts made from it (size, fit, PDF).",
  args: z.object({ uploadId: z.string().uuid() }),
  run: async (a, ctx) => {
    const u = await getUpload(a.uploadId, { companyId: ctx.companyId || undefined });
    const show = (v) => (v === null || v === undefined ? null : Array.isArray(v) ? v.map((x) => x?.translations?.en ?? x?.primary ?? x).map((x) => (typeof x === "object" ? JSON.stringify(x) : x)) : typeof v === "object" ? v.translations?.en ?? (v.list ? v.list.join(", ") : JSON.stringify(v)) : v);
    return {
      status: u.upload.status,
      mode: u.upload.mode,
      error: u.upload.error,
      fieldsRead: u.label ? u.label.fields.filter((f) => f.read).map((f) => ({ field: f.field, value: show(f.value) })) : [],
      empty: u.label ? u.label.missing : [],
      confirmed: !!u.label?.confirmedAt,
      layouts: u.layouts.map((l) => layoutResult(l, u.upload.labelId)),
      ...(u.label ? { ref: { type: "label", id: u.label.id, name: u.upload.originalName || "uploaded label" } } : {}),
    };
  },
});

defineTool({
  name: "confirm_label_upload",
  module: "labels",
  risk: "write",
  permissions: ["update_labels"],
  label: "Laying out the label",
  description:
    `Proposes confirming the fields read from an uploaded label (rebuild) — with any corrections the USER gave, fields: { field: value } (field one of ${REVIEW_FIELDS.join(", ")}) — and laying it out at the size chosen at upload (or preset / widthMm+heightMm). ` +
    "Only after the user has seen the fields and said they are right. The result has the preview, the PDF and the fit warnings.",
  args: z.object({ uploadId: z.string().uuid(), fields: z.record(z.string(), z.string().max(4000)).optional(), ...sizeArgs }),
  preview: async (a, ctx) => {
    const u = await getUpload(a.uploadId, { companyId: ctx.companyId });
    if (u.upload.mode !== "rebuild" || !u.label) throw new ToolError(u.upload.status === "extracting" ? "The label is still being read; wait for it to finish." : "This upload has no label to confirm.", "not_ready");
    const bad = Object.keys(a.fields || {}).filter((f) => !REVIEW_FIELDS.includes(f));
    if (bad.length) throw new ToolError(`These fields can't be set: ${bad.join(", ")}`, "bad_field");
    const size = a.preset || a.widthMm ? sizeLabel(resolveLayout(sizeOf(a))) : u.task?.id ? "the size chosen at upload" : "the default size";
    return {
      title: `Lay out ${u.upload.originalName || "the label"}`,
      summary: `The fields read from the file${Object.keys(a.fields || {}).length ? " (with your corrections)" : ""} are confirmed and the label is laid out at ${size}. Empty fields stay empty.`,
      runLabel: "Confirm and lay out",
      details: [
        { label: "Fields read", value: String(u.label.fields.filter((f) => f.read).length) },
        ...Object.entries(a.fields || {}).map(([k, v]) => ({ label: `Correction: ${k}`, value: v })),
        { label: "Empty (not on the file)", value: u.label.missing.filter((f) => !(a.fields || {})[f]).join(", ") || "none" },
        { label: "Size", value: size },
      ],
      aiCalls: null,
      missing: [],
    };
  },
  run: async (a, ctx) => {
    const out = await confirmRebuild(a.uploadId, { fields: a.fields || {}, layout: a.preset || a.widthMm ? sizeOf(a) : null }, { companyId: ctx.companyId, userId: userIdOf(ctx) });
    return { labelLayout: layoutResult(out.layout, out.labelId), empty: out.missing, link: `/labels/detail/${out.labelId}?tab=layout`, ref: { type: "label", id: out.labelId, name: `label ${out.layout.size}` } };
  },
});
