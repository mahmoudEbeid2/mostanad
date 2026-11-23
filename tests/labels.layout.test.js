// Printable label layout ("same label, other dimensions") and "upload a label to
// resize": a stored label at 10×15 and 10×12 cm → PDF page exactly that size,
// nothing below the minimum text size, overflow reported (no PDF, never cut);
// an uploaded label in both modes — rebuild (fields never invented: what the
// file didn't state stays empty and is listed) and scale (proportions kept, the
// smallest text size reported); tenant isolation; the assistant's layout tools
// only run from an approved card, incl. the chat example "خلّي الليبل ده 10×12"
// with a scripted model. Needs `npm run dev:test` (API, workers, cert-renderer).
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asCompany, createCompany, cleanupCompany, form } from "./certificates-v2/helpers.js";
import { SAMPLE_LABEL_DATA } from "./fixtures/labelLayoutSample.js";
import { textSizes } from "../src/services/label/layout/labelPdf.js";
import { putFile } from "../src/services/certificates/storage/fileStore.js";
import { runRebuildExtraction, onlyWhatWasRead } from "../src/services/label/layout/labelUploadService.js";
import * as registry from "../src/services/assistant/registry/index.js";
import * as assistant from "../src/services/assistant/assistantService.js";
import * as actions from "../src/services/assistant/actions.js";
import { storeAttachments } from "../src/services/assistant/attachments.js";

process.env.GEMINI_DISABLED = "true";
const { assert, counts } = makeAssert();
const s = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const PT_PER_MM = 72 / 25.4;
async function pdfBox(buf) {
  const d = await PDFDocument.load(buf);
  const p = d.getPage(0);
  const box = p.getMediaBox();
  return { pages: d.getPageCount(), wMm: box.width / PT_PER_MM, hMm: box.height / PT_PER_MM };
}
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

async function newLabel(companyId, labelData = SAMPLE_LABEL_DATA) {
  return prisma.generatedLabel.create({ data: { companyId, inputPayload: {}, labelData, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "EG", language: "en", status: "draft" } });
}

