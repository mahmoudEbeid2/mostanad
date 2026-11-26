// The harvest's reader (28 Nov, owner: "accuracy over cost"): every file of a drop goes to Gemini
// natively — PDFs and images as files (File API), spreadsheets as their rows — in ONE call per drop
// (split only by size), with a strict JSON schema: one entry per value, with its file, page and the
// printed words it was read from. A second call with the same files checks every value against its
// page; numbers (amounts, batch numbers, dates, registration numbers) must also appear character for
// character in their quote (code). What either check doubts is kept as "needs review", never filled.
//
//   model      GEMINI_HARVEST_MODEL only (modelRegistry.harvestModel): a Pro model, never flash / lite,
//              no fallback to a smaller model on overload — the call fails and retries instead
//   files      cached by content (sha256) while Google keeps them (48 h, its own expiry time); a PDF over
//              the per-file limit, or one too big for a call, is sent as page ranges
//   failure    a group that fails is split; a single file that still fails is reported, the rest goes on
//   storage    the drop's values wait on intake_batches.harvest until the drop is filed under a company,
//              then become harvested_facts (extractor "ai") — the rules reader's facts for the same files
//              are replaced; without a harvest model the rules reader (harvestRules.js) is the reader
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../../lib/prisma.js";
import geminiClient from "../ai/geminiClient.js";
import { harvestModel, HARVEST_SETTINGS } from "../ai/modelRegistry.js";
import { geminiDisabled } from "../ai/geminiGuard.js";
import { withAiContext, currentAiContext } from "../ai/aiContext.js";
import * as fileStore from "../certificates/storage/fileStore.js";
import { readXlsx, readCsv } from "../intake/productSheet.js";
import { norm, normPack, numberPattern, dateFormatOf } from "./harvestRules.js";
import { mergeAll, summaryAr } from "./harvestService.js";

const PDF_MAX_BYTES = 45 * 1024 * 1024; // Google: a PDF up to 50 MB
const PAGES_PER_CALL = 400; // well inside a 1M-token window at high resolution
const PARTS_PER_CALL = 40;
const VALUES_PER_VERIFY = 300;
const CALL_TIMEOUT_MS = 15 * 60 * 1000;
const URI_MARGIN_MS = 60 * 60 * 1000; // a cached file with less than an hour left is sent again
const UPLOAD_TIMEOUT_MS = 3 * 60 * 1000; // one File API upload (and each status check) — never waited on forever
const PROCESSING_POLLS = 60; // × 3 s: how long Google may take to make an uploaded file ACTIVE
// 26 Nov (prod: 5 files "waiting" 0/5 for 8+ minutes): a drop's whole read — queued, uploads, calls —
// has HARVEST_TIMEOUT_MIN minutes. Past it the files still unread are failed with the reason and
// Express goes on with the rules reader's facts (they were made at filing).
export const HARVEST_TIMEOUT_MS = Math.max(1, Number(process.env.HARVEST_TIMEOUT_MIN) || 15) * 60 * 1000;
export const HARVEST_WAIT_MS = HARVEST_TIMEOUT_MS; // Express waits this long for a drop's read, then goes on
const GATE_GRACE_MS = 30 * 1000; // the job records its own timeout first; the gate only for a job that never answers

const harvestTimeout = (what) => Object.assign(new Error(`the read took longer than ${Math.round(HARVEST_TIMEOUT_MS / 60000)} min (${what}) — stopped; the rules reader's facts are used`), { harvestTimeout: true });
/** A promise that rejects after ms (the SDK's File API calls have no timeout of their own) */
function within(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} didn't answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
/** The run's clock: throws once its deadline passed or it was given up (nothing more is sent) */
function checkRun(run, what) {
  if (!run?.deadline) return;
  if (run.cancelled || Date.now() >= run.deadline) {
    run.cancelled = true;
    throw harvestTimeout(what);
  }
}

/** Is the AI reader on? → { on, model, reason } */
export function aiHarvestAvailable() {
  if (geminiDisabled()) return { on: false, model: null, reason: "GEMINI_DISABLED" };
  const m = harvestModel();
  return m.id ? { on: true, model: m.id, reason: null } : { on: false, model: null, reason: m.reason };
}

