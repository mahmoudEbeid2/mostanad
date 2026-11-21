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
import { makeAssert, api, createCompany } from "./certificates-v2/helpers.js";

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

// --map-localhost: another server holds [::1]:3000 on this machine — send the app's "localhost" API calls to 127.0.0.1 (run with --front http://[::1]:5173)
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000", ...(process.argv.includes("--map-localhost") ? ["--host-resolver-rules=MAP localhost 127.0.0.1"] : [])] });
await browser.defaultBrowserContext().overridePermissions(FRONT, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const text = (sel) => page.$eval(sel, (e) => e.innerText.trim());
const until = (fn, ...args) => page.waitForFunction(fn, { timeout: 8000 }, ...args);
const contains = (sel, s) => until((q, want) => document.querySelector(q)?.innerText.includes(want), sel, s);
// C2 stubs: Load more on a table, a card's Run / Cancel / progress, and the turn after it finished
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept" };
const STUBBED = /\/blocks\/[^/]+\/more|\/assistant\/actions\/|\/actions\/[^/]+\/continue$|\/assistant\/conversations\/[^/]+\/messages$/;
const json = (req, body, status = 200) => req.respond({ status, contentType: "application/json", headers: cors, body: JSON.stringify({ status: "success", data: body }) });
const cards = new Map(); // id → action
let progressTicks = 0;
const continued = [];
await page.setRequestInterception(true);
page.on("request", async (req) => {
  const url = req.url();
  if (req.method() === "OPTIONS") return !STUBBED.test(url) ? req.continue() : req.respond({ status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE" } });
  if (/\/blocks\/[^/]+\/more/.test(url) && req.method() === "POST") {
    const all = url.includes("all=true");
    const b = { ...reply.blocks[0] };
    const extra = Array.from({ length: all ? b.total - b.rows.length : 2 }, (_, i) => ({ cells: { label: `Extra ${b.rows.length + i + 1}`, count: "1" }, ref: null }));
    return json(req, { block: { ...b, rows: [...b.rows, ...extra], nextPage: all ? null : 3, more: all ? 0 : b.total - b.rows.length - 2 }, added: extra.length });
  }
  let m = /\/assistant\/actions\/([^/?]+)\/(approve|cancel)$/.exec(url);
  if (m && req.method() === "POST") {
    const a = cards.get(m[1]);
    const decided = { ...a, decidedAt: new Date().toISOString(), decidedBy: "you" };
    const next = m[2] === "cancel" ? { ...decided, status: "cancelled" } : { ...decided, status: "running", taskId: crypto.randomUUID() };
    cards.set(a.id, next);
    return json(req, { action: next });
  }
  m = /\/assistant\/actions\/([^/?]+)$/.exec(url);
  if (m && req.method() === "GET") {
    const a = cards.get(m[1]);
    progressTicks++;
    const done = progressTicks >= 2;
    const next = done ? { ...a, status: "done", result: { link: `/invoices/${invoice.id}` } } : a;
    cards.set(a.id, next);
    return json(req, { action: next, task: { status: done ? "completed" : "processing", progress: done ? 100 : 62, stage: "Stage 2 of 3 · extracting lines" } });
  }
  m = /\/conversations\/[^/]+\/actions\/([^/]+)\/continue$/.exec(url);
  if (m && req.method() === "POST") {
    continued.push(m[1]);
    const message = { id: crypto.randomUUID(), role: "assistant", text: "The invoice was read: 9 lines.", toolCalls: [], links: [], blocks: [], actions: [], error: null, createdAt: new Date().toISOString() };
    return req.respond({ status: 200, contentType: "text/event-stream", headers: cors, body: sse([["message", { userMessageId: "e", message }]]) });
  }
  if (!(/\/assistant\/conversations\/[^/]+\/messages$/.test(url) && req.method() === "POST")) return req.continue();
  sent.push(JSON.parse(req.postData()));
  const r = reply;
  if (r === "real") return req.continue(); // through to the API (Gemini is off there: a stored error)
  if (delayMs) await sleep(delayMs);
  if (r.status) return req.respond({ status: r.status, contentType: "application/json", headers: cors, body: JSON.stringify({ status: "fail", message: r.message }) });
  for (const a of r.actions || []) cards.set(a.id, a);
  const message = { id: crypto.randomUUID(), role: "assistant", text: r.text, toolCalls: r.toolCalls, links: [], blocks: r.blocks || [], actions: r.actions || [], error: null, createdAt: new Date().toISOString() };
  return req.respond({
    status: 200,
    contentType: "text/event-stream",
    headers: cors,
    body: sse([["status", { type: "status", text: "Thinking…" }], ...r.toolCalls.flatMap((c) => [["tool_start", { type: "tool_start", tool: c.name, label: c.label, args: c.args }], ["tool_end", { type: "tool_end", ...c }]]), ["message", { userMessageId: crypto.randomUUID(), message }]]),
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
  // E0: a floating button bottom-right on every page, never on /assistant, never under a modal
  for (const p of ["/products", "/invoices", `/invoices/${invoice.id}`, "/certificates", "/catalogues"]) {
    await page.goto(`${FRONT}${p}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(T("assistant-fab"), { timeout: 8000 });
    const box = await page.$eval(T("assistant-fab"), (e) => { const r = e.getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, pos: getComputedStyle(e).position }; });
    assert(`✦ floats bottom-right on ${p}`, box.pos === "fixed" && box.right < 60 && box.bottom < 60, box);
  }
  await page.focus(`${T("assistant-fab")} button`);
  await page.waitForFunction((s) => getComputedStyle(document.querySelector(s)).opacity === "1", { timeout: 3000 }, `${T("assistant-fab")} [role="tooltip"]`).catch(() => {});
  assert("keyboard reachable, tooltip \"Ask Dossira · Ctrl K\"", (await text(`${T("assistant-fab")} [role="tooltip"]`)) === "Ask Dossira · Ctrl K" && (await page.$eval(`${T("assistant-fab")} [role="tooltip"]`, (e) => getComputedStyle(e).opacity)) === "1");
  await page.evaluate(() => {
    const m = document.createElement("div");
    m.id = "smoke-modal";
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    document.body.appendChild(m);
  });
  await page.waitForFunction((s) => !document.querySelector(s), { timeout: 4000 }, T("assistant-fab"));
  assert("hidden while a modal is open", !(await page.$(T("assistant-fab"))));
  await page.evaluate(() => document.getElementById("smoke-modal").remove());
  await page.waitForSelector(T("assistant-fab"), { timeout: 4000 });
  assert("…and back when it closes", !!(await page.$(T("assistant-fab"))));
  await page.click(T("nav-assistant"));
  await page.waitForSelector(T("assistant-page"));
  assert("the assistant is a full page at /assistant (no drawer)", page.url().endsWith("/assistant") && !(await page.$('[role="dialog"]')));
  assert("opened from the nav: no context chip, no Back link", !(await page.$(T("context-chip"))) && !(await page.$(T("back-link"))));
  assert("suggested questions are offered", (await page.$$(T("suggestion"))).length >= 3);
  assert("no floating button on /assistant itself", !(await page.$(T("assistant-fab"))));
  await page.click(T("conversation-title"));
  await page.keyboard.type("hi ");
  await page.keyboard.sendCharacter("مرحبا");
  assert("typing anywhere on the page goes into the message box (Arabic too)", (await page.$eval(T("assistant-input"), (e) => e.value)) === "hi مرحبا" && (await page.evaluate(() => document.activeElement?.dataset.testid)) === "assistant-input", await page.$eval(T("assistant-input"), (e) => e.value));
  await page.$eval(T("assistant-input"), (e) => e.blur());
  await page.click(T("assistant-input"), { clickCount: 3 });
  await page.keyboard.press("Backspace");
  assert("the E2 line is shown", (await text(T("assistant-page"))).includes("Every change asks you first."));
  await until((s) => document.querySelectorAll(`${s} option`).length > 1, T("assistant-scope"));
  assert("system admin: a company picker with All companies", (await page.$eval(T("assistant-scope"), (e) => e.value)) === "all");
  await page.select(T("assistant-scope"), company.id);

  const tableBlock = {
    id: crypto.randomUUID(),
    type: "table",
    tool: "count_records",
    columns: [{ key: "label", label: "Company" }, { key: "count", label: "Certificates" }],
    rows: [{ cells: { label: company.name, count: "3" }, ref: { type: "company", id: company.id } }, { cells: { label: 'Other, "quoted"', count: "0" }, ref: null }],
    total: 8,
    more: 6,
    nextPage: 2,
  };
  reply = { text: `This week: **3 certificates**. See [the invoice](entity:invoice/${invoice.id}) and [x](https://evil.example).`, toolCalls: [step], blocks: [tableBlock] };
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
  assert("the report is the system's table block with Copy table / Download CSV", !!(await page.$(`${T("table-block")} table`)) && !!(await page.$(T("download-csv"))));
  const hrefs = await page.$$eval(`${T("assistant-answer")} a`, (as) => as.map((a) => a.getAttribute("href")));
  assert("entity links go to the entity's page; no other link is rendered", hrefs.length === 1 && hrefs[0] === `/invoices/${invoice.id}`, hrefs);
  assert("the table's first column links to the entity", (await page.$eval(`${T("table-block")} tbody a`, (a) => a.getAttribute("href"))) === "/companies");
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
  assert("the table says 2 of 8 and offers Load more and Show all", (await text(T("table-count"))).startsWith("2 of 8") && !!(await page.$(T("load-more"))) && !!(await page.$(T("show-all"))));
  await page.click(T("load-more"));
  await contains(T("table-count"), "4 of 8");
  assert("Load more appends the next rows (the cursor, no model call)", (await page.$$(`${T("table-block")} tbody tr`)).length === 4 && sent.length === 1);
  await page.click(T("show-all"));
  await contains(T("table-count"), "8 of 8");
  assert("Show all loads the rest; no more buttons", !(await page.$(T("load-more"))) && !(await page.$(T("show-all"))));
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

  console.log("\n✦ Files (real upload) and confirmation cards");
  const pdfPath = path.join(process.cwd(), "fixtures", "certificates", "outlined_text.pdf");
  const input = await page.$(T("file-input"));
  await input.uploadFile(pdfPath);
  await page.waitForSelector(T("pending-files"), { timeout: 8000 });
  await page.waitForFunction((s) => document.querySelector(s) && !document.querySelector(`${s} [data-testid="upload-progress"]`), { timeout: 15000 }, T("pending-files"));
  assert("attach button: the file is uploaded and shown as a chip with its size", (await text(T("pending-files"))).includes("outlined_text.pdf") && /KB|MB/.test(await text(T("pending-files"))));
  // drag & drop a PNG onto the input
  await page.evaluate(async (sel) => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dropped-label.png", { type: "image/png" }));
    const el = document.querySelector(sel);
    el.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, T("composer"));
  await contains(T("pending-files"), "dropped-label.png");
  await page.waitForFunction((s) => !document.querySelector(`${s} [data-testid="upload-progress"]`), { timeout: 15000 }, T("pending-files"));
  assert("drag & drop: the dropped file is uploaded too", (await page.$$(`${T("pending-files")} ${T("file-chip")}`)).length === 2);
  await page.click('button[aria-label="Remove dropped-label.png"]');
  assert("a chip can be removed before sending", (await page.$$(`${T("pending-files")} ${T("file-chip")}`)).length === 1);
  const stored = await prisma.assistantAttachment.findMany({ where: { companyId: company.id } });
  assert("files are stored in the picked company", stored.length === 2 && stored.every((a) => a.companyId === company.id));
  const card = (title, extra = {}) => ({ id: crypto.randomUUID(), tool: "upload_invoice", status: "pending", preview: { title, summary: "The invoice is read in the background.", runLabel: "Upload", details: [{ label: "File", value: "outlined_text.pdf" }, { label: "Company", value: company.name }, { label: "Certificates to make", value: "COA, FSC" }], aiCalls: "Reads the invoice · about 3 AI calls", missing: [] }, companyId: company.id, ...extra });
  const runCard = card("Upload invoice");
  reply = { text: "Here is the card to upload the invoice.", toolCalls: [{ name: "upload_invoice", label: "Uploading the invoice", args: {}, ok: true, summary: "waiting for your OK" }], actions: [runCard] };
  await ask("upload this invoice and make COA + FSC");
  await page.waitForSelector(`${T("action-card")}[data-status="pending"]`, { timeout: 8000 });
  assert("the message carried the attachment id", sent.at(-1).attachmentIds?.length === 1 && stored.some((a) => a.id === sent.at(-1).attachmentIds[0]), sent.at(-1));
  assert("the user's message shows its file", (await text(T("assistant-messages"))).includes("outlined_text.pdf"));
  const cardText = await text(`${T("action-card")}[data-status="pending"]`);
  assert("the card: Needs your OK, what, file, company, types, AI use; Upload / Cancel", ["Needs your OK", "Upload invoice", "outlined_text.pdf", company.name, "COA, FSC", "about 3 AI calls", "Upload", "Cancel"].every((x) => cardText.includes(x)), cardText);
  await shot("e2-confirm");
  await page.click(T("action-run"));
  await page.waitForSelector(T("progress-card"), { timeout: 8000 });
  assert("Run → Approved by you · time, and a progress card from the task", /Approved by you · \d/.test(await text(T("action-decision"))));
  await page.waitForSelector(T("event-line"), { timeout: 15000 });
  await contains(T("assistant-messages"), "The invoice was read: 9 lines.");
  assert("when the job ends the assistant is told and continues", continued[0] === runCard.id && (await text(T("progress-card"))).includes("100%"));
  await shot("e2-done");
  const cancelCard = card("Generate 14 certificates");
  reply = { text: "Card to generate.", toolCalls: [], actions: [cancelCard] };
  await ask("generate them");
  await page.waitForSelector(`[data-testid="action-card"][data-status="pending"]`, { timeout: 8000 });
  await page.click(`[data-testid="action-card"][data-status="pending"] ${T("action-cancel")}`);
  await page.waitForSelector(`[data-testid="action-card"][data-status="cancelled"]`, { timeout: 8000 });
  assert("Cancel → Cancelled · time, no progress, no continue", (await text(`[data-testid="action-card"][data-status="cancelled"]`)).includes("Cancelled ·") && continued.length === 1);

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

  console.log("\n✏️ Edit and resend");
  const answers = async () => (await page.$$(T("assistant-answer"))).length;
  const before = await answers();
  reply = { text: "Resent answer.", toolCalls: [] };
  let mine = await page.$$(T("user-message"));
  const resendOf = sent.length;
  await mine.at(-1).hover();
  await (await mine.at(-1).$(T("resend-message"))).click();
  await contains(T("assistant-messages"), "Resent answer.");
  assert("Resend sends the same text with editOf, and no new page context", sent.length === resendOf + 1 && sent.at(-1).text === "and in general?" && /^[0-9a-f-]{36}$/.test(sent.at(-1).editOf || "") && !("page" in sent.at(-1)), sent.at(-1));
  assert("…its old answer is replaced, not added to", (await answers()) === before && !(await page.$$eval(T("assistant-answer"), (els) => els.some((e) => e.innerText.trim() === "ok"))));
  reply = { text: "Edited answer.", toolCalls: [] };
  mine = await page.$$(T("user-message"));
  await mine[0].hover();
  await (await mine[0].$(T("edit-message"))).click();
  await page.waitForSelector(T("edit-input"));
  await page.$eval(T("edit-input"), (e) => e.select());
  await page.keyboard.type("only line 1?");
  await page.keyboard.press("Enter");
  await contains(T("assistant-messages"), "Edited answer.");
  assert("Edit sends the new text with editOf", sent.at(-1).text === "only line 1?" && !!sent.at(-1).editOf, sent.at(-1));
  assert("…and everything after the edited message is gone", (await page.$$(T("user-message"))).length === 1 && (await answers()) === 1 && !(await text(T("assistant-messages"))).includes("no batch number"));
  await shot("e1-from-invoice");
  await page.click(T("back-link"));
  await page.waitForFunction((id) => location.pathname === `/invoices/${id}`, { timeout: 8000 }, invoice.id);
  assert("Back returns to the invoice", true);
  await page.click("main"); // the page has focus, as when a person works on it
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => location.pathname === "/assistant", { timeout: 8000 });
  assert("Ctrl+K opens the assistant with the page as context", page.url().includes(`from=invoice:${invoice.id}`));

  console.log("\n✦ Settings");
  await page.waitForSelector('button[title="Assistant settings"]', { timeout: 8000 });
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
  await prisma.assistantSetting.update({ where: { scopeKey: company.id }, data: { enabled: false } }); // the admin switch (its API is covered by assistant.c1.test.js)
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
  await prisma.storedFile.deleteMany({ where: { companyId: company.id, kind: "assistant_attachment" } });
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.role.delete({ where: { id: role.id } });
  await prisma.company.delete({ where: { id: company.id } });
  await prisma.$disconnect();
}
if (SHOTS && !fs.existsSync(SHOTS)) console.log(`(no shots dir ${SHOTS})`);
console.log(`\n${counts.passed} passed, ${counts.failed} failed`);
process.exit(counts.failed ? 1 : 0);
