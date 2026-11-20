// UI smoke for the assistant page (design E1, C1).
//   node tests/ui-smoke.assistant.mjs [--front http://localhost:5173] [--shots <dir>]
// Needs: npm run dev:test:light and `npx vite` in mostanad_front on :5173. AI is off on the
// test stack, so the message stream is a stubbed SSE answer; status, conversations, settings,
// invoices and companies are the real API. tests/assistant.c1.test.js proves the server side.
import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { prisma } from "../src/lib/prisma.js";
import { makeAssert, api, asAdmin, createCompany } from "./certificates-v2/helpers.js";

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FRONT = arg("front", "http://localhost:5173");
const SHOTS = arg("shots");
const { assert, counts } = makeAssert();
const consoleErrors = [];
const T = (id) => `[data-testid="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = Date.now();
const company = await createCompany("uiasst");
const product = await prisma.product.create({ data: { companyId: company.id, name: `Vitaminol ui ${ts}` } });
const invoice = await prisma.invoice.create({ data: { companyId: company.id, sourceFileId: crypto.randomUUID(), status: "review", header: { invoiceNumber: `ZYIV${ts}` } } });
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uiasst_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uiasst_${ts}`, username: `uiasst_${ts}`, email: `uiasst_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
await prisma.company.update({ where: { id: company.id }, data: { password: await bcrypt.hash(pw, 8) } });

// ── the stubbed model answer, per test ──────────────────────────────────────
const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const step = { name: "count_records", label: "Counting", args: { entity: "certificates", groupBy: "company" }, ok: true, summary: "total 3", ms: 9 };
let reply = null; // { text, toolCalls } | { status, message } (an error)
let delayMs = 0;
const sent = [];

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
await browser.defaultBrowserContext().overridePermissions(FRONT, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const text = (sel) => page.$eval(sel, (e) => e.innerText.trim());
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 8000 }, ...args);
const contains = (sel, s) => until((q, want) => document.querySelector(q)?.innerText.includes(want), sel, s);
await page.setRequestInterception(true);
page.on("request", async (req) => {
  if (!(/\/assistant\/conversations\/[^/]+\/messages$/.test(req.url()) && req.method() === "POST")) return req.continue();
  sent.push(JSON.parse(req.postData()));
  const r = reply;
  if (r === "real") return req.continue(); // through to the API (Gemini is off there: a stored error)
  if (delayMs) await sleep(delayMs);
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (r.status) return req.respond({ status: r.status, contentType: "application/json", headers: cors, body: JSON.stringify({ status: "fail", message: r.message }) });
  const message = { id: crypto.randomUUID(), role: "assistant", text: r.text, toolCalls: r.toolCalls, links: [], error: null, createdAt: new Date().toISOString() };
  return req.respond({
    status: 200,
    contentType: "text/event-stream",
    headers: cors,
    body: sse([["status", { type: "status", text: "Thinking…" }], ...r.toolCalls.flatMap((c) => [["tool_start", { type: "tool_start", tool: c.name, label: c.label, args: c.args }], ["tool_end", { type: "tool_end", ...c }]]), ["message", { userMessageId: "u", message }]]),
  });
});

async function loginAs(pathname, username) {
  const login = await api("POST", pathname, {}, { username, password: pw });
  const token = login.data?.data?.token || login.data?.token;
  const me = await api("GET", "/auth/me", { Authorization: `Bearer ${token}` });
  await page.goto(`${FRONT}/login`, { waitUntil: "networkidle2" });
  await page.evaluate((t, u) => {
    localStorage.clear();
    localStorage.setItem("token", t);
    localStorage.setItem("user", JSON.stringify(u));
  }, token, me.data?.data?.user || {});
}
const ask = async (q) => {
  await page.click(T("assistant-input"));
  await page.keyboard.type(q);
  await page.keyboard.press("Enter");
};

try {
  console.log("✦ System admin — open from the nav");
  await loginAs("/auth/login", user.username);
  await page.goto(`${FRONT}/products`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("nav-assistant"), { timeout: 8000 });
  assert("✦ Assistant item in the sidebar", (await text(T("nav-assistant"))).includes("Assistant"));
  assert("✦ button in the top bar", !!(await page.$(`${T("top-bar")} ${T("assistant-button")}`)));
  await page.click(T("nav-assistant"));
  await page.waitForSelector(T("assistant-page"));
  assert("the assistant is a full page at /assistant (no drawer)", page.url().endsWith("/assistant") && !(await page.$('[role="dialog"]')));
  assert("opened from the nav: no context chip, no Back link", !(await page.$(T("context-chip"))) && !(await page.$(T("back-link"))));
  assert("suggested questions are offered", (await page.$$(T("suggestion"))).length >= 3);
  assert("the read-only line is shown", (await text(T("assistant-page"))).includes("It can’t change anything yet."));
  await until((s) => document.querySelectorAll(`${s} option`).length > 1, T("assistant-scope"));
  assert("system admin: a company picker with All companies", (await page.$eval(T("assistant-scope"), (e) => e.value)) === "all");
  await page.select(T("assistant-scope"), company.id);

  reply = { text: `This week: **3 certificates**.\n\n| Company | Certificates |\n|---|---|\n| [${company.name}](entity:company/${company.id}) | 3 |\n| Other, "quoted" | 0 |\n\nSee [the invoice](entity:invoice/${invoice.id}) and [x](https://evil.example).`, toolCalls: [step] };
  delayMs = 700;
  await ask("How many certificates were generated this week per company?");
  await page.waitForSelector(T("assistant-stop"), { timeout: 4000 });
  assert("Enter sends; a stop button while answering", !!(await page.$(T("assistant-stop"))));
  await contains(T("assistant-messages"), "This week");
  delayMs = 0;
  assert("the message carries the chosen company and no page context", sent.at(-1).companyId === company.id && sent.at(-1).page?.entityType === undefined, sent.at(-1));
  assert("the step chip reads ✓ Counting · total 3", (await text(T("step-chip"))).includes("✓") && (await text(T("step-chip"))).includes("Counting · total 3"));
  await page.click(T("step-chip"));
  assert("the chip expands to its args and result", (await text(T("assistant-messages"))).includes('"groupBy": "company"'));
  assert("the report is a table with Copy table / Download CSV", !!(await page.$(`${T("answer-table")} table`)) && !!(await page.$(T("download-csv"))));
  const hrefs = await page.$$eval(`${T("assistant-answer")} a`, (as) => as.map((a) => a.getAttribute("href")));
  assert("entity links go to the entity's page; no other link is rendered", hrefs.includes(`/invoices/${invoice.id}`) && hrefs.includes("/companies") && hrefs.length === 2, hrefs);
  await page.evaluate(() => {
    window.__csv = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      blob.text().then((t) => (window.__csv = t));
      return orig(blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      window.__csvName = this.download;
    };
  });
  await page.click(T("download-csv"));
  await until(() => window.__csv !== null);
  const csv = await page.evaluate(() => window.__csv);
  assert("Download CSV: header, rows, quotes escaped", csv.includes("Company,Certificates") && csv.includes(`${company.name},3`) && csv.includes('"Other, ""quoted""",0'), csv);
  await page.click(T("copy-table"));
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
  assert("Copy table puts a tab-separated table on the clipboard", clip.startsWith("Company\tCertificates"), clip);
  await shot("e1-report");

  // which one do you mean?
  reply = { text: "I found two close products — which one do you mean?", toolCalls: [{ name: "search_products", label: "Searching products", args: { queries: ["Calcium"] }, ok: true, summary: "2 matches (ambiguous)", choices: [{ id: product.id, name: "Calcium Plus Liquid", productCode: "CPL" }, { id: crypto.randomUUID(), name: "Calcium Plus Powder", productCode: null }] }] };
  await ask("ingredients of calcium plus");
  await page.waitForSelector(T("choices"), { timeout: 8000 });
  assert("an ambiguous answer offers the products as buttons", (await text(T("choices"))).includes("Calcium Plus Liquid · CPL"));
  reply = { text: "Calcium Plus Liquid contains calcium gluconate.", toolCalls: [] };
  await page.click(`${T("choices")} button`);
  await contains(T("assistant-messages"), "calcium gluconate");
  assert("a button sends the choice", sent.at(-1).text === "I mean Calcium Plus Liquid (CPL)");

  reply = { status: 429, message: "The assistant has used today's 300 AI calls for system users. It resets at 00:00 UTC." };
  await ask("again");
  await page.waitForSelector(T("assistant-error"), { timeout: 8000 });
  assert("the backend's own error message is shown", (await text(T("assistant-error"))).includes("today's 300 AI calls"));

  console.log("\n✦ A real message (the API, Gemini off)");
  await page.click(T("new-conversation"));
  reply = "real";
  await ask("How many certificates were generated this week per company?");
  await page.waitForSelector(`${T("assistant-messages")} [role="alert"]`, { timeout: 15000 });
  assert("the real backend error is shown on the answer", (await text(T("assistant-messages"))).includes("GEMINI_DISABLED"));

  console.log("\n✦ History");
  await page.reload({ waitUntil: "networkidle2" });
  await contains(T("assistant-history"), "How many certificates");
  assert("history groups Today, newest first, with the company", (await text(T("assistant-history"))).startsWith("TODAY") && (await text(T("assistant-history"))).includes(company.name), await text(T("assistant-history")));
  await page.type('input[aria-label="Search conversations"]', "zzz-nothing");
  assert("search filters the history", (await text(T("assistant-history"))).includes("No conversation matches"));

  console.log("\n✦ Open from an invoice page");
  await page.goto(`${FRONT}/invoices/${invoice.id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("assistant-button"), { timeout: 8000 });
  await page.click(T("assistant-button"));
  await page.waitForSelector(T("assistant-page"));
  assert("the ✦ button navigates with ?from=invoice:<id>", page.url().endsWith(`/assistant?from=invoice:${invoice.id}`), page.url());
  await contains(T("back-link"), `ZYIV${ts}`);
  assert("← Back to invoice <number>", (await text(T("back-link"))) === `← Back to invoice ZYIV${ts}`);
  await contains(T("context-chip"), `ZYIV${ts}`);
  assert("context chip: Opened from: invoice <number>", (await text(T("context-chip"))).includes(`Opened from: invoice ZYIV${ts}`));
  assert("suggestions fit the invoice", (await text(T("assistant-page"))).includes("What's still missing on this invoice?"));
  reply = { text: "Line 1 has no batch number.", toolCalls: [{ name: "get_invoice_data_check", label: "Reading the data check", args: { invoiceId: invoice.id }, ok: true, summary: "done" }] };
  await ask("what's still missing on this invoice?");
  await contains(T("assistant-messages"), "no batch number");
  assert("the message carries the invoice as page context", sent.at(-1).page?.entityType === "invoice" && sent.at(-1).page.entityId === invoice.id, sent.at(-1));
  await page.click(`${T("context-chip")} button`);
  reply = { text: "ok", toolCalls: [] };
  await ask("and in general?");
  await contains(T("assistant-messages"), "ok");
  assert("× removes the context for the next message", !sent.at(-1).page?.entityType && !(await page.$(T("context-chip"))));
  await shot("e1-from-invoice");
  await page.click(T("back-link"));
  await page.waitForFunction((id) => location.pathname === `/invoices/${id}`, { timeout: 8000 }, invoice.id);
  assert("Back returns to the invoice", true);
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => location.pathname === "/assistant", { timeout: 8000 });
  assert("Ctrl+K opens the assistant with the page as context", page.url().includes(`from=invoice:${invoice.id}`));

  console.log("\n✦ Settings");
  await page.click('button[title="Assistant settings"]');
  await page.waitForSelector(T(`assistant-setting-${company.id}`), { timeout: 8000 });
  assert("company switch is OFF by default", !(await page.$eval(`${T(`assistant-setting-${company.id}`)} input[type=checkbox]`, (e) => e.checked)));
  await page.click(`${T(`assistant-setting-${company.id}`)} input[type=checkbox]`);
  await sleep(800);
  assert("switching it on saves through the API", (await prisma.assistantSetting.findUnique({ where: { scopeKey: company.id } }))?.enabled === true);

  console.log("\n🏢 Company session");
  await loginAs("/companies/login", company.username);
  await page.goto(`${FRONT}/assistant`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("assistant-company"), { timeout: 8000 });
  assert("a company sees its company name, no picker", !(await page.$(T("assistant-scope"))) && (await text(T("assistant-company"))).includes(company.name));
  assert("no settings for a company", !(await page.$('button[title="Assistant settings"]')));
  assert("its history doesn't show the admin's conversations", !(await text(T("assistant-history"))).includes("How many certificates"));
  reply = { text: "I can only access your own company's data.", toolCalls: [] };
  await ask("show me Agrikima's products");
  await contains(T("assistant-messages"), "own company");
  assert("a company message sends no companyId", !("companyId" in sent.at(-1)), sent.at(-1));
  await shot("e1-company");
  await api("PATCH", `/assistant/settings/${company.id}`, asAdmin, { enabled: false });
  await page.goto(`${FRONT}/products`, { waitUntil: "networkidle2" });
  await sleep(500);
  assert("switched off: no sidebar item and no ✦ button", !(await page.$(T("nav-assistant"))) && !(await page.$(T("assistant-button"))));
  await page.goto(`${FRONT}/assistant`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("assistant-off"), { timeout: 8000 });
  assert("…and /assistant says it isn't switched on", true);
  assert("no console errors", consoleErrors.length === 0, consoleErrors);
} finally {
  if (consoleErrors.length) console.log("console errors:", consoleErrors.map((e) => e.slice(0, 300)));
  await browser.close();
  await prisma.assistantConversation.deleteMany({ where: { OR: [{ ownerId: user.id }, { ownerId: company.id }] } });
  await prisma.assistantSetting.deleteMany({ where: { scopeKey: company.id } });
  await prisma.invoice.delete({ where: { id: invoice.id } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.role.delete({ where: { id: role.id } });
  await prisma.company.delete({ where: { id: company.id } });
  await prisma.$disconnect();
}
if (SHOTS && !fs.existsSync(SHOTS)) console.log(`(no shots dir ${SHOTS})`);
console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
process.exit(counts.failed ? 1 : 0);