// ── the schema ─────────────────────────────────────────────────────────────────────────────
export const DOC_TYPES = ["certificate_coa", "certificate_coc", "certificate_hc", "certificate_fsc", "certificate_other", "label", "catalogue", "invoice", "manufacturing_order", "lab_report", "registration", "product_list", "other"];
export const FIELDS = {
  company: ["name", "address", "country", "email", "phone", "website", "producerName", "companyCode", "registrationNo"],
  product: ["name", "productCode", "category", "physicalForm", "packaging", "validity", "storage", "dosage", "administration", "indications", "targetSpecies", "withdrawalPeriod", "contraindications", "registrationNumber", "appearance", "compositionBasis", "ingredient", "specification", "origin"],
  batch: ["batchNo", "productionDate", "expiryDate", "batchSize", "result"],
  document: ["documentNumber", "issueDate", "signatoryName", "signatoryTitle"],
  commercial: ["invoiceNumber", "invoiceLine", "consignee", "buyer"],
};
const ALL_FIELDS = [...new Set(Object.values(FIELDS).flat())];
// copied, never reasoned: these must be printed exactly as stored (checked against the quote by code)
const EXACT = new Set(["batchNo", "productionDate", "expiryDate", "batchSize", "result", "registrationNumber", "registrationNo", "documentNumber", "invoiceNumber", "companyCode"]);

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "the file's label as given (F1, F2 …)" },
          docType: { type: "string", enum: DOC_TYPES },
          company: { type: "string", nullable: true, description: "the company the document belongs to, as printed" },
        },
        required: ["file", "docType"],
      },
    },
    values: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entity: { type: "string", enum: Object.keys(FIELDS) },
          field: { type: "string", enum: ALL_FIELDS },
          value: { type: "string", description: "exactly as printed (an ingredient: its name; a specification / result: the printed text)" },
          amount: { type: "string", nullable: true, description: "an ingredient's amount exactly as printed, e.g. \"10,000 IU\", \"ad 1 mL\"; an invoice line's quantity" },
          unit: { type: "string", nullable: true },
          test: { type: "string", nullable: true, description: "for a specification / result: the test's name (pH, Assay, Appearance …)" },
          row: { type: "integer", nullable: true, description: "for an ingredient: its position in the printed composition, from 1" },
          product: { type: "string", nullable: true, description: "the product the value belongs to — a known product's name exactly when it is the same product" },
          pack: { type: "string", nullable: true, description: "the pack size, when the value belongs to one pack" },
          batchNo: { type: "string", nullable: true, description: "for a batch value: the batch it belongs to" },
          file: { type: "string" },
          page: { type: "integer", description: "page number in that file, from 1" },
          snippet: { type: "string", description: "the printed words the value was read from, verbatim" },
        },
        required: ["entity", "field", "value", "file", "page", "snippet"],
      },
    },
  },
  required: ["files", "values"],
};

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          verdict: { type: "string", enum: ["match", "mismatch", "not_found"] },
          printed: { type: "string", nullable: true, description: "what the page actually prints, when it differs" },
          note: { type: "string", nullable: true },
        },
        required: ["i", "verdict"],
      },
    },
  },
  required: ["checks"],
};

const EXTRACT_PROMPT = [
  "You read the documents of a veterinary / animal-feed company: certificates (COA, COC, health, free sale), product labels, catalogues, invoices, manufacturing orders, lab reports, registration documents and product lists.",
  "Read EVERY page of EVERY file and report every value they print, one entry per value, for these fields:",
  "- company: name, address, country, email, phone, website, producerName (the manufacturer printed as producer), companyCode (a code used in its document numbers), registrationNo (the company's own registration).",
  "- product: name, productCode, category, physicalForm, packaging (each pack size its own entry), validity (shelf life), storage, dosage, administration, indications, targetSpecies, withdrawalPeriod, contraindications, registrationNumber (only as printed), appearance, compositionBasis (e.g. \"Each 1 mL contains\"), ingredient (one entry per composition row: value = the name, amount = the amount as printed, row = its position), specification (test = the test, value = the specified limit/text), origin (country of origin).",
  "- batch: batchNo, productionDate, expiryDate, batchSize, result (test = the test, value = the result) — set batchNo on each so values of one batch stay together.",
  "- document: documentNumber, issueDate, signatoryName, signatoryTitle.",
  "- commercial: invoiceNumber, invoiceLine (value = the product as printed, pack, amount = the quantity), consignee, buyer.",
  "Rules:",
  "- Copy values exactly as printed, character for character — never correct, translate, round or reformat numbers, codes or dates.",
  "- snippet = the printed words the value comes from, verbatim (a short line). page = the page number inside that file.",
  "- Never report a value the page does not print. Never guess. A field that isn't printed is simply absent.",
  "- A file listing several products: give each value its product. A label printed twice on one sheet (two panels): report each value once.",
  "- When a product is one of the known products below (same product, maybe written differently), use the known name exactly in `product`.",
  "- For each file, also say what it is (docType) and whose it is (company).",
].join("\n");

const VERIFY_PROMPT = [
  "Below are values someone read from the attached files. Check EACH one against the page it cites.",
  "verdict: match = the page prints exactly this value (for numbers, codes, dates, amounts: character for character) for this product / batch;",
  "mismatch = the page prints something different (give `printed`); not_found = the cited page does not print it at all.",
  "Be strict with numbers: \"10,000 IU\" ≠ \"1,000 IU\", \"01/10/2026\" ≠ \"10/01/2026\". Return one check per value, with its i.",
].join("\n");

// ── files → parts (what one request carries) ───────────────────────────────────────────────
const isPdf = (buf) => buf.subarray(0, 5).toString("latin1") === "%PDF-";
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", heif: "image/heif" };
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function pdfPages(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  return { doc, count: doc.getPageCount() };
}

async function slicePdf(doc, from, to) {
  const out = await PDFDocument.create();
  const pages = await out.copyPages(doc, Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i));
  pages.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}

/**
 * One drop file → its parts: { label, name, kind: "file"|"text", mimeType, buffer?, text?, pages, pageOffset }
 * (an .ai file is a PDF inside; a spreadsheet goes as its rows). → { parts, skipped? }
 */
