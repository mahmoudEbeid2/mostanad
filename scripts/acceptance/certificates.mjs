// Certificates — definition of done (CERT_DONE_CHECKLIST.md): the 19 scenarios, run on PRODUCTION against
// the company ADDVET with the client's real files, PASS / FAIL per scenario. Everything the run creates is
// deleted at the end (exact ids it recorded — never by pattern), and the numbering counters it moved are
// put back as they were. Run it after every certificates-related deploy; a FAIL blocks the "done" report.
//
//   inside the app container:  node scripts/acceptance/certificates.mjs --files <dir with the fixtures> [--keep] [--only 1,2,…]
//   from a workstation:        bash scripts/acceptance/run-prod.sh       (copies fixtures/addvet/ in, runs, cleans up)
//
// The fixture is the drop of scenario 1: ADDVET's COC, COA and HC for Oman (10-26), the manufacturing order
// MADADD2610001 and the unrelated invoice BRN2025002 (ROSHAN, Pakistan) the client sends in the same batch.
// It uses the real model where the product does (the drop's read, the chat's one-line answers): it costs a
// few cents and takes 10–20 minutes. Scenario 14's company switch is the page's (useFollowEntityCompany);
// here the API it relies on is checked.
import fs from "fs";
import path from "path";
import { prisma } from "../../src/lib/prisma.js";
import * as assistant from "../../src/services/assistant/assistantService.js";
import { storeAttachments } from "../../src/services/assistant/attachments.js";
import * as actions from "../../src/services/assistant/actions.js";
import * as intake from "../../src/services/intake/intakeService.js";
import { notMadeTypes } from "../../src/services/intake/expressService.js";
import { createRequest, getRequest } from "../../src/services/certificates/workflow/requestService.js";
import { reviewAction, revise, reviewChecks } from "../../src/services/certificates/workflow/reviewService.js";
import { finalize, editValues } from "../../src/services/certificates/certificates/editService.js";
import { isBlocking, isNA } from "../../src/services/certificates/generation/batchService.js";
import { batchFacts, guardBatchSize } from "../../src/services/certificates/experiment/experimentFill.js";
import { fieldRole } from "../../src/services/certificates/generation/batchAnswer.js";
import { listSchemes, formatNumber } from "../../src/services/certificates/generation/docNumbers.js";
import { samePack, splitNamePack } from "../../src/services/certificates/matching/packNormalizer.js";
import { readPages } from "../../src/services/intake/intakeText.js";
import * as fileStore from "../../src/services/certificates/storage/fileStore.js";
import { entityCompany } from "../../src/controllers/certificatesV2/workflowController.js";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const DIR = arg("--files");
const KEEP = process.argv.includes("--keep");
const ONLY = arg("--only") ? new Set(arg("--only").split(",").map(Number)) : null;
const COMPANY = "ADDVET";
const FILES = { coc: "ADDVET OMAN COC 10-26.pdf", coa: "ADDVET OMAN COA 10-26.pdf", hc: "ADDVET HC OMAN 10-26.pdf", mo: "MADADD2610001.pdf", invoice: "BRN2025002 - ROSHAN.pdf" };
// the MO's 10 lines (MADADD2610001): the request must be exactly these products in these packs
const MO_LINES = [["ADDMECTIN", "100 mL"], ["SULFAPRIM", "100 mL"], ["OLIGOVET", "100 mL"], ["ADDOXY 200-LA", "100 mL"], ["ADD-E120", "1 L"], ["AMINOVITA", "1 L"], ["H-DURIN", "1 L"], ["H-RESPI", "1 L"], ["CURCUMARIN", "1 L"], ["ADDHEPA", "1 L"]];
const MO_CUSTOMER = "Madhoob Trading Group";
const ANSWER_OK = "ADDHEPA حجم 240 KG — Appearance Conforms, Identification Positive, pH 5.2, assay 99%";
const ANSWER_OUT = "H-RESPI حجم 240 KG — Appearance Conforms, Identification Positive, pH 9.9, assay 99%";

const t0 = Date.now();
const say = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${a.join(" ")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "");
const flat = (s) => String(s || "").replace(/\s+/g, " ").replace(/μ/g, "µ").trim();

const results = [];
const created = { conversations: [], requests: new Set(), certificates: new Set(), batches: new Set() };
let schemesBefore = null;
const ctx = {}; // what one scenario leaves for the next: requestId, certificates, …

async function scenario(n, title, fn) {
  if (ONLY && !ONLY.has(n)) return;
  say(`#${n} ${title} …`);
  let pass = false;
  let detail = "";
  try {
    const out = await fn();
    pass = out.pass;
    detail = out.detail || "";
  } catch (err) {
    detail = `crashed: ${err.code ? `${err.code} ` : ""}${err.message}`;
  }
  results.push({ n, title, pass, detail });
  say(`#${n} ${pass ? "PASS" : "FAIL"}${detail ? ` — ${detail}` : ""}`);
}

