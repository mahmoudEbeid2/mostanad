// Phase 7, acceptance 1 (26 Nov production test): the 5 real ADDVET files dropped in an "All companies"
// chat with «دي شهادات ADDVET وليبلات منتجين. طلّعلي شهادات COA و COC و HC للمنتجين دول بسرعة», the
// person choosing «شركة جديدة: ADDVET» → one card → one click →
//   templates COA / COC / HC made from the files, the products with their composition from the COC,
//   the 2 labels filed as reference labels (linked to their products), draft certificates whose
//   batch / dates / results are blank and flagged (no sample values), ZIP + combined PDF + manifest,
//   and steps that say what really happened.
// Not part of `npm test`: it reads the client's files from ADDVET_DIR (default the Desktop folder).
//   node tests/e2e/addvetExpress.e2e.mjs            scripted model (the stack in --no-gemini mode)
//   node tests/e2e/addvetExpress.e2e.mjs --live     the real model (the stack WITH Gemini)
// Writes reports/addvet-e2e/<mode>/{summary.json,run.log,ADDVET-drafts.zip,ADDVET-drafts.pdf}.
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../../src/lib/prisma.js";
import { makeAssert, api, asAdmin, cleanupCompany } from "../certificates-v2/helpers.js";
import * as assistant from "../../src/services/assistant/assistantService.js";
import { storeAttachments } from "../../src/services/assistant/attachments.js";
import * as intake from "../../src/services/intake/intakeService.js";