export async function partsOf({ label, name, buffer, mimeType = null }) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (isPdf(buffer)) {
    let pages = 1;
    let doc = null;
    try {
      ({ doc, count: pages } = await pdfPages(buffer));
    } catch {
      // unreadable by pdf-lib: still sent whole when small enough (Gemini reads it itself)
      if (buffer.length <= PDF_MAX_BYTES) return { parts: [{ label, name, kind: "file", mimeType: "application/pdf", buffer, pages: 1, pageOffset: 0 }] };
      return { parts: [], skipped: "a PDF over 45 MB that can't be split" };
    }
    if (buffer.length <= PDF_MAX_BYTES && pages <= PAGES_PER_CALL) return { parts: [{ label, name, kind: "file", mimeType: "application/pdf", buffer, pages, pageOffset: 0, doc }] };
    // too big for one piece: page ranges, each under both limits
    const perPage = buffer.length / pages;
    const step = Math.max(1, Math.min(PAGES_PER_CALL, Math.floor(PDF_MAX_BYTES / perPage)));
    const parts = [];
    for (let from = 1; from <= pages; from += step) {
      const to = Math.min(pages, from + step - 1);
      parts.push({ label, name, kind: "file", mimeType: "application/pdf", buffer: await slicePdf(doc, from, to), pages: to - from + 1, pageOffset: from - 1 });
    }
    return { parts };
  }
  if (IMAGE_TYPES[ext] || /^image\//.test(mimeType || "")) return { parts: [{ label, name, kind: "file", mimeType: IMAGE_TYPES[ext] || mimeType, buffer, pages: 1, pageOffset: 0 }] };
  if (ext === "xlsx" || ext === "csv") {
    const rows = ext === "xlsx" ? await readXlsx(buffer) : readCsv(buffer.toString("utf8"));
    const text = rows.map((r) => r.map((c) => String(c ?? "").replace(/[\r\n]+/g, " ")).join(" | ")).join("\n").slice(0, 400_000);
    return { parts: [{ label, name, kind: "text", text, pages: 1, pageOffset: 0 }] };
  }
  return { parts: [], skipped: "not a PDF, image or spreadsheet" };
}

