// UI smoke for "Copy to another brand" (Products) and "Layout & size" / "Upload label to resize" (Labels).
//   node tests/ui-smoke.copyAndLayout.mjs [--front http://localhost:5173] [--shots <dir>]
// Needs the test stack (API + cert-renderer) and `npx vite` in mostanad_front. The real API
// throughout (no AI is called: copy and layout are deterministic; the upload uses "scale").
import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "fs";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";
import { SAMPLE_LABEL_DATA } from "./fixtures/labelLayoutSample.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FRONT = arg("front", "http://localhost:5173");
const SHOTS = arg("shots");
const { assert, counts } = makeAssert();
const consoleErrors = [];
const T = (id) => `[data-testid="${id}"]`;
const ts = Date.now();

const company = await createCompany("uicopy");
const [b1, b2] = await Promise.all([prisma.brand.create({ data: { companyId: company.id, name: `UI Brand One ${ts}` } }), prisma.brand.create({ data: { companyId: company.id, name: `UI Brand Two ${ts}` } })]);
const src = await prisma.product.create({ data: { companyId: company.id, brandId: b1.id, name: `UiAmox ${ts}`, productCode: `UA-${ts}`, registrationNumber: `REG-${ts}`, storage: "Below 25 °C", dosage: "1 g / 2 L", activeIngredients: [{ name: "Amoxicillin", concentration: "20%" }] } });
const other = await prisma.product.create({ data: { companyId: company.id, brandId: b1.id, name: `UiOther ${ts}`, storage: "Cool" } });
const label = await prisma.generatedLabel.create({ data: { companyId: company.id, inputPayload: {}, labelData: SAMPLE_LABEL_DATA, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "EG", language: "en", status: "draft" } });
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uicopy_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uicopy_${ts}`, username: `uicopy_${ts}`, email: `uicopy_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|404|409/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 15000 }, ...args);
const has = (text) => until((t) => document.body.innerText.includes(t), text);
async function retype(selector, text) {
  await page.focus(selector);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(selector, text);
}
async function clickText(selector, text) {
  await until((sel, t) => [...document.querySelectorAll(sel)].some((e) => e.innerText.trim().includes(t)), selector, text);
  await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find((e) => e.innerText.trim().includes(t)).click(), selector, text);
}

