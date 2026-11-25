// "Change the size, keep the design": an uploaded designed label (PDF / .ai) at
// other sizes by the label-resizer service (docker/label-resizer, PyMuPDF).
//   same proportions  → the whole design scaled (exact), smallest text reported;
//   other proportions → re-arranged: every word, number and unit of the original
//                       still in the text layer, legible text never under the
//                       minimum, the page exactly the size asked (bleed: TrimBox);
//   doesn't fit       → no PDF, the block and a size that fits are named;
//   API               → upload without a mode keeps the design; the design only
//                       (sizes: []) for the editor; preview (nothing saved); save
//                       several sizes at once (one version + PDF + PNG each);
//                       a block's font size set by hand never goes under the
//                       minimum; .ai saved PDF-compatible accepted, other .ai
//                       refused; an image only scaled; tenant isolation; the
//                       label's Layout tab lists its designs;
//   assistant         → resize_label / upload_label_and_resize keep the design by
//                       default; "rebuild" only when asked.
// Needs `npm run dev:test` (API, workers, label-resizer on LABEL_RESIZER_URL).
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asCompany, createCompany, cleanupCompany, form } from "./certificates-v2/helpers.js";
import { designedLabelPdf, gradientPng, DESIGN_WORDS_SAMPLE } from "./fixtures/designLabel.js";
import { SAMPLE_LABEL_DATA } from "./fixtures/labelLayoutSample.js";
import * as resizer from "../src/services/label/layout/labelResizerClient.js";
import { parseResizeInput, fitOf, fitLinesAr } from "../src/services/label/layout/designResizeService.js";
import { labelFileType } from "../src/services/label/layout/labelUploadService.js";
import * as registry from "../src/services/assistant/registry/index.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as actions from "../src/services/assistant/actions.js";
import { storeAttachments } from "../src/services/assistant/attachments.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const PT_PER_MM = 72 / 25.4;
const near = (a, b, tol = 0.05) => Math.abs(a - b) <= tol;

/** → { words: Map word→count, sizes: [pt] } of a PDF's first page */
async function textLayer(buf) {
  const doc = await getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const words = new Map();
    const sizes = [];
    for (const it of content.items) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      for (const w of it.str.split(/\s+/).filter(Boolean)) words.set(w, (words.get(w) || 0) + 1);
      sizes.push(Math.hypot(it.transform[2], it.transform[3]));
    }
    return { words, sizes };
  } finally {
    await doc.destroy();
  }
}
const diffWords = (a, b) => {
  const out = [];
  for (const [w, n] of a) if ((b.get(w) || 0) !== n) out.push(`${w}:${n}→${b.get(w) || 0}`);
  for (const [w, n] of b) if (!a.has(w)) out.push(`+${w}:${n}`);
  return out;
};
async function boxes(buf) {
  const p = (await PDFDocument.load(buf)).getPage(0);
  const mm = (b) => ({ w: b.width / PT_PER_MM, h: b.height / PT_PER_MM });
  return { media: mm(p.getMediaBox()), trim: mm(p.getTrimBox()) };
}