/** A part → its Gemini File API reference, uploaded once per content while Google keeps it */
export async function geminiRef(part, run = null) {
  const hash = sha(part.buffer);
  const cached = await prisma.geminiFile.findFirst({ where: { sha256: hash, expiresAt: { gt: new Date(Date.now() + URI_MARGIN_MS) } }, orderBy: { expiresAt: "desc" } });
  if (cached) return { fileUri: cached.uri, mimeType: cached.mimeType };
  const tmp = path.join(os.tmpdir(), `harvest-${hash.slice(0, 16)}-${process.pid}${part.mimeType === "application/pdf" ? ".pdf" : ""}`);
  fs.writeFileSync(tmp, part.buffer);
  try {
    const t0 = Date.now();
    console.log(`[harvest] uploading "${part.name}" (${Math.round(part.buffer.length / 1024)} KB) to the Gemini File API`);
    const up = await within(geminiClient.uploadFile(tmp, { mimeType: part.mimeType, displayName: part.name.slice(0, 100) }), UPLOAD_TIMEOUT_MS, `the Gemini File API upload of "${part.name}"`);
    let f = await within(geminiClient.getFile(up.name), UPLOAD_TIMEOUT_MS, "the Gemini File API");
    for (let n = 0; f.state === "PROCESSING" && n < PROCESSING_POLLS; n++) {
      checkRun(run, `"${part.name}" still processing at Google`);
      await new Promise((r) => setTimeout(r, 3000));
      f = await within(geminiClient.getFile(up.name), UPLOAD_TIMEOUT_MS, "the Gemini File API");
    }
    if (f.state !== "ACTIVE") throw new Error(`Gemini didn't accept the file (state ${f.state})`);
    console.log(`[harvest] "${part.name}" uploaded and ACTIVE in ${Math.round((Date.now() - t0) / 1000)} s`);
    // Google's own expiry for the file (48 h at the time of writing); 47 h when it doesn't say
    const expiresAt = f.expirationTime ? new Date(f.expirationTime) : new Date(Date.now() + 47 * 3600 * 1000);
    await prisma.geminiFile.create({ data: { sha256: hash, name: f.name, uri: f.uri, mimeType: f.mimeType || part.mimeType, sizeBytes: part.buffer.length, expiresAt } });
    return { fileUri: f.uri, mimeType: f.mimeType || part.mimeType };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ── the calls ──────────────────────────────────────────────────────────────────────────────
const partKey = (p) => `${p.label}${p.pageOffset ? `@${p.pageOffset}` : ""}`;

async function contentsFor(parts, intro, run = null) {
  const content = [{ text: intro }];
  for (const p of parts) {
    checkRun(run, "uploading the files");
    const header = `=== File ${partKey(p)}: "${p.name}"${p.pageOffset ? ` — pages ${p.pageOffset + 1}–${p.pageOffset + p.pages} of the file (number pages from ${p.pageOffset + 1})` : ""} ===`;
    content.push({ text: header });
    if (p.kind === "text") content.push({ text: p.text });
    else content.push({ fileData: await geminiRef(p, run) });
  }
  return [{ role: "user", parts: content }];
}

async function callJson({ model, contents, schema, feature, ledgerCtx, run = null }) {
  checkRun(run, feature === "intake.harvest_verify" ? "checking the values" : "reading the files");
  // never past the run's deadline: the call is aborted when the read's time is up
  const timeoutMs = run?.deadline ? Math.max(5000, Math.min(CALL_TIMEOUT_MS, run.deadline - Date.now())) : CALL_TIMEOUT_MS;
  const request = {
    model,
    contents,
    config: {
      temperature: HARVEST_SETTINGS.temperature,
      thinkingConfig: { thinkingBudget: HARVEST_SETTINGS.thinkingBudget },
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
      responseSchema: schema,
      mediaResolution: "MEDIA_RESOLUTION_HIGH", // labels and scans at full resolution
      allowFallback: false,
      timeoutMs,
    },
  };
  const t0 = Date.now();
  console.log(`[harvest] ${feature} → ${model} (timeout ${Math.round(timeoutMs / 1000)} s)`);
  // (each call site names its ledger feature literally)
  let response;
  try {
    response = await withAiContext({ ...currentAiContext(), ...ledgerCtx }, () =>
      feature === "intake.harvest_verify"
        ? geminiClient.generateContentWithRetry({ ledger: { feature: "intake.harvest_verify" }, ...request })
        : geminiClient.generateContentWithRetry({ ledger: { feature: "intake.harvest" }, ...request })
    );
  } catch (err) {
    console.error(`[harvest] ${feature} failed after ${Math.round((Date.now() - t0) / 1000)} s: ${err.message}`);
    // the call was cut at the read's deadline: the whole read stops, not just this group
    if (run?.deadline && Date.now() >= run.deadline - 1000) {
      run.cancelled = true;
      throw harvestTimeout(feature === "intake.harvest_verify" ? "checking the values" : "reading the files");
    }
    throw err;
  }
  console.log(`[harvest] ${feature} answered in ${Math.round((Date.now() - t0) / 1000)} s`);
  const finish = response.candidates?.[0]?.finishReason;
  if (finish && finish !== "STOP") throw Object.assign(new Error(`the answer stopped early (${finish})`), { splittable: true });
  try {
    return JSON.parse(String(response.text || "").replace(/^```json\s*|```\s*$/g, ""));
  } catch {
    throw Object.assign(new Error("the answer was not valid JSON"), { splittable: true });
  }
}

/** A value is well-formed and inside the schema → normalized, else null (dropped) */
export function cleanValue(v, labels) {
  if (!v || !FIELDS[v.entity]?.includes(v.field)) return null;
  const value = String(v.value ?? "").trim();
  if (!value || value.length > 2000) return null;
  if (!labels.has(String(v.file))) return null;
  const page = Number.isInteger(v.page) && v.page > 0 ? v.page : null;
  return {
    entity: v.entity,
    field: v.field,
    value,
    amount: v.amount ? String(v.amount).trim() : null,
    unit: v.unit ? String(v.unit).trim() : null,
    test: v.test ? String(v.test).trim().slice(0, 80) : null,
    row: Number.isInteger(v.row) ? v.row : null,
    product: v.product ? String(v.product).trim().slice(0, 200) : null,
    pack: v.pack ? String(v.pack).trim().slice(0, 60) : null,
    batchNo: v.batchNo ? String(v.batchNo).trim().slice(0, 80) : null,
    file: String(v.file),
    page,
    snippet: String(v.snippet || "").trim().slice(0, 500),
  };
}

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();
/** Code's own check for a copied number / code / date: it must be in its quote exactly */
export function exactCheck(v) {
  const needs = EXACT.has(v.field) || (v.field === "ingredient" && v.amount);
  if (!needs) return null;
  const quote = squash(v.snippet);
  const what = v.field === "ingredient" ? v.amount : v.value;
  return quote.includes(squash(what)) ? null : `«${what}» مش مكتوب كده بالظبط في النص المقتبس`;
}

/**
 * Read a set of parts (one group). A group that fails is halved; a single part that still fails
 * is split into page halves (a PDF), else reported. → { values, files, failed: [{ label, error }] }
 */
async function readGroup(parts, ctx) {
  const labels = new Set(parts.map((p) => p.label));
  try {
    const out = await callJson({ model: ctx.model, contents: await contentsFor(parts, `${EXTRACT_PROMPT}\n\n${ctx.known}`, ctx), schema: EXTRACT_SCHEMA, feature: "intake.harvest", ledgerCtx: ctx.ledgerCtx, run: ctx });
    const values = [];
    for (const raw of out.values || []) {
      // a part of a split PDF numbers its pages from its first page in the file
      const v = cleanValue({ ...raw, file: String(raw.file || "").split("@")[0] }, labels);
      if (v) values.push(v);
    }
    return { values, files: (out.files || []).map((f) => ({ ...f, file: String(f.file || "").split("@")[0] })), failed: [] };
  } catch (err) {
    if (err.harvestTimeout) throw err; // out of time: splitting would only send more
    if (parts.length > 1) {
      const half = Math.ceil(parts.length / 2);
      const a = await readGroup(parts.slice(0, half), ctx);
      const b = await readGroup(parts.slice(half), ctx);
      return { values: [...a.values, ...b.values], files: [...a.files, ...b.files], failed: [...a.failed, ...b.failed] };
    }
    const p = parts[0];
    if (err.splittable && p.kind === "file" && p.mimeType === "application/pdf" && p.pages > 1) {
      const { doc } = await pdfPages(p.buffer);
      const mid = Math.ceil(p.pages / 2);
      const halves = [
        { ...p, buffer: await slicePdf(doc, 1, mid), pages: mid },
        { ...p, buffer: await slicePdf(doc, mid + 1, p.pages), pages: p.pages - mid, pageOffset: p.pageOffset + mid },
      ];
      return readGroup(halves, ctx); // the pair fails → each half alone
    }
    return { values: [], files: [], failed: [{ label: p.label, error: String(err.message).slice(0, 300) }] };
  }
}

/** The verification pass over one group's values → the values with reviewStatus / verifyNote */
async function verifyGroup(parts, values, ctx) {
  const out = values.map((v) => ({ ...v, reviewStatus: "confirmed", verifyNote: null }));
  for (const [i, v] of out.entries()) {
    const bad = exactCheck(v);
    if (bad) Object.assign(out[i], { reviewStatus: "needs_review", verifyNote: bad });
  }
  for (let start = 0; start < out.length; start += VALUES_PER_VERIFY) {
    const chunk = out.slice(start, start + VALUES_PER_VERIFY);
    const list = chunk.map((v, k) => ({ i: start + k, file: v.file, page: v.page, entity: v.entity, field: v.field, test: v.test, product: v.product, batchNo: v.batchNo, value: v.value, amount: v.amount }));
    try {
      const res = await callJson({ model: ctx.model, contents: await contentsFor(parts, `${VERIFY_PROMPT}\n\nValues:\n${JSON.stringify(list)}`, ctx), schema: VERIFY_SCHEMA, feature: "intake.harvest_verify", ledgerCtx: ctx.ledgerCtx, run: ctx });
      const seen = new Set();
      for (const c of res.checks || []) {
        if (!Number.isInteger(c.i) || c.i < start || c.i >= start + chunk.length) continue;
        seen.add(c.i);
        if (c.verdict !== "match") Object.assign(out[c.i], { reviewStatus: "needs_review", verifyNote: [c.verdict === "not_found" ? "المراجِع مالقاهاش في الصفحة" : `المراجِع قرا: ${c.printed || "حاجة تانية"}`, c.note].filter(Boolean).join(" — ").slice(0, 300) });
      }
      // a value the checker skipped is not confirmed by it
      for (let k = start; k < start + chunk.length; k++) if (!seen.has(k) && out[k].reviewStatus === "confirmed") Object.assign(out[k], { reviewStatus: "needs_review", verifyNote: "المراجعة ماوصلتلهاش" });
    } catch (err) {
      if (err.harvestTimeout) throw err;
      for (let k = start; k < start + chunk.length; k++) if (out[k].reviewStatus === "confirmed") Object.assign(out[k], { reviewStatus: "needs_review", verifyNote: `المراجعة فشلت: ${String(err.message).slice(0, 120)}` });
    }
  }
  return out;
}

/** Split parts into calls: ≤ PAGES_PER_CALL pages and ≤ PARTS_PER_CALL parts each, files kept together */
export function groupsOf(parts) {
  const groups = [];
  let cur = [];
  let pages = 0;
  for (const p of parts) {
    if (cur.length && (pages + p.pages > PAGES_PER_CALL || cur.length >= PARTS_PER_CALL)) {
      groups.push(cur);
      cur = [];
      pages = 0;
    }
    cur.push(p);
    pages += p.pages;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Read files (each { label, fileId, name, status }) and check what was read. files' status / error /
 * docType / values are set in place; onProgress(done) after each group. → { values, docTypes }
 */
export async function readAndVerify(files, run, onProgress = async () => {}) {
  const parts = [];
  for (const f of files) {
    try {
      const { buffer, row } = await fileStore.readFile(f.fileId);
      const r = await partsOf({ label: f.label, name: f.name, buffer, mimeType: row.mimeType });
      if (r.skipped) Object.assign(f, { status: "skipped", error: r.skipped });
      parts.push(...r.parts);
    } catch (err) {
      Object.assign(f, { status: "failed", error: String(err.message).slice(0, 200) });
    }
  }
  const values = [];
  const docTypes = {};
  const settled = () => files.filter((f) => !["waiting", "reading"].includes(f.status)).length;
  await onProgress(settled(), "uploading");
  for (const group of groupsOf(parts)) {
    // the card shows which files are being read now (one group = one call: they finish together)
    const inGroup = new Set(group.map((p) => p.label));
    for (const f of files) if (inGroup.has(f.label) && f.status === "waiting") f.status = "reading";
    await onProgress(settled(), "reading");
    const read = await readGroup(group, run);
    for (const d of read.files) if (DOC_TYPES.includes(d.docType)) docTypes[d.file] = { docType: d.docType, company: d.company || null };
    const failed = new Set(read.failed.map((x) => x.label));
    await onProgress(settled(), "verifying");
    const checked = await verifyGroup(group.filter((p) => !failed.has(p.label)), read.values, run);
    values.push(...checked);
    for (const label of new Set(group.map((p) => p.label))) {
      const f = files.find((x) => x.label === label);
      const fail = read.failed.find((x) => x.label === label);
      // a file split in parts counts as failed only when none of it was read
      if (fail && !read.values.some((v) => v.file === label)) Object.assign(f, { status: "failed", error: fail.error });
      else if (["waiting", "reading"].includes(f.status)) Object.assign(f, { status: "read", docType: docTypes[label]?.docType || null, values: checked.filter((v) => v.file === label).length });
    }
    await onProgress(settled(), "reading");
  }
  return { values, docTypes };
}

// ── a drop ─────────────────────────────────────────────────────────────────────────────────
const setHarvest = (batchId, patch) =>
  prisma.$executeRaw`UPDATE intake_batches SET harvest = COALESCE(harvest, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, updated_at = NOW() WHERE id = ${batchId}`;
// the job's own writes while it runs: a read the gate already gave up on is never written over
const setRunning = (batchId, patch) =>
  prisma.$executeRaw`UPDATE intake_batches SET harvest = harvest || ${JSON.stringify(patch)}::jsonb, updated_at = NOW() WHERE id = ${batchId} AND harvest->>'status' = 'running'`;

/**
 * The read stopped (out of time, or an error): every file not read yet is failed with the reason,
 * the drop's read is "failed" — Express goes on with the rules reader. Only a read still queued /
 * running is marked (a finished one is never undone). → true when this call marked it
 */
export async function failHarvest(batchId, error, files = null) {
  const b = await prisma.intakeBatch.findUnique({ where: { id: batchId }, select: { harvest: true } });
  const h = b?.harvest;
  if (!h || !["queued", "running"].includes(h.status)) return false;
  const why = String(error).slice(0, 300);
  const list = (files || h.files || []).map((f) => (["waiting", "reading"].includes(f.status) ? { ...f, status: "failed", error: why } : f));
  const patch = { status: "failed", error: why, files: list, done: list.length, finishedAt: new Date().toISOString() };
  const n = await prisma.$executeRaw`UPDATE intake_batches SET harvest = harvest || ${JSON.stringify(patch)}::jsonb, updated_at = NOW() WHERE id = ${batchId} AND harvest->>'status' IN ('queued', 'running')`;
  if (n) console.error(`[harvest] drop ${batchId}: read failed — ${why}`);
  return n > 0;
}

/** The drop's whole files (not a bundle's page items, not a .zip container) */
async function dropFiles(batchId) {
  const items = await prisma.intakeItem.findMany({ where: { batchId, fileId: { not: null }, pageFrom: null }, orderBy: { createdAt: "asc" } });
  return items.filter((i) => !/\.zip$/i.test(i.name) && i.status !== "duplicate");
}

async function knownList(batch) {
  const companyId = batch.companyId;
  const products = companyId ? await prisma.product.findMany({ where: { companyId }, select: { name: true, packaging: true }, take: 600 }) : [];
  const companies = await prisma.company.findMany({ select: { name: true }, take: 300, orderBy: { createdAt: "desc" } });
  return [
    products.length ? `Known products of this company: ${products.map((p) => (p.packaging ? `${p.name} (${p.packaging})` : p.name)).join("; ")}` : "Known products: none yet.",
    `Known companies: ${companies.map((c) => c.name).join("; ")}`,
  ].join("\n");
}

/** Sum the ledger for this drop's harvest calls → { calls, inputTokens, outputTokens, thinkingTokens, costUsd | null } */
export async function harvestCost(batchId) {
  const rows = await prisma.aiCall.findMany({ where: { entityType: "intake_batch", entityId: batchId, feature: { in: ["intake.harvest", "intake.harvest_verify"] } }, select: { inputTokens: true, outputTokens: true, thinkingTokens: true, costUsd: true } }).catch(() => []);
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  return { calls: rows.length, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), thinkingTokens: sum("thinkingTokens"), costUsd: rows.some((r) => r.costUsd === null) ? null : rows.reduce((n, r) => n + Number(r.costUsd), 0) };
}

/**
 * The job (BullMQ "harvestDrop"): read every file of a drop, verify, keep the values on the drop,
 * then — if the drop is already filed — turn them into facts. Never throws for one file.
 */
export async function runDropHarvest(batchId, ctx = {}) {
  const avail = aiHarvestAvailable();
  if (!avail.on) {
    await setHarvest(batchId, { status: "off", reason: avail.reason });
    return { status: "off", reason: avail.reason };
  }
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { status: "gone" };
  // one clock for the job and Express's gate: from when the drop's read was queued
  const queuedAt = new Date(batch.harvest?.startedAt || Date.now()).getTime();
  const deadline = queuedAt + HARVEST_TIMEOUT_MS;
  if (batch.harvest?.status === "failed" || Date.now() >= deadline) {
    // waited in the queue past its time (the gate went on without it): not started at all
    await failHarvest(batchId, harvestTimeout("waiting in the queue").message);
    return { status: "failed", reason: "timeout" };
  }
  const items = await dropFiles(batchId);
  const files = items.map((it, i) => ({ label: `F${i + 1}`, itemId: it.id, fileId: it.fileId, name: it.name, status: "waiting", error: null }));
  await setHarvest(batchId, { status: "running", model: avail.model, done: 0, total: files.length, files, startedAt: new Date(queuedAt).toISOString(), runningAt: new Date().toISOString(), finishedAt: null, error: null, values: [], applied: false });
  console.log(`[harvest] drop ${batchId}: reading ${files.length} file(s) with ${avail.model}, ${Math.round((deadline - Date.now()) / 1000)} s left`);
  const run = { model: avail.model, known: null, deadline, cancelled: false, ledgerCtx: { entityType: "intake_batch", entityId: batchId, ...(batch.companyId ? { companyId: batch.companyId } : {}) } };
  const progress = async (done, stage) => {
    if (run.cancelled) return;
    await setRunning(batchId, { done, stage, files });
    ctx.progress?.(Math.round(5 + (90 * done) / Math.max(1, files.length)), `بقرا الملفات… ${done}/${files.length}`);
  };

  let values;
  let docTypes;
  let timer;
  try {
    run.known = await knownList(batch);
    // the read itself, or the deadline — whichever comes first (a hung upload / call never holds Express)
    const reading = readAndVerify(files, run, progress);
    // a read given up on still ends (its call returns or times out): said, never unhandled
    reading.catch((err) => run.cancelled && console.warn(`[harvest] drop ${batchId}: the stopped read ended: ${err.message}`));
    const out = await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(harvestTimeout("the deadline passed")), Math.max(0, deadline - Date.now()));
      }),
    ]);
    ({ values, docTypes } = out);
  } catch (err) {
    run.cancelled = true; // a call still in flight sends nothing more and writes nothing
    await failHarvest(batchId, err.message, files);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const cost = await harvestCost(batchId);
  const review = values.filter((v) => v.reviewStatus !== "confirmed").length;
  const written = await setRunning(batchId, { status: "done", done: files.length, files, docTypes, values, review, cost, finishedAt: new Date().toISOString() });
  if (!written) return { status: "failed", reason: "given up by the gate before it finished" };
  console.log(`[harvest] drop ${batchId}: ${files.filter((f) => f.status === "read").length}/${files.length} files, ${values.length} values (${review} to review), ${cost.calls} calls, ${cost.inputTokens}+${cost.outputTokens}+${cost.thinkingTokens} tokens, cost ${cost.costUsd ?? "unpriced"}`);
  // the drop filed already → its facts now (else execute / Express apply them)
  const now = await prisma.intakeBatch.findUnique({ where: { id: batchId }, select: { status: true } });
  if (now?.status === "done") await applyDropHarvest(batchId);
  return { status: "done", files: files.length, values: values.length, review, cost };
}