async function main() {
  console.log("🧪 Labels — printable layout & size\n");
  const coA = await createCompany(`layA${s}`);
  const coB = await createCompany(`layB${s}`);
  const A = asCompany(coA.id);
  const B = asCompany(coB.id);
  const label = await newLabel(coA.id);
  let pdf15 = null;
  try {
    let r = await api("GET", "/labels/layout-sizes", A);
    assert("sizes: presets incl. 10×15, 10×12, 7×10, 5×8; minimum 6 pt by default", r.status === 200 && ["100x150", "100x120", "70x100", "50x80"].every((k) => r.data.data.presets.some((p) => p.key === k)) && r.data.data.defaults.minFontPt === 6, r.data);

    console.log("\nA stored label at 10×15 and 10×12 cm");
    for (const [preset, w, h] of [["100x150", 100, 150], ["100x120", 100, 120]]) {
      r = await api("POST", `/labels/${label.id}/layout/preview`, A, { preset });
      const nw = r.data?.data?.new;
      assert(`${preset} preview: fits, a PNG preview, sections reported`, r.status === 200 && nw?.fit?.fits === true && /^data:image\/png;base64,/.test(nw.previewDataUrl) && nw.fit.sections.length >= 8, r.data?.message || nw?.fit);
      r = await api("POST", `/labels/${label.id}/layout`, A, { preset });
      const lay = r.data?.data?.layout;
      assert(`${preset} saved as a new version with a PDF`, r.status === 201 && lay?.hasPdf && lay.widthMm === w && lay.heightMm === h, r.data);
      const file = await api("GET", `/label-layouts/${lay.id}/pdf`, A);
      const box = await pdfBox(file.buffer);
      assert(`${preset}: one PDF page, exactly ${w} × ${h} mm (MediaBox ${box.wMm.toFixed(3)} × ${box.hMm.toFixed(3)})`, file.status === 200 && box.pages === 1 && near(box.wMm, w) && near(box.hMm, h), box);
      const sizes = await textSizes(file.buffer);
      assert(`${preset}: real text in the PDF, nothing below 6 pt (smallest ${sizes.smallestPt} pt) and as reported`, sizes.runs > 20 && sizes.smallestPt >= 6 && near(sizes.smallestPt, lay.fit.smallestTextPt, 0.02), sizes);
      if (preset === "100x150") pdf15 = file.buffer;
    }
    r = await api("GET", `/labels/${label.id}/layout`, A);
    assert("versions listed newest first (v2 10×12, v1 10×15)", r.data?.data?.versions?.map((v) => `${v.version}:${v.size}`).join(",") === "2:10 × 12 cm,1:10 × 15 cm", r.data?.data?.versions);
    r = await api("POST", `/labels/${label.id}/layout/preview`, A, { preset: "100x150" });
    assert("the preview shows the old (current) size next to the new one", r.data?.data?.old?.size === "10 × 12 cm" && /^data:image\/png/.test(r.data.data.old.previewDataUrl || ""), r.data?.data?.old);

    console.log("\nToo small: reported, never cut, never below the minimum");
    r = await api("POST", `/labels/${label.id}/layout`, A, { preset: "40x60" });
    const small = r.data?.data?.layout;
    const over = (small?.fit?.sections || []).filter((x) => x.status === "overflow");
    assert("4×6 cm: doesn't fit at 6 pt in 2 columns → no PDF", r.status === 201 && small.fit.fits === false && small.hasPdf === false && small.fit.fontPt === 6, small?.fit);
    assert("…each overflowing section says how many mm it needs (e.g. 'overflow: Warnings needs N mm more')", over.length > 0 && over.every((x) => x.overflowMm > 0 && /^overflow: .+ needs [\d.]+ mm more$/.test(x.message)), over);
    r = await api("GET", `/label-layouts/${small.id}/pdf`, A);
    assert("…its PDF download is refused (409), with the reason", r.status === 409 && /didn't fit/.test(r.data?.message));
    r = await api("POST", `/labels/${label.id}/layout/preview`, A, { preset: "100x150", minFontPt: 9, startFontPt: 9, maxColumns: 1 });
    assert("a higher minimum (9 pt) is honoured: fits only if 9 pt fits, never smaller", r.status === 200 && (r.data.data.new.fit.fits ? r.data.data.new.fit.fontPt >= 9 : r.data.data.new.fit.fontPt === 9), r.data?.data?.new?.fit);
    r = await api("POST", `/labels/${label.id}/layout/preview`, A, { preset: "nope" });
    assert("an unknown preset → 400", r.status === 400);

    console.log("\nTenancy");
    r = await api("GET", `/labels/${label.id}/layout`, B);
    assert("company B can't read A's label layout (404)", r.status === 404);
    r = await api("POST", `/labels/${label.id}/layout`, B, { preset: "100x120" });
    assert("…nor save one (404)", r.status === 404);
    r = await api("GET", `/label-layouts/${small.id}/preview.png`, B);
    assert("…nor download A's files (404)", r.status === 404);

    console.log("\nUpload → scale (keep the original design)");
    r = await api("POST", "/label-uploads", A, form({ mode: "scale", layout: JSON.stringify({ preset: "100x120" }) }, { buffer: pdf15, name: "label-10x15.pdf", type: "application/pdf" }));
    const sc = r.data?.data?.layout;
    assert("10×15 PDF → 10×12: 201, mode scale, fit-not-stretch, 80 %", r.status === 201 && sc?.mode === "scale" && sc.fit.stretch === false && sc.fit.scalePct === 80, r.data);
    const scPdf = await api("GET", `/label-layouts/${sc.id}/pdf`, A);
    const scBox = await pdfBox(scPdf.buffer);
    assert(`scaled PDF exactly 100 × 120 mm (${scBox.wMm.toFixed(3)} × ${scBox.hMm.toFixed(3)})`, near(scBox.wMm, 100) && near(scBox.hMm, 120));
    const before = await textSizes(pdf15);
    assert(`smallest text reported from the PDF text layer: ${before.smallestPt} pt × 0.8 = ${sc.fit.smallestTextPt} pt`, near(sc.fit.smallestTextPt, before.smallestPt * 0.8, 0.02) && sc.fit.textMeasurable === true);
    assert("…and below the 6 pt minimum it warns", sc.fit.smallestTextPt >= 6 || sc.fit.warnings.some((w) => /below the 6 pt minimum/.test(w)), sc.fit.warnings);
    const after = await textSizes(scPdf.buffer);
    assert("proportions kept: the text in the scaled PDF is the original × 0.8", near(after.smallestPt, before.smallestPt * 0.8, 0.05), { before: before.smallestPt, after: after.smallestPt });
    r = await api("POST", "/label-uploads", A, form({ mode: "scale", stretch: "true", layout: JSON.stringify({ preset: "100x120" }) }, { buffer: pdf15, name: "stretch.pdf", type: "application/pdf" }));
    assert("stretch to fill only with an explicit warning that it distorts the text", r.status === 201 && r.data.data.layout.fit.stretch === true && r.data.data.layout.fit.warnings.some((w) => /distort/.test(w)), r.data?.data?.layout?.fit);
    const shot = (await api("POST", `/labels/${label.id}/layout/preview`, A, { preset: "100x120" })).data.data.new.previewDataUrl;
    const png = Buffer.from(shot.split(",")[1], "base64");
    r = await api("POST", "/label-uploads", A, form({ mode: "scale", layout: JSON.stringify({ preset: "70x100" }) }, { buffer: png, name: "label.png", type: "image/png" }));
    assert("an image: placed on the page, text size 'can't be measured' (said, not guessed)", r.status === 201 && r.data.data.layout.fit.textMeasurable === false && r.data.data.layout.fit.smallestTextPt === null && r.data.data.layout.fit.warnings.some((w) => /can't be measured/.test(w)), r.data?.data?.layout?.fit);
    const upId = r.data.data.upload.id;
    r = await api("GET", `/label-uploads/${upId}`, B);
    assert("company B can't read A's upload (404)", r.status === 404);
    const stored = await prisma.storedFile.findUnique({ where: { id: (await prisma.labelUpload.findUnique({ where: { id: upId } })).fileId } });
    assert("the upload is a StoredFile of the label's company", stored.companyId === coA.id && stored.kind === "label_upload");
    r = await api("POST", "/label-uploads", A, form({ mode: "scale", companyId: coB.id, layout: JSON.stringify({ preset: "100x120" }) }, { buffer: pdf15, name: "x.pdf", type: "application/pdf" }));
    assert("a company caller's upload always lands in its own company (companyId ignored)", r.status === 201 && (await prisma.labelUpload.findUnique({ where: { id: r.data.data.upload.id } })).companyId === coA.id);

    console.log("\nUpload → rebuild (read into a label, confirmed, laid out)");
    r = await api("POST", "/label-uploads", A, form({ mode: "rebuild", layout: JSON.stringify({ preset: "100x120" }) }, { buffer: pdf15, name: "rebuild.pdf", type: "application/pdf" }));
    assert("rebuild upload → 202, a background read (task), status extracting", r.status === 202 && r.data.data.taskId && r.data.data.upload.status === "extracting", r.data);
    // the AI read itself (paid) is stubbed below with what labelExtractor returns for a label that states only some fields
    const file = await putFile({ companyId: coA.id, kind: "label_upload", buffer: pdf15, mimeType: "application/pdf", originalName: "stub.pdf" });
    const up = await prisma.labelUpload.create({ data: { companyId: coA.id, fileId: file.id, originalName: "stub.pdf", mimeType: "application/pdf", mode: "rebuild", status: "extracting" } });
    const lt = (en) => ({ translations: { en }, primary: "en" });
    const stubExtract = async () => ({
      // labelExtractor's own stand-ins for what the file didn't state: "Unknown", "q.s.", country, keep-out = true
      labelData: { ...SAMPLE_LABEL_DATA, productName: lt("AMOXIVET 20% WSP"), activeIngredients: [{ translations: { en: "Amoxicillin trihydrate" }, primary: "en", amount: "200 mg/g", unit: null, normalizedName: "amoxicillin trihydrate" }], targetAnimalSpecies: { translations: { en: "Unknown" }, primary: "en", list: ["Unknown"], source: "inferred" }, withdrawalPeriod: null, warnings: [], userSafety: [], contraindications: null, storage: lt("Store below 25 °C"), registrationNumber: null, countryOfProduction: lt("EG"), keepOutOfReachOfChildren: true, indications: [], aimOfUse: lt("") },
      extractionMeta: { productName: { confidence: 0.98 }, activeIngredients: { confidence: 0.95 }, storage: { confidence: 0.9 }, directionOfUse: { confidence: 0.9 }, targetAnimalSpecies: { confidence: 0 } },
    });
    const out = await runRebuildExtraction({ uploadId: up.id, companyId: coA.id }, { extract: stubExtract });
    const rebuilt = await prisma.generatedLabel.findUnique({ where: { id: out.labelId } });
    assert("an extracted label (origin extracted, draft) in the upload's company", rebuilt.origin === "extracted" && rebuilt.status === "draft" && rebuilt.companyId === coA.id);
    assert("fields never invented: unread ones are EMPTY (no 'Unknown', no country stand-in, no keep-out), and listed", rebuilt.labelData.targetAnimalSpecies === null && rebuilt.labelData.countryOfProduction === null && rebuilt.labelData.keepOutOfReachOfChildren === null && rebuilt.labelData.withdrawalPeriod === null && out.missing.includes("withdrawalPeriod") && out.missing.includes("targetAnimalSpecies") && out.read.includes("productName") && !JSON.stringify(rebuilt.labelData).includes("Unknown"), { read: out.read, missing: out.missing });
    assert("batch / dates from the file are not carried into the new label", rebuilt.labelData.batchNo === null && rebuilt.labelData.expiryDate === null);
    const pure = onlyWhatWasRead({ productName: lt("X"), activeIngredients: [{ translations: { en: "Unknown" }, primary: "en", amount: "q.s." }] }, { productName: {} });
    assert("onlyWhatWasRead drops a stand-in ingredient", pure.labelData.activeIngredients.length === 0 && pure.missing.includes("activeIngredients"));
    r = await api("GET", `/label-uploads/${up.id}`, A);
    const fields = r.data?.data?.label?.fields || [];
    assert("review: every field shown with read / not read", r.status === 200 && r.data.data.upload.status === "review" && fields.find((f) => f.field === "productName")?.read === true && fields.find((f) => f.field === "withdrawalPeriod")?.read === false);
    r = await api("POST", `/label-uploads/${up.id}/confirm`, A, { fields: { withdrawalPeriod: "Meat: 1 day" }, layout: { preset: "100x120" } });
    const rl = r.data?.data?.layout;
    assert("confirm (+ the person's own correction) → laid out at 10×12 with a PDF", r.status === 201 && rl?.hasPdf && rl.size === "10 × 12 cm", r.data);
    const rpdf = (await api("GET", `/label-layouts/${rl.id}/pdf`, A)).buffer;
    const rbox = await pdfBox(rpdf);
    const rsizes = await textSizes(rpdf);
    assert(`rebuilt PDF exactly 100 × 120 mm, nothing below 6 pt (smallest ${rsizes.smallestPt})`, near(rbox.wMm, 100) && near(rbox.hMm, 120) && rsizes.smallestPt >= 6);
    const lab = await prisma.generatedLabel.findUnique({ where: { id: out.labelId } });
    assert("the correction is the person's (provenance tier user), the rest confirmed", lab.labelProvenance.withdrawalPeriod?.tier === "user" && lab.labelProvenance.productName?.confirmed === true && lab.labelData.withdrawalPeriod?.translations?.en === "Meat: 1 day");
    r = await api("POST", `/labels/${out.labelId}/layout`, A, { preset: "70x100" });
    assert("the rebuilt label can be resized again later like any label", r.status === 201 && r.data.data.layout.version === 2, r.data?.data?.layout);

    console.log("\nAssistant: layout tools only through an approved card");
    const actorA = { kind: "company", id: coA.id, name: coA.name, companyId: coA.id };
    await assistant.updateSettings(coA.id, { enabled: true, messagesPerUserPerHour: 500, modelCallsPerDay: 5000 });
    const conv = await assistant.createConversation(actorA);
    const ctx = (texts) => ({ actor: actorA, scope: { companyId: coA.id }, conversationId: conv.id, userTexts: texts, propose: (p) => actions.proposeAction({ conversationId: conv.id, messageId: null, actor: actorA, ...p }) });
    let t = await registry.runTool("list_label_sizes", {}, ctx([]));
    assert("list_label_sizes is a read", t.status === "ok" && t.data.presets.length >= 6);
    t = await registry.runTool("get_label_layout", { labelId: label.id }, ctx([]));
    assert("get_label_layout is a read (current size, versions)", t.status === "ok" && t.data.current?.size && t.data.versions.length === 3, t.data);
    const n = await prisma.labelLayout.count({ where: { labelId: label.id } });
    t = await registry.runTool("resize_label", { labelId: label.id, preset: "70x100" }, ctx(["make it 7x10"]));
    let card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    const det = Object.fromEntries((card?.preview?.details || []).map((d) => [d.label, d.value]));
    assert("resize_label → a card (old → new size, fit, smallest font), nothing saved", card?.status === "pending" && /→ 7 × 10 cm/.test(det.Size) && det.Fit && /pt/.test(det["Smallest text"]) && (await prisma.labelLayout.count({ where: { labelId: label.id } })) === n, card ? det : t);
    const done = await actions.approveAction(actorA, card.id);
    assert("after Run: a new version, the result carries the layout (PDF, preview) and a link to the tab", done.status === "done" && done.result.labelLayout?.hasPdf && /tab=layout/.test(done.result.link) && (await prisma.labelLayout.count({ where: { labelId: label.id } })) === n + 1, done.result);
    t = await registry.runTool("resize_label", { labelId: label.id }, ctx([]));
    assert("resize_label without a size: no card (asks which size)", !t.data?.actionId);

    const [att] = await storeAttachments({ conversationId: conv.id, companyId: coA.id, actor: actorA, files: [{ buffer: pdf15, originalname: "label-10x15.pdf", mimetype: "application/pdf" }] });
    t = await registry.runTool("upload_label_and_resize", { attachmentId: att.id, mode: "scale", preset: "100x120" }, ctx(["scale it to 10x12"]));
    card = t.data?.actionId ? await prisma.assistantAction.findUnique({ where: { id: t.data.actionId } }) : null;
    const d2 = Object.fromEntries((card?.preview?.details || []).map((d) => [d.label, d.value]));
    const uploadsBefore = await prisma.labelUpload.count({ where: { companyId: coA.id } });
    assert("upload_label_and_resize → a card (file, mode, size, company), nothing uploaded yet", card?.status === "pending" && d2.File === "label-10x15.pdf" && /scale/i.test(d2.Mode) && d2.Size === "10 × 12 cm" && d2.Company, d2);
    const up2 = await actions.approveAction(actorA, card.id);
    assert("after Run (scale): a 10×12 PDF, scale and smallest text in the result", up2.status === "done" && up2.result.labelLayout?.fit?.scalePct === 80 && (await prisma.labelUpload.count({ where: { companyId: coA.id } })) === uploadsBefore + 1, up2.result);

    // the chat example, model scripted (the real model needs a paid key): file + "خلّي الليبل ده 10×12"
    const steps = [];
    const script = (list) => async (req) => {
      steps.push(req);
      const step = list[Math.min(steps.length - 1, list.length - 1)];
      return { content: { role: "model", parts: typeof step === "function" ? step(req) : step }, usage: { promptTokenCount: 5, candidatesTokenCount: 1 } };
    };
    const [att2] = await storeAttachments({ conversationId: conv.id, companyId: coA.id, actor: actorA, files: [{ buffer: pdf15, originalname: "client-label.pdf", mimetype: "application/pdf" }] });
    const turn = await assistant.sendMessage(actorA, conv.id, { text: "خلّي الليبل ده 10×12", attachmentIds: [att2.id] }, { generate: script([[{ functionCall: { name: "upload_label_and_resize", args: { attachmentId: att2.id, mode: "rebuild", preset: "100x120" } } }], [{ text: "جهزت لك كارت: هقرأ الليبل وبعدها تراجع الحقول." }]]) });
    const chatCard = turn.message?.actions?.[0];
    assert("chat example: the model's call becomes a rebuild card at 10 × 12 cm; nothing uploaded until Run", chatCard?.status === "pending" && chatCard.tool === "upload_label_and_resize" && chatCard.preview.details.some((d) => d.value === "10 × 12 cm") && chatCard.preview.details.some((d) => /Rebuild/.test(d.value)), chatCard || turn);
    assert("…the labels tools were offered for that message (file + size words)", JSON.stringify(steps[0]?.tools || steps[0] || "").includes("upload_label_and_resize"));
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
