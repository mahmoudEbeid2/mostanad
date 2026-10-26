// Fill automatically items 2, 4, 5 — frontend smoke run of the new screens, in headless Chromium
// against the dev stack. NOT part of `npm test` (needs the Vite dev server): run it by hand.
//
//   node tests/certificates-v2/ui-smoke.labResults.mjs [--front http://localhost:5173] [--shots <dir>]
//
// Needs: npm run dev:test (API + workers, Gemini off), pdf2htmlex, and `npx vite` in mostanad_front
// on :5173. It logs in AS a throwaway company it creates (no QA user), and removes it at the end.
// Covers: the results grid (rows per batch, the batch number asked first, the specification next
// to each cell, out of spec highlighted, arrow keys, a pasted Excel block, one save), the supplier
// COA upload (off while AI is unavailable, with the reason), "Prepare certificates" (stages, what
// still needs you) and "Fix this template" (the checklist on a converted ADDVET design).
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import bcrypt from "bcryptjs";
import { api, createCompany, cleanupCompany, makeAssert, prisma, uploadTemplate } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { computeNeeds } from "../../src/services/certificates/dataNeeds/dataNeedsService.js";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const FRONT = arg("front", "http://localhost:5173");
const SHOTS = arg("shots");
const { assert, counts } = makeAssert();
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const company = await createCompany("uilab");
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const waitForText = (text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
const cells = () => page.$$eval('[data-testid="results-row"]', (rows) => rows.map((r) => [...r.querySelectorAll('[data-testid="result-cell"]')].map((i) => ({ id: i.id, value: i.value, disabled: i.disabled, red: i.className.includes("border-red-400") }))));

try {
  // ── data: a COA template with two lab results (one linked to its spec) and a spec-instead field
  const FIELDS = [
    { key: "batch_no", label: "Batch No.", source: { kind: "item", path: "batchNo" }, category: "invoice_line", required: false },
    { key: "ph_spec", label: "pH specification", source: { kind: "product", path: "specifications.values.pH" }, category: "product_data" },
    { key: "ph_result", label: "pH result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
    { key: "assay_result", label: "Assay result", source: { kind: "manual" }, category: "batch_data", isLabResult: true },
  ];
  const tpl = await seedTemplate(company.id, { name: "UI COA", typeCode: "COA", typeName: "Certificate of Analysis", scope: "per_product", fields: FIELDS });
  await prisma.templateField.updateMany({ where: { versionId: tpl.versionId, key: "ph_result" }, data: { specFieldKey: "ph_spec" } });
  const P = await prisma.product.create({ data: { companyId: company.id, name: "ADD-E 120", specifications: { values: { pH: "6.5 - 7.5" } } } });
  const inv = await prisma.invoice.create({ data: { companyId: company.id, status: "review", sourceFileId: "00000000-0000-4000-8000-0000000000c1", header: { invoiceNumber: "UI-LAB-1" }, headerExtracted: {}, textContent: "=== Page 1 ===\nINVOICE UI-LAB-1" } });
  const lines = [{ batchNo: "AV-1" }, { batchNo: "av 1" }, {}];
  for (const [i, l] of lines.entries()) {
    const data = { name: "ADD-E 120 1L", ...l, extra: {} };
    await prisma.invoiceItem.create({ data: { invoiceId: inv.id, lineNo: i + 1, data, dataExtracted: data, productId: P.id, matchStatus: "matched", matchMethod: "user" } });
  }
  await computeNeeds(inv.id, company.id, { ai: false });

  // ── log in as the company (its password set for this run; the company is deleted at the end)
  const pw = `ui-${Date.now()}`;
  await prisma.company.update({ where: { id: company.id }, data: { password: await bcrypt.hash(pw, 8) } });
  const login = await api("POST", "/companies/login", {}, { username: company.username, password: pw });
  const token = login.data?.data?.token;
  const me = await api("GET", "/auth/me", { Authorization: `Bearer ${token}` });
  assert("company login → token", !!token && !!me.data?.data?.user, login.data);
  await page.goto(`${FRONT}/login`, { waitUntil: "networkidle2" });
  await page.evaluate((t, u) => {
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify(u));
  }, token, me.data?.data?.user);

  console.log("\n🧪 The results grid");
  await page.goto(`${FRONT}/invoices/${inv.id}`, { waitUntil: "networkidle2" });
  assert("the grid shows in the data check", await page.waitForSelector('[data-testid="results-grid"]', { timeout: 20000 }).then(() => true, () => false));
  let c = await cells();
  assert("two rows: batch AV-1 (lines 1 + 2) and the line without a batch", c.length === 2 && (await waitForText("lines 1, 2")) && (await waitForText("line 3")), c);
  assert("the specification is next to the cell", await waitForText("Spec: 6.5 - 7.5"));
  assert("the line without a batch number: its cells wait for the batch number", c[1].every((x) => x.disabled) && !!(await page.$('[data-testid="batch-input"]')));
  assert("the data check warns about it", await waitForText("no batch number — results can't be reused"));
  await shot("grid-1");
  // a block pasted from Excel fills the row from the focused cell
  await page.focus("#rg-0-0");
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "7.1\t99.5 %\n");
    document.getElementById("rg-0-0").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  c = await cells();
  assert("paste from Excel: “7.1 ⇥ 99.5 %” fills pH and assay", c[0][0].value === "7.1" && c[0][1].value === "99.5 %", c[0]);
  // arrow keys: at the end of the text → the next cell
  await page.focus("#rg-0-0");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowRight");
  assert("ArrowRight at the end of a cell moves to the next result", (await page.evaluate(() => document.activeElement?.id)) === "rg-0-1");
  // out of spec, highlighted while typing
  await page.click("#rg-0-0", { clickCount: 3 });
  await page.keyboard.type("9.9");
  c = await cells();
  assert("9.9 outside 6.5 - 7.5 → highlighted, and said under the cell", c[0][0].red && (await waitForText("outside the specification")), c[0][0]);
  await page.click("#rg-0-0", { clickCount: 3 });
  await page.keyboard.type("7.1");
  // the line without a batch: type it first, then a result
  await page.type('[data-testid="batch-input"]', "AV-1");
  c = await cells();
  assert("with a batch number typed, the row's cells open", c[1].every((x) => !x.disabled), c[1]);
  await shot("grid-2");
  await page.click('[data-testid="results-save"]');
  assert("one save → “every certificate of those batches is filled”", await waitForText("every certificate of those batches is filled"));
  await sleep(800);
  c = await cells();
  assert("the line joined batch AV-1: one row for lines 1, 2, 3, its values kept", c.length === 1 && c[0][0].value === "7.1" && (await waitForText("lines 1, 2, 3")), c);
  const needs = await prisma.certificateDataNeed.findMany({ where: { invoiceId: inv.id, fieldKey: "ph_result" } });
  assert("…every line's pH result is filled in the DB", needs.length === 3 && needs.every((n) => n.value === "7.1"), needs.map((n) => [n.status, n.value]));
  await shot("grid-3");

  console.log("\n🧪 Supplier COA upload");
  const upload = await page.$('[data-testid="coa-file"]');
  assert("the upload is there, and off while AI is unavailable (Gemini off on this stack), with the reason", !!upload && (await page.$eval('[data-testid="coa-file"]', (i) => i.disabled)) && !!(await page.$('[data-testid="ai-action-off"] [data-testid="coa-upload"]')));

  console.log("\n🧪 Prepare certificates");
  await page.click('[data-testid="prepare-certificates"]');
  assert("the panel shows the four stages", await page.waitForSelector('[data-testid="prepare-panel"]', { timeout: 10000 }).then(() => true, () => false) && (await page.$$('[data-testid="prepare-panel"] [data-stage]')).length === 4);
  assert("…and finishes with what still needs you", await page.waitForSelector('[data-testid="prepare-summary"]', { timeout: 60000 }).then(() => true, () => false));
  const stages = await page.$$eval('[data-testid="prepare-panel"] [data-stage]', (els) => els.map((e) => `${e.dataset.stage}:${e.dataset.status}`));
  assert("stages in order, each with its outcome", stages.join() === "matching:skipped,product_data:done,batch_results:skipped,supplier_coa:skipped", stages);
  assert("the data check collapses to what still needs you (Show all values)", !!(await page.$('[data-testid="show-every-value"]')));
  await shot("prepare");

  console.log("\n🧪 Fix this template");
  const type = await prisma.certificateType.findFirst({ where: { companyId: company.id } });
  const up = await uploadTemplate(company.id, { file: "ADDVET_COA.ai", name: "ADDVET COA (UI)", certificateTypeId: type.id });
  assert("ADDVET design converted", up.task?.status === "completed" && up.version?.status === "draft", up.task?.error || up.version?.status);
  await page.goto(`${FRONT}/certificates/templates/${up.data.data.templateId}/versions/${up.version.id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="fix-template"]', { timeout: 20000 });
  await page.click('[data-testid="fix-template"]');
  assert("the checklist opens", await page.waitForSelector('[data-testid="repair-wizard"]', { timeout: 20000 }).then(() => true, () => false));
  assert("…with the fixed results to decide row by row", await waitForText("Fixed results — decide each row", 60000));
  await shot("repair");
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
  await shot("fatal");
}

const relevant = consoleErrors.filter((e) => !/favicon|DevTools|React Router Future/i.test(e));
assert("zero console errors", relevant.length === 0, relevant.slice(0, 5));
await browser.close();
await cleanupCompany(company.id);
await prisma.$disconnect();
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
