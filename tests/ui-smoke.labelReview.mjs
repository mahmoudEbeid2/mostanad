// UI smoke for the label review (client report 24 Nov, item 6): "Could not check —
// No approved regulatory rules exist yet" offered "Ask Assistant to fix", and the
// button did nothing ("دي مش بتروح خالص").
//   node tests/ui-smoke.labelReview.mjs [--front http://localhost:5173] [--shots <dir>]
// Needs the test stack and `npx vite` in mostanad_front. The label and its report are
// real rows; the chat answer is a stubbed response (AI is off on the test stack).
import "dotenv/config";
import bcrypt from "bcryptjs";
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

const company = await createCompany("uilabel");
const label = await prisma.generatedLabel.create({ data: { companyId: company.id, inputPayload: {}, labelData: { ...SAMPLE_LABEL_DATA, productType: "feed_additive" }, labelProvenance: {}, schemaVersion: "vet-label@2.0.0", country: "EG", language: "en", status: "failed_validation" } });
const verdicts = [
  { path: "_regulatory", label: { en: "Regulatory Requirements" }, status: "UNVERIFIABLE", presence: "MISSING", severity: "warning", layer: "regulatory_rule", comparison: "regulatory", ruleKey: "NO_AUTHORITATIVE_REQUIREMENTS", message: "No approved regulatory rules exist yet for this country/product scope." },
  { path: "storage", label: { en: "Storage" }, status: "FAIL", presence: "PRESENT", severity: "error", layer: "schema", message: "Storage must state a temperature." },
];
await prisma.validationReport.create({ data: { labelId: label.id, versionNumber: label.currentVersion, passed: false, errorCount: 1, warningCount: 1, verdicts, engineVersion: "test" } });
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uilabel_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uilabel_${ts}`, username: `uilabel_${ts}`, email: `uilabel_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && !/Failed to load resource|404|409/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 15000 }, ...args);
const has = (text) => until((t) => document.body.innerText.includes(t), text);

// AI on/off and the chat answer are stubbed; everything else is the real API
let aiOn = false;
const chats = [];
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
await page.setRequestInterception(true);
page.on("request", (req) => {
  const url = req.url();
  if (req.method() === "OPTIONS" && /\/chat$/.test(url)) return req.respond({ status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST" } });
  if (/\/ai-status$/.test(url) && aiOn) return req.respond({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ status: "success", data: { available: true } }) });
  if (/\/labels\/[^/]+\/chat$/.test(url) && req.method() === "POST") {
    chats.push(JSON.parse(req.postData()));
    return req.respond({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ status: "success", data: { intent: "edit", status: "refused", path: "storage", reason: "the new text has no temperature either" } }) });
  }
  return req.continue();
});

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

  console.log("Label review → \"Could not check\"");
  await page.goto(`${FRONT}/labels/detail/${label.id}`, { waitUntil: "networkidle2" });
  await has("What needs attention");
  await page.evaluate(() => [...document.querySelectorAll("#verdict-list button")].find((b) => b.innerText.includes("Could not check"))?.click());
  await page.waitForSelector(T("add-rules-link"), { timeout: 8000 });
  const card = await page.$eval(T("add-rules-link"), (a) => a.closest("div.bg-white").innerText);
  assert("the card says there are no approved rules for EG (feed additive)", /No approved rules for EG \(feed additive\)/.test(card), card);
  assert("…and has no \"Ask Assistant to fix\" (the label chat can't add rules)", !/Ask Assistant to fix/.test(card), card);
  const href = await page.$eval(T("add-rules-link"), (a) => a.getAttribute("href"));
  assert("…but a link to add them, prefilled with the country and scope", href === "/regulatory-documents?add=1&country=EG&productScope=feed_additives", href);
  await shot("label-review-no-rules");

  console.log("\n\"Ask Assistant to fix\" on a field it can fix");
  const askButtons = await page.$$eval("#verdict-list button", (bs) => bs.filter((b) => /Ask Assistant to fix/.test(b.innerText)).length);
  assert("the storage FAIL keeps its \"Ask Assistant to fix\"", askButtons === 1, askButtons);
  await page.evaluate(() => [...document.querySelectorAll("#verdict-list button")].find((b) => /Ask Assistant to fix/.test(b.innerText)).click());
  await has("AI is unavailable right now");
  assert("AI off → the chat says why it wasn't sent (never silent), nothing posted", chats.length === 0);

  aiOn = true;
  await page.reload({ waitUntil: "networkidle2" });
  await has("What needs attention");
  await page.evaluate(() => [...document.querySelectorAll("#verdict-list button")].find((b) => /Ask Assistant to fix/.test(b.innerText)).click());
  await has("I couldn't make that change to storage");
  assert("AI on → the request is sent at once (no extra click)", chats.length === 1 && /Storage/.test(chats[0].message), chats);
  assert("…and a refusal is answered in the chat with the reason", true);
  await page.evaluate(() => [...document.querySelectorAll("#verdict-list button")].find((b) => /Ask Assistant to fix/.test(b.innerText)).click());
  await until((n) => document.body.innerText.split("I couldn't make that change to storage").length - 1 >= n, 2);
  assert("pressing it again sends again", chats.length === 2, chats.length);
  await shot("label-review-chat");

  console.log("\nThe link to Regulatory & EDA");
  await page.goto(`${FRONT}${href}`, { waitUntil: "networkidle2" });
  await until(() => [...document.querySelectorAll("input")].some((i) => i.value === "EG"));
  const prefilled = await page.evaluate(() => ({ country: [...document.querySelectorAll("input")].some((i) => i.value === "EG"), scope: [...document.querySelectorAll("input")].some((i) => i.value === "feed_additives") }));
  assert("the upload form opens with the label's country and scope", prefilled.country && prefilled.scope, prefilled);
  await shot("regulatory-prefilled");
  assert("no console errors", consoleErrors.length === 0, consoleErrors);
} catch (err) {
  assert(`smoke crashed: ${err.message}`, false, err.stack);
  await shot("crash");
} finally {
  await browser.close();
  await prisma.labelChatMessage.deleteMany({ where: { labelId: label.id } }).catch(() => {});
  await cleanupCompany(company.id).catch((e) => console.error(e.message));
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.role.delete({ where: { id: role.id } }).catch(() => {});
  console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total`);
  await prisma.$disconnect();
  process.exit(counts.failed ? 1 : 0);
}
