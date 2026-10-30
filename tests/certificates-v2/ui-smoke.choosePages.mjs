// C1 "Choose pages" — frontend smoke run in headless Chromium against the dev stack.
// NOT part of `npm test` (needs the Vite dev server): run it by hand.
//
//   node tests/certificates-v2/ui-smoke.choosePages.mjs [--front http://localhost:5173] [--shots <dir>]
//
// Needs: npm run dev:test (or dev:test:light) and `npx vite` in mostanad_front on :5173. Logs in as
// a throwaway system user with manage_catalogues (the company and user are removed at the end).
// Covers: upload opens the step, thumbnails, kind tags, keep/skip, quick select, the range input
// both ways, the filter, the preview with ‹ › and the keyboard, the summary, the disabled states,
// "Save and extract later", and the failure states with the backend's real message.
import path from "path";
import puppeteer from "puppeteer";
import bcrypt from "bcryptjs";
import { api, createCompany, cleanupCompany, makeAssert, prisma } from "./helpers.js";
import { fixtureCatalogue } from "./c1Fixture.js";
import fs from "fs";
import os from "os";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const FRONT = arg("front", "http://localhost:5173");
const SHOTS = arg("shots");
const { assert, counts } = makeAssert();
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const company = await createCompany("uic1");
const ts = Date.now();
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uic1_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uic1_${ts}`, username: `uic1_${ts}`, email: `uic1_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
const pdfPath = path.join(os.tmpdir(), `c1-smoke-${ts}.pdf`);
fs.writeFileSync(pdfPath, await fixtureCatalogue());

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const waitForText = (text, timeout = 20000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
const T = (id) => `[data-testid="${id}"]`;
const textOf = (id) => page.$eval(T(id), (e) => e.innerText.trim());
const valueOf = (id) => page.$eval(T(id), (e) => e.value);
const disabled = (id) => page.$eval(T(id), (e) => e.disabled);
const thumbs = () => page.$$eval(T("page-thumb"), (l) => l.map((e) => ({ n: Number(e.dataset.page), kept: e.dataset.kept === "true", dim: e.querySelector("button").className.includes("opacity-45"), blue: e.querySelector("button").className.includes("border-blue-600"), text: e.innerText })));
const keptPages = async () => (await thumbs()).filter((t) => t.kept).map((t) => t.n);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clickThumb = (n) => page.click(`${T("page-thumb")}[data-page="${n}"] button[aria-pressed]`);
const setRange = async (text) => {
  await page.click(T("page-range"));
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
};
// a focused button takes Space for itself: the keyboard rules hold with focus on the page
const blur = () => page.evaluate(() => document.activeElement?.blur());

try {
  // ── log in as a system user, scoped to the throwaway company
  const login = await api("POST", "/auth/login", {}, { username: user.username, password: pw });
  const token = login.data?.data?.token || login.data?.token;
  const me = await api("GET", "/auth/me", { Authorization: `Bearer ${token}` });
  assert("system user login → token", !!token && !!me.data?.data?.user, login.data);
  await page.goto(`${FRONT}/login`, { waitUntil: "networkidle2" });
  await page.evaluate((t, u, c) => {
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify(u));
    localStorage.setItem("certificates.companyId", c);
  }, token, me.data?.data?.user, company.id);

  console.log("\n📤 Upload opens Choose pages");
  await page.goto(`${FRONT}/catalogues`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("catalogue-upload"));
  assert("the upload panel is step 1 of 4", (await page.$eval(`${T("catalogue-steps")} [aria-current="step"]`, (e) => e.innerText)).includes("Upload"));
  const inputs = await page.$$(`${T("catalogue-upload")} input:not([type=file])`);
  await inputs[0].type("Smoke Feed Co");
  await (await page.$(`${T("catalogue-upload")} input[type=file]`)).uploadFile(pdfPath);
  await sleep(200);
  await page.click(`${T("catalogue-upload")} button[type=submit]`);
  await page.waitForSelector(T("page-grid"), { timeout: 60000 });
  const versionId = page.url().match(/versions\/([^/]+)\/pages/)?.[1];
  assert("after the upload job the browser is on /catalogues/versions/:id/pages", !!versionId, page.url());
  assert("step 2 is current", (await page.$eval(`${T("catalogue-steps")} [aria-current="step"]`, (e) => e.innerText)).includes("Choose pages"));
  assert("no extraction was started by the upload", (await prisma.backgroundTask.count({ where: { companyId: company.id, type: "catalogue_extract" } })) === 0);

  console.log("\n🖼️ The grid");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="page-thumb"] img').length >= 9, { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="page-thumb"] img')].every((i) => i.complete && i.naturalWidth > 0), { timeout: 20000 });
  let list = await thumbs();
  assert("9 pages, every thumbnail really loaded through the API", list.length === 9);
  // loaded isn't enough: a page of text must not come out white (fonts the PDF doesn't embed)
  const ink = await page.$$eval(`${T("page-thumb")} img`, (imgs) =>
    imgs.map((img) => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 200) dark++;
      return dark;
    })
  );
  assert("text pages show their text, the blank page 3 stays white", ink.every((d, i) => (i === 2 ? d === 0 : d > 30)), ink);
  const tags = await page.$$eval(`${T("page-thumb")} span.font-medium`, (l) => l.map((e) => e.scrollWidth <= e.clientWidth));
  assert("no kind tag is cut off", tags.length === 9 && tags.every(Boolean), tags);
  assert("default kept = product + scanned pages 4, 6, 8", same(await keptPages(), [4, 6, 8]), await keptPages());
  assert("kept pages have the blue border, skipped ones are dimmed", list.every((t) => (t.kept ? t.blue && !t.dim : t.dim && !t.blue)));
  assert("kind tags on the pages", /Cover/.test(list[0].text) && /Contents/.test(list[1].text) && /Blank/.test(list[2].text) && /Product/.test(list[3].text) && /About/.test(list[4].text) && /Contact/.test(list[6].text) && /Back cover/.test(list[8].text), list.map((t) => t.text));
  assert('the scanned page says "No text — can\'t auto-detect"', /No text — can't auto-detect/.test(list[7].text), list[7].text);
  assert("range input shows the selection", (await valueOf("page-range")) === "4, 6, 8", await valueOf("page-range"));
  let summary = await textOf("pages-summary");
  assert('summary: "3 of 9 pages will be read"', summary.includes("3 of 9 pages will be read"), summary);
  assert("estimate shown, labelled, compared with all pages", /AI tokens \(estimate\)/.test(summary) && /all pages:/.test(summary) && /% less than reading every page/.test(summary), summary);
  assert('button: "Extract 3 pages →"', (await textOf("extract-pages")).includes("Extract 3 pages →"));
  assert("the kept scanned page is called out: the AI can't read it", /1 kept page has no text layer/.test(await textOf("kept-no-text")));
  await shot("c1-grid");

  console.log("\n👆 Keep / skip, the range input");
  await clickThumb(5);
  assert("clicking page 5 keeps it, the text follows", same(await keptPages(), [4, 5, 6, 8]) && (await valueOf("page-range")) === "4–6, 8", await valueOf("page-range"));
  await clickThumb(5);
  assert("clicking it again skips it", same(await keptPages(), [4, 6, 8]));
  await setRange("2-4, 7–9");
  assert('typing "2-4, 7–9" (both dashes) updates the grid', same(await keptPages(), [2, 3, 4, 7, 8, 9]), await keptPages());
  await setRange("4-20");
  const rangeHint = await page.$eval("#rangehint", (e) => e.innerText);
  assert("a range past the end is named, Save is off", /Not a page of this file: 4-20/.test(rangeHint) && (await disabled("save-later")), rangeHint);
  await setRange("1, 4");

  console.log("\n⚡ Quick select + filter");
  await page.click(T("quick-all"));
  assert("All → 9 kept", (await keptPages()).length === 9 && (await valueOf("page-range")) === "1–9");
  await page.click(T("quick-none"));
  assert("None → 0 kept, range empty", (await keptPages()).length === 0 && (await valueOf("page-range")) === "");
  assert('at 0: "Extract 0 pages →" and Save are disabled', (await textOf("extract-pages")).includes("Extract 0 pages →") && (await disabled("extract-pages")) && (await disabled("save-later")));
  await page.click(T("quick-products"));
  assert("Product pages only → 4, 6, 8", same(await keptPages(), [4, 6, 8]));
  await page.click(T("quick-invert"));
  assert("Invert → 1, 2, 3, 5, 7, 9", same(await keptPages(), [1, 2, 3, 5, 7, 9]));
  await page.click(T("quick-invert"));
  assert("filter counts: All · 9, Kept · 3, Skipped · 6", (await textOf("filter-all")).includes("9") && (await textOf("filter-kept")).includes("3") && (await textOf("filter-skipped")).includes("6"));
  await page.click(T("filter-skipped"));
  assert("Skipped shows 6 pages", (await thumbs()).length === 6 && (await thumbs()).every((t) => !t.kept));
  await page.click(T("filter-kept"));
  assert("Kept shows 3 pages", (await thumbs()).length === 3);
  await page.click(T("filter-all"));

  console.log("\n🔍 Preview + keyboard");
  await page.click(`${T("page-thumb")}[data-page="3"] button[aria-label^="Preview"]`);
  assert("the eye opens page 3 without changing the selection", (await textOf("preview-page")) === "Page 3 of 9" && same(await keptPages(), [4, 6, 8]));
  await page.waitForFunction((s) => document.querySelector(s)?.complete && document.querySelector(s).naturalWidth > 0, { timeout: 20000 }, `${T("page-preview")} img`);
  assert("the reason line says why", /Blank page — nothing printed\. Skipped\./.test(await textOf("preview-reason")), await textOf("preview-reason"));
  await page.click('button[aria-label="Next page"]');
  assert("› moves to page 4", (await textOf("preview-page")) === "Page 4 of 9");
  assert("page 4 says why it was kept", /Product page.*Kept\./.test(await textOf("preview-reason")), await textOf("preview-reason"));
  await blur();
  await page.keyboard.press("ArrowRight");
  assert("→ moves to page 5", (await textOf("preview-page")) === "Page 5 of 9");
  await page.keyboard.press(" ");
  assert("Space keeps page 5", (await keptPages()).includes(5));
  await page.keyboard.press("ArrowLeft");
  assert("← moves back to page 4", (await textOf("preview-page")) === "Page 4 of 9");
  await page.click(T("preview-toggle"));
  assert("the Keep/Skip toggle skips page 4", !(await keptPages()).includes(4));
  summary = await textOf("pages-summary");
  assert('the summary follows: "3 of 9"', summary.includes("3 of 9 pages will be read"), summary);
  await setRange("4–6, 8");
  await shot("c1-preview");

  console.log("\n💾 Save and extract later");
  await page.click(T("save-later"));
  await page.waitForFunction(() => location.pathname === "/catalogues", { timeout: 15000 });
  const saved = (await prisma.catalogueVersion.findUnique({ where: { id: versionId } })).pageSelection;
  assert("saved [4, 5, 6, 8] as a person's choice", same(saved.pages, [4, 5, 6, 8]) && saved.source === "user", saved);
  await page.waitForSelector(T("choose-pages"), { timeout: 15000 });
  assert("the catalogue list offers Choose pages", true);
  await page.click(T("choose-pages"));
  await page.waitForSelector(T("page-grid"));
  assert("coming back shows the saved pages", (await valueOf("page-range")) === "4–6, 8", await valueOf("page-range"));

  console.log("\n🚫 AI off and failures");
  await page.waitForFunction((s) => document.querySelector(s)?.disabled, { timeout: 15000 }, T("extract-pages"));
  assert("on this stack (GEMINI_DISABLED) Extract is off, with the reason", !!(await page.$(`${T("pages-summary")} ${T("ai-action-off")}`)));
  // the status says AI is up; the job then fails for real and the backend's message must reach the screen
  await page.setRequestInterception(true);
  const onReq = (r) => (r.url().endsWith("/ai-status") ? r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ status: "success", data: { available: true, message: null, reason: null } }) }) : r.continue());
  page.on("request", onReq);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction((s) => document.querySelector(s) && !document.querySelector(s).disabled, { timeout: 15000 }, T("extract-pages"));
  await page.click(T("extract-pages"));
  await page.waitForSelector(T("pages-error"), { timeout: 30000 });
  const err = await textOf("pages-error");
  assert("a failed extraction shows the backend's real message", /AI|Gemini/i.test(err) && !/^The products weren't read$/.test(err), err);
  await shot("c1-extract-failed");
  page.off("request", onReq);
  await page.setRequestInterception(false);

  const before = consoleErrors.length;
  await page.goto(`${FRONT}/catalogues/versions/00000000-0000-4000-8000-000000000000/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("pages-failed"), { timeout: 15000 });
  assert("a missing version: the failure state with the backend's message and Try again", /Catalogue version/i.test(await textOf("pages-failed")) && /Try again/.test(await textOf("pages-failed")), await textOf("pages-failed"));
  consoleErrors.length = before; // that 404 is what this check asked for

  console.log("\n📱 Phone width");
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(`${FRONT}/catalogues/versions/${versionId}/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("page-grid"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert("no sideways scroll at 390px", overflow <= 0, overflow);
  await shot("c1-phone");
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
  await shot("fatal");
}

const relevant = consoleErrors.filter((e) => !/favicon|DevTools|React Router Future/i.test(e));
assert("zero console errors", relevant.length === 0, relevant.slice(0, 5));
await browser.close();
fs.rmSync(pdfPath, { force: true });
await cleanupCompany(company.id);
await prisma.user.delete({ where: { id: user.id } }).catch((e) => console.error("user cleanup:", e.message));
await prisma.role.delete({ where: { id: role.id } }).catch((e) => console.error("role cleanup:", e.message));
await prisma.$disconnect();
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