async function main() {
  console.log("🧪 Labels — resize keeping the original design\n");
  const design = await designedLabelPdf();
  const original = await textLayer(design);

  console.log("Input rules (no service needed)");
  const p = parseResizeInput({ sizes: [{ preset: "100x150" }, { widthMm: 100, heightMm: 150 }, { widthMm: 70, heightMm: 100 }] });
  assert("sizes: a preset and the same size typed are one size; order kept", p.sizes.length === 2 && p.sizes[0].widthMm === 100 && p.sizes[1].heightMm === 100, p.sizes);
  let threw = null;
  try {
    parseResizeInput({ sizes: Array.from({ length: 9 }, (_, i) => ({ widthMm: 50 + i, heightMm: 80 })) });
  } catch (e) {
    threw = e;
  }
  assert("more than 8 sizes at once → 400", threw?.statusCode === 400, threw?.message);
  threw = null;
  try {
    parseResizeInput({ sizes: [{ widthMm: 100, heightMm: 120 }], overrides: { "../x": { fontPt: 8 } } });
  } catch (e) {
    threw = e;
  }
  assert("an override names a block id only (t12 / g3)", threw?.statusCode === 400, threw?.message);
  assert(".ai saved PDF-compatible → read as a PDF", labelFileType("application/postscript", "x.ai", Buffer.concat([Buffer.from("%PDF-1.6\n"), design.subarray(9)])) === "application/pdf");
  threw = null;
  try {
    labelFileType("application/postscript", "old.ai", Buffer.from("%!PS-Adobe-3.0 EPSF"));
  } catch (e) {
    threw = e;
  }
  assert(".ai without PDF inside → 400 telling how to save it", threw?.statusCode === 400 && /PDF Compatible/.test(threw.message), threw?.message);
  const ar = fitLinesAr(fitOf({ fit: false, mode: "smart", report: { scale: 0.8, overflow: [{ id: "t3", role: "paragraph", text: "Indications", overflowMm: 4.2 }], suggestions: [{ widthMm: 110, heightMm: 120 }], blocks: [], warnings: [] } }, { minFontPt: 6, rule: null, bleedMm: 0, cropMarks: false }));
  assert("the report in plain Arabic: no PDF, which block, by how much, a size that fits", /لم يُعمل PDF/.test(ar[0]) && ar.some((l) => /فقرة «Indications» ينقصه 4.2 مم/.test(l)) && ar.some((l) => /11 × 12 سم/.test(l)), ar);
  assert("…no technical words in it", !ar.join(" ").match(/overflow|block|smart|scale|rewrap|anchor|pt\b/i), ar);

  console.log("\nThe engine (label-resizer service)");
  const d = await resizer.describe(design);
  assert("describe: the page in mm, blocks with roles (product name, table, paragraph, image)", near(d.pageMm.width, 100) && near(d.pageMm.height, 150) && ["product_name", "table", "paragraph"].every((r) => d.blocks.some((b) => b.role === r)) && d.blocks.some((b) => b.id.startsWith("g")), d.blocks?.map((b) => `${b.id}:${b.role}`));
  const [same, wide, tall, tiny] = await resizer.resize(design, { sizes: [{ widthMm: 66.67, heightMm: 100 }, { widthMm: 100, heightMm: 120 }, { widthMm: 70, heightMm: 150 }, { widthMm: 30, heightMm: 30 }], minFontPt: 6 });
  assert("same proportions (10×15 → 6.67×10) → the whole design scaled", same.mode === "scale" && same.fit && !!same.pdf, { mode: same.mode, fit: same.fit });
  const sb = await boxes(same.pdf);
  assert(`…page exactly 66.67 × 100 mm (${sb.media.w.toFixed(2)} × ${sb.media.h.toFixed(2)})`, near(sb.media.w, 66.67) && near(sb.media.h, 100), sb);
  const sl = await textLayer(same.pdf);
  assert("…text layer: 0 missing, 0 extra words", diffWords(original.words, sl.words).length === 0, diffWords(original.words, sl.words));
  assert("…smallest text after scaling reported, and warned under 6 pt", same.report.smallestFontPt < 6 && same.report.warnings.some((w) => w.code === "below_min"), same.report);
  for (const [name, r, w, h] of [["10×12 (shorter)", wide, 100, 120], ["7×15 (narrower)", tall, 70, 150]]) {
    assert(`${name}: re-arranged (not a plain scale), fits, a PDF`, r.mode === "smart" && r.fit && !!r.pdf, { mode: r.mode, overflow: r.report.overflow });
    if (!r.pdf) continue;
    const b = await boxes(r.pdf);
    assert(`${name}: page exactly ${w} × ${h} mm (${b.media.w.toFixed(2)} × ${b.media.h.toFixed(2)})`, near(b.media.w, w) && near(b.media.h, h), b);
    const t = await textLayer(r.pdf);
    const diff = diffWords(original.words, t.words);
    assert(`${name}: every word, number and unit of the original, none added`, diff.length === 0, diff);
    assert(`${name}: sample words kept exactly (${DESIGN_WORDS_SAMPLE.join(", ")})`, DESIGN_WORDS_SAMPLE.every((x) => t.words.has(x)), [...t.words.keys()]);
    assert(`${name}: no legible text under 6 pt (smallest ${Math.min(...t.sizes).toFixed(2)})`, Math.min(...t.sizes) >= 5.99 || Math.min(...original.sizes) < 6, t.sizes);
    assert(`${name}: the image keeps its proportions (block g* scaled uniformly)`, r.report.blocks.filter((x) => x.id.startsWith("g")).every((x) => x.scale > 0), r.report.blocks.filter((x) => x.id.startsWith("g")));
  }
  assert("3×3 cm: doesn't fit → no PDF, the block named, a size suggested", !tiny.fit && tiny.pdf === null && tiny.report.overflow.length > 0 && tiny.report.suggestions.some((x) => x.widthMm && x.heightMm) && !!tiny.png, tiny.report.overflow);
  const [bleed] = await resizer.resize(design, { sizes: [{ widthMm: 100, heightMm: 120 }], bleedMm: 3, cropMarks: true });
  const bb = await boxes(bleed.pdf);
  assert(`bleed 3 mm + crop marks: TrimBox 100 × 120 mm, the sheet larger (${bb.media.w.toFixed(1)} × ${bb.media.h.toFixed(1)})`, near(bb.trim.w, 100) && near(bb.trim.h, 120) && bb.media.w > 106 && bb.media.h > 126, bb);

  console.log("\nAPI");
  const coA = await createCompany(`drA${s}`);
  const coB = await createCompany(`drB${s}`);
  const A = asCompany(coA.id);
  const B = asCompany(coB.id);
  try {
    const label = await prisma.generatedLabel.create({ data: { companyId: coA.id, inputPayload: {}, labelData: SAMPLE_LABEL_DATA, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "EG", language: "en", status: "draft" } });
    let r = await api("POST", "/label-uploads", A, form({ layout: JSON.stringify({ preset: "100x120" }) }, { buffer: design, name: "h-durin.pdf", type: "application/pdf" }));
    assert("upload, no mode → the design kept (smart), 201, one version with a PDF", r.status === 201 && r.data?.data?.upload?.mode === "smart" && r.data.data.layout?.mode === "smart" && r.data.data.layout.hasPdf, r.data);
    r = await api("POST", "/label-uploads", A, form({ sizes: "[]", labelId: label.id }, { buffer: design, name: "H-DURIN 1L.ai", type: "application/postscript" }));
    const up = r.data?.data?.upload;
    assert(".ai (PDF-compatible) for a label, sizes [] → kept for the editor: ready, no version yet", r.status === 201 && up?.status === "ready" && up.mimeType === "application/pdf" && r.data.data.layouts.length === 0, r.data);
    r = await api("POST", "/label-uploads", A, form({ labelId: label.id, mode: "rebuild", layout: JSON.stringify({ preset: "100x120" }) }, { buffer: design, name: "x.pdf", type: "application/pdf" }));
    assert("a new label from the text is never added to an existing label → 400", r.status === 400, r.data);

    r = await api("GET", `/label-uploads/${up.id}/design`, A);
    assert("design: the original as a picture, its blocks, the minimum", r.status === 200 && /^data:image\/png;base64,/.test(r.data.data.originalDataUrl) && r.data.data.blocks.length > 5 && r.data.data.minFontPt >= 6, r.data?.message);
    const para = r.data.data.blocks.find((b) => b.role === "paragraph");
    r = await api("GET", `/label-uploads/${up.id}/design`, B);
    assert("another company → 404", r.status === 404);

    const before = await prisma.labelLayout.count({ where: { uploadId: up.id } });
    r = await api("POST", `/label-uploads/${up.id}/preview`, A, { sizes: [{ preset: "100x120" }, { preset: "70x100" }] });
    const res = r.data?.data?.results || [];
    assert("preview of 2 sizes: a picture and the report each", r.status === 200 && res.length === 2 && res.every((x) => /^data:image\/png/.test(x.previewDataUrl) && x.fit.mode === "smart"), r.data?.message);
    assert("…nothing saved by a preview", (await prisma.labelLayout.count({ where: { uploadId: up.id } })) === before);
    r = await api("POST", `/label-uploads/${up.id}/preview`, A, { sizes: [{ preset: "100x120" }], overrides: { [para.id]: { fontPt: 2 } } });
    const ed = r.data?.data?.results?.[0]?.fit;
    assert("a block's font set to 2 pt by hand → raised to the minimum, and said so", ed?.blocks.find((b) => b.id === para.id)?.fontPt >= 6 && ed.warnings.some((w) => w.code === "font_raised_to_min"), ed?.blocks?.find((b) => b.id === para.id));
    r = await api("POST", `/label-uploads/${up.id}/preview`, B, { sizes: [{ preset: "100x120" }] });
    assert("another company can't preview it → 404", r.status === 404);

    r = await api("POST", `/label-uploads/${up.id}/resize`, A, { sizes: [{ preset: "100x120" }, { preset: "100x100" }], bleedMm: 3, cropMarks: true });
    const saved = r.data?.data?.layouts || [];
    assert("save 2 sizes at once → 2 versions (v1, v2), each with PDF + PNG", r.status === 201 && saved.length === 2 && saved.every((l) => l.hasPdf && l.previewUrl && l.mode === "smart") && saved.map((l) => l.version).join() === "1,2", r.data);
    const pdf = await api("GET", `/label-layouts/${saved[0].id}/pdf`, A);
    const pb = await boxes(pdf.buffer);
    assert(`the saved PDF: TrimBox 100 × 120 mm with the bleed around it`, pdf.status === 200 && near(pb.trim.w, 100) && near(pb.trim.h, 120) && pb.media.w > 106, pb);
    const png = await api("GET", `/label-layouts/${saved[0].id}/preview.png`, A);
    assert("the saved PNG preview", png.status === 200 && png.buffer?.subarray(1, 4).toString() === "PNG");
    assert("another company can't download it → 404", (await api("GET", `/label-layouts/${saved[0].id}/pdf`, B)).status === 404);

    r = await api("GET", `/labels/${label.id}/layout`, A);
    const des = r.data?.data?.designs || [];
    assert("the label's Layout tab lists its design and the sizes saved from it", r.status === 200 && des.length === 1 && des[0].uploadId === up.id && des[0].layouts.length === 2, des);

    r = await api("POST", "/label-uploads", A, form({ layout: JSON.stringify({ preset: "100x120" }) }, { buffer: gradientPng(120, 180), name: "photo.png", type: "image/png" }));
    assert("an image: only scaled whole (proportions kept)", r.status === 201 && r.data?.data?.layout?.mode === "scale" && r.data.data.layout.fit.stretch === false, r.data);
    r = await api("POST", "/label-uploads", A, form({}, { buffer: Buffer.from("%!PS-Adobe-3.0"), name: "old.ai", type: "application/postscript" }));
    assert(".ai without PDF inside → 400", r.status === 400 && /PDF Compatible/.test(r.data?.message || ""), r.data);

    console.log("\nAssistant");
    const actor = { kind: "company", id: coA.id, name: coA.name, companyId: coA.id };
    await assistant.updateSettings(coA.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
    const conv = await assistant.createConversation(actor);
    const ctx = (texts = []) => ({ actor, scope: { companyId: coA.id }, conversationId: conv.id, userTexts: texts, propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor, ...p }) });
    let t = await registry.runTool("resize_label", { labelId: label.id, preset: "70x100" }, ctx(["غيّر مقاس الليبل 7×10"]));
    let card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    assert("resize_label on a label with its design → keeps the design (card says so, with the result)", card?.status === "pending" && card.preview.details.some((x) => x.value === "تغيير المقاس مع الحفاظ على التصميم") && card.preview.details.some((x) => x.label === "النتيجة"), card?.preview || t);
    const [att] = await storeAttachments({ conversationId: conv.id, companyId: coA.id, actor, files: [{ buffer: design, originalname: "client.pdf", mimetype: "application/pdf" }] });
    t = await registry.runTool("upload_label_and_resize", { attachmentId: att.id, preset: "100x120" }, ctx(["خلّي الليبل ده 10×12"]));
    card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    assert("upload_label_and_resize, no mode → keeps the design, the result shown before anything is saved", card?.status === "pending" && card.preview.details.some((x) => x.label === "Mode" && x.value === "تغيير المقاس مع الحفاظ على التصميم") && card.preview.details.some((x) => x.label === "النتيجة"), card?.preview || t);
  } finally {
    await cleanupCompany(coA.id).catch((e) => console.error(e.message));
    await cleanupCompany(coB.id).catch((e) => console.error(e.message));
  }
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  process.exit(counts.failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
