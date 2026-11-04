// Certificate types per invoice (D1) and the review chips + new product modal (D2) — frontend
// smoke run in headless Chromium against the dev stack. NOT part of `npm test` (needs the Vite
// dev server): run it by hand.
//
//   node tests/certificates-v2/ui-smoke.invoiceTypes.mjs [--front http://localhost:5173] [--shots <dir>]
//
// Needs: npm run dev:test:light and `npx vite` in mostanad_front on :5173. Logs in as a throwaway
// system user with every permission (the company and user are removed at the end).
import path from "path";
import fs from "fs";
import puppeteer from "puppeteer";
import bcrypt from "bcryptjs";
import { api, asCompany, createCompany, cleanupCompany, fixture, makeAssert, prisma } from "./helpers.js";
import { seedTemplate } from "./invoiceGoldenHarness.js";
import { registerNewProductSmoke } from "./ui-smoke.newProduct.mjs";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const FRONT = arg("front", "http://localhost:5173");
const SHOTS = arg("shots");
const { assert, counts } = makeAssert();
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const company = await createCompany("uid1");
const A = asCompany(company.id);
const ts = Date.now();
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uid1_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uid1_${ts}`, username: `uid1_${ts}`, email: `uid1_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
const pdfPath = path.join(process.cwd(), "fixtures", "certificates", "outlined_text.pdf");