// ── values → facts ─────────────────────────────────────────────────────────────────────────
const SOURCE_OF = { certificate_coa: "certificate", certificate_coc: "certificate", certificate_hc: "certificate", certificate_fsc: "certificate", certificate_other: "certificate", label: "label", catalogue: "catalogue", invoice: "invoice", manufacturing_order: "mo", lab_report: "lab", registration: "registration", product_list: "list", other: "other" };
const CERT_OF = { certificate_coa: "COA", certificate_coc: "COC", certificate_hc: "HC", certificate_fsc: "FSC" };
const PRODUCT_KEY = { administration: "routeOfAdmin", registrationNumber: "registrationNumber", productCode: "productCode" };

/** A drop's AI values → harvested_facts rows (one company) */
export function factRows(values, { companyId, fileOf, docTypes, modelId, productIdOf = () => null }) {
  const rows = [];
  // a value without its product, in a file about one product (a label): that product
  const only = new Map();
  for (const label of new Set(values.map((v) => v.file))) {
    const names = [...new Set(values.filter((v) => v.file === label && v.product).map((v) => v.product))];
    only.set(label, names.length === 1 ? names[0] : null);
  }
  const base = (v, extra) => {
    const f = fileOf(v.file);
    const dt = docTypes[v.file]?.docType || "other";
    const named = v.product || only.get(v.file);
    const productId = !named && (extra.entity === "product" || extra.entity === "batch") ? productIdOf(v.file) : null;
    return { companyId, productId, productName: named || null, pack: v.pack ? normPack(v.pack) || v.pack : null, sourceType: SOURCE_OF[dt] || "other", certCode: CERT_OF[dt] || null, fileId: f?.fileId || null, fileName: f?.name || null, page: v.page, snippet: v.snippet || null, perBatch: false, batchNo: null, extractor: "ai", reviewStatus: v.reviewStatus || "confirmed", verifyNote: v.verifyNote || null, modelId, unit: v.unit || null, ...extra };
  };
  const push = (v, extra) => rows.push({ ...base(v, extra), valueNorm: norm(extra.value).slice(0, 300) });
  // composition: one fact per file page and product, its rows in order
  const comps = new Map();
  for (const v of values.filter((x) => x.entity === "product" && x.field === "ingredient")) {
    const k = `${v.file}|${v.page}|${v.product || ""}`;
    if (!comps.has(k)) comps.set(k, []);
    comps.get(k).push(v);
  }
  for (const list of comps.values()) {
    list.sort((a, b) => (a.row ?? 999) - (b.row ?? 999));
    const doubt = list.find((x) => x.reviewStatus !== "confirmed");
    const value = list.map((x) => ({ name: x.value, amountRaw: x.amount || null, amount: x.amount ? Number(String(x.amount).replace(/[^\d.]/g, "")) || null : null, unit: x.unit || null }));
    push({ ...list[0], reviewStatus: doubt ? "needs_review" : "confirmed", verifyNote: doubt?.verifyNote || null, snippet: list.map((x) => x.snippet).join(" · ").slice(0, 400) }, { entity: "product", key: "activeIngredients", value });
  }
  // a document's own number and date: only their pattern (a certificate never reprints them)
  for (const v of values.filter((x) => x.entity === "document" && x.field === "documentNumber")) {
    const date = values.find((x) => x.file === v.file && x.page === v.page && x.field === "issueDate")?.value || null;
    const pat = numberPattern(v.value, date);
    const cert = CERT_OF[docTypes[v.file]?.docType];
    if (pat && cert) push(v, { entity: "document", key: "numbering", value: { certCode: cert, ...pat } });
  }
  for (const v of values.filter((x) => x.entity === "document" && x.field === "issueDate")) {
    const fmt = dateFormatOf(v.value);
    if (fmt) push(v, { entity: "document", key: "dateFormat", value: fmt });
  }
  for (const v of values) {
    if (v.field === "ingredient" || v.field === "documentNumber" || v.field === "issueDate") continue;
    if (v.entity === "product") {
      if (v.field === "specification") push(v, { entity: "product", key: `spec:${v.test || "Specification"}`, value: v.value });
      else if (v.field === "targetSpecies") push(v, { entity: "product", key: "targetSpecies", value: v.value.split(/\s*[,;/]\s*|\s+and\s+/i).filter(Boolean) });
      else if (v.field === "packaging") push(v, { entity: "product", key: "packaging", value: normPack(v.value) || v.value });
      else push(v, { entity: "product", key: PRODUCT_KEY[v.field] || (v.field === "category" ? "category" : v.field), value: v.value });
    } else if (v.entity === "batch") {
      push(v, { entity: "batch", key: v.field === "result" ? `result:${v.test || "Result"}` : v.field, value: v.value, perBatch: true, batchNo: v.batchNo || (v.field === "batchNo" ? v.value : null) });
    } else if (v.entity === "commercial") {
      push(v, { entity: "commercial", key: v.field, value: v.field === "invoiceLine" ? { product: v.value, pack: v.pack, quantity: v.amount } : v.value });
    } else {
      push(v, { entity: v.entity, key: v.field, value: v.value });
    }
  }
  return rows;
}

