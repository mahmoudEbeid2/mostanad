// Certificates V2 — frontend smoke run (plan §16.3: "a Playwright smoke run of
// the wizard and the editor against the dev stack (optional, recommended)").
// Drives the real mostanad_front pages in headless Chromium. NOT part of
// `npm test` (needs the Vite dev server): run it by hand.
//
//   node tests/certificates-v2/ui-smoke.mjs --user <username> --password-file <file> [--phase 1..6] [--shots <dir>]
//
// Needs: npm run dev:test (API + workers), pdf2htmlex, and `npx vite` in
// mostanad_front on :5173. The login is a local QA user (Admin role); the
// script creates its own throwaway company and removes it at the end.
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { api, asAdmin, createCompany, cleanupCompany, FIXTURES, makeAssert, prisma } from "./helpers.js";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const FRONT = arg("front", "http://localhost:5173");
const USER = arg("user");
const PASSWORD = arg("password-file") ? fs.readFileSync(arg("password-file"), "utf8").trim() : process.env.QA_PASSWORD;
const PHASE = Number(arg("phase", 99));
const SHOTS = arg("shots");
if (!USER || !PASSWORD) {
  console.error("usage: --user <username> --password-file <file>");
  process.exit(2);
}

const { assert, counts } = makeAssert();
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
// every failed API response, with its body — a console "400" alone says nothing
page.on("response", async (res) => {
  if (res.status() >= 400 && res.url().includes("/api/")) {
    const body = await res.text().catch(() => "");
    console.log(`     ⚠ ${res.status()} ${res.request().method()} ${res.url().replace(/^https?:\/\/[^/]+/, "")} ${body.slice(0, 200)}`);
  }
});

const shot = async (name) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
const textOf = () => page.evaluate(() => document.body.innerText);
async function waitForText(text, timeout = 30_000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
    return true;
  } catch {
    return false;
  }
}
async function clickText(selector, text) {
  const ok = await page.evaluate(
    (sel, t) => {
      const el = Array.from(document.querySelectorAll(sel)).find((e) => e.innerText.trim().includes(t));
      if (el) el.click();
      return !!el;
    },
    selector,
    text
  );
  if (!ok) throw new Error(`no ${selector} with text "${text}"`);
}

const company = await createCompany("ui");
export const ctx = { allowConsole: [], page, company, waitForText, clickText, textOf, shot, sleep, assert, FRONT, FIXTURES, api, asAdmin, prisma };

try {
  console.log("\n🧪 Login");
  await page.goto(`${FRONT}/login`, { waitUntil: "networkidle2" });
  await page.type('input[placeholder="admin or admin@example.com"]', USER);
  await page.type('input[type="password"]', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}), page.click('form button[type="submit"]')]);
  assert("logged in (left /login)", !page.url().includes("/login"), page.url());
  await page.evaluate((id) => localStorage.setItem("certificates.companyId", id), company.id);

  const phases = (await import("./ui-smoke.phases.mjs")).default;
  for (const [n, run] of phases) {
    if (n > PHASE) break;
    console.log(`\n🧪 Phase ${n} UI`);
    await run(ctx);
  }
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
  await shot("fatal");
}

// phases may declare an error they provoke on purpose (e.g. a 409 conflict)
const relevantErrors = consoleErrors.filter((e) => !/favicon|DevTools|React Router Future/i.test(e) && !ctx.allowConsole.some((re) => re.test(e)));
assert("zero console errors", relevantErrors.length === 0, relevantErrors.slice(0, 5));

await browser.close();
await cleanupCompany(company.id);
await prisma.$disconnect();
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