const LIVE = process.argv.includes("--live");
if (!LIVE) process.env.GEMINI_DISABLED = "true";
const DIR = process.env.ADDVET_DIR || "C:/Users/A Store/Desktop/New folder";
const FILES = ["ADDVET OMAN COA 10-26.pdf", "ADDVET OMAN COC 10-26.pdf", "ADDVET HC OMAN 10-26.pdf", "27 - ADDOXY 200-LA.pdf", "1 SULFAPRIM.pdf"];
const MESSAGE = "دي شهادات ADDVET وليبلات منتجين. طلّعلي شهادات COA و COC و HC للمنتجين دول بسرعة";
const OUT = path.join(process.cwd(), "reports", "addvet-e2e", LIVE ? "live" : "scripted");
fs.mkdirSync(OUT, { recursive: true });
const { assert, counts } = makeAssert();
const log = [];
const t0 = Date.now();
const say = (...a) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(" ")}`;
  log.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 2000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
};

// the scripted model: what the real one is told to do with this message (start_intake express, the types named)
const scripted = () => {
  let n = 0;
  return async () => (n++ === 0 ? { content: { role: "model", parts: [{ functionCall: { name: "start_intake", args: { express: true, certificateTypes: ["COA", "COC", "HC"] } } }] }, usage: {} } : { content: { role: "model", parts: [{ text: "رتّبت الملفات في الكارت تحت — راجعه ودوس «طلّع الشهادات»." }] }, usage: {} });
};

async function main() {
  for (const f of FILES) if (!fs.existsSync(path.join(DIR, f))) throw new Error(`missing ${f} in ${DIR}`);
  // a fresh start: an ADDVET made by an earlier run of this script (by intake) is removed first
  for (const c of await prisma.company.findMany({ where: { name: { equals: "ADDVET", mode: "insensitive" } }, select: { id: true } })) {
    if (await prisma.intakeCreated.findFirst({ where: { entityType: "company", entityId: c.id } })) await cleanupCompany(c.id);
    else throw new Error("A company named ADDVET exists that this script didn't make — not touching it");
  }
  const me = (await api("GET", "/auth/me", asAdmin)).data?.data?.user;
  const admin = { kind: "user", id: me?.id || "00000000-0000-0000-0000-000000000000", name: "ADDVET e2e", permissions: null, can: () => true };
  await assistant.updateSettings("system", { enabled: true, messagesPerUserPerHour: 1000, modelCallsPerDay: 100000 });
  const startedAt = new Date();

  const conv = await assistant.createConversation(admin, { companyId: null });
  const atts = await storeAttachments({ conversationId: conv.id, companyId: null, actor: admin, files: FILES.map((f) => ({ buffer: fs.readFileSync(path.join(DIR, f)), originalname: f, mimetype: "application/pdf" })) });
  say(`dropped ${atts.length} files in an "All companies" chat`);
  // «شركة جديدة: ADDVET»: the files go unbound with the person's choice in the message (the chat's chip)
  const turn = await assistant.sendMessage(admin, conv.id, { text: `${MESSAGE}\n(شركة جديدة: ADDVET)`, attachmentIds: atts.map((a) => a.id) }, LIVE ? {} : { generate: scripted() });
  const calls = (turn.message?.toolCalls || []).map((c) => `${c.name}(${JSON.stringify(c.args || {})})`);
  say("model called:", calls.join(" ; ") || "(nothing)", "·", (turn.message?.text || "").replace(/\s+/g, " ").slice(0, 160));
  let batch = await prisma.intakeBatch.findFirst({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" } });
  assert("the message → start_intake with express and the three types, one card under the answer", !!batch && batch.mode === "express" && ["COA", "COC", "HC"].every((c) => (batch.express?.requestedTypes || []).includes(c)), { calls, batch: batch && { mode: batch.mode, express: batch.express } });
  if (!batch) return;

  batch = await until(async () => {
    const b = await prisma.intakeBatch.findUnique({ where: { id: batch.id } });
    return !["uploading", "classifying"].includes(b.status) && b;
  }, 600_000);
  const tCard = Date.now();
  let view = await intake.getBatchView(admin, batch.id);
  say(`card ready (${batch.status}) — ${view.items.length} rows`);
  const by = Object.fromEntries(view.items.filter((i) => !i.parentId).map((i) => [i.name, i]));
  assert("no file of the drop is a duplicate of itself", Object.values(by).every((i) => i.action !== "duplicate"), Object.values(by).map((i) => `${i.name}:${i.action}`));
  assert("the company proposed: ADDVET, new", view.newEntities.companies.some((c) => /^ADDVET$/i.test(c.name)), view.newEntities.companies);
  assert("every row has a country (whole files too)", view.items.filter((i) => !i.parentId && i.docType !== "label").every((i) => i.country === "OM"), view.items.filter((i) => !i.parentId).map((i) => `${i.name}:${i.country}`));
  const questions = view.items.filter((i) => i.question === "product");
  say(`unclear pages: ${questions.map((q) => `${q.name.replace(/ — .*$/, "")} p.${q.pages}${q.suggested ? ` → ${q.suggested.name}` : ""}`).join(" | ") || "none"}`);
  // the person presses «اقبل الاقتراحات»
  for (const q of questions.filter((x) => x.suggested?.name)) await intake.decideItem(admin, q.id, { products: [{ name: q.suggested.name }] });
  view = await intake.getBatchView(admin, batch.id);
  say("will create:", JSON.stringify(view.newEntities));

  const tClick = Date.now();
  await intake.startExecute(admin, batch.id, { revisions: Object.fromEntries(view.items.map((i) => [i.id, i.revision])) });
  say("clicked «طلّع الشهادات»");
  let last = null;
  const ex = await until(async () => {
    const b = await prisma.intakeBatch.findUnique({ where: { id: batch.id } });
    const stage = b.status !== "done" ? `filing (${b.status})` : b.express?.stage || "templates";
    if (stage !== last) say("stage:", (last = stage));
    return (b.status === "failed" || (b.status === "done" && b.express?.stage === "done")) && b.express;
  }, 45 * 60_000, 3000);
  const tDone = Date.now();
  view = await intake.getBatchView(admin, batch.id);
  const e = view.express || {};
  for (const s of e.steps || []) say(`step ${s.key}: ${s.status} — ${s.ar}`);
  say("summary:", e.summary?.ar || "—");
  for (const t of e.templates || []) say(`template ${t.code}: ${t.status}${t.why ? ` — ${t.why}` : ""}`);

  const co = await prisma.company.findFirst({ where: { name: { equals: "ADDVET", mode: "insensitive" } } });
  assert("the company ADDVET exists now", !!co);
  if (!co) return;
  const types = await prisma.certificateType.findMany({ where: { companyId: co.id }, select: { code: true, name: true } });
  assert("types COA, COC (Certificate of Composition), HC for ADDVET", ["COA", "COC", "HC"].every((c) => types.some((t) => t.code === c)) && types.find((t) => t.code === "COC")?.name === "Certificate of Composition", types);
  const templates = await prisma.certificateTemplate.findMany({ where: { companyId: co.id }, include: { certificateType: { select: { code: true } } } });
  assert("a template per type, made from the files", ["COA", "COC", "HC"].every((c) => templates.some((t) => t.certificateType.code === c)), templates.map((t) => t.certificateType.code));
  const products = await prisma.product.findMany({ where: { companyId: co.id }, select: { id: true, name: true, activeIngredients: true, packaging: true, compositionBasis: true, fieldProvenance: true } });
  const composed = products.filter((p) => Array.isArray(p.activeIngredients) && p.activeIngredients.length && p.fieldProvenance?.activeIngredients?.certCode === "COC");
  say(`products: ${products.length} (${products.map((p) => p.name).join(", ")}); with composition from the COC: ${composed.length}`);
  assert("the 10 products of the files", products.length >= 10, products.map((p) => p.name));
  // (CURCUMARIN's page prints no "Each … contains" line: no basis is right for it)
  assert("…with their composition, pack and (where printed) basis from the COC, each with its file and page", composed.length >= 8 && composed.every((p) => p.packaging && p.fieldProvenance.activeIngredients.page) && composed.filter((p) => p.compositionBasis).length >= composed.length - 1, composed.map((p) => `${p.name}:${p.compositionBasis}:${p.packaging}`));
  const labelItems = await prisma.intakeItem.findMany({ where: { batchId: batch.id, name: { in: FILES.slice(3) } } });
  const refs = await prisma.referenceLabel.findMany({ where: { companyId: co.id }, select: { name: true, productId: true } });
  if (LIVE) assert("the 2 labels → reference labels, linked to their products", refs.length >= 2 && refs.every((r) => r.productId), refs);
  else assert("the 2 labels → reference-label jobs queued (read by the model in a live run)", labelItems.length === 2 && labelItems.every((i) => i.status === "done" && i.result?.referenceLabel), labelItems.map((i) => `${i.name}:${i.status}`));

  const certs = await prisma.certificate.findMany({ where: { companyId: co.id }, include: { certificateType: { select: { code: true } }, product: { select: { name: true } }, versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
  say(`certificates: ${certs.length} — ${Object.entries(certs.reduce((m, c) => ((m[c.certificateType.code] = (m[c.certificateType.code] || 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  assert("draft certificates were made", certs.length > 0 && certs.every((c) => ["draft", "failed"].includes(c.status)), certs.map((c) => c.status));
  // the issued files' own batch facts (read from them) must never be printed on a draft
  const facts = [...new Set((await prisma.intakeItem.findMany({ where: { batchId: batch.id } })).flatMap((i) => (i.classification?.batches || []).flatMap((b) => [b.batchNo, b.productionDate, b.expiryDate])).filter((x) => x && String(x).length >= 5))];
  let printed = [];
  for (const c of certs.filter((x) => x.versions[0]?.htmlFileId)) {
    const html = await (await import("../../src/services/certificates/storage/fileStore.js")).readText(c.versions[0].htmlFileId);
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
    printed.push(...facts.filter((f) => text.includes(f)).map((f) => `${c.certificateType.code}/${c.product?.name}: ${f}`));
  }
  assert(`no draft prints the files' batch numbers / dates (${facts.length} checked)`, printed.length === 0, printed.slice(0, 10));
  const blanks = certs.filter((c) => c.flagCount > 0);
  assert("…their batch / date / result places are blank and flagged (finalize refused)", blanks.length > 0, certs.map((c) => `${c.certificateType.code}:${c.flagCount}`));

  const cb = e.generation?.certificateBatchId ? await prisma.certificateBatch.findUnique({ where: { id: e.generation.certificateBatchId } }) : null;
  let manifest = null;
  if (cb?.zipFileId) {
    const zipBuf = (await api("GET", `/certificate-batches/${cb.id}/zip`, asAdmin)).buffer;
    fs.writeFileSync(path.join(OUT, "ADDVET-drafts.zip"), zipBuf);
    const zip = await JSZip.loadAsync(zipBuf);
    manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    const pdfBuf = (await api("GET", `/certificate-batches/${cb.id}/combined.pdf`, asAdmin)).buffer;
    fs.writeFileSync(path.join(OUT, "ADDVET-drafts.pdf"), pdfBuf);
    say(`ZIP: ${Object.keys(zip.files).filter((n) => n.endsWith(".pdf")).length} PDFs + manifest; combined PDF ${(await PDFDocument.load(pdfBuf)).getPageCount()} pages`);
  }
  assert("ZIP + combined PDF + manifest", !!cb?.zipFileId && !!cb?.combinedPdfFileId && manifest?.documents?.length === certs.filter((c) => c.status !== "failed").length, { zip: cb?.zipFileId, manifest: manifest?.documents?.length });
  assert("the steps say what happened (no green check on a step that made nothing)", (e.steps || []).every((s) => (s.status === "ok") === s.ok) && !(e.steps || []).some((s) => s.key === "certificates" && s.status === "ok" && !certs.length), e.steps);

  const ai = await prisma.aiCall.findMany({ where: { createdAt: { gte: startedAt } }, select: { feature: true, costUsd: true, model: true } }).catch(() => []);
  const byFeature = {};
  for (const c of ai) {
    const k = c.feature || "?";
    byFeature[k] ||= { calls: 0, costUsd: 0 };
    byFeature[k].calls++;
    byFeature[k].costUsd = Number((byFeature[k].costUsd + Number(c.costUsd || 0)).toFixed(5));
  }
  const cost = Number(ai.reduce((n, c) => n + Number(c.costUsd || 0), 0).toFixed(4));
  const summary = {
    mode: LIVE ? "live" : "scripted",
    when: startedAt.toISOString(),
    companyId: co.id,
    batchId: batch.id,
    modelCalls: calls,
    seconds: { dropToCard: Math.round((tCard - t0) / 1000), clickToDone: Math.round((tDone - tClick) / 1000), dropToDone: Math.round((tDone - t0) / 1000) },
    unclearPages: questions.map((q) => ({ page: `${q.name} p.${q.pages}`, suggested: q.suggested?.name || null })),
    templates: e.templates,
    steps: e.steps,
    summary: e.summary,
    products: products.length,
    withComposition: composed.length,
    referenceLabels: refs.length,
    certificates: certs.map((c) => ({ id: c.id, type: c.certificateType.code, product: c.product?.name || null, status: c.status, flags: c.flagCount })),
    ai: { calls: ai.length, costUsd: cost, byFeature },
    passed: counts.passed,
    failed: counts.failed,
  };
  say(`AI: ${ai.length} calls, $${cost}`, JSON.stringify(byFeature));
  say(`timing: drop → card ${summary.seconds.dropToCard}s, click → done ${summary.seconds.clickToDone}s, drop → PDFs ${summary.seconds.dropToDone}s`);
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 1));
}

main()
  .catch((err) => assert(`no crash: ${err.stack}`, false))
  .finally(async () => {
    fs.writeFileSync(path.join(OUT, "run.log"), log.join("\n"));
    console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total — ${OUT}\n`);
    await prisma.$disconnect();
    process.exit(counts.failed ? 1 : 0);
  });
