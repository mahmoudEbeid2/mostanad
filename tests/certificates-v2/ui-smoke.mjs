// Certificates V2 — frontend smoke run (plan §16.3: "a Playwright smoke run of
// the wizard and the editor against the dev stack (optional, recommended)").
// Drives the real mostanad_front pages in headless Chromium. NOT part of
// `npm test` (needs the Vite dev server): run it by hand.
//
//   node tests/certificates-v2/ui-smoke.mjs --user <username> --password-file <file> [--phase 1..7] [--shots <dir>]
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

// Accessibility audit of the page's <main> (no axe dependency): every form
// control has an accessible name (placeholder alone doesn't count), every
// button/link has one (icon-only → aria-label), progress bars expose their
// value, and each Tab stop shows a visible focus indicator.
async function audit(name) {
  const problems = await page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const text = (el) => (el.innerText || el.textContent || "").trim();
    const named = (el) => {
      if (el.getAttribute("aria-label")?.trim()) return true;
      const by = el.getAttribute("aria-labelledby");
      if (by && by.split(/\s+/).some((id) => text(document.getElementById(id) || document.createElement("i")))) return true;
      if (el.closest("label") && text(el.closest("label"))) return true;
      if (el.id && Array.from(document.querySelectorAll("label")).some((l) => l.htmlFor === el.id && text(l))) return true;
      return !!el.getAttribute("title")?.trim();
    };
    const desc = (el) =>
      `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}${el.getAttribute("data-key") ? `[key=${el.getAttribute("data-key")}]` : ""}${el.getAttribute("placeholder") ? `[ph=${el.getAttribute("placeholder")}]` : ""}${el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""}`;
    const out = [];
    for (const el of main.querySelectorAll("input, select, textarea")) {
      if (el.type === "hidden" || (!visible(el) && el.type !== "file")) continue;
      if (!named(el)) out.push(`unlabelled ${desc(el)}`);
    }
    for (const el of main.querySelectorAll("button, a[href], [role=button]")) {
      if (!visible(el)) continue;
      if (!text(el) && !el.getAttribute("aria-label")?.trim()) out.push(`icon-only without aria-label: ${el.outerHTML.slice(0, 100)}`);
    }
    for (const el of main.querySelectorAll('[role="progressbar"]')) {
      if (!el.hasAttribute("aria-valuenow") || !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) out.push(`progressbar without value/name: ${el.outerHTML.slice(0, 80)}`);
    }
    return out;
  });
  // focus: Tab through <main>; every stop must show an outline or a box-shadow ring
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  const seen = new Set();
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || !el.closest("main")) return null;
      if (el.tagName === "IFRAME") return { key: "iframe", ok: true };
      const s = getComputedStyle(el);
      const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== "none");
      return { key: el.outerHTML.slice(0, 100), ok: ring };
    });
    if (!r) continue;
    if (seen.has(r.key)) break;
    seen.add(r.key);
    if (!r.ok) problems.push(`no visible focus: ${r.key}`);
  }
  await page.evaluate(() => document.activeElement?.blur());
  assert(`a11y: ${name}`, problems.length === 0, problems.slice(0, 8));
}

const company = await createCompany("ui");
export const ctx = { allowConsole: [], page, company, waitForText, clickText, textOf, shot, sleep, assert, audit, FRONT, FIXTURES, api, asAdmin, prisma };

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
