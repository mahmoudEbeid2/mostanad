// UI smoke for "Add Reference Label" with several files (client report 24 Nov:
// "can I upload more than one label at a time, not one by one?").
//   node tests/ui-smoke.referenceUpload.mjs [--front http://localhost:5173] [--shots <dir>]
// Needs the test stack (`npm run dev:test`) and `npx vite` in mostanad_front. The
// real API: three files are chosen at once, each is sent on its own and gets its
// own row — two queued, one skipped because the company already has it (with
// the date). No AI is called (the reference worker runs with Gemini off).
import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "fs";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";
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

const company = await createCompany("uiref");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiref-"));
const names = [`ref-a-${ts}.png`, `ref-b-${ts}.png`, `ref-old-${ts}.png`];
const files = names.map((n) => (fs.writeFileSync(path.join(dir, n), PNG), path.join(dir, n)));
await prisma.referenceLabel.create({ data: { name: names[2], companyId: company.id, country: "EG", createdAt: new Date("2026-11-20T10:00:00Z") } });
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uiref_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uiref_${ts}`, username: `uiref_${ts}`, email: `uiref_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|400|404|409/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 15000 }, ...args);
const has = (text) => until((t) => document.body.innerText.includes(t), text);

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

  console.log("Reference labels → Add Reference → three files at once");
  await page.goto(`${FRONT}/reference-labels`, { waitUntil: "networkidle2" });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.includes("Add Reference")).click());
  await page.waitForSelector(T("reference-files"));
  // country (react-select) and company
  await page.click('input[id^="react-select"]');
  await page.keyboard.type("Egypt");
  await page.keyboard.press("Enter");
  await until((id) => [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.value === id)), company.id);
  await page.evaluate((id) => {
    const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === id));
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(sel, id);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, company.id);
  const input = await page.$(T("reference-files"));
  assert("the file input takes several files", await input.evaluate((e) => e.multiple));
  await input.uploadFile(...files);
  await has("3 files chosen");
  assert("the drop zone says several files are fine", await page.evaluate(() => document.body.innerText.includes("One or more PDFs or images")));
  await shot("reference-chosen");
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Upload 3 files/.test(b.innerText)).click());
  await page.waitForSelector(T("reference-upload-results"));
  await until(() => [...document.querySelectorAll('[data-testid="reference-upload-results"] li')].every((li) => ["queued", "skipped", "failed"].includes(li.dataset.state)));
  const rows = await page.$$eval(`${T("reference-upload-results")} li`, (lis) => lis.map((li) => ({ state: li.dataset.state, text: li.innerText })));
  await shot("reference-results");
  assert("one row per file", rows.length === 3, rows);
  assert("two new files → queued", rows.filter((r) => r.state === "queued").length === 2 && rows.filter((r) => r.state === "queued").every((r) => /Queued for reading/.test(r.text)), rows);
  const skipped = rows.find((r) => r.state === "skipped");
  assert("the file the company already has → skipped, with the date it was uploaded", skipped && skipped.text.includes(names[2]) && /Already uploaded on .*2026|20/.test(skipped.text), rows);
  const tasks = await prisma.backgroundTask.count({ where: { companyId: company.id, type: "reference_label_extraction" } });
  assert("two background tasks for the company", tasks === 2, tasks);
  assert('"Track 2 queued" leads to the progress screen', !!(await page.$(T("track-queued"))) && /Track 2 queued/.test(await page.$eval(T("track-queued"), (b) => b.innerText)));
  await page.click(T("track-queued"));
  await until(() => location.pathname === "/processing-bulk");
  assert("no console errors", consoleErrors.length === 0, consoleErrors);
} catch (err) {
  assert(`smoke crashed: ${err.message}`, false, err.stack);
  await shot("crash");
} finally {
  await browser.close();
  await prisma.referenceLabel.deleteMany({ where: { companyId: company.id } }).catch(() => {});
  await prisma.backgroundTask.deleteMany({ where: { companyId: company.id } }).catch(() => {});
  await cleanupCompany(company.id).catch((e) => console.error(e.message));
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
