import { z } from "zod";
import { defineTool } from "../registry.js";
import { ToolError } from "../access.js";
import { prisma } from "../../../../lib/prisma.js";
import { id } from "./common.js";
import { loadAttachment, attachmentFile } from "../../attachments.js";
import { listSizes, getLabelLayout, layOut, saveLabelLayout } from "../../../label/layout/layoutService.js";
import { uploadLabelFile, getUpload, confirmRebuild, REVIEW_FIELDS, labelFileType } from "../../../label/layout/labelUploadService.js";
import { designsOfLabel, previewResize, saveResize, previewFile, fitLinesAr } from "../../../label/layout/designResizeService.js";
import { SIZE_PRESETS, sizeLabel, resolveLayout } from "../../../label/layout/layoutSpec.js";

// Label size from the chat ("same label, other dimensions"): read the sizes and
// a label's layout; resize a stored label; upload a label file and resize it.
// The default always keeps the original design (smart: the file's own artwork,
// fonts and words at the new size). "A new label from the text (without the
// design)" — rebuild for a file, text for a stored label — only when the user
// asks for it. Every write is behind a confirmation card. The finished card
// carries the layout (preview + PDF) and links to the label's Layout & size tab.

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
  if (fit.mode === "smart") {
    const lines = fitLinesAr(fit);
    return { mode: "smart", fits: fit.fits, scalePct: fit.scalePct, smallestTextPt: fit.smallestTextPt, minFontPt: fit.minFontPt, overflow: [], warnings: lines.filter((l) => l.startsWith("⚠") || l.startsWith("اقتراح")), summary: lines };
  }
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
    "Proposes a stored label at a new size: preset (e.g. 100x120 for 10×12 cm) or widthMm + heightMm. " +
    "mode smart (the default when the label has its design file): the label's ORIGINAL design at the new size — same artwork, fonts and words; the card shows whether it fits, the scale and the smallest text. " +
    "mode text: a NEW label laid out from the label's text WITHOUT the original design — only when the user asks for a new label from the text, or the label has no design file. " +
    "Text is never cut or set below the minimum: if it doesn't fit, the card says what needs more room and no PDF is made. Saved as a new version with its PDF.",
  args: z.object({ labelId: id("label"), mode: z.enum(["smart", "text"]).optional().describe("smart = keep the design (default when there is a design file); text = new label from the text, without the design"), ...sizeArgs }),
  guard: (a) => needSize(a),
  preview: async (a, ctx) => {
    needSize(a);
    await labelOf(a.labelId, ctx);
    const [design] = await designsOfLabel(a.labelId, ctx.companyId);
    const mode = a.mode || (design ? "smart" : "text");
    if (mode === "smart") {
      if (!design) throw new ToolError("This label has no design file yet. Ask the user to attach the label's PDF or .ai design (upload_label_and_resize with labelId), or — only if they want it — a new label from the text (mode text).", "no_design");
      const target = resolveLayout(sizeOf(a));
      const [r] = (await previewResize(design.uploadId, { sizes: [{ widthMm: target.widthMm, heightMm: target.heightMm }], minFontPt: a.minFontPt }, { companyId: ctx.companyId })).results;
      return {
        title: `${design.originalName || "الليبل"} → ${r.size}`,
        summary: r.fit.fits ? `نفس التصميم الأصلي على مقاس ${r.size}، ويُحفظ كنسخة جديدة مع ملف PDF.` : `لا يتّسع على ${r.size} — لن يُعمل PDF. ${fitLinesAr(r.fit).filter((l) => l.startsWith("اقتراح")).join(" ")}`,
        runLabel: "احفظ المقاس",
        details: [
          { label: "الطريقة", value: "تغيير المقاس مع الحفاظ على التصميم" },
          { label: "المقاس", value: `${design.layouts[0]?.size || "الأصلي"} → ${r.size}` },
          ...fitLinesAr(r.fit).map((l, i) => ({ label: i ? "" : "النتيجة", value: l })),
        ],
        aiCalls: null,
        missing: [],
      };
    }
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
    const [design] = await designsOfLabel(a.labelId, ctx.companyId);
    if ((a.mode || (design ? "smart" : "text")) === "smart") {
      if (!design) throw new ToolError("This label has no design file yet.", "no_design");
      const target = resolveLayout(sizeOf(a));
      const { layouts } = await saveResize(design.uploadId, { sizes: [{ widthMm: target.widthMm, heightMm: target.heightMm }], minFontPt: a.minFontPt }, { companyId: ctx.companyId, userId: userIdOf(ctx) });
      return { labelLayout: layoutResult(layouts[0], a.labelId), link: `/labels/detail/${a.labelId}?tab=layout`, ref: { type: "label", id: a.labelId, name: `label ${layouts[0].size}` } };
    }
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
    "Proposes resizing a label FILE the user attached (PDF, Illustrator .ai, PNG or JPEG) — only when the user asks to change its size; a label they only want to keep or use as a reference goes to upload_label. " +
    "mode: smart (DEFAULT — the original design at the new size: same artwork, fonts and words; bands stretch, logos keep their proportions, text re-wraps only when needed and never goes under the minimum; the card shows the result before anything is saved) " +
    "· scale (the whole file placed on the new page, proportions kept, white around it; stretch only if the user insists, it distorts the text) " +
    "· rebuild (ONLY when the user explicitly asks for a new label from the text — the text is read by AI and re-typed in a plain layout WITHOUT the original design; the user checks the fields, then it is laid out). " +
    "A PNG/JPEG can only be scaled whole. labelId: the label this design belongs to, when the user is on a label. After a rebuild upload finishes, call get_label_upload, show the user the fields read and the empty ones, and ask them to confirm before confirm_label_upload.",
  args: z.object({
    attachmentId: z.string().uuid().describe("The id of the label file attached in this conversation"),
    mode: z.enum(["smart", "scale", "rebuild"]).optional(),
    labelId: z.string().uuid().optional().describe("Optional: the stored label this design file belongs to"),
    ...sizeArgs,
    stretch: z.boolean().optional().describe("scale only: fill the page, distorting the text (only on the user's explicit request)"),
    productId: z.string().uuid().optional().describe("Optional: the product the label is for (search_products)"),
    country: z.string().length(2).optional().describe("Optional: the label's country (ISO alpha-2), for its minimum text size rule"),
  }),
  guard: (a) => needSize(a),
  preview: async (a, ctx) => {
    needSize(a);
    const att = await loadAttachment(a.attachmentId, { conversationId: ctx.conversationId, companyId: ctx.companyId });
    const isAi = /\.ai$/i.test(att.name || "");
    if (!["application/pdf", "image/png", "image/jpeg"].includes(att.mimeType) && !isAi) throw new ToolError(`${att.name} is ${att.mimeType}; a label to resize must be a PDF, .ai, PNG or JPEG`, "bad_type");
    const target = resolveLayout(sizeOf(a));
    const company = await prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } });
    const product = a.productId ? await prisma.product.findFirst({ where: { id: a.productId, companyId: ctx.companyId }, select: { name: true } }) : null;
    if (a.productId && !product) throw new ToolError("Product not found!", "not_found");
    const mode = a.mode || "smart";
    if (a.labelId) await labelOf(a.labelId, ctx);
    if (mode === "smart") {
      const file = await attachmentFile(att);
      let type;
      try {
        type = labelFileType(att.mimeType, att.name, file.buffer);
      } catch (err) {
        throw new ToolError(err.message, "bad_type");
      }
      const r = type === "application/pdf" ? (await previewFile(file.buffer, { sizes: [{ widthMm: target.widthMm, heightMm: target.heightMm }], minFontPt: a.minFontPt }, { companyId: ctx.companyId, country: a.country || null })).results[0] : null;
      return {
        title: `${att.name} → ${sizeLabel(target)}`,
        summary: !r ? `صورة: تُكبَّر/تُصغَّر كما هي (بنفس النسب) على مقاس ${sizeLabel(target)}.` : r.fit.fits ? `نفس التصميم الأصلي على مقاس ${sizeLabel(target)}، بنفس الكلمات والأرقام، ويُحفظ مع ملف PDF.` : `لا يتّسع على ${sizeLabel(target)} — لن يُعمل PDF. ${fitLinesAr(r.fit).filter((l) => l.startsWith("اقتراح")).join(" ")}`,
        runLabel: "غيّر المقاس",
        details: [
          { label: "File", value: att.name },
          { label: "Mode", value: "تغيير المقاس مع الحفاظ على التصميم" },
          { label: "Size", value: sizeLabel(target) },
          { label: "Company", value: company?.name || ctx.companyId },
          ...(product ? [{ label: "Product", value: product.name }] : []),
          ...(r ? fitLinesAr(r.fit).map((l, i) => ({ label: i ? "" : "النتيجة", value: l })) : []),
        ],
        aiCalls: null,
        missing: [],
      };
    }
    return {
      title: `Resize ${att.name} to ${sizeLabel(target)}`,
      summary:
        mode === "rebuild"
          ? "The label's text is read by AI and re-typed in a plain layout — the original design (artwork, colours, logo) is NOT kept. Nothing is filled in that the file doesn't show; you check the fields next, then it is laid out at the new size."
          : `The original design is placed on a ${sizeLabel(target)} page, proportions kept${a.stretch ? " — STRETCHED to fill: the text will be distorted" : ""}.`,
      runLabel: mode === "rebuild" ? "Read the label" : "Scale",
      details: [
        { label: "File", value: att.name },
        { label: "Mode", value: mode === "rebuild" ? "ليبل جديد من النص (بدون التصميم)" : a.stretch ? "Scale — stretch to fill (distorts text)" : "Keep the original design, just scale" },
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
    const out = await uploadLabelFile({ buffer: file.buffer, originalName: att.name, mimeType: att.mimeType, companyId: ctx.companyId, productId: a.productId || null, labelId: a.labelId || null, mode: a.mode || "smart", layout: sizeOf(a), stretch: !!a.stretch, country: a.country || null, userId: userIdOf(ctx) });
    if (out.layout)
      return {
        uploadId: out.upload.id,
        labelLayout: layoutResult(out.layout, a.labelId || null),
        ...(a.labelId ? { link: `/labels/detail/${a.labelId}?tab=layout` } : {}),
        note: out.layout.mode === "smart" ? "Done. Tell the user in their language: whether it fits, the smallest text size, any warning or suggestion (labelLayout.fit.summary); the preview and PDF are on the card." : "Scaled. Tell the user the scale %, the smallest text size (or that it can't be measured) and any warning.",
      };
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