/**
 * The drop's values → facts, once (idempotent: `applied`), under the company each file was filed for;
 * the rules reader's facts for those files are replaced. Then the merge. → summary for the card
 */
export async function applyDropHarvest(batchId) {
  const batch = await prisma.intakeBatch.findUnique({ where: { id: batchId } });
  const h = batch?.harvest;
  if (!h || h.status !== "done" || h.applied) return h?.summary || null;
  // claim it (two callers — the job and execute — may both get here)
  const claimed = await prisma.$executeRaw`UPDATE intake_batches SET harvest = harvest || '{"applied": true}'::jsonb WHERE id = ${batchId} AND COALESCE((harvest->>'applied')::boolean, false) = false`;
  if (!claimed) return null;
  const items = await prisma.intakeItem.findMany({ where: { batchId } });
  const byLabel = new Map((h.files || []).map((f) => [f.label, f]));
  const companyOf = (f) => {
    const it = items.find((i) => i.id === f.itemId);
    return it?.result?.plan?.companyId || it?.companyId || batch.companyId || null;
  };
  const companies = new Set();
  let facts = 0;
  for (const f of h.files || []) {
    const companyId = companyOf(f);
    if (!companyId || f.status !== "read") continue;
    companies.add(companyId);
    const values = (h.values || []).filter((v) => v.file === f.label);
    // the AI read of this file replaces the rules reader's (its own pages, as one file)
    const children = items.filter((i) => i.parentId === f.itemId && i.fileId).map((i) => i.fileId);
    await prisma.harvestedFact.deleteMany({ where: { companyId, extractor: "rules", fileId: { in: [f.fileId, ...children] } } });
    const it = items.find((i) => i.id === f.itemId);
    const ids = it?.result?.plan?.productIds || [];
    const rows = factRows(values, { companyId, fileOf: (l) => byLabel.get(l), docTypes: h.docTypes || {}, modelId: h.model, productIdOf: () => (ids.length === 1 ? ids[0] : null) });
    if (rows.length) facts += (await prisma.harvestedFact.createMany({ data: rows, skipDuplicates: true })).count;
  }
  let filled = 0;
  let conflicts = 0;
  for (const companyId of companies) {
    const m = await mergeAll(companyId);
    filled += m.filled;
    conflicts += m.conflicts;
  }
  const read = (h.files || []).filter((f) => f.status === "read").length;
  const summary = { files: read, values: (h.values || []).length, facts, filled, conflicts, review: h.review || 0, failed: (h.files || []).filter((f) => f.status === "failed").map((f) => ({ name: f.name, error: f.error })), batchMissing: 0 };
  summary.ar = summaryAr(summary);
  await setHarvest(batchId, { summary });
  return summary;
}

