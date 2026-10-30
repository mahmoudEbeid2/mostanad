// Catalogue upload (C0) and "Choose pages" (C1) — frontend smoke run in headless Chromium against
// the dev stack. NOT part of `npm test` (needs the Vite dev server): run it by hand.
//
//   node tests/certificates-v2/ui-smoke.choosePages.mjs [--front http://localhost:5173] [--shots <dir>]
//
// Needs: npm run dev:test:light and `npx vite` in mostanad_front on :5173. Logs in as a throwaway
// system user with manage_catalogues (the company and user are removed at the end).
// C0: every state — empty, file picked (click, drop, keyboard), client checks, uploading (slowed
// down), Cancel, checking, ready, failed at each stage — and the list's status pills.
// C1: nothing pre-selected, keep/skip, range both ways, quick select, "Same pages as last version",
// filter, preview + keyboard, Extract off at 0, save, lazy thumbnails (≤ 6 at a time, none twice).
import path from "path";
import puppeteer from "puppeteer";
import bcrypt from "bcryptjs";
import { api, asAdmin, form, createCompany, cleanupCompany, makeAssert, prisma } from "./helpers.js";
import { fixtureCatalogue, encryptedPdf } from "./c1Fixture.js";
import fs from "fs";
import os from "os";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const FRONT = arg("front", "http://localhost:5173");
const SHOTS = arg("shots");
const BIG = arg("big"); // an optional ~100-page PDF for the lazy-loading checks
const { assert, counts } = makeAssert();
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const company = await createCompany("uic1");
const ts = Date.now();
const permissions = await prisma.permission.findMany({ select: { id: true } });
const role = await prisma.role.create({ data: { name: `uic1_${ts}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } } });
const pw = `ui-${ts}`;
const user = await prisma.user.create({ data: { name: `uic1_${ts}`, username: `uic1_${ts}`, email: `uic1_${ts}@example.invalid`, password: await bcrypt.hash(pw, 8), roleId: role.id } });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c1-smoke-"));
const file = (name, data) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
};
const fixture = await fixtureCatalogue();
const pdfPath = file("acme.pdf", fixture);
const realPdf = path.join(process.cwd(), "fixtures", "catalogues", "Agrikima_Catalogue_2022-new_-_feed.pdf");
const lockedPath = file("locked.pdf", encryptedPdf("secret"));
const textPath = file("notes.txt", "not a pdf");
const hugePath = path.join(tmp, "huge.pdf");
fs.closeSync(fs.openSync(hugePath, "w"));
fs.truncateSync(hugePath, 61 * 1024 * 1024);

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--window-size=1440,1000"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const cdp = await page.createCDPSession();
const expected = [];
page.on("console", (m) => m.type() === "error" && !expected.some((re) => re.test(m.text())) && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
page.on("response", (r) => r.status() >= 400 && console.log(`     ⚠ ${r.status()} ${r.request().method()} ${r.url()}`)); // names the resource behind a console error
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const T = (id) => `[data-testid="${id}"]`;
const textOf = (id) => page.$eval(T(id), (e) => e.innerText.trim());
const valueOf = (id) => page.$eval(T(id), (e) => e.value);
const disabled = (id) => page.$eval(T(id), (e) => e.disabled);
const exists = async (id) => !!(await page.$(T(id)));
const phase = () => page.$eval(T("catalogue-upload"), (e) => e.dataset.phase);
const untilPhase = (p, timeout = 30000) => page.waitForFunction((want) => document.querySelector('[data-testid="catalogue-upload"]')?.dataset.phase === want, { timeout }, p);
const thumbs = () => page.$$eval(T("page-thumb"), (l) => l.map((e) => ({ n: Number(e.dataset.page), kept: e.dataset.kept === "true", blue: e.querySelector("button").className.includes("border-blue-600"), text: e.innerText })));
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
const blur = () => page.evaluate(() => document.activeElement?.blur());
const network = (o) => cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...o });
const pickFile = async (p) => {
  await (await page.$(T("file-input"))).uploadFile(p);
  await sleep(150);
};
const openUpload = async () => {
  await page.goto(`${FRONT}/catalogues`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("catalogue-upload"));
};

try {
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
  await cdp.send("Network.enable");

  console.log("\n📥 C0 — empty");
  await openUpload();
  assert("drop zone, Upload off, step 1 current", (await exists("drop-zone")) && (await disabled("upload-submit")) && (await page.$eval(`${T("catalogue-steps")} [aria-current="step"]`, (e) => e.innerText)).includes("Upload"));
  assert('"Choose a PDF first."', (await textOf("catalogue-upload")).includes("Choose a PDF first."));
  await shot("c0-empty");
  await page.focus(T("drop-zone"));
  const chooser = page.waitForFileChooser({ timeout: 3000 }).then(() => true, () => false);
  await page.keyboard.press("Enter");
  assert("the drop zone is reachable by keyboard: Enter opens the file chooser", await chooser);
  await pickFile(textPath);
  assert("client check: not a PDF", /isn't a PDF/.test(await textOf("file-error")) && (await exists("drop-zone")));
  await pickFile(hugePath);
  assert("client check: over 60 MB, says the size", /61\.\d? MB|64\.\d MB — the limit is 60 MB/.test(await textOf("file-error")), await textOf("file-error"));

  console.log("\n📄 C0 — file picked");
  await pickFile(pdfPath);
  assert("file card with name, size, Change file; Upload on", (await textOf("file-card")).includes("acme.pdf") && (await textOf("file-card")).includes("ready to upload") && (await exists("change-file")) && !(await disabled("upload-submit")));
  assert("the drop zone made way, no error left", !(await exists("drop-zone")) && !(await exists("file-error")));
  await shot("c0-file-picked");
  await openUpload();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.4"], "dropped.pdf", { type: "application/pdf" }));
    document.querySelector('[data-testid="drop-zone"]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForSelector(T("file-card"), { timeout: 3000 });
  assert("drag and drop picks the file", (await textOf("file-card")).includes("dropped.pdf"));

  console.log("\n⏫ C0 — uploading, Cancel");
  await openUpload();
  await pickFile(realPdf);
  await network({ uploadThroughput: 1.5e6 }); // bytes a second: about 10 s for this file
  await page.click(T("upload-submit"));
  await untilPhase("uploading");
  await page.waitForFunction(() => /left/.test(document.querySelector('[data-testid="upload-progress"]')?.innerText || ""), { timeout: 15000 });
  const during = await textOf("upload-progress");
  assert("overall bar + stage: MB of MB, %, time left", /Upload the file/.test(during) && /\d+\.\d of 1\d\.\d MB/.test(during) && /about \d+ (s|min) left/.test(during) && /Check the PDF/.test(during) && /after the upload/.test(during), during);
  assert("Choose pages → is off while uploading", await disabled("choose-pages-next"));
  assert('the list shows the running upload ("Uploading N%")', /Uploading \d+%/.test(await textOf("upload-row")), await textOf("upload-row"));
  await shot("c0-uploading");
  const beforeCancel = await prisma.catalogueVersion.count({ where: { companyId: company.id } });
  expected.push(/ERR_ABORTED|canceled/i);
  await page.click(T("cancel-upload"));
  await untilPhase("idle", 5000);
  assert("Cancel: back to the picked file, Upload on, no row left", (await textOf("file-card")).includes("Agrikima") && !(await disabled("upload-submit")) && !(await exists("upload-row")));
  await network({});
  await sleep(500);
  assert("Cancel: nothing was created", (await prisma.catalogueVersion.count({ where: { companyId: company.id } })) === beforeCancel);

  console.log("\n🚫 C0 — failed");
  await openUpload();
  await pickFile(lockedPath);
  expected.push(/status of 422/);
  await page.click(T("upload-submit"));
  await untilPhase("failed");
  assert("a protected PDF: the backend's message", /This PDF is password-protected — upload a copy without a password\./.test(await textOf("upload-error")), await textOf("upload-error"));
  assert("…and the stage it stopped at", /locked\.pdf/.test(await textOf("upload-failed-stage")) && /stopped at “Check the PDF”/.test(await textOf("upload-failed-stage")) && /couldn't be opened/.test(await textOf("upload-failed")), await textOf("upload-failed-stage"));
  await shot("c0-failed");
  await page.click(T("upload-retry"));
  await untilPhase("failed");
  assert("Try again runs it again, same answer", /password-protected/.test(await textOf("upload-error")));
  await page.click(T("upload-another"));
  await untilPhase("idle");
  assert("Upload another file: back to the drop zone", await exists("drop-zone"));
  await pickFile(pdfPath);
  await page.setOfflineMode(true);
  expected.push(/ERR_INTERNET_DISCONNECTED|ERR_NETWORK|Failed to load resource/);
  await page.click(T("upload-submit"));
  await untilPhase("failed");
  await page.setOfflineMode(false);
  assert("no network: a real sentence, stopped at “Upload the file”", /connection was lost/.test(await textOf("upload-error")) && /stopped at “Upload the file”/.test(await textOf("upload-failed-stage")), await textOf("upload-failed-stage"));

  console.log("\n✅ C0 — checking, ready");
  await openUpload();
  await pickFile(pdfPath);
  await page.type(T("field-edition"), "2026");
  await page.type(T("field-manufacturer"), "Smoke Feed Co");
  await network({ latency: 2500 }); // the answer takes a moment: the check is on screen
  await page.click(T("upload-submit"));
  await untilPhase("checking");
  const checking = await textOf("upload-progress");
  assert("checking: 95%, “counting pages…”, upload ticked", /Checking the PDF/.test(checking) && (await textOf("upload-overall")) === "95%" && /counting pages/.test(checking) && /MB uploaded/.test(checking), checking);
  await shot("c0-checking");
  await untilPhase("ready");
  await network({});
  const ready = await textOf("upload-progress");
  assert("ready: 100%, the page count, Choose pages → on", /Uploaded — 9 pages/.test(ready) && (await textOf("upload-overall")) === "100%" && /9 pages · opens fine, not password-protected/.test(ready) && !(await disabled("choose-pages-next")), ready);
  assert("step 2 is next", (await page.$eval(`${T("catalogue-steps")} [aria-current="step"]`, (e) => e.innerText)).includes("Choose pages"));
  assert("the upload is in the list as “Choose pages”", (await textOf("version-status")) === "Choose pages", await textOf("version-status"));
  assert("no extraction was started", (await prisma.backgroundTask.count({ where: { companyId: company.id, type: "catalogue_extract" } })) === 0);
  await shot("c0-ready");

  console.log("\n🏷️ Status pills");
  const version = await prisma.catalogueVersion.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: "desc" } });
  const versionId = version.id;
  const task = await prisma.backgroundTask.create({ data: { type: "catalogue_extract", status: "processing", companyId: company.id, progress: 40, message: "Reading products" } });
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "extracting", extractTaskId: task.id } });
  // no socket at all: the pill must still move, from the task row alone
  await page.setRequestInterception(true);
  const noSocket = (r) => (r.url().includes("/socket.io/") ? r.abort() : r.continue());
  page.on("request", noSocket);
  expected.push(/socket\.io|ERR_FAILED|WebSocket/);
  await openUpload();
  await page.waitForFunction(() => document.body.innerText.includes("Extracting 40%"), { timeout: 10000 });
  assert('"Extracting 40%" with a small bar', !!(await page.$(`${T("catalogue")} [role="progressbar"]`)));
  await prisma.backgroundTask.update({ where: { id: task.id }, data: { progress: 55 } });
  const moved = await page.waitForFunction(() => document.body.innerText.includes("Extracting 55%"), { timeout: 8000 }).then(() => true, () => false);
  assert("without the socket the poll moves it to 55%", moved);
  page.off("request", noSocket);
  await page.setRequestInterception(false);
  await prisma.backgroundTask.update({ where: { id: task.id }, data: { status: "completed", progress: 100 } });
  for (const [status, label] of [["review", "Review"], ["applied", "Applied"]]) {
    await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status } });
    await openUpload();
    assert(`status ${status} → “${label}”`, (await textOf("version-status")) === label, await textOf("version-status"));
  }
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { status: "pages_ready", extractTaskId: null } });

  console.log("\n📑 C1 — nothing pre-selected");
  await page.goto(`${FRONT}/catalogues/versions/${versionId}/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("page-grid"));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="page-thumb"] img')].length >= 9 && [...document.querySelectorAll('[data-testid="page-thumb"] img')].every((i) => i.complete && i.naturalWidth > 0), { timeout: 30000 });
  let list = await thumbs();
  assert("9 pages, none kept", list.length === 9 && list.every((t) => !t.kept));
  assert("no kind tags", !list.some((t) => /Cover|Contents|Product|Blank|About|Contact|Back cover/.test(t.text)), list.map((t) => t.text));
  assert("the note says what to do", (await textOf("nothing-chosen")) === "No pages chosen yet. Click each page that has products, or type them in “Pages” — e.g. 4–15, 17–20.", await textOf("nothing-chosen"));
  assert('summary "0 of 9 pages will be read"', (await textOf("pages-summary")).includes("0 of 9 pages will be read"));
  assert("Extract and Save are off at 0", (await disabled("extract-pages")) && (await disabled("save-later")) && (await textOf("extract-pages")).includes("Choose pages to extract"), await textOf("extract-pages"));
  assert('no "Same pages as last version" on a first version', !(await exists("quick-same")));
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
  assert("thumbnails have their pixels; the blank page stays white", ink.every((d, i) => (i === 2 ? d === 0 : d > 30)), ink);
  await shot("c1-empty");

  console.log("\n👆 Keep / skip, range");
  await clickThumb(4);
  list = await thumbs();
  assert("clicking page 4 keeps it: blue border + check, the text follows", same(await keptPages(), [4]) && list[3].blue && (await valueOf("page-range")) === "4");
  assert("the note goes away, Extract says “Extract 1 page →”", !(await exists("nothing-chosen")) && (await textOf("extract-pages")).includes("Extract 1 page →"));
  await clickThumb(5);
  assert("page 5 too: 4–5", (await valueOf("page-range")) === "4–5");
  await clickThumb(5);
  assert("clicking again skips it", same(await keptPages(), [4]));
  await setRange("2-4, 7–9");
  assert('typing "2-4, 7–9" (both dashes) updates the grid', same(await keptPages(), [2, 3, 4, 7, 8, 9]), await keptPages());
  await setRange("4-20");
  assert("a range past the end is named, Save is off", /Not a page of this file: 4-20/.test(await page.$eval("#rangehint", (e) => e.innerText)) && (await disabled("save-later")));

  console.log("\n⚡ Quick select + filter");
  await page.click(T("quick-all"));
  assert("All → 9 kept", (await keptPages()).length === 9 && (await valueOf("page-range")) === "1–9");
  await page.click(T("quick-none"));
  assert("None → 0 kept, Extract off", (await keptPages()).length === 0 && (await valueOf("page-range")) === "" && (await disabled("extract-pages")));
  await setRange("4, 6, 8");
  await page.click(T("quick-invert"));
  assert("Invert → 1, 2, 3, 5, 7, 9", same(await keptPages(), [1, 2, 3, 5, 7, 9]));
  await page.click(T("quick-invert"));
  assert("filter counts: All · 9, Kept · 3, Not chosen · 6", (await textOf("filter-all")) === "All · 9" && (await textOf("filter-kept")) === "Kept · 3" && (await textOf("filter-skipped")) === "Not chosen · 6");
  await page.click(T("filter-skipped"));
  assert("Not chosen shows 6 pages", (await thumbs()).length === 6 && (await thumbs()).every((t) => !t.kept));
  await page.click(T("filter-kept"));
  assert("Kept shows 3 pages", (await thumbs()).length === 3);
  await page.click(T("filter-all"));

  console.log("\n🔍 Preview + keyboard");
  await page.click(`${T("page-thumb")}[data-page="3"] button[aria-label^="Preview"]`);
  assert("the eye opens page 3 without changing the selection", (await textOf("preview-page")) === "Page 3 of 9" && same(await keptPages(), [4, 6, 8]));
  await page.waitForFunction((s) => document.querySelector(s)?.complete && document.querySelector(s).naturalWidth > 0, { timeout: 20000 }, `${T("page-preview")} img`);
  assert("not chosen: the Keep button and the line", (await textOf("preview-toggle")) === "Keep this page" && /Not chosen/.test(await textOf("preview-reason")));
  await page.click('button[aria-label="Next page"]');
  assert("› moves to page 4, kept", (await textOf("preview-page")) === "Page 4 of 9" && (await textOf("preview-toggle")) === "Kept" && /Kept/.test(await textOf("preview-reason")));
  await blur();
  await page.keyboard.press("ArrowRight");
  assert("→ moves to page 5", (await textOf("preview-page")) === "Page 5 of 9");
  await page.keyboard.press(" ");
  assert("Space keeps page 5", (await keptPages()).includes(5));
  await page.keyboard.press("ArrowLeft");
  assert("← moves back to page 4", (await textOf("preview-page")) === "Page 4 of 9");
  await page.click(T("preview-toggle"));
  assert("the toggle skips page 4", !(await keptPages()).includes(4));
  await setRange("4–6, 8");
  const summary = await textOf("pages-summary");
  assert("summary: 4 of 9, tokens labelled estimate, % against all pages", summary.includes("4 of 9 pages will be read") && /AI tokens \(estimate\)/.test(summary) && /all pages:/.test(summary) && /56% less than reading every page/.test(summary), summary);
  await shot("c1-preview");

  console.log("\n💾 Save and extract later");
  await page.click(T("save-later"));
  await page.waitForFunction(() => location.pathname === "/catalogues", { timeout: 15000 });
  const saved = (await prisma.catalogueVersion.findUnique({ where: { id: versionId } })).pageSelection;
  assert("saved [4, 5, 6, 8] as a person's choice", same(saved.pages, [4, 5, 6, 8]) && saved.source === "user", saved);
  await page.waitForSelector(T("choose-pages"), { timeout: 15000 });
  await page.click(T("choose-pages"));
  await page.waitForSelector(T("page-grid"));
  assert("coming back shows the saved pages", (await valueOf("page-range")) === "4–6, 8", await valueOf("page-range"));

  console.log("\n🔁 Same pages as last version");
  const next = await api("POST", `/catalogues/${version.catalogueId}/versions`, asAdmin, form({ label: "next" }, { buffer: fixture, name: "next.pdf", type: "application/pdf" }));
  await page.goto(`${FRONT}/catalogues/versions/${next.data.data.versionId}/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("quick-same"));
  assert("offered, not applied: nothing kept", (await keptPages()).length === 0 && (await exists("nothing-chosen")));
  await page.click(T("quick-same"));
  assert("one click applies it", same(await keptPages(), [4, 5, 6, 8]) && (await valueOf("page-range")) === "4–6, 8");

  console.log("\n🧹 Changing the pages after an extraction");
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { extraction: { pages: [4, 5, 6, 8], at: new Date().toISOString() } } });
  await page.goto(`${FRONT}/catalogues/versions/${versionId}/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("page-grid"));
  assert("nothing removed: no note", !(await exists("removed-note")));
  await clickThumb(6);
  assert("taking a read page out says what happens to its products", /Page 6 was read before/.test(await textOf("removed-note")) && /reviewed or linked stay/.test(await textOf("removed-note")), await textOf("removed-note"));
  await prisma.catalogueVersion.update({ where: { id: versionId }, data: { extraction: {} } });

  console.log("\n🚫 AI off, failures");
  await page.goto(`${FRONT}/catalogues/versions/${versionId}/pages`, { waitUntil: "networkidle2" });
  await page.waitForFunction((s) => document.querySelector(s)?.disabled, { timeout: 15000 }, T("extract-pages"));
  assert("on this stack (GEMINI_DISABLED) Extract is off, with the reason", !!(await page.$(`${T("pages-summary")} ${T("ai-action-off")}`)));
  await page.setRequestInterception(true);
  const aiUp = (r) => (r.url().endsWith("/ai-status") ? r.respond({ status: 200, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ status: "success", data: { available: true, message: null, reason: null } }) }) : r.continue());
  page.on("request", aiUp);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction((s) => document.querySelector(s) && !document.querySelector(s).disabled, { timeout: 15000 }, T("extract-pages"));
  await page.click(T("extract-pages"));
  await page.waitForSelector(T("pages-error"), { timeout: 30000 });
  const err = await textOf("pages-error");
  assert("a failed extraction shows the backend's real message", /AI|Gemini/i.test(err) && !/^The products weren't read$/.test(err), err);
  await shot("c1-extract-failed");
  page.off("request", aiUp);
  await page.setRequestInterception(false);
  await page.goto(`${FRONT}/catalogues/versions/${versionId}/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("read-by-hand"));
  await page.click(T("read-by-hand"));
  await page.waitForFunction(() => /\/review$/.test(location.pathname), { timeout: 30000 });
  assert("AI off: “type by hand” reads the pages and opens the review", (await prisma.catalogueBlock.count({ where: { versionId } })) > 0);
  expected.push(/status of 404/);
  await page.goto(`${FRONT}/catalogues/versions/00000000-0000-4000-8000-000000000000/pages`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("pages-failed"), { timeout: 15000 });
  assert("a missing version: the failure state with the backend's message and Try again", /Catalogue version/i.test(await textOf("pages-failed")) && /Try again/.test(await textOf("pages-failed")), await textOf("pages-failed"));

  if (BIG) {
    console.log("\n🐢 Lazy thumbnails on a long catalogue");
    const bigUp = await api("POST", "/catalogues", asAdmin, form({ companyId: company.id, manufacturer: "Big" }, { buffer: fs.readFileSync(BIG), name: "big.pdf", type: "application/pdf" }));
    // counted inside the page, at the XMLHttpRequest the loader uses: the exact number in flight
    await page.evaluateOnNewDocument(() => {
      const seen = (window.__images = { open: 0, peak: 0, urls: [] });
      const { open, send } = XMLHttpRequest.prototype;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__image = /\/pages\/\d+\/image/.test(url) ? url : null;
        // here, ahead of axios's own handler: the next image starts from that one
        if (this.__image) this.addEventListener("loadend", () => seen.open--);
        return open.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        if (this.__image) {
          seen.urls.push(this.__image);
          seen.peak = Math.max(seen.peak, ++seen.open);
        }
        return send.apply(this, args);
      };
    });
    const images = () => page.evaluate(() => ({ urls: window.__images.urls, peak: window.__images.peak }));
    await page.goto(`${FRONT}/catalogues/versions/${bigUp.data.data.versionId}/pages`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(T("page-image-loading"), { timeout: 15000 });
    assert("a shimmer until a thumbnail is there", true);
    await sleep(6000);
    const atOpen = (await images()).urls.length;
    assert("on opening only the pages near the view are asked for", atOpen > 0 && atOpen < 40, atOpen);
    await page.evaluate(() => document.querySelector("main").scrollTo(0, 1e6));
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="page-thumb"]')].slice(-6).every((t) => t.querySelector("img")), { timeout: 120000 });
    const { urls, peak } = await images();
    assert("scrolling down brings the last pages", urls.length > atOpen, urls.length);
    assert("at most 6 images at a time", peak <= 6 && peak > 1, peak);
    assert("no image fetched twice", new Set(urls).size === urls.length, { total: urls.length, unique: new Set(urls).size });
    console.log(`     ${atOpen} images on opening, ${urls.length} after scrolling to the end, at most ${peak} at a time`);
  }

  console.log("\n📱 Phone width");
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(`${FRONT}/catalogues`, { waitUntil: "networkidle2" });
  await page.waitForSelector(T("catalogue-upload"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert("no sideways scroll at 390px", overflow <= 0, overflow);
} catch (err) {
  console.error("Fatal:", err);
  counts.failed++;
  await shot("fatal");
}

const relevant = consoleErrors.filter((e) => !/favicon|DevTools|React Router Future/i.test(e));
assert("zero console errors", relevant.length === 0, relevant.slice(0, 5));
await browser.close();
fs.rmSync(tmp, { recursive: true, force: true });
await cleanupCompany(company.id);
await prisma.user.delete({ where: { id: user.id } }).catch((e) => console.error("user cleanup:", e.message));
await prisma.role.delete({ where: { id: role.id } }).catch((e) => console.error("role cleanup:", e.message));
await prisma.$disconnect();
console.log(`\n📊 RESULTS: ${counts.passed} passed / ${counts.failed} failed / ${counts.passed + counts.failed} total\n`);
process.exit(counts.failed > 0 ? 1 : 0);
