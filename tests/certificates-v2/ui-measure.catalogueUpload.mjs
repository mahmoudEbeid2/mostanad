// Catalogue upload speed in a real browser: Upload click → pages screen usable, and how many page
// images the screen asks for when it opens. NOT part of `npm test`. Same script before and after.
//
//   node tests/certificates-v2/ui-measure.catalogueUpload.mjs <file.pdf> [--front http://localhost:5173]
//
// Needs: npm run dev:test:light and `npx vite` in mostanad_front on :5173.
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import bcrypt from "bcryptjs";
import { api, createCompany, cleanupCompany, prisma } from "./helpers.js";

const file = process.argv[2];
const i = process.argv.indexOf("--front");
const FRONT = i > 0 ? process.argv[i + 1] : "http://localhost:5173";
const T = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const company = await createCompany("uimeasure");
const ts = Date.now();
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uim_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uim_${ts}`, username: `uim_${ts}`, email: `uim_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const out = { file: path.basename(file), mb: +(fs.statSync(file).size / 1e6).toFixed(1) };
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
  await page.goto(`${FRONT}/catalogues`, { waitUntil: "networkidle2" });

  const images = [];
  page.on("response", (r) => /\/pages\/\d+\/image/.test(r.url()) && images.push(r.url()));
  await page.waitForSelector(T("catalogue-upload"));
  await (await page.$(`${T("catalogue-upload")} input[type=file]`)).uploadFile(file);
  await sleep(300);
  await page.waitForSelector(`${T("catalogue-upload")} button[type=submit]:not([disabled])`, { timeout: 10000 });
  const t0 = Date.now();
  await page.click(`${T("catalogue-upload")} button[type=submit]`);
  // the new flow stops on a "Choose pages →" link after the check; the old one navigates by itself
  await page.waitForFunction(() => document.querySelector('[data-testid="page-grid"]') || document.querySelector('[data-testid="choose-pages-next"]'), { timeout: 280000 });
  out.uploadChecked = Date.now() - t0;
  const next = await page.$(T("choose-pages-next"));
  if (next) await next.click();
  await page.waitForSelector(T("page-grid"), { timeout: 280000 });
  out.gridOnScreen = Date.now() - t0;
  // usable = the thumbnails in view have pixels
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('[data-testid="page-thumb"] img')].filter((x) => x.getBoundingClientRect().top < innerHeight);
    return imgs.length >= 6 && imgs.every((x) => x.complete && x.naturalWidth > 0);
  }, { timeout: 120000 });
  out.pagesUsable = Date.now() - t0;
  await sleep(4000);
  out.imageRequestsAfterOpen = images.length;
  out.thumbsOnPage = await page.$$eval(T("page-thumb"), (l) => l.length);
  console.log(JSON.stringify(out));
} catch (err) {
  console.error("Fatal:", err.message, JSON.stringify(out));
  process.exitCode = 1;
}
await browser.close();
await cleanupCompany(company.id);
await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
await prisma.$disconnect();
process.exit(process.exitCode || 0);
