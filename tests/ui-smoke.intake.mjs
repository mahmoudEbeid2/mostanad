// UI smoke for "ارفع ملفاتك" (auto-intake): files chosen on the page (no company
// needed) → per-file progress → the review card (Arabic) → a dropdown change →
// "نفّذ الكل" → the summary. And the same card under an assistant answer.
//   node tests/ui-smoke.intake.mjs [--front http://localhost:5173] [--shots <dir>]
// Needs `npm run dev:test` and `npx vite` in mostanad_front. Real API and worker (AI off):
// the files are small PDFs with the real test folder's names and text (fixtures/intake).
import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "fs";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, createCompany, cleanupCompany } from "./certificates-v2/helpers.js";

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
const samples = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures", "intake", "samples.json"), "utf8"));
const PICK = ["12 H-DURIN 1L.pdf", "12 H-DURIN 1L.ai", "8 AMINOVITA 1L new.pdf", "40 - ADDMECTIN 1% _100ML.pdf", "ADDVET OMAN COA 10-26.ai", "ADDVET OMAN COA 10-26.pdf", "ADDVET HC OMAN 10-26.pdf", "BRN2025002 - ROSHAN.pdf", "MADADD2610001.pdf", "Concentrates Catalogue 2025.pdf"];

async function pdfOf(sample) {
  const doc = await PDFDocument.create();
  doc.setTitle(sample.name);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of sample.pages || [{ text: "" }]) {
    const page = doc.addPage([595, 842]);
    const lines = String(p.text || "").replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").match(/.{1,110}(\s|$)/g) || [];
    lines.slice(0, 70).forEach((l, k) => page.drawText(l.trim(), { x: 30, y: 800 - k * 11, size: 7, font }));
  }
  return Buffer.from(await doc.save());
}

const company = await createCompany("uiintake");
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uiintake_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uiintake_${ts}`, username: `uiintake_${ts}`, email: `uiintake_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiintake-"));
const paths = [];
for (const n of PICK) {
  const p = path.join(dir, n);
  fs.writeFileSync(p, await pdfOf(samples.find((s) => s.name === n)));
  paths.push(p);
}

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|404|409/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name, full = true) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
const until = (fn, ms = 20000, ...args) => page.waitForFunction(fn, { timeout: ms }, ...args);
const text = (sel) => page.$eval(sel, (e) => e.innerText);

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

  console.log("Dashboard and sidebar");
  await page.goto(`${FRONT}/dashboard`, { waitUntil: "networkidle2" });
  assert("the dashboard has the drop zone \"ارفع ملفاتك\"", !!(await page.$(T("intake-tile"))));
  assert("the sidebar has \"ارفع ملفاتك\"", (await page.evaluate(() => document.body.innerText)).includes("ارفع ملفاتك"));

  console.log("\nUpload page → review card");
  await page.goto(`${FRONT}/intake`, { waitUntil: "networkidle2" });
  await (await page.$(T("intake-files"))).uploadFile(...paths);
  await page.waitForSelector(T("intake-picked"));
  assert(`the ${PICK.length} files are listed with their sizes, no company asked`, (await page.$$(`${T("intake-picked")} li`)).length === PICK.length);
  await page.select('select[aria-label="الشركة (اختياري)"]', company.id);
  await shot("intake-upload-page");
  await page.click(T("intake-start"));
  await until(() => /\/intake\/[0-9a-f-]{36}$/.test(location.pathname), 60000);
  await until(() => document.querySelector('[data-testid="intake-review"]')?.dataset.status === "review", 120000);
  const rows = await page.$$eval(T("intake-row"), (rs) => rs.map((r) => ({ action: r.dataset.action, text: r.innerText })));
  assert("the card lists every file with what it is (Arabic)", rows.length >= PICK.length && rows.some((r) => r.text.includes("ليبل")) && rows.some((r) => r.text.includes("قالب شهادة")) && rows.some((r) => r.text.includes("فاتورة")) && rows.some((r) => r.text.includes("كتالوج")), rows.map((r) => r.action));
  assert("…what's new at the top (brand ADDVET, the products)", (await text(T("intake-new"))).includes("براند ADDVET") && /منتجات/.test(await text(T("intake-new"))));
  assert("…the label's .ai is its design file, the COA PDF a bundle (one certificate per page)", rows.some((r) => r.action === "label_design") && rows.some((r) => r.action === "bundle"));
  await shot("intake-review-card");
  // one change: the HC is only kept, not made a template
  const hcSelect = await page.$('select[aria-label="اللي هيحصل لـ ADDVET HC OMAN 10-26.pdf"]');
  if (hcSelect) {
    await hcSelect.select("issued_document");
    await until(() => [...document.querySelectorAll('[data-testid="intake-row"]')].some((r) => r.innerText.includes("ADDVET HC") && r.dataset.action === "issued_document"));
  }
  assert("a dropdown changes the row (HC: kept as an issued certificate)", !!hcSelect);
  const before = await prisma.product.count({ where: { companyId: company.id } });
  assert("nothing made before the button", before === 0);
  await page.click(T("intake-run"));
  await until(() => document.querySelector('[data-testid="intake-review"]')?.dataset.status === "done", 240000);
  await page.waitForSelector(T("intake-summary"));
  const summary = await text(T("intake-summary"));
  console.log("   ", summary.split("\n")[0]);
  assert("\"نفّذ الكل\" → the plain summary: what was made, what needs you (with links)", /اتعمل/.test(summary) && /براند/.test(summary) && /منتج/.test(summary) && /قالب شهادة/.test(summary) && /محتاج منك/.test(summary), summary);
  assert("…the brand and products exist now", (await prisma.brand.count({ where: { companyId: company.id } })) === 1 && (await prisma.product.count({ where: { companyId: company.id } })) >= 4);
  await shot("intake-summary");

  console.log("\nThe same card under an assistant answer");
  const batchId = (await page.evaluate(() => location.pathname.split("/").pop()));
  const conv = await prisma.assistantConversation.create({ data: { ownerType: "user", ownerId: user.id, title: `ملفات ${ts}` } });
  await prisma.assistantMessage.create({ data: { conversationId: conv.id, role: "user", text: "دي شهادات addvet", scopeKey: "system" } });
  await prisma.assistantMessage.create({ data: { conversationId: conv.id, role: "assistant", text: "رتبت الملفات تحت — راجع الكارت ودوس «نفّذ الكل».", scopeKey: "system", blocks: [{ id: `intake-${batchId}`, type: "intake", tool: "start_intake", batchId, title: "Files" }] } });
  await page.goto(`${FRONT}/assistant`, { waitUntil: "networkidle2" });
  await page.evaluate((t) => [...document.querySelectorAll('[data-testid="assistant-history"] button, [data-testid="assistant-history"] a')].find((b) => b.innerText.includes(t))?.click(), `ملفات ${ts}`);
  await page.waitForSelector(`[data-testid="assistant-messages"] ${T("intake-review")}`, { timeout: 15000 }).catch(() => {});
  assert("the assistant message shows the intake card", !!(await page.$(`${T("intake-review")}`)));
  await shot("intake-in-assistant", false);
  assert("no console errors", consoleErrors.length === 0, consoleErrors);
} catch (err) {
  assert(`smoke crashed: ${err.message}`, false, err.stack);
  await shot("intake-crash");
} finally {
  await browser.close();
  await prisma.assistantConversation.deleteMany({ where: { ownerId: user.id } }).catch(() => {});
  await prisma.intakeBatch.deleteMany({ where: { ownerId: user.id } }).catch(() => {});
  await cleanupCompany(company.id).catch((e) => console.error(e.message));
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