try {
  const login = await api("POST", "/auth/login", {}, { username: user.username, password: pw });
  const token = login.data?.data?.token || login.data?.token;
  const me = await api("GET", "/auth/me", { Authorization: `Bearer ${token}` });
  await page.goto(`${FRONT}/login`, { waitUntil: "networkidle2" });
  await page.evaluate((t, u) => {
    localStorage.clear();
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify(u));
  }, token, me.data?.data?.user || {});

  console.log("Products → Copy to another brand");
  await page.goto(`${FRONT}/products`, { waitUntil: "networkidle2" });
  await page.type('input[placeholder*="Search" i]', `UiAmox ${ts}`).catch(() => {});
  await page.waitForSelector(`[aria-label="Copy UiAmox ${ts} to another brand"]`, { timeout: 15000 });
  await page.click(`[aria-label="Copy UiAmox ${ts} to another brand"]`);
  await page.waitForSelector(T("copy-groups"));
  const groups = await page.$$eval(`${T("copy-groups")} input[type=checkbox]`, (els) => els.map((e) => e.checked));
  const modalText = await page.$eval('[role="dialog"]', (e) => e.innerText);
  assert("copy modal: every field group ticked, the registration number explained and never offered", groups.length >= 7 && groups.every(Boolean) && /registration number is not copied/i.test(modalText) && !/Registration number\s*$/m.test(modalText));
  await page.select('select[aria-label="Target company"]', company.id).catch(() => {});
  await until((id) => [...document.querySelectorAll('select[aria-label="Target brand"] option')].some((o) => o.value === id), b2.id);
  await page.select('select[aria-label="Target brand"]', b2.id);
  await retype('input[aria-label="New name"]', `UiVetamox ${ts}`);
  await shot("copy-modal");
  await page.click(T("copy-submit"));
  await page.waitForSelector(T("copied-from"), { timeout: 15000 });
  const view = await page.$eval(T("copied-from"), (e) => e.innerText);
  assert("after Copy the new product opens: 'Copied from <A> · <brand>' and 'Needs its own registration number'", view.includes(`UiAmox ${ts}`) && view.includes(b1.name) && !!(await page.$(T("needs-registration"))), view);
  await shot("copied-product");
  const copy = await prisma.product.findFirst({ where: { name: `UiVetamox ${ts}` } });
  assert("…created in the chosen brand without a registration number", copy?.brandId === b2.id && copy.registrationNumber === null);

  await prisma.product.update({ where: { id: src.id }, data: { storage: "Below 30 °C" } });
  await clickText("button", "Update from source");
  await page.waitForSelector(T("source-diff"));
  const rows = await page.$$eval(`${T("source-diff")} tbody tr`, (trs) => trs.map((t) => t.innerText));
  assert("the diff shows the field that changed on the original (storage)", rows.length === 1 && /Storage/.test(rows[0]) && /Below 30/.test(rows[0]), rows);
  await page.click(`${T("source-diff")} tbody input[type=checkbox]`);
  await shot("source-diff");
  await page.click(T("apply-from-source"));
  await until(() => !document.querySelector('[data-testid="source-diff"]'));
  assert("Update applies only the ticked field", (await prisma.product.findUnique({ where: { id: copy.id } })).storage === "Below 30 °C");

  console.log("\nProducts → bulk copy");
  await page.goto(`${FRONT}/products`, { waitUntil: "networkidle2" });
  for (const p of [src, other]) {
    await page.waitForSelector(`[aria-label="Select ${p.name}"]`);
    await page.click(`[aria-label="Select ${p.name}"]`);
  }
  await page.waitForSelector(T("products-selection"));
  await clickText(`${T("products-selection")} button`, "Copy to brand");
  await page.waitForSelector(T("copy-bulk-names"));
  await page.select('select[aria-label="Target company"]', company.id).catch(() => {});
  await until((id) => [...document.querySelectorAll('select[aria-label="Target brand"] option')].some((o) => o.value === id), b2.id);
  await page.select('select[aria-label="Target brand"]', b2.id);
  const bulkNames = await page.$$eval(`${T("copy-bulk-names")} tbody tr`, (trs) => trs.length);
  assert("bulk: a name/code row per selected product", bulkNames === 2);
  await retype(`input[aria-label="New name for ${other.name}"]`, `UiOther2 ${ts}`);
  await shot("bulk-copy");
  await page.click(T("copy-submit"));
  await page.waitForSelector(T("copy-bulk-report"), { timeout: 15000 });
  const report = await page.$eval(T("copy-bulk-report"), (e) => e.innerText);
  assert("bulk report: each product → its new name", report.includes(`UiOther2 ${ts}`) && (report.match(/→/g) || []).length === 2, report);

  console.log("\nLabel → Layout & size");
  await page.goto(`${FRONT}/labels/detail/${label.id}?tab=layout`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("layout-size-tab"), { timeout: 15000 });
  await clickText('[role="radio"]', "10 × 15 cm");
  await page.click(T("layout-preview"));
  await page.waitForSelector(T("layout-compare"), { timeout: 30000 });
  await page.click(T("layout-save"));
  await page.waitForSelector(T("layout-versions"), { timeout: 30000 });
  await clickText('[role="radio"]', "10 × 12 cm");
  await page.click(T("layout-preview"));
  await until(() => document.querySelectorAll('[data-testid="layout-compare"] figure').length === 2);
  const compare = await page.$eval(T("layout-compare"), (e) => e.innerText);
  const fit = await page.$$eval(`${T("fit-sections")} li`, (lis) => lis.map((l) => l.innerText));
  assert("old vs new side by side (Now 10 × 15 / New 10 × 12) with the fit per section", /Now: 10 × 15 cm/.test(compare) && /New: 10 × 12 cm/.test(compare) && fit.length >= 8 && fit.every((f) => /fits|font reduced to|needs/.test(f)), { compare: compare.slice(0, 200), fit });
  const widths = await page.$$eval(`${T("layout-compare")} figure > div`, (ds) => ds.filter((d) => d.style.minHeight).map((d) => [d.getBoundingClientRect().width, parseFloat(d.style.minHeight)]));
  assert("previews at real proportions: same width, 10×12 shorter than 10×15 (120/150)", widths.length === 2 && Math.abs(widths[0][0] - widths[1][0]) < 1 && Math.abs(widths[1][1] / widths[0][1] - 0.8) < 0.01, widths);
  await shot("layout-compare");
  await page.click(T("layout-save"));
  await until(() => document.querySelectorAll('[data-testid="layout-versions"] tbody tr').length === 2);
  assert("saved as version 2; a PDF download button for the current size", !!(await page.$(T("layout-download"))) && (await page.$eval(T("layout-download"), (e) => e.innerText)).includes("10 × 12"));
  await clickText('[role="radio"]', "4 × 6 cm");
  await page.click(T("layout-preview"));
  await has("Doesn't fit even at");
  const overflow = await page.$$eval(`${T("fit-sections")} li`, (lis) => lis.map((l) => l.innerText).filter((t) => /needs [\d.]+ mm more/.test(t)));
  assert("4×6: 'doesn't fit', each overflowing section with the mm it needs", overflow.length > 0, overflow);
  await shot("layout-overflow");

  console.log("\nLabels → Upload label to resize (scale)");
  const pdf = (await api("GET", `/label-layouts/${(await prisma.labelLayout.findFirst({ where: { labelId: label.id, version: 1 } })).id}/pdf`, { Authorization: `Bearer ${token}` })).buffer;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uiresize-")), "client-label-10x15.pdf");
  fs.writeFileSync(tmp, pdf);
  await page.goto(`${FRONT}/labels/browse`, { waitUntil: "networkidle2" });
  await page.click(T("open-resize-upload"));
  await page.waitForSelector(T("resize-dropzone"));
  const input = await page.$('input[aria-label="Label file"]');
  await input.uploadFile(tmp);
  await has("client-label-10x15.pdf");
  // client report 24 Nov: every upload was rebuilt and lost its design — scale is the default now
  const defaultMode = await page.$eval('input[name="mode"]:checked', (e) => e.closest("label").innerText);
  assert("the resize modal opens on \"Keep the original design, just scale\"", /Keep the original design/.test(defaultMode), defaultMode);
  await page.evaluate(() => [...document.querySelectorAll('input[name="mode"]')].find((e) => /Rebuild/.test(e.closest("label").innerText)).click());
  await has("The original design is not kept");
  assert("choosing rebuild says the design is not kept", true);
  await clickText("label", "Keep the original design, just scale");
  await clickText("button", "10 × 12 cm");
  await page.select('select[aria-label="Company"]', company.id).catch(() => {});
  await shot("resize-upload");
  await page.click(T("resize-start"));
  await page.waitForSelector(T("resize-result"), { timeout: 30000 });
  await has("Scaled to 80 %");
  const result = await page.$eval(T("resize-result"), (e) => e.innerText);
  const smallest = Number(result.match(/Smallest text: ([\d.]+) pt/)?.[1]);
  assert("scale result: 10 × 12 cm, 80 %, the smallest text, and the warning exactly when it is below 6 pt", /10 × 12 cm/.test(result) && smallest > 0 && /below the 6 pt minimum/.test(result) === smallest < 6, result);
  await until(() => { const c = document.querySelector('[data-testid="pdf-preview"]'); return c && c.dataset.rendered === "true" && c.height > c.width; });
  assert("the scaled PDF is previewed (pdf.js) and can be downloaded", !!(await page.$(T("resize-download"))));
  await shot("resize-result");
  assert("no console errors", consoleErrors.length === 0, consoleErrors);
} catch (err) {
  assert(`smoke crashed: ${err.message}`, false, err.stack);
  await shot("crash");
} finally {
  await browser.close();
  await prisma.product.deleteMany({ where: { companyId: company.id, sourceProductId: { not: null } } }).catch(() => {});
  await cleanupCompany(company.id).catch((e) => console.error(e.message));
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