const F = (key, label, sourcePath, o = {}) => ({ key, label, source: { kind: "product", path: sourcePath }, required: true, category: "product_data", ...o });
const coa = await seedTemplate(company.id, { typeName: "Certificate of Analysis", typeCode: "COA", scope: "per_product", name: "COA any", fields: [F("storage", "Storage", "storage"), F("appearance", "Appearance", "appearance"), F("batch", "Batch no", "batchNo", { source: { kind: "item", path: "batchNo" }, category: "invoice_line" }), F("ph", "pH result", "x", { source: { kind: "manual" }, category: "batch_data", isLabResult: true })] });
const fsc = await seedTemplate(company.id, { typeName: "Free Sale Certificate", typeCode: "FSC", scope: "per_product", name: "FSC any", fields: [F("producer", "Manufacturer", "producer"), F("origin", "Country of origin", "origin"), F("dosage", "Dosage", "dosage", { required: false })] });
const coo = await seedTemplate(company.id, { typeName: "Certificate of Origin", typeCode: "COO", scope: "per_invoice", name: "COO any", fields: [{ key: "co", label: "Company", source: { kind: "company", path: "name" } }] });
await prisma.certificateType.create({ data: { companyId: company.id, name: "GMP Certificate", code: "GMP" } });

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("response", (r) => r.status() >= 400 && console.log(`     ⚠ ${r.status()} ${r.request().method()} ${r.url()}`));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
const T = (id) => `[data-testid="${id}"]`;
const card = (code) => `${T("type-card")}[data-code="${code}"]`;
const chip = (code) => `${T("type-chip")}[data-code="${code}"]`;
const checked = (sel) => page.$eval(sel, (e) => e.getAttribute("aria-checked"));
const text = (sel) => page.$eval(sel, (e) => e.innerText.trim());
const submit = 'form button[type="submit"]';
const submitOff = () => page.$eval(submit, (e) => e.disabled);
const invoiceId = () => page.url().match(/invoices\/([0-9a-f-]{36})/)?.[1];
const stored = (id) => prisma.invoice.findUnique({ where: { id } });
const openUpload = async () => {
  await page.goto(`${FRONT}/invoices`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("certificate-types"));
};
const pick = async () => {
  await (await page.$('form input[type="file"]')).uploadFile(pdfPath);
  await sleep(150);
};
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 8000 }, ...args);
const openReview = async (id) => {
  await page.goto(`${FRONT}/invoices/${id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("invoice-items"));
};
const lines = async (id, rows) => {
  for (const row of rows) await api("POST", `/invoices/${id}/items`, A, row);
};
const ctx = { page, A, T, chip, checked, text, until, sleep, shot, assert, api, prisma, company, openReview, lines, coa, fsc, coo, fixture, pdfPath };

try {
  const login = await api("POST", "/auth/login", {}, { username: user.username, password: pw });
  const token = login.data?.data?.token || login.data?.token;
  const me = await api("GET", "/auth/me", { Authorization: `Bearer ${token}` });
  await page.goto(`${FRONT}/login`, { waitUntil: "networkidle2" });
  await page.evaluate((t, u, c) => {
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify(u));
    localStorage.setItem("certificates.companyId", c);
  }, token, me.data?.data?.user, company.id);

  console.log("\n📥 D1 — cards");
  await openUpload();
  assert("usable types selected by default", (await checked(card("COA"))) === "true" && (await checked(card("FSC"))) === "true" && (await checked(card("COO"))) === "true");
  assert("Select all: all, 3 of 3", (await checked(T("select-all-types"))) === "true" && (await text(T("select-all-types"))).includes("3 of 3"));
  assert("card copy: templates and scope", (await text(card("COA"))).includes("1 template · one per product") && (await text(card("COO"))).includes("one for the whole invoice"));
  const gmp = await text(card("GMP"));
  assert("a type with no template: greyed, no selection, link", gmp.includes("No active template yet") && gmp.includes("Create a template") && (await page.$eval(card("GMP"), (e) => e.tagName)) === "DIV" && (await page.$eval(`${card("GMP")} [role="checkbox"]`, (e) => e.getAttribute("aria-disabled"))) === "true");
  await page.click(`${card("GMP")} [role="checkbox"]`);
  assert("clicking it selects nothing", (await text(T("select-all-types"))).includes("3 of 3"));
  assert("the link opens the wizard with that type", (await page.$eval(`${card("GMP")} a`, (e) => e.getAttribute("href"))).includes("/certificates/templates/new?certificateTypeId="));
  assert("summary names the chosen types", (await text(T("types-summary"))).includes("Will make COA + COO + FSC for every matched product"), await text(T("types-summary")));
  await shot("d1-all");

  await page.click(card("FSC"));
  assert("click toggles: FSC off", (await checked(card("FSC"))) === "false");
  assert("Select all: mixed, 2 of 3", (await checked(T("select-all-types"))) === "mixed" && (await text(T("select-all-types"))).includes("2 of 3"));
  assert("include-new only while all are selected", !(await page.$(T("include-new-types"))));
  await page.focus(card("FSC"));
  await page.keyboard.press("Space");
  assert("Space toggles: FSC on again", (await checked(card("FSC"))) === "true");
  assert("include-new back with all selected", !!(await page.$(T("include-new-types"))));
  await page.click(T("select-all-types"));
  assert("Select all from all: none", (await checked(T("select-all-types"))) === "false" && (await text(T("select-all-types"))).includes("0 of 3"));
  assert("none: the red message", (await text(T("types-summary"))).includes("Pick at least one certificate."));
  await pick();
  assert("none: Upload off, even with a file", await submitOff());
  await shot("d1-none");
  await page.click(T("select-all-types"));
  assert("Select all from none: all", (await checked(T("select-all-types"))) === "true");
  assert("Upload on with a type and a file", !(await submitOff()));

  console.log("\n📥 D1 — what is saved");
  await page.click(submit);
  await page.waitForFunction(() => /invoices\/[0-9a-f-]{36}/.test(location.href), { timeout: 15000 });
  let id = invoiceId();
  assert("all + include new → null", (await stored(id)).certificateTypeIds === null);

  await openUpload();
  await pick();
  await page.click(T("include-new-types"));
  await page.click(submit);
  await page.waitForFunction(() => /invoices\/[0-9a-f-]{36}/.test(location.href), { timeout: 15000 });
  id = invoiceId();
  assert("all, include new off → the array of all", (await stored(id)).certificateTypeIds.length === 3);

  await openUpload();
  await pick();
  await page.click(card("COO"));
  await page.click(card("FSC"));
  await page.click(T("remember-types"));
  await page.click(submit);
  await page.waitForFunction(() => /invoices\/[0-9a-f-]{36}/.test(location.href), { timeout: 15000 });
  id = invoiceId();
  assert("two off → only COA", (await stored(id)).certificateTypeIds.join() === coa.typeId);
  assert("Remember saved the company default", (await prisma.company.findUnique({ where: { id: company.id } })).defaultCertificateTypeIds.join() === coa.typeId);

  await openUpload();
  assert("the default preselects", (await checked(card("COA"))) === "true" && (await checked(card("FSC"))) === "false" && (await text(T("select-all-types"))).includes("1 of 3"));

  console.log("\n📋 D2 — chips");
  const p1 = await prisma.product.create({ data: { companyId: company.id, name: "Vitaminol", productCode: "VT-1", storage: "Below 25 C", appearance: "Clear", producer: "Acme", origin: "EG" } });
  const p2 = await prisma.product.create({ data: { companyId: company.id, name: "Toxinil", productCode: "TX-2", storage: "Dry", appearance: "Powder", producer: "Acme", origin: "EG" } });
  await lines(id, [{ data: { name: "VITAMINOL 1L", batchNo: "B1" }, productId: p1.id }, { data: { name: "TOXINIL 25KG", batchNo: "B2" }, productId: p2.id }]);
  await openReview(id);
  await page.waitForSelector(T("type-chips"));
  assert("chip per usable type, no GMP", (await page.$$(T("type-chip"))).length === 3 && !(await page.$(chip("GMP"))));
  assert("COA on, with its count", (await checked(chip("COA"))) === "true" && (await text(chip("COA"))).includes("2 certificates"));
  assert("FSC off still says what it would make", (await checked(chip("FSC"))) === "false" && (await text(chip("FSC"))).includes("2 certificates"));
  assert("COO: one for the invoice", (await text(chip("COO"))).includes("1 for the invoice"));
  const summaryRows = () => page.$$eval(`${T("plan-preview")} .font-mono`, (l) => l.map((e) => e.innerText));
  assert("the plan shows only COA", (await summaryRows()).join() === "COA", await summaryRows());
  assert("the last chip can't be turned off", await page.$eval(chip("COA"), (e) => e.disabled));
  await shot("d2-chips");
  await page.click(chip("FSC"));
  await until((c) => document.querySelector(c)?.getAttribute("aria-checked") === "true", chip("FSC"));
  assert("toggling on PATCHes the invoice", (await stored(id)).certificateTypeIds.length === 2);
  await until((s) => document.querySelectorAll(s).length === 2, `${T("plan-preview")} .font-mono`);
  assert("the plan follows", (await summaryRows()).sort().join() === "COA,FSC");
  await page.click(T("all-types"));
  await until((c) => document.querySelector(c)?.getAttribute("aria-checked") === "true", chip("COO"));
  assert("All types → null", (await stored(id)).certificateTypeIds === null);
  await page.click(chip("COO"));
  await until((c) => document.querySelector(c)?.getAttribute("aria-checked") === "false", chip("COO"));

  await api("POST", `/invoices/${id}/confirm`, A);
  await openReview(id);
  const planned = () => page.$$eval("button", (l) => l.map((b) => b.innerText).find((t) => /^Generate \d/.test(t)));
  await page.waitForSelector(T("type-chips"));
  await until(() => [...document.querySelectorAll("button")].some((b) => /^Generate \d/.test(b.innerText)));
  assert("Generate counts the chosen types", (await planned()) === "Generate 4 certificates", await planned());
  await page.click(chip("COO"));
  await until(() => [...document.querySelectorAll("button")].some((b) => b.innerText === "Generate 5 certificates"));
  assert("the Generate count follows a chip, the invoice stays confirmed", (await stored(id)).status === "ready");

  await prisma.invoice.update({ where: { id }, data: { status: "generated", certificateTypeIds: [coa.typeId, fsc.typeId] } });
  await page.goto(`${FRONT}/invoices/${id}`, { waitUntil: "networkidle2" });
  assert("no chips once generated", !(await page.$(T("type-chip"))));

  await registerNewProductSmoke(ctx);
} catch (err) {
  console.error(err);
  counts.failed++;
  await shot("fatal");
}

const relevant = consoleErrors.filter((e) => !/favicon|DevTools|React Router Future|Failed to load resource/i.test(e));
assert("zero console errors", relevant.length === 0, relevant.slice(0, 5));
await browser.close();
await cleanupCompany(company.id);
await prisma.user.delete({ where: { id: user.id } }).catch((e) => console.error("user cleanup:", e.message));
await prisma.role.delete({ where: { id: role.id } }).catch((e) => console.error("role cleanup:", e.message));
await prisma.$disconnect();
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