/**
 * Express asks before making drafts: is the drop's read still running? → "wait" | "go"
 * (applies the read when it's done; gives up waiting after HARVEST_WAIT_MS).
 */
export async function harvestGate(batchId) {
  const b = await prisma.intakeBatch.findUnique({ where: { id: batchId }, select: { harvest: true, createdAt: true } });
  const h = b?.harvest;
  if (!h || ["off", "failed"].includes(h.status)) return "go";
  if (h.status === "done") {
    await applyDropHarvest(batchId);
    return "go";
  }
  const since = new Date(h.startedAt || b.createdAt).getTime();
  if (Date.now() - since < HARVEST_WAIT_MS + GATE_GRACE_MS) return "wait";
  // still queued / running past its time and the job never said so (no worker took it, or it died):
  // its files are failed with the reason, and the drafts are made from the rules reader's facts
  await failHarvest(batchId, h.status === "queued" ? `no harvest worker took the read in ${Math.round(HARVEST_WAIT_MS / 60000)} min (is the certificate-template worker running?) — the rules reader's facts are used` : harvestTimeout("no answer from the job").message);
  return "go";
}

// ── files already stored (re-harvest, one upload) ─────────────────────────────────────────────
const READ_MIME = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif)|text\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/;
export const aiReadable = (mimeType) => READ_MIME.test(String(mimeType || ""));