// ── shared steps ─────────────────────────────────────────────────────────────────────────────────────
async function drop(admin, message) {
  const conv = await assistant.createConversation(admin, { companyId: null });
  created.conversations.push(conv.id);
  const atts = await storeAttachments({ conversationId: conv.id, companyId: null, actor: admin, files: Object.values(FILES).map((f) => ({ buffer: fs.readFileSync(path.join(DIR, f)), originalname: f, mimetype: "application/pdf" })) });
  const turn = await assistant.sendMessage(admin, conv.id, { text: message, attachmentIds: atts.map((a) => a.id) });
  const first = turn.message?.toolCalls?.[0] || null;
  let batch = await prisma.intakeBatch.findFirst({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" } });
  if (!batch) return { conv, first, batch: null };
  batch = await until(async () => {
    const b = await prisma.intakeBatch.findUnique({ where: { id: batch.id } });
    return !["uploading", "classifying"].includes(b.status) && b;
  }, 900_000);
  if (!batch) throw new Error("the drop's card never became ready (15 min)");
  let view = await intake.getBatchView(admin, batch.id);
  // the person presses «اقبل الاقتراحات» (each unclear page → the card's suggestion), then «طلّع الشهادات»
  const asked = view.items.filter((i) => i.question === "product");
  for (const q of asked.filter((x) => x.suggested?.name)) await intake.decideItem(admin, q.id, { products: [{ name: q.suggested.name }] });
  if (asked.length) say(`   card questions: ${asked.map((q) => `${q.name} → ${q.suggested?.name || "(no suggestion)"}`).join(" | ")}`);
  view = await intake.getBatchView(admin, batch.id);
  await intake.startExecute(admin, batch.id, { revisions: Object.fromEntries(view.items.map((i) => [i.id, i.revision])) });
  const done = await until(async () => {
    const b = await prisma.intakeBatch.findUnique({ where: { id: batch.id } });
    return b.status === "done" && b.express?.stage === "done" && b;
  }, 2_400_000, 6000);
  if (!done) throw new Error("Express didn't finish (40 min)");
  view = await intake.getBatchView(admin, batch.id);
  if (view.express?.request?.id) created.requests.add(view.express.request.id);
  (ctx.views ||= []).push(view);
  return { conv, first, batch: done, view };
}

const certsOf = (invoiceId, code = null) =>
  prisma.certificate.findMany({ where: { invoiceId, ...(code ? { certificateType: { code } } : {}) }, include: { certificateType: { select: { code: true } }, product: { select: { id: true, name: true, packaging: true, physicalForm: true, productForm: true, productType: true, routeOfAdmin: true, activeIngredients: true } } }, orderBy: { createdAt: "asc" } });
const valuesOf = async (c) => (await prisma.certificateVersion.findUnique({ where: { certificateId_versionNumber: { certificateId: c.id, versionNumber: c.currentVersion } }, select: { values: true, htmlFileId: true } })) || { values: {} };
const fieldsOf = (versionId) => prisma.templateField.findMany({ where: { versionId }, orderBy: { sortOrder: "asc" } });
const blockingOf = (values) => Object.entries(values || {}).filter(([, v]) => (v.flags || []).some(isBlocking));
const who = (c) => `${c.product?.name || "(shipment)"}${c.product?.packaging ? ` ${c.product.packaging}` : ""}`;

async function main() {
  if (!DIR || !Object.values(FILES).every((f) => fs.existsSync(path.join(DIR, f)))) throw new Error(`--files <dir> must hold: ${Object.values(FILES).join(", ")}`);
  const company = await prisma.company.findFirst({ where: { name: COMPANY }, select: { id: true, name: true, profile: true } });
  if (!company) throw new Error(`No company ${COMPANY}`);
  const user = await prisma.user.findFirst({ where: { username: "admin" }, select: { id: true, username: true } });
  if (!user) throw new Error("No admin user");
  const admin = { kind: "user", id: user.id, name: user.username, permissions: null, can: () => true };
  const cid = company.id;
  schemesBefore = await prisma.numberingScheme.findMany({ where: { companyId: cid } });
  say(`company ${company.name} · ${Object.keys(FILES).length} files from ${DIR}`);

  await scenario(1, "Chat drop of COC + COA + HC + MO + invoice with «شهادات»", async () => {
    const r = await drop(admin, "شهادات");
    ctx.drop1 = r;
    const byCode = r.first?.name === "start_intake" && r.first.routedByCode === true && r.first.args?.express === true;
    const requestId = r.view?.express?.request?.id;
    ctx.requestId = requestId;
    if (!requestId) return { pass: false, detail: `${byCode ? "" : `routed to ${r.first?.name || "nothing"}; `}no request (${r.view?.express?.summary?.en || "?"})` };
    const lines = await prisma.invoiceItem.findMany({ where: { invoiceId: requestId }, orderBy: { lineNo: "asc" }, include: { product: { select: { name: true, packaging: true } } } });
    const shown = lines.map((l) => `${l.product?.name || `?${l.data?.name}`} ${l.product?.packaging || l.data?.packing || ""}`.trim());
    const match = (l, [name, pack]) => l.product && norm(l.product.name).startsWith(norm(name)) && samePack(l.product.packaging || splitNamePack(l.product.name).pack, pack);
    const missing = MO_LINES.filter((e) => !lines.some((l) => match(l, e))).map((e) => e.join(" "));
    const extra = lines.filter((l) => !MO_LINES.some((e) => match(l, e))).map((l) => `${l.product?.name || l.data?.name} ${l.product?.packaging || l.data?.packing || ""}`);
    const pass = byCode && missing.length === 0 && extra.length === 0 && lines.length === MO_LINES.length;
    return { pass, detail: `${byCode ? "Express by code" : `NOT by code (${r.first?.name})`} · request ${requestId.slice(0, 8)} · ${lines.length} lines: ${shown.join(" | ")}${missing.length ? ` · missing: ${missing.join(", ")}` : ""}${extra.length ? ` · extra: ${extra.join(", ")}` : ""}` };
  });

  await scenario(2, "Same drop again within 24 h", async () => {
    if (!ctx.requestId) return { pass: false, detail: "needs #1's request" };
    const before = await prisma.certificate.count({ where: { invoiceId: ctx.requestId } });
    const r = await drop(admin, "شهادات");
    const again = r.view?.express?.request;
    const after = await prisma.certificate.count({ where: { invoiceId: ctx.requestId } });
    const other = again?.id && again.id !== ctx.requestId ? await prisma.certificate.count({ where: { invoiceId: again.id } }) : 0;
    const pass = again?.id === ctx.requestId && again.sameFiles === true && after === before && other === 0;
    return { pass, detail: `request ${again?.id === ctx.requestId ? "reused" : `NEW ${again?.id?.slice(0, 8)}`} (sameFiles ${again?.sameFiles}) · drafts ${before} → ${after}` };
  });

  // the source pages of the COC (the drop's own file) for #3 / #4
  const cocPages = async () => {
    if (ctx.cocPages) return ctx.cocPages;
    const items = await prisma.intakeItem.findMany({ where: { batchId: ctx.drop1.batch.id }, select: { id: true, name: true, parentId: true, fileId: true, pageFrom: true, result: true } });
    const file = items.find((i) => !i.parentId && i.name === FILES.coc);
    const { pages } = await readPages((await fileStore.readFile(file.fileId)).buffer, { maxPages: 30, maxChars: 6000 });
    const pageOf = new Map();
    for (const part of items.filter((i) => i.parentId === file.id && i.pageFrom)) for (const pid of part.result?.plan?.productIds || []) pageOf.set(pid, part.pageFrom);
    ctx.cocPages = { pages, pageOf };
    return ctx.cocPages;
  };

  await scenario(3, "COC of every product: 0 blanks, composition = the source page, basis only when printed", async () => {
    const cocs = await certsOf(ctx.requestId, "COC");
    if (!cocs.length) return { pass: false, detail: "no COC drafts" };
    const { pages, pageOf } = await cocPages();
    const bad = [];
    ctx.cleanCocs = [];
    for (const c of cocs) {
      const { values } = await valuesOf(c);
      const blanks = blockingOf(values).map(([k]) => k);
      const fields = await fieldsOf(c.templateVersionId);
      const pageNo = pageOf.get(c.productId) || pages.find((p) => new RegExp(`Trade Name:?\\s*${String(c.product?.name || "").split(/\s+/)[0]}`, "i").test(p.text))?.n;
      const text = flat(pages.find((p) => p.n === pageNo)?.text);
      // the draft's composition, row by row, in order
      const rowOf = (f) => Number((/activeIngredients\[(\d+)\]/.exec(f.source?.path || f.source?.template || "") || [])[1] ?? -1);
      const rows = new Map();
      for (const f of fields.filter((x) => ["composition_name", "composition_amount"].includes(x.role) && rowOf(x) >= 0)) {
        const v = flat(values[f.key]?.value);
        if (v) rows.set(rowOf(f), [...(rows.get(rowOf(f)) || []), v]);
      }
      const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, parts]) => parts);
      let at = text.indexOf("Composition");
      const wrong = [];
      for (const parts of ordered)
        for (const part of parts) {
          const i = text.indexOf(part, Math.max(0, at));
          if (i < 0) wrong.push(part);
          else at = i;
        }
      const ingredients = Array.isArray(c.product?.activeIngredients) ? c.product.activeIngredients.length : 0;
      const basisField = fields.find((f) => f.role === "composition_basis");
      const basis = basisField ? flat(values[basisField.key]?.value) : "";
      const pagePrintsBasis = /\b(?:Each|Every)\s+[\d.,]*\s*\w+\s+contains|Contains\s+per\b/i.test(text);
      const basisOk = basisField ? (pagePrintsBasis ? !!basis && text.includes(basis) : !basis) : true;
      const problems = [...(blanks.length ? [`${blanks.length} blank (${blanks.join(", ")})`] : []), ...(!pageNo ? ["source page not found"] : []), ...(wrong.length ? [`not on page ${pageNo}: ${wrong.slice(0, 3).join(" / ")}`] : []), ...(ordered.length !== ingredients ? [`${ordered.length} rows for ${ingredients} ingredients`] : []), ...(!basisOk ? [`basis "${basis}" (page ${pagePrintsBasis ? "prints one" : "prints none"})`] : [])];
      if (problems.length) bad.push(`${who(c)}: ${problems.join("; ")}`);
      else ctx.cleanCocs.push(c);
    }
    return { pass: !bad.length, detail: bad.length ? bad.join(" · ") : `${cocs.length} COCs, 0 blanks, every row on its page in order` };
  });

  await scenario(4, "COC render: no overflow / shrunk on amounts, no stray «:»", async () => {
    const cocs = await certsOf(ctx.requestId, "COC");
    const bad = [];
    for (const c of cocs) {
      const { values, htmlFileId } = await valuesOf(c);
      const fields = await fieldsOf(c.templateVersionId);
      const amountKeys = new Set(fields.filter((f) => ["composition_amount", "composition_name"].includes(f.role)).map((f) => f.key));
      const layout = Object.entries(values).filter(([k, v]) => amountKeys.has(k) && (v.flags || []).some((x) => x === "overflow" || x === "shrunk" || String(x).startsWith("rows_overflow"))).map(([k, v]) => `${k}[${v.flags.join(",")}]`);
      const html = htmlFileId ? await fileStore.readText(htmlFileId) : "";
      const text = flat(html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
      const stray = /Composition:\s*:/.test(text);
      if (layout.length || stray || !html) bad.push(`${who(c)}: ${[...(layout.length ? [layout.join(" ")] : []), ...(stray ? ["stray «:»"] : []), ...(!html ? ["no render"] : [])].join("; ")}`);
    }
    return { pass: cocs.length > 0 && !bad.length, detail: bad.length ? bad.join(" · ") : `${cocs.length} COCs clean` };
  });

  await scenario(5, "COA of every product: no blank (an unknown result / batch size is taken off — #15); batch, dates with file + page", async () => {
    const coas = await certsOf(ctx.requestId, "COA");
    if (!coas.length) return { pass: false, detail: "no COA drafts" };
    const bad = [];
    for (const c of coas) {
      const { values } = await valuesOf(c);
      const fields = await fieldsOf(c.templateVersionId);
      const role = new Map(fields.map((f) => [f.key, fieldRole(f)]));
      const problems = [];
      // 28 Nov (owner): a COA test with no result, and an unknown batch size, is taken off — never a blank
      for (const [k] of blockingOf(values)) problems.push(`blank ${k} (${(role.get(k) || {}).role})`);
      for (const want of ["batchNo", "productionDate", "expiryDate"]) {
        const f = fields.find((x) => role.get(x.key)?.role === want);
        if (!f) continue;
        const v = values[f.key];
        if (!flat(v?.value)) problems.push(`${want} empty`);
        else if (!v.provenance?.file || v.provenance?.page == null) problems.push(`${want} "${v.value}" without file + page`);
      }
      if (problems.length) bad.push(`${who(c)}: ${problems.join(", ")}`);
    }
    return { pass: !bad.length, detail: bad.length ? bad.join(" · ") : `${coas.length} COAs` };
  });

  await scenario(6, "COA content: nothing from the sample, no result word in a spec, results are amounts", async () => {
    const coas = await certsOf(ctx.requestId, "COA");
    const bad = [];
    for (const c of coas) {
      const { values } = await valuesOf(c);
      const fields = await fieldsOf(c.templateVersionId);
      const names = new Set((c.product?.activeIngredients || []).map((i) => norm(i.name)).filter(Boolean));
      const problems = [];
      for (const f of fields) {
        const v = values[f.key];
        const val = flat(v?.value);
        const r = fieldRole(f);
        if ((v?.flags || []).includes("sample_value")) problems.push(`${f.key} was the sample`);
        if (r.role === "result" && val && v?.origin !== "manual" && f.sampleValue && norm(val) === norm(f.sampleValue)) problems.push(`${f.key} = the sample's "${val}"`);
        if (r.role === "result" && val && names.has(norm(val))) problems.push(`${f.key} shows a name "${val}"`);
        if (/^spec/i.test(f.key) && /\b(?:conforms?|complies)\b/i.test(val)) problems.push(`${f.key} spec holds a result word "${val}"`);
      }
      if (problems.length) bad.push(`${who(c)}: ${problems.join(", ")}`);
    }
    return { pass: coas.length > 0 && !bad.length, detail: bad.length ? bad.join(" · ") : `${coas.length} COAs` };
  });

  // 28 Nov (owner), the COA rule: a test whose result is unknown is taken off (never blank, never "N/A", never
  // inferred); the table closes up; the certificate stays a normal one; the card lists what was taken off
  const printedText = async (htmlFileId) => (htmlFileId ? await fileStore.readText(htmlFileId) : "");
  const visible = (html) => flat(String(html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
  const PRINTS_NA = /(^|[^A-Za-z])N\s*\/\s*A([^A-Za-z]|$)/i;
  const WATERMARK = /SAMPLE\s*[–-]\s*NOT VALID/i;
  const REMOVED_LINE = /^اتشال من الشهادة: .+ — مفيش نتيجة\. ابعت النتيجة في سطر وترجع$/;
  await scenario(15, "COA: an unknown test / batch size is taken off — not blank, not N/A; finalizable; the card lists it in one line", async () => {
    const coas = await certsOf(ctx.requestId, "COA");
    if (!coas.length) return { pass: false, detail: "no COA drafts" };
    // the card that made these drafts (a drop of the same files may reuse an earlier request's COAs)
    const card = new Map((ctx.views || []).flatMap((v) => v.express?.certificates || []).map((c) => [c.id, c]));
    const madeBy = [...(ctx.views || [])].reverse().find((v) => (v.express?.certificates || []).some((c) => c.type === "COA"));
    const bad = [];
    let taken = 0;
    for (const c of coas) {
      const { values, htmlFileId } = await valuesOf(c);
      const fields = await fieldsOf(c.templateVersionId);
      const html = await printedText(htmlFileId);
      const problems = [];
      const listed = [];
      for (const f of fields) {
        const r = fieldRole(f);
        if (r.role !== "result" && r.role !== "batchSize") continue;
        const v = values[f.key] || {};
        const removed = (v.flags || []).includes("row_removed");
        if (!flat(v.value)) {
          if (!removed) problems.push(`${f.key} empty but printed`);
          else if (html.includes(`data-field="${f.key}"`)) problems.push(`${f.key} still in the page`);
          else taken++;
          if (removed && v.provenance?.rule !== "not_applicable_oral") listed.push(f.key);
        } else if (removed) problems.push(`${f.key} "${v.value}" has a value but was taken off`);
      }
      // the rule's own places never block (other blanks — dates, composition — are #3 / #5's)
      const ruled = blockingOf(values).filter(([k]) => ["result", "batchSize"].includes(fieldRole(fields.find((f) => f.key === k) || {}).role));
      if (ruled.length) problems.push(`blocking: ${ruled.map(([k]) => k).join(", ")}`);
      if (PRINTS_NA.test(visible(html))) problems.push("prints N/A");
      if (WATERMARK.test(html)) problems.push("watermarked");
      const line = card.get(c.id)?.removedAr || null;
      if (listed.length && !REMOVED_LINE.test(line || "")) problems.push(`card line ${line ? `"${line}"` : "MISSING"}`);
      if (!listed.length && line) problems.push(`card lists "${line}" but nothing was taken off`);
      if (problems.length) bad.push(`${who(c)}: ${problems.join(", ")}`);
    }
    const msg = madeBy?.express?.missing?.ar || "";
    if (taken && !/اتشال من الشهادة/.test(msg)) bad.push("the drop's message doesn't list the rows taken off");
    const sample = (madeBy?.express?.certificates || []).find((c) => c.removedAr)?.removedAr;
    return { pass: !bad.length && taken > 0, detail: bad.length ? bad.join(" · ") : `${coas.length} COAs · ${taken} rows taken off · card: "${sample || "—"}"` };
  });

  await scenario(17, "No «N/A» for an unknown value on any certificate; a test the product type doesn't have is taken off", async () => {
    const all = await certsOf(ctx.requestId);
    const bad = [];
    let notApplicable = 0;
    for (const c of all) {
      const { values, htmlFileId } = await valuesOf(c);
      const problems = [];
      for (const [k, v] of Object.entries(values || {})) {
        if (v?.kind === "group") {
          for (const row of v.rows || []) for (const [ck, cv] of Object.entries(row || {})) if (isNA(cv)) problems.push(`${k}.${ck} "N/A"`);
          continue;
        }
        if (isNA(v?.value) && v?.origin !== "manual" && v?.provenance?.needStatus !== "provided") problems.push(`${k} "${v.value}"`);
        if (v?.provenance?.rule === "not_applicable_oral") {
          notApplicable++;
          if (c.certificateType.code === "COA" && !(v.flags || []).includes("row_removed")) problems.push(`${k} not applicable but its row stayed`);
        }
      }
      if (PRINTS_NA.test(visible(await printedText(htmlFileId)))) problems.push("the page prints N/A");
      if (problems.length) bad.push(`${c.certificateType.code} ${who(c)}: ${problems.join(", ")}`);
    }
    return { pass: all.length > 0 && !bad.length, detail: bad.length ? bad.join(" · ") : `${all.length} certificates · ${notApplicable} not-applicable tests taken off` };
  });

  // a chat answer → its card → the person presses it
  const answer = async (text) => {
    const turn = await assistant.sendMessage(admin, ctx.drop1.conv.id, { text });
    const card = (turn.message?.actions || []).find((a) => a.tool === "fill_missing_batch_values") || (turn.message?.actions || [])[0];
    return { turn, card };
  };
  const coaOf = async (name) => (await certsOf(ctx.requestId, "COA")).find((c) => norm(c.product?.name).startsWith(norm(name)));

  await scenario(7, `One-line answer «${ANSWER_OK}»`, async () => {
    const { turn, card } = await answer(ANSWER_OK);
    if (!card) return { pass: false, detail: `no card — the reply: ${flat(turn.message?.text).slice(0, 160)}` };
    await actions.approveAction(admin, card.id);
    const c = await coaOf("ADDHEPA");
    const { values } = await valuesOf(await prisma.certificate.findUnique({ where: { id: c.id }, include: { product: true } }));
    const fields = await fieldsOf(c.templateVersionId);
    const get = (pred) => flat(values[fields.find(pred)?.key]?.value);
    const res = (t) => get((f) => fieldRole(f).role === "result" && new RegExp(t, "i").test(fieldRole(f).test || f.label));
    const got = { appearance: res("appearance"), identification: res("identification"), pH: res("^ph"), assay: res("assay"), batchSize: get((f) => fieldRole(f).role === "batchSize") };
    const pass = /conforms/i.test(got.appearance) && /positive/i.test(got.identification) && got.pH === "5.2" && /^99\s*%$/.test(got.assay) && /^240\s*KG$/i.test(got.batchSize);
    return { pass, detail: JSON.stringify(got) };
  });

  await scenario(16, "The result given later brings its row back (ADDHEPA after #7)", async () => {
    const c = await coaOf("ADDHEPA");
    if (!c) return { pass: false, detail: "no ADDHEPA COA" };
    const { values, htmlFileId } = await valuesOf(await prisma.certificate.findUnique({ where: { id: c.id } }));
    const fields = await fieldsOf(c.templateVersionId);
    const html = await printedText(htmlFileId);
    const back = fields.filter((f) => ["result", "batchSize"].includes(fieldRole(f).role) && flat(values[f.key]?.value));
    const problems = [];
    for (const f of back) {
      if ((values[f.key].flags || []).includes("row_removed")) problems.push(`${f.key} still flagged removed`);
      if (!html.includes(`data-field="${f.key}"`)) problems.push(`${f.key} not in the page`);
    }
    const ph = fields.find((f) => fieldRole(f).role === "result" && /^ph/i.test(fieldRole(f).test || f.label));
    if (!ph || flat(values[ph.key]?.value) !== "5.2") problems.push(`pH "${ph ? values[ph.key]?.value : "no field"}"`);
    if (!/5\.2/.test(visible(html))) problems.push("5.2 not printed");
    return { pass: back.length >= 5 && !problems.length, detail: problems.length ? problems.join(", ") : `back: ${back.map((f) => `${fieldRole(f).test || "batch size"}=${flat(values[f.key].value)}`).join(", ")}` };
  });

  await scenario(8, "pH outside its spec: a warning on the card, finalize refused without a comment", async () => {
    const { turn, card } = await answer(ANSWER_OUT);
    if (!card) return { pass: false, detail: `no card — the reply: ${flat(turn.message?.text).slice(0, 160)}` };
    const warned = (card.preview?.warnings || []).some((w) => /9\.9/.test(w));
    await actions.approveAction(admin, card.id);
    const c = await coaOf("H-RESPI");
    const fresh = await prisma.certificate.findUnique({ where: { id: c.id } });
    let refused = null;
    try {
      await finalize(c.id, c.companyId, admin.id, { expectedVersion: fresh.currentVersion });
      created.certificates.add(c.id);
    } catch (err) {
      refused = err.code;
    }
    const { outOfSpec } = await reviewChecks(c.id, c.companyId);
    return { pass: warned && refused === "OUT_OF_SPEC", detail: `card warning ${warned ? "shown" : "MISSING"} · finalize ${refused ? `refused (${refused})` : "ALLOWED"} · out of spec: ${outOfSpec.map((o) => `${o.label}=${o.value} vs ${o.spec}`).join(", ") || "none"}` };
  });

  await scenario(9, "HC: one for the shipment, its products, the MO's consignee, the company's exporter", async () => {
    const hcs = await certsOf(ctx.requestId, "HC");
    if (hcs.length !== 1) return { pass: false, detail: `${hcs.length} HC certificates` };
    const hc = hcs[0];
    const { values } = await valuesOf(hc);
    const lines = await prisma.invoiceItem.findMany({ where: { invoiceId: ctx.requestId }, include: { product: { select: { name: true } } } });
    const group = Object.values(values).find((v) => v.kind === "group");
    const rowNames = (group?.rows || []).map((r) => Object.values(r.cells || r).map((x) => (typeof x === "object" ? x?.value : x)).find((x) => x && lines.some((l) => norm(String(x)).startsWith(norm(l.product?.name)))) || null);
    const covered = lines.filter((l) => rowNames.some((n) => n && norm(n).startsWith(norm(l.product?.name)))).length;
    const consignee = flat(values.consignee_name?.value);
    const exporter = flat(values.exporter_name?.value);
    const producer = company.profile?.producerName || null;
    const pass = hc.scope === "per_invoice" && covered === lines.length && consignee === MO_CUSTOMER && (!producer || exporter === producer);
    return { pass, detail: `scope ${hc.scope} · rows ${group?.rows?.length ?? 0} for ${lines.length} products (${covered} found) · consignee "${consignee}"${(values.consignee_name?.flags || []).length ? ` ${JSON.stringify(values.consignee_name.flags)}` : ""} · exporter "${exporter}"` };
  });

  await scenario(11, "Request from names «OLIGOVET 100ML / OLIGOVET 1L / addhepa»", async () => {
    const out = await createRequest({ companyId: cid, userId: admin.id, text: "OLIGOVET 100ML\nOLIGOVET 1L\naddhepa" });
    const id = out.request.id;
    ctx.namesRequestId = id;
    created.requests.add(id);
    const view = await getRequest(id, cid);
    const [r100, r1l, hepa] = view.rows;
    const has1l = await prisma.product.findFirst({ where: { companyId: cid, name: { equals: "OLIGOVET", mode: "insensitive" }, packaging: { in: ["1 L", "1L", "1 l", "1000 mL", "1000mL"] } }, select: { id: true } });
    const ok100 = r100?.match === "matched" && /100\s*mL/i.test(r100.packing || "");
    const ok1l = has1l ? r1l?.match === "matched" && r1l.productId === has1l.id : r1l?.match === "new_pack" && r1l.candidates?.length > 0;
    const okHepa = hepa?.match === "matched" && /ADDHEPA/i.test(hepa.product || "");
    return { pass: ok100 && ok1l && okHepa, detail: `100ML ${r100?.match} ${r100?.packing || ""} · 1L ${r1l?.match}${has1l ? " (a 1 L pack exists: matched to it)" : " (offered as a new pack)"} · addhepa ${hepa?.match} ${hepa?.product || ""}` };
  });

  await scenario(10, "FSC (template not ready): none made; card and matrix say so in both languages", async () => {
    const id = ctx.namesRequestId;
    const view = await getRequest(id, cid);
    const cells = view.rows.map((r) => r.cells?.FSC).filter(Boolean);
    const said = cells.length > 0 && cells.every((c) => (c.missing || []).some((m) => /FSC/.test(m.en || "") && /isn't ready/.test(m.en || "") && /FSC/.test(m.ar || "") && /[؀-ۿ]/.test(m.ar || "")));
    const card = notMadeTypes(["FSC"], new Set())[0];
    const cardOk = /isn't ready/.test(card.en) && /[؀-ۿ]/.test(card.ar);
    const made = await prisma.certificate.count({ where: { invoiceId: { in: [...created.requests] }, certificateType: { code: "FSC" } } });
    return { pass: said && cardOk && made === 0, detail: `matrix: ${cells.map((c) => c.missing?.[0]?.en || c.status).join(" | ") || "no FSC column"} · card: "${card.en}" / "${card.ar}" · FSC made: ${made}` };
  });

  await scenario(13, "Review chain: draft → in review → approved → final; edit after final → revision 2, revision 1 read-only", async () => {
    const c = (ctx.cleanCocs || [])[0];
    if (!c) return { pass: false, detail: "no COC with 0 blanks (see #3)" };
    ctx.numbersBefore = await listSchemes(cid);
    const steps = [];
    const st = async () => {
      const x = await prisma.certificate.findUnique({ where: { id: c.id }, select: { status: true, reviewStatus: true, currentVersion: true } });
      steps.push(x.status === "final" ? "final" : x.reviewStatus || "draft");
      return x;
    };
    await st();
    await reviewAction(c.id, cid, admin.id, { action: "submit" });
    await st();
    await reviewAction(c.id, cid, admin.id, { action: "pass" });
    await st();
    const before = await st();
    await reviewAction(c.id, cid, admin.id, { action: "authorize", expectedVersion: before.currentVersion });
    created.certificates.add(c.id);
    const fin = await st();
    ctx.firstFinal = c.id;
    const rev = await revise(c.id, cid, admin.id);
    created.certificates.add(rev.id);
    const v2 = await valuesOf(rev);
    const plain = Object.entries(v2.values).filter(([, x]) => x?.kind !== "group" && flat(x?.value)).map(([k]) => k);
    const key = plain.find((k) => /product_name|trade/i.test(k)) || plain[0];
    const edited = await editValues(rev.id, cid, admin.id, { expectedVersion: rev.currentVersion, changes: { [key]: `${v2.values[key]?.value || ""} ` } }).then(() => true, () => false);
    let locked = false;
    try {
      await editValues(c.id, cid, admin.id, { expectedVersion: fin.currentVersion, changes: { [key]: "x" } });
    } catch (err) {
      locked = /FINAL|final/.test(`${err.code} ${err.message}`);
    }
    const r1 = await prisma.certificate.findUnique({ where: { id: c.id }, select: { status: true } });
    const pass = steps.slice(0, 4).join(">") === "draft>in_review>awaiting_authorization>awaiting_authorization" && fin.status === "final" && rev.revisionNumber === 2 && edited && locked && r1.status === "final";
    return { pass, detail: `${[...new Set(steps)].join(" → ")} · revision ${rev.revisionNumber} edited ${edited} · revision 1 ${locked ? "read-only" : "EDITABLE"}` };
  });

  await scenario(12, "Numbering: drafts take none; finalize gives the next, no gap / repeat; COC / COA restart monthly", async () => {
    const certIds = (await prisma.certificate.findMany({ where: { invoiceId: ctx.requestId, status: { not: "final" } }, select: { id: true } })).map((c) => c.id);
    const draftNumbers = await prisma.documentNumber.count({ where: { certificateId: { in: certIds } } });
    const before = (ctx.numbersBefore || (await listSchemes(cid))).find((s) => s.certCode === "COC");
    const first = ctx.firstFinal ? await prisma.documentNumber.findFirst({ where: { certificateId: ctx.firstFinal }, select: { number: true } }) : null;
    const second = (ctx.cleanCocs || []).find((c) => c.id !== ctx.firstFinal);
    let n2 = null;
    if (second) {
      const fresh = await prisma.certificate.findUnique({ where: { id: second.id } });
      await finalize(second.id, cid, admin.id, { expectedVersion: fresh.currentVersion });
      created.certificates.add(second.id);
      n2 = (await prisma.documentNumber.findFirst({ where: { certificateId: second.id }, select: { number: true } }))?.number;
    }
    const want1 = before?.next;
    const want2 = before ? formatNumber(before.pattern, before.nextNumber + 1) : null;
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 2);
    const later = await listSchemes(cid, nextMonth);
    const monthly = ["COC", "COA"].every((code) => later.find((s) => s.certCode === code)?.monthly === true && later.find((s) => s.certCode === code)?.nextNumber === 1);
    const pass = draftNumbers === 0 && first?.number === want1 && n2 === want2 && monthly;
    return { pass, detail: `drafts holding a number: ${draftNumbers} · finals: ${first?.number || "-"} (want ${want1}), ${n2 || "-"} (want ${want2}) · next month COC/COA restart at 1: ${monthly} · the test finals are deleted and the counters put back at the end` };
  });

  await scenario(18, "A COA with rows taken off is a normal certificate: finalizes (number given), no watermark", async () => {
    const coas = await certsOf(ctx.requestId, "COA");
    let pick = null;
    for (const c of coas) {
      if (c.status !== "draft" || /ADDHEPA|H-RESPI/i.test(c.product?.name || "")) continue;
      const { values } = await valuesOf(c);
      if (!blockingOf(values).length && Object.values(values).some((v) => (v?.flags || []).includes("row_removed"))) {
        pick = c;
        break;
      }
    }
    if (!pick) return { pass: false, detail: "no COA draft with rows taken off and nothing blocking" };
    const fresh = await prisma.certificate.findUnique({ where: { id: pick.id } });
    let error = null;
    try {
      await finalize(pick.id, cid, admin.id, { expectedVersion: fresh.currentVersion });
    } catch (err) {
      error = `${err.code || ""} ${err.message}`;
    }
    created.certificates.add(pick.id);
    const after = await prisma.certificate.findUnique({ where: { id: pick.id } });
    const number = (await prisma.documentNumber.findFirst({ where: { certificateId: pick.id }, select: { number: true } }))?.number;
    const html = await printedText((await valuesOf(after)).htmlFileId);
    const pass = !error && after.status === "final" && !!number && !WATERMARK.test(html) && !after.isExperimentSample;
    return { pass, detail: error ? `finalize refused: ${error}` : `${who(pick)} → ${after.status}, number ${number || "NONE"}, watermark ${WATERMARK.test(html) ? "PRESENT" : "none"}` };
  });

  await scenario(19, "Experiment mode's batch size: pack × quantity, never the count with a volume unit (code check)", async () => {
    const f = batchFacts({ quantity: 2400, packing: "100 mL" });
    const cases = [
      ['2400 × 100 mL, the model said "2400 L"', guardBatchSize("2400 L", f), "240 L"],
      ['the model said "240 L"', guardBatchSize("240 L", f), "240 L"],
      ['no pack, the model said "2400 L"', guardBatchSize("2400 L", batchFacts({ quantity: 2400 })), "2400 units"],
      ["500 × 1 KG", batchFacts({ quantity: 500, packing: "1 KG" })?.total, "500 kg"],
    ];
    const bad = cases.filter(([, got, want]) => got !== want);
    return { pass: !bad.length, detail: cases.map(([t, got, want]) => `${t} → ${got}${got === want ? "" : ` (want ${want})`}`).join(" · ") };
  });

  await scenario(14, "Deep link with another company selected opens and switches company", async () => {
    const call = (type, id, company = null) =>
      new Promise((resolve) => {
        const res = { status: () => res, json: (body) => resolve({ ok: true, body }) };
        entityCompany({ params: { type, id }, company }, res, (err) => resolve({ ok: false, err }));
      });
    const cert = (await certsOf(ctx.requestId))[0];
    const asAdmin = await call("request", ctx.requestId);
    const asAdminCert = cert ? await call("certificate", cert.id) : { ok: false };
    const other = await prisma.company.findFirst({ where: { id: { not: cid } }, select: { id: true } });
    const asOther = await call("request", ctx.requestId, other);
    const pass = asAdmin.ok && asAdmin.body.data.companyId === cid && asAdminCert.ok && asAdminCert.body.data.companyId === cid && !asOther.ok && asOther.err?.statusCode === 404;
    return { pass, detail: `request → ${asAdmin.body?.data?.companyName || "?"}, certificate → ${asAdminCert.body?.data?.companyName || "?"}, another company's session → ${asOther.ok ? "SEES IT" : asOther.err?.statusCode}. (The page switches with useFollowEntityCompany on the request and certificate pages.)` };
  });
}

/** Everything this run made, by the ids it recorded; the counters it moved, back as they were. */
async function cleanup() {
  const requests = [...created.requests];
  const certIds = new Set(created.certificates);
  for (const c of await prisma.certificate.findMany({ where: { invoiceId: { in: requests } }, select: { id: true } })) certIds.add(c.id);
  // revisions point at what they revise: theirs first
  for (const c of await prisma.certificate.findMany({ where: { revisionOfId: { in: [...certIds] } }, select: { id: true } })) certIds.add(c.id);
  const ids = [...certIds];
  const out = await prisma.$transaction(async (tx) => {
    const n = {};
    n.numbers = (await tx.documentNumber.deleteMany({ where: { certificateId: { in: ids } } })).count;
    n.items = (await tx.certificateItem.deleteMany({ where: { certificateId: { in: ids } } })).count;
    n.versions = (await tx.certificateVersion.deleteMany({ where: { certificateId: { in: ids } } })).count;
    await tx.certificate.updateMany({ where: { id: { in: ids } }, data: { revisionOfId: null } });
    n.certificates = (await tx.certificate.deleteMany({ where: { id: { in: ids } } })).count;
    n.batches = (await tx.certificateBatch.deleteMany({ where: { invoiceId: { in: requests } } })).count;
    n.needs = (await tx.certificateDataNeed.deleteMany({ where: { invoiceId: { in: requests } } })).count;
    n.lines = (await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: requests } } })).count;
    n.requests = (await tx.invoice.deleteMany({ where: { id: { in: requests }, origin: "direct" } })).count;
    for (const s of schemesBefore || []) await tx.numberingScheme.update({ where: { id: s.id }, data: { lastSeq: s.lastSeq, seqPeriod: s.seqPeriod, source: s.source, confirmed: s.confirmed } });
    n.counters = (schemesBefore || []).length;
    return n;
  }, { timeout: 120_000 });
  for (const id of created.conversations) await prisma.assistantConversation.update({ where: { id }, data: { deletedAt: new Date() } }).catch(() => {});
  say(`cleanup: ${JSON.stringify(out)} · ${created.conversations.length} conversations closed`);
}

let exitCode = 1;
try {
  await main();
  exitCode = results.every((r) => r.pass) ? 0 : 1;
} catch (err) {
  console.error(`acceptance stopped: ${err.message}`);
} finally {
  if (!KEEP) {
    try {
      await cleanup();
    } catch (err) {
      console.error(`CLEANUP FAILED: ${err.message} — requests ${[...created.requests].join(", ")}`);
      exitCode = 1;
    }
  } else say(`--keep: left requests ${[...created.requests].join(", ")}`);
  console.log("\n════ Certificates — definition of done ════");
  for (const r of results.sort((a, b) => a.n - b.n)) console.log(`${r.pass ? "PASS" : "FAIL"}  #${String(r.n).padStart(2)}  ${r.title}${r.detail ? `\n        ${r.detail}` : ""}`);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed} / ${results.length} passed · ${Math.round((Date.now() - t0) / 1000)} s${results.length === 19 ? "" : " (not every scenario ran)"}`);
  await prisma.$disconnect();
  process.exit(exitCode);
}