/**
 * Stored files of one company, read with the AI reader → facts (each file's earlier facts replaced),
 * then the merge. Files the AI already read are skipped unless force — a re-run costs nothing again.
 * files: [{ id, name, productId? }] → { files, read, skipped, failed, values, review, facts, filled, conflicts }
 */
export async function harvestStoredAi(companyId, files, { force = false, progress = null } = {}) {
  const avail = aiHarvestAvailable();
  if (!avail.on) return null;
  let list = files;
  if (!force) {
    const done = new Set((await prisma.harvestedFact.findMany({ where: { companyId, extractor: "ai", fileId: { in: files.map((f) => f.id) } }, select: { fileId: true }, distinct: ["fileId"] })).map((r) => r.fileId));
    list = files.filter((f) => !done.has(f.id));
  }
  const rows = list.map((f, i) => ({ label: `F${i + 1}`, fileId: f.id, name: f.name || f.id, status: "waiting", error: null, productId: f.productId || null }));
  const run = { model: avail.model, known: await knownList({ companyId }), ledgerCtx: { companyId, entityType: "company", entityId: companyId } };
  const { values, docTypes } = await readAndVerify(rows, run, async (done) => progress?.(Math.round((90 * done) / Math.max(1, rows.length)), `بقرا الملفات… ${done}/${rows.length}`));
  let facts = 0;
  for (const f of rows.filter((x) => x.status === "read")) {
    await prisma.harvestedFact.deleteMany({ where: { companyId, fileId: f.fileId } });
    const data = factRows(values.filter((v) => v.file === f.label), { companyId, fileOf: (l) => rows.find((x) => x.label === l), docTypes, modelId: avail.model, productIdOf: () => f.productId });
    if (data.length) facts += (await prisma.harvestedFact.createMany({ data, skipDuplicates: true })).count;
  }
  progress?.(95, "Filling the products");
  const merged = await mergeAll(companyId);
  return { files: files.length, read: rows.filter((f) => f.status === "read").length, skipped: files.length - list.length, failed: rows.filter((f) => f.status === "failed").map((f) => ({ name: f.name, error: f.error })), values: values.length, review: values.filter((v) => v.reviewStatus !== "confirmed").length, facts, ...merged };
}
