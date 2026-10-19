// Per-phase steps for ui-smoke.mjs. Each phase leaves state the next one uses
// (ctx.state), mirroring the owner's demo flow.
import path from "path";

async function phase1(ctx) {
  const { page, FRONT, assert, waitForText, clickText, shot, FIXTURES, api, prisma, company } = ctx;
  ctx.state = {};

  // Types page: empty state → create COA
  await page.goto(`${FRONT}/certificates/types`, { waitUntil: "networkidle2" });
  assert("types: empty state tells what to do", await waitForText("No certificate types yet"));
  await clickText("button", "New type");
  await page.type('input[placeholder="Certificate of Analysis"]', "Certificate of Analysis");
  await page.type('input[placeholder="COA"]', "COA");
  await clickText("button", "Save");
  assert("types: created row shows", await waitForText("Certificate of Analysis"));
  await shot("p1-types");
  await ctx.audit("types page");

  // Templates list → wizard upload
  await page.goto(`${FRONT}/certificates/templates`, { waitUntil: "networkidle2" });
  assert("templates: empty state", await waitForText("No templates yet"));
  const adminView = await page.evaluate(() => ({ banner: document.querySelector('[data-testid="role-banner"]')?.innerText || "", picker: !!document.querySelector('select[aria-label="Company"]') }));
  assert("templates: system admin banner + company picker (A1)", adminView.banner.includes("System admin") && adminView.picker, adminView);
  await clickText("a, button", "Upload template");
  await page.waitForSelector('input[type="file"]');
  const input = await page.$('input[type="file"]');
  await input.uploadFile(path.join(FIXTURES, "ADDVET_COA.ai"));
  await page.waitForFunction(() => document.body.innerText.includes("ADDVET_COA.ai"));
  await clickText("button", "Upload & convert");
  assert("wizard: conversion finished", await waitForText("Converted — this is exactly how the design will print", 60_000));

  // The preview iframe holds the sanitized document, sandboxed without scripts
  await page.waitForSelector("iframe");
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector("[data-page]"), { timeout: 15000 }).catch(() => {});
  const frameInfo = await page.$eval("iframe", (f) => ({
    sandbox: f.getAttribute("sandbox"),
    src: f.getAttribute("src"),
    srcdoc: f.getAttribute("srcdoc"),
    pages: f.contentDocument?.querySelectorAll("[data-page]").length || 0,
    lines: f.contentDocument?.querySelectorAll("[data-line]").length || 0,
    scripts: f.contentDocument?.querySelectorAll("script").length || 0,
    batch: f.contentDocument?.querySelector('[data-line="p1-l11"]')?.textContent,
  }));
  assert("preview: sandbox is exactly allow-same-origin", frameInfo.sandbox === "allow-same-origin", frameInfo.sandbox);
  assert("preview: no src/srcdoc — written into the sandboxed frame (plan §20 I5)", !frameInfo.src && !frameInfo.srcdoc, frameInfo);
  assert("preview: 1 page, 33 lines, no scripts", frameInfo.pages === 1 && frameInfo.lines === 33 && frameInfo.scripts === 0, frameInfo);
  assert("preview: Batch No. line rendered", frameInfo.batch === "Batch No.:  AVVS1122005", frameInfo.batch);
  await shot("p1-wizard-preview");
  await ctx.audit("wizard upload + converted preview (A2/A3)");

  const m = page.url().match(/templates\/([^/]+)\/versions\/([^/?]+)/);
  ctx.state.addvet = { templateId: m?.[1], versionId: m?.[2] };
  assert("wizard URL is addressable (template + version)", !!m, page.url());

  await page.goto(`${FRONT}/certificates/templates`, { waitUntil: "networkidle2" });
  assert("templates list shows the upload", await waitForText("ADDVET COA"));
  await page.waitForFunction(() => Array.from(document.querySelectorAll("img")).some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), { timeout: 15000 }).catch(() => {});
  const thumbs = await page.$$eval("img", (imgs) => imgs.filter((i) => i.src.startsWith("blob:") && i.naturalWidth > 0).length);
  assert("templates list: thumbnail loaded through the API", thumbs >= 1, thumbs);
  await shot("p1-templates");
  await ctx.audit("templates list (A1)");

  // Company account: no picker — its own name, read-only, where system users pick (A1/A2)
  const adminSession = await page.evaluate(() => ({ token: localStorage.getItem("token"), user: localStorage.getItem("user") }));
  const bcrypt = (await import("bcryptjs")).default;
  const pw = `ui-${Date.now()}`;
  // The only thing this pass changes on the company is its password hash; the
  // finally below puts the original back (asserted), whatever happens in between.
  const { password: originalHash } = await prisma.company.findUnique({ where: { id: company.id }, select: { password: true } });
  await prisma.company.update({ where: { id: company.id }, data: { password: await bcrypt.hash(pw, 8) } });
  try {
    const login = await api("POST", "/companies/login", {}, { username: company.username, password: pw });
    const token = login.data?.data?.token;
    const me = await api("GET", "/auth/me", { Authorization: `Bearer ${token}` });
    await page.evaluate(
      (t, u) => {
        localStorage.setItem("token", t);
        localStorage.setItem("user", JSON.stringify(u));
      },
      token,
      me.data?.data?.user
    );
    const companyView = async () => {
      await page.waitForSelector('[data-testid="company-fixed"]', { timeout: 10000 }).catch(() => {});
      return page.evaluate(() => ({
        fixed: document.querySelector('[data-testid="company-fixed"]')?.innerText || "",
        banner: document.querySelector('[data-testid="role-banner"]')?.innerText || "",
        picker: !!document.querySelector('select[aria-label="Company"]'),
      }));
    };
    await page.goto(`${FRONT}/certificates/templates`, { waitUntil: "networkidle2" });
    const listView = await companyView();
    assert(
      "company account: name read-only, green banner, no picker (A1)",
      listView.fixed.includes(company.name) && listView.banner.includes("Company account") && listView.banner.includes(company.name) && !listView.picker && (await waitForText("ADDVET COA", 10000)),
      listView
    );
    await shot("p1-company-templates");
    await ctx.audit("templates list, company account");
    await page.goto(`${FRONT}/certificates/templates/new`, { waitUntil: "networkidle2" });
    const formView = await companyView();
    assert("company account: upload form shows the company fixed (A2)", formView.fixed.includes(company.name) && formView.fixed.includes("your company") && !formView.picker, formView);
    const nav = await page.$$eval("aside a", (as) => as.map((a) => a.getAttribute("href")));
    assert("company account: sidebar lists the four certificates pages", ["/certificates/templates", "/certificates/types", "/invoices", "/certificates"].every((h) => nav.includes(h)), nav);
    await page.goto(`${FRONT}/invoices`, { waitUntil: "networkidle2" });
    const invView = await companyView();
    assert("company account: invoices page, green banner, no picker (B1)", page.url().endsWith("/invoices") && invView.banner.includes("Company account") && !invView.picker && (await waitForText("No invoices yet", 10000)), invView);
    await shot("p1-company-invoices");
    await ctx.audit("invoices, company account (B1)");
  } finally {
    await page.evaluate((s) => {
      localStorage.setItem("token", s.token);
      localStorage.setItem("user", s.user);
    }, adminSession);
    await prisma.company.update({ where: { id: company.id }, data: { password: originalHash } });
  }
  const restored = await prisma.company.findUnique({ where: { id: company.id }, select: { password: true } });
  assert("company account: original password hash restored", restored?.password === originalHash);
}

// Selects [start,end) of a line's text inside the DocumentFrame and fires the
// mouseup FieldMarker listens to (ctrl = additive multi-selection).
async function selectInFrame(page, lineId, value, { ctrl = false, toLineId = null, toValue = null } = {}) {
  return page.evaluate(
    (lineId, value, ctrl, toLineId, toValue) => {
      const d = document.querySelector("iframe").contentDocument;
      const at = (id, v, end) => {
        const line = d.querySelector(`[data-line="${id}"]`);
        const off = line.textContent.indexOf(v) + (end ? v.length : 0);
        const w = d.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let pos = 0;
        while (w.nextNode()) {
          const n = w.currentNode;
          if (off <= pos + n.data.length && (end || off < pos + n.data.length)) return [n, off - pos];
          pos += n.data.length;
        }
        return null;
      };
      const r = d.createRange();
      r.setStart(...at(lineId, value, false));
      r.setEnd(...at(toLineId || lineId, toValue || value, true));
      const sel = d.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      d.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, ctrlKey: ctrl }));
      return sel.toString();
    },
    lineId,
    value,
    ctrl,
    toLineId,
    toValue
  );
}

const clickExact = async (page, text) => {
  await page.waitForFunction((t) => Array.from(document.querySelectorAll("button")).some((x) => x.innerText.trim() === t && !x.disabled), { timeout: 15000 }, text).catch(() => {});
  return page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll("button")).find((x) => x.innerText.trim() === t && !x.disabled);
    if (b) b.click();
    return !!b;
  }, text);
};

async function phase2(ctx) {
  const { page, FRONT, assert, waitForText, clickText, shot, sleep, api, asAdmin, company } = ctx;
  const { templateId, versionId } = ctx.state.addvet;
  const frameText = () => page.evaluate(() => document.querySelector("iframe")?.contentDocument?.body?.innerText || "");
  const saved = () => page.waitForFunction(() => document.querySelector('[data-testid="save-state"]')?.innerText.includes("All changes saved"), { timeout: 20000 }).then(() => true, () => false);

  await page.goto(`${FRONT}/certificates/templates/${templateId}/versions/${versionId}?step=fields`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector('[data-line="p1-l11"]'), { timeout: 20000 });
  assert("fields: empty state explains how to mark", await waitForText("Select the text that changes"));

  // one value → floating "Make field"
  await selectInFrame(page, "p1-l11", "AVVS1122005");
  await page.waitForSelector('[data-testid="make-field"]', { timeout: 5000 });
  assert("selection shows the floating Make field button", (await page.$eval('[data-testid="make-field"]', (b) => b.innerText)).includes("Make field"));
  await page.click('[data-testid="make-field"]');
  await page.waitForSelector('[data-testid="field-label"]');
  await page.focus('[data-testid="field-label"]');
  await page.type('[data-testid="field-label"]', "Batch No");
  assert("label auto-slugs the key (batch_no)", !!(await page.waitForSelector('[data-testid="field-batch_no"]', { timeout: 5000 }).catch(() => null)));
  // source: react-select inside the open editor
  const srcInput = await page.$('[data-testid="field-batch_no"] input[id^="react-select"]');
  await srcInput.type("Batch number");
  await page.keyboard.press("Enter");
  assert("source chip shows Invoice line · Batch number", await waitForText("Invoice line · Batch number", 5000));
  assert("autosave → saved", await saved());

  // Ctrl-select two values → "Make fields (2)"
  await selectInFrame(page, "p1-l12", "11/2022", { ctrl: true });
  await selectInFrame(page, "p1-l13", "11/2025", { ctrl: true });
  const label2 = await page.$eval('[data-testid="make-field"]', (b) => b.innerText).catch(() => "");
  assert("Ctrl-select: Make fields (2)", label2.includes("Make fields (2)"), label2);
  await page.click('[data-testid="make-field"]');
  assert("two fields added, saved", (await saved()) && (await page.$$('[data-testid^="field-"]')).length >= 3);

  // a selection across two lines makes one draft per line
  await selectInFrame(page, "p1-l16", "1L", { toLineId: "p1-l17", toValue: "JORDAN" });
  const label3 = await page.$eval('[data-testid="make-field"]', (b) => b.innerText).catch(() => "");
  assert("multi-line selection: one field per line (2)", label3.includes("Make fields (2)"), label3);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector("iframe").contentDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

  const hl = await page.evaluate(() => {
    const w = document.querySelector("iframe").contentWindow;
    return w.CSS?.highlights ? (w.CSS.highlights.get("cert-field")?.size || 0) + (w.CSS.highlights.get("cert-field-active")?.size || 0) : -1;
  });
  assert("fields highlighted with the CSS Custom Highlight API (3)", hl === 3, hl);
  const docUntouched = await page.evaluate(() => !document.querySelector("iframe").contentDocument.querySelector("[data-field], mark"));
  assert("nothing is written into the document", docUntouched);
  await shot("p2-fields");
  await ctx.audit("mark fields (A4)");

  // settings → prepare
  console.log("     next button:", await page.evaluate(() => { const b = Array.from(document.querySelectorAll("button")).find((x) => x.innerText.includes("Next: settings")); return b ? `disabled=${b.disabled}` : "none"; }), "url:", page.url());
  await clickText("button", "Next: settings");
  await sleep(500);
  console.log("     after click url:", page.url());
  assert("settings step", await waitForText("Save settings"));
  await clickText("button", "Next: prepare & test");
  assert("prepare button enabled", await clickExact(page, "Prepare"));
  assert("prepare: gate passed in the UI", await waitForText("Prepare passed — ready to activate", 90000));
  assert("prepare: per-check cards + per-field deltas listed", (await page.$$('[data-testid="prepare-report"] [data-check]')).length === 7 && (await waitForText("Position Δ")));
  await shot("p2-prepare");

  // test fill rendered on the server
  await page.waitForSelector('[data-testid="test-batch_no"]');
  await page.type('[data-testid="test-batch_no"]', "AVVS1124011");
  await clickText("button", "Render preview");
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.body?.innerText.includes("AVVS1124011"), { timeout: 20000 }).catch(() => {});
  assert("test fill: server render shows the typed value", (await frameText()).includes("AVVS1124011"));
  assert("test fill: unresolved required field flagged", await waitForText("Required value missing", 5000));
  await shot("p2-testfill");
  await ctx.audit("prepare report + test fill (A5)");

  // activate
  await clickText("button", "Next: activate");
  assert("activate button enabled", await clickExact(page, "Activate v1"));
  assert("activate: version is active", await waitForText("This version is active.", 20000));
  const v = await api("GET", `/template-versions/${versionId}?companyId=${company.id}`, asAdmin);
  assert("API: version active, 3 fields", v.data?.data?.version?.status === "active" && v.data.data.version.fields.length === 3, v.data?.data?.version?.status);
  await shot("p2-activate");
  await ctx.audit("activate step");

  // A1 card: "3 fields · round-trip x %" of the active version
  await page.goto(`${FRONT}/certificates/templates`, { waitUntil: "networkidle2" });
  const gate = await page.waitForSelector('[data-testid="template-gate"]', { timeout: 10000 }).then((e) => e.evaluate((x) => x.innerText), () => "");
  assert("templates list: active card shows field count + round-trip (A1)", /^3 fields · round-trip (< )?\d\.\d{3} %$/.test(gate), gate);
  await sleep(200);
}

// Replaces an input's whole value the way a user does (click, Ctrl+A, type, Enter).
async function retype(page, handle, text) {
  await handle.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

async function phase3(ctx) {
  const { page, FRONT, assert, waitForText, clickText, shot, sleep, company, prisma, FIXTURES } = ctx;
  const { shapeExtraction } = await import("../../src/services/certificates/invoices/invoiceExtractor.js");
  const fileStore = await import("../../src/services/certificates/storage/fileStore.js");

  // Empty state → upload in the UI. Gemini is disabled on the test stack, so
  // extraction must fail explicitly, with the real reason, and zero lines.
  await page.goto(`${FRONT}/invoices`, { waitUntil: "networkidle2" });
  assert("invoices: empty state says what to do", await waitForText("No invoices yet"));
  assert("invoices: upload panel on the same page (B1)", !!(await page.$('input[type="file"]')) && (await waitForText("Destination country", 2000)));
  await (await page.$('input[type="file"]')).uploadFile(path.join(FIXTURES, "outlined_text.pdf"));
  await page.waitForFunction(() => document.body.innerText.includes("outlined_text.pdf"));
  await clickText("button", "Upload & read invoice");
  await page.waitForFunction(() => /\/invoices\/[0-9a-f-]{36}/.test(location.pathname), { timeout: 15000 });
  assert("upload redirects to the review page", /\/invoices\/[0-9a-f-]{36}/.test(page.url()), page.url());
  assert("failed extraction shown with the real reason", await waitForText("Couldn’t read this invoice:", 60000) && (await waitForText("GEMINI_DISABLED", 2000)) && (await waitForText("No certificates were created.", 1000)));
  await shot("p3-failed");
  await ctx.audit("failed extraction");
  await clickText("button", "Try again");
  assert("Try again re-reads it: the loader, then the same explicit failure", (await page.waitForSelector('[data-testid="extracting"], [data-testid="extraction-failed"]', { timeout: 10000 }).then(() => true, () => false)) && (await waitForText("Couldn’t read this invoice:", 60000)));

  // A review-state invoice, stored exactly as the extract job stores it.
  const brand = await prisma.brand.create({ data: { companyId: company.id, name: "ADDvet UI" } });
  const pAE = await prisma.product.create({ data: { companyId: company.id, name: "ADD-E120", productCode: "AE120", brandId: brand.id } });
  await prisma.product.create({ data: { companyId: company.id, name: "Selenium Plus", productCode: "SP-2" } });
  await prisma.product.create({ data: { companyId: company.id, name: "Selenium Plus", productCode: "SP-3", brandId: brand.id } });
  const shaped = shapeExtraction({
    header: { invoiceNumber: "INV-UI-1", invoiceDate: "15/04/2026", customerName: "Gulf Vet", customerCountry: "SA", currency: "USD" },
    items: [
      { lineNo: 1, name: "ADD-E120", code: "AE120", batchNo: "AVVS1124011", productionDate: "06/2024", expiryDate: "06/2027", quantity: "100", unit: "L" },
      { lineNo: 2, name: "Selenium Plus", code: "SP-9", batchNo: "S1", expiryDate: "03/04/2027" },
      { lineNo: 3, name: "Mystery Tonic", batchNo: "M1" },
    ],
  });
  const src = await fileStore.putFile({ companyId: company.id, kind: "invoice_source", buffer: (await import("fs")).readFileSync(path.join(FIXTURES, "outlined_text.pdf")), mimeType: "application/pdf", originalName: "invoice.pdf" });
  const inv = await prisma.invoice.create({
    data: { companyId: company.id, brandId: brand.id, country: "SA", status: "review", sourceFileId: src.id, header: shaped.header, headerExtracted: shaped.header, extraction: { modelId: "test", promptHash: "test", warnings: ["line 3 code unreadable"] } },
  });
  await prisma.invoiceItem.createMany({ data: shaped.items.map((it) => ({ invoiceId: inv.id, lineNo: it.lineNo, data: it.data, dataExtracted: it.data })) });
  const { matchInvoice } = await import("../../src/services/certificates/matching/productMatcher.js");
  await matchInvoice(inv.id);
  ctx.state.invoice = { id: inv.id, brandId: brand.id, productId: pAE.id };

  await page.goto(`${FRONT}/invoices/${inv.id}`, { waitUntil: "networkidle2" });
  assert("review: header + lines rendered", (await waitForText("Invoice INV-UI-1")) && (await page.$$('[data-testid="invoice-items"] tbody tr')).length === 3);
  assert("review: extraction notes shown", await waitForText("line 3 code unreadable", 3000));
  assert("review: original invoice shown side by side", !!(await page.waitForFunction(() => document.querySelector('iframe[title="Original invoice"]')?.src.startsWith("blob:"), { timeout: 15000 }).catch(() => null)));
  assert("review: confirm disabled while lines need a product", await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Confirm & continue")?.disabled === true));
  assert("review: ambiguous date warned", await waitForText("Some dates are ambiguous", 3000));
  assert("review: banner names the lines that need a product", (await page.$eval('[data-testid="needs-match-banner"]', (e) => e.innerText).catch(() => "")).includes("2 lines need a product match"));

  // header edit → "edited" marker
  const numberInput = await page.evaluateHandle(() => Array.from(document.querySelectorAll("label")).find((l) => l.innerText.startsWith("Invoice number"))?.querySelector("input"));
  await retype(page, numberInput, "INV-UI-1A");
  assert("header edit saved, marked edited", await waitForText("Invoice INV-UI-1A", 10000) && (await page.evaluate(() => Array.from(document.querySelectorAll("label")).find((l) => l.innerText.startsWith("Invoice number"))?.innerText.includes("edited"))));

  // cell edit: fix the ambiguous expiry on line 2
  await retype(page, await page.$('tr[data-line="2"] input[data-key="expiryDate"]'), "04/2027");
  await page.waitForFunction(() => !document.body.innerText.includes("Some dates are ambiguous"), { timeout: 10000 }).catch(() => {});
  assert("cell edit re-normalises the date (warning gone)", !(await ctx.textOf()).includes("Some dates are ambiguous"));
  assert("cell shows the edited marker", !!(await page.$('tr[data-line="2"] input[data-key="expiryDate"] + [aria-label^="Edited"]')));

  // Esc reverts a cell instead of saving it
  const batch1 = await page.$('tr[data-line="1"] input[data-key="batchNo"]');
  await batch1.click();
  await page.keyboard.type("XXX");
  await page.keyboard.press("Escape");
  await sleep(800);
  const b1 = (await prisma.invoiceItem.findFirst({ where: { invoiceId: inv.id, lineNo: 1 } })).data.batchNo;
  assert("Esc reverts the cell (nothing saved)", b1 === "AVVS1124011" && (await batch1.evaluate((el) => el.value)) === "AVVS1124011", b1);

  // manual match from the candidates (brand-first), ignore line 3
  await page.click('tr[data-line="2"] input[id^="react-select"]');
  // react-select renders group headings uppercase, and innerText follows CSS
  const listed = await page.waitForFunction(() => /suggested matches/i.test(document.body.innerText), { timeout: 5000 }).then(() => true, () => false);
  assert("match select lists ranked candidates", listed);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('tr[data-line="2"]')?.innerText.includes("✓ you"), { timeout: 10000 }).catch(() => {});
  assert("line 2 matched by the user", (await page.$eval('tr[data-line="2"]', (r) => r.innerText)).includes("✓ you"));
  await page.click('tr[data-line="3"] button[title="Ignore this line"]');
  assert("line 3 ignored", await waitForText("no certificate for this line", 10000));
  await shot("p3-review");
  await ctx.audit("review & match (B3)");

  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Confirm & continue")?.click());
  assert("confirm → ready", await waitForText("Confirmed — editing anything sends it back to review.", 10000));
  const row = await prisma.invoice.findUnique({ where: { id: inv.id }, include: { items: true } });
  assert("DB: ready, header edited, raw extraction untouched", row.status === "ready" && row.header.invoiceNumber === "INV-UI-1A" && row.headerExtracted.invoiceNumber === "INV-UI-1");

  // A5 test fill: "Invoice item (optional)" lists the confirmed invoice's lines
  const { templateId, versionId } = ctx.state.addvet;
  const testFrame = () => page.evaluate(() => document.querySelector('[data-testid="test-fill"] iframe')?.contentDocument?.body?.innerText || "");
  await page.goto(`${FRONT}/certificates/templates/${templateId}/versions/${versionId}?step=prepare`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="test-invoice-item"] input', { timeout: 15000 });
  await page.click('[data-testid="test-invoice-item"] input');
  await page.keyboard.type("INV-UI-1A");
  const listedLine = await page.waitForFunction(() => document.querySelector('[data-testid="test-invoice-item"]')?.innerText.includes("INV-UI-1A · line 1"), { timeout: 15000 }).then(() => true, () => false);
  const ignoredHidden = !(await page.$eval('[data-testid="test-invoice-item"]', (e) => e.innerText)).includes("line 3");
  assert("test fill: invoice item picker lists the confirmed lines (ignored line left out)", listedLine && ignoredHidden);
  await page.keyboard.press("Enter");
  await clickText("button", "Render preview");
  await page.waitForFunction(() => document.querySelector('[data-testid="test-fill"] iframe')?.contentDocument?.body?.innerText.includes("AVVS1124011"), { timeout: 20000 }).catch(() => {});
  assert("test fill: the picked line's batch is rendered", (await testFrame()).includes("AVVS1124011"));
  await page.click('[data-testid="test-invoice-item"] [class*="indicatorContainer"]'); // react-select clear (×)
  await clickText("button", "Render preview");
  await page.waitForFunction(() => !document.querySelector('[data-testid="test-fill"] iframe')?.contentDocument?.body?.innerText.includes("AVVS1124011"), { timeout: 20000 }).catch(() => {});
  assert("test fill: clearing the line falls back (batch unresolved again)", !(await testFrame()).includes("AVVS1124011") && (await waitForText("Required value missing", 5000)));
  await shot("p3-testfill-item");
  await ctx.audit("test fill with invoice item");

  // list: search + per-status action (B1)
  await page.goto(`${FRONT}/invoices`, { waitUntil: "networkidle2" });
  await page.type('input[placeholder="Search invoice no. or customer"]', "ui-1a");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="invoices-table"] tbody tr').length === 1, { timeout: 10000 }).catch(() => {});
  const rows = await page.$$eval('[data-testid="invoices-table"] tbody tr', (trs) => trs.map((t) => t.innerText));
  assert("list search finds the invoice, action says Review", rows.length === 1 && rows[0].includes("INV-UI-1A") && rows[0].includes("Review"), rows);
  await shot("p3-list");
  await ctx.audit("invoices list (B1)");
  await sleep(200);
}

async function phase4(ctx) {
  const { page, FRONT, assert, waitForText, shot, prisma } = ctx;
  const inv = ctx.state.invoice; // confirmed in phase 3; the ADDVET COA is active since phase 2

  await page.goto(`${FRONT}/invoices/${inv.id}`, { waitUntil: "networkidle2" });
  assert("plan preview on the confirmed invoice", await waitForText("Plan preview", 10000));
  const planText = await page.$eval('[data-testid="plan-preview"]', (e) => e.innerText).catch(() => "");
  assert("plan: 2 COA certificates, one per product, from the active template", planText.includes("COA") && planText.includes("2 certificates · one per product"), planText);
  const genLabel = await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.startsWith("Generate"))?.innerText.trim());
  assert("Generate button names the count", genLabel === "Generate 2 certificates", genLabel);
  await shot("p4-plan");

  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.startsWith("Generate"))?.click());
  await page.waitForSelector('[data-testid="batch-view"]', { timeout: 15000 });
  assert("batch view replaces the review (B4)", await waitForText("Certificates for INV-UI-1A", 5000));
  const finished = await page.waitForFunction(() => ["done", "partially_failed", "failed"].includes(document.querySelector('[data-testid="batch-view"]')?.dataset.status), { timeout: 120000 }).then(() => true, () => false);
  assert("batch finished in the UI", finished);
  const status = await page.$eval('[data-testid="batch-view"]', (e) => e.dataset.status);
  assert("batch done (no failures)", status === "done", status);
  assert("progress reads 2 of 2", await waitForText("2 of 2", 5000));
  const cards = await page.$$eval('[data-testid="certificate-card"]', (cs) => cs.map((c) => ({ status: c.dataset.status, text: c.innerText })));
  assert("two draft cards, one per line, with their batch numbers", cards.length === 2 && cards.every((c) => c.status === "draft") && cards.some((c) => c.text.includes("Batch AVVS1124011")) && cards.some((c) => c.text.includes("Batch S1")), cards);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="certificate-card"] img')).filter((i) => i.src.startsWith("blob:") && i.naturalWidth > 0).length === 2, { timeout: 15000 }).catch(() => {});
  const thumbs = await page.$$eval('[data-testid="certificate-card"] img', (imgs) => imgs.filter((i) => i.src.startsWith("blob:") && i.naturalWidth > 0).length);
  assert("card thumbnails rendered on the server, loaded through the API", thumbs === 2, thumbs);
  const db = await prisma.certificate.findMany({ where: { invoiceId: inv.id }, include: { versions: true } });
  assert("DB: 2 certificates, version 1 each, values from the lines", db.length === 2 && db.every((c) => c.versions.length === 1) && db.some((c) => c.versions[0].values.batch_no?.value === "AVVS1124011"));
  await shot("p4-batch");
  await ctx.audit("batch view (B4)");

  await page.goto(`${FRONT}/invoices`, { waitUntil: "networkidle2" });
  const row = await page.$$eval('[data-testid="invoices-table"] tbody tr', (trs) => trs.map((t) => t.innerText).find((t) => t.includes("INV-UI-1A")) || "");
  assert("invoice list: generated, 2 certificates, action Open", /generated/i.test(row) && /\t2\t/.test(row) && row.includes("Open"), row);

  await page.goto(`${FRONT}/certificates`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="certificate-card"]', { timeout: 10000 }).catch(() => {});
  assert("generated certificates page lists both", (await page.$$('[data-testid="certificate-card"]')).length === 2);
  await page.type('input[placeholder="Search product, batch or invoice no."]', "avvs1124011");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="certificate-card"]').length === 1, { timeout: 10000 }).catch(() => {});
  assert("search narrows to the batch", (await page.$$('[data-testid="certificate-card"]')).length === 1);
  await shot("p4-list");
  await ctx.audit("generated certificates list");
  ctx.state.certificateIds = db.map((c) => c.id);
}

async function phase5(ctx) {
  const { page, FRONT, assert, waitForText, shot, sleep, prisma, api, asAdmin, company } = ctx;
  const fsMod = await import("fs");
  const pathMod = await import("path");
  const os = await import("os");
  const downloads = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "cert-dl-"));
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const downloaded = async (re, timeout = 60000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const hit = fsMod.readdirSync(downloads).find((f) => re.test(f) && !f.endsWith(".crdownload"));
      if (hit) return pathMod.join(downloads, hit);
      await sleep(300);
    }
    return null;
  };
  const onDialog = (d) => d.accept();
  page.on("dialog", onDialog);
  const cert = await prisma.certificate.findFirst({ where: { id: { in: ctx.state.certificateIds } }, include: { items: { include: { invoiceItem: true } } } });
  const certId = cert.items[0].invoiceItem.data.batchNo === "AVVS1124011" ? cert.id : ctx.state.certificateIds.find((x) => x !== cert.id);
  const fields = await prisma.templateField.findMany({ where: { versionId: cert.templateVersionId } });
  const saved = () => page.waitForFunction(() => /^Saved/.test(document.querySelector('[data-testid="save-state"]')?.innerText || ""), { timeout: 30000 }).then(() => true, () => false);
  const version = async () => (await prisma.certificate.findUnique({ where: { id: certId } })).currentVersion;
  const frameText = () => page.evaluate(() => document.querySelector("iframe")?.contentDocument?.body?.innerText || "");

  await page.goto(`${FRONT}/certificates/${certId}`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.querySelector("[data-field]"), { timeout: 20000 });
  const titleText = await page.$eval('[data-testid="editor-title"]', (e) => e.innerText);
  assert("editor: title, status and version (B5)", titleText.includes("COA · ADD-E120") && /draft/i.test(titleText) && titleText.includes("v1"), titleText);
  assert("editor: the server render is in the sandboxed frame", (await frameText()).includes("AVVS1124011") && (await page.$eval("iframe", (f) => f.getAttribute("sandbox"))) === "allow-same-origin");
  const issues = await page.$eval('[data-testid="issues-left"]', (e) => e.innerText).catch(() => "");
  assert("finalize disabled, issues named under it", issues === "2 issues left" && (await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Finalize")?.disabled)), issues);
  assert("source chips shown (Invoice line · Batch number)", await waitForText("Invoice line · Batch number", 3000));
  await shot("p5-editor");
  await ctx.audit("certificate editor (B5)");

  // Esc reverts an input — nothing is saved
  const batchInput = await page.$('input[data-key="batch_no"]');
  await batchInput.click();
  await page.keyboard.type("ZZ");
  await page.keyboard.press("Escape");
  await sleep(1500);
  assert("Esc reverts the value; no new version", (await batchInput.evaluate((e) => e.value)) === "AVVS1124011" && (await version()) === 1);

  // fix the two missing values: instant (ephemeral) preview, then autosave → server render
  const missingKeys = fields.filter((f) => f.key !== "batch_no").map((f) => f.key);
  for (const key of missingKeys) {
    const sample = fields.find((f) => f.key === key).sampleValue;
    await page.click(`input[data-key="${key}"]`);
    await page.keyboard.type(sample);
  }
  const sample0 = fields.find((f) => f.key === missingKeys[0]).sampleValue;
  const instant = await page.evaluate((k) => document.querySelector("iframe").contentDocument.querySelector(`[data-field="${k}"]`)?.textContent, missingKeys[0]);
  assert("typing updates the field in the frame instantly", instant === sample0, instant);
  assert("autosave after 1 s → saved", await saved());
  await page.waitForFunction(() => !document.querySelector('[data-testid="issues-left"]'), { timeout: 15000 }).catch(() => {});
  assert("server re-rendered v2, issues gone, finalize enabled", (await version()) === 2 && !(await page.$('[data-testid="issues-left"]')) && (await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Finalize")?.disabled === false)));

  // someone else saves meanwhile → conflict dialog → overwrite with mine
  ctx.allowConsole.push(/status of 409 \(Conflict\)/); // the conflict below is deliberate
  const other = await api("PATCH", `/certificates/${certId}/values?companyId=${company.id}`, asAdmin, { expectedVersion: 2, changes: { batch_no: "AVVS1124011-B" } });
  assert("(another session saved v3)", other.status === 200, other.data);
  await page.click('input[data-key="batch_no"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type("AVVS1124011-C");
  await page.keyboard.down("Control");
  await page.keyboard.press("s");
  await page.keyboard.up("Control");
  assert("409 → conflict dialog (reload vs overwrite)", !!(await page.waitForSelector('[data-testid="conflict"]', { timeout: 10000 }).catch(() => null)));
  await shot("p5-conflict");
  await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="conflict"] button')).find((b) => b.innerText.includes("Overwrite"))?.click());
  await page.waitForFunction(() => !document.querySelector('[data-testid="conflict"]'), { timeout: 15000 }).catch(() => {});
  const row = await prisma.certificate.findUnique({ where: { id: certId }, include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } } });
  assert("overwrite saved mine as v4", row.currentVersion === 4 && row.versions[0].values.batch_no.value === "AVVS1124011-C", row.currentVersion);
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.body?.innerText.includes("AVVS1124011-C"), { timeout: 15000 }).catch(() => {});
  const v4Text = await frameText();
  await shot("p5-v4");
  assert("the frame shows the server render of v4", v4Text.includes("AVVS1124011-C"), v4Text.split("\n").filter((l) => /AVVS|Batch/i.test(l)));

  // versions: view an old one (read-only), restore it, restore the latest back
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.startsWith("Versions"))?.click());
  await page.waitForSelector('[data-testid="versions-drawer"]');
  assert("versions drawer lists 4", (await page.$$('[data-testid="versions-drawer"] li')).length === 4);
  await page.evaluate(() => Array.from(document.querySelectorAll('[data-version="1"] button')).find((b) => b.innerText === "View")?.click());
  assert("viewing v1: banner + read-only", (await waitForText("Viewing version 1 — read-only", 10000)) && (await page.$eval('input[data-key="batch_no"]', (e) => e.disabled)));
  await page.waitForFunction(() => document.querySelector("iframe")?.contentDocument?.body?.innerText.includes("AVVS1124011") && !document.querySelector("iframe").contentDocument.body.innerText.includes("AVVS1124011-C"), { timeout: 15000 }).catch(() => {});
  assert("the frame shows v1's stored HTML", !(await frameText()).includes("AVVS1124011-C"));
  await page.evaluate(() => Array.from(document.querySelectorAll('[data-version="2"] button')).find((b) => b.innerText === "Restore")?.click());
  await page.waitForFunction(() => document.querySelector('[data-testid="editor-title"]')?.innerText.includes("v5"), { timeout: 15000 }).catch(() => {});
  assert("restore v2 → v5 (forward-only)", (await version()) === 5 && (await page.$eval('input[data-key="batch_no"]', (e) => e.value)) === "AVVS1124011");
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Close")?.click());
  await shot("p5-restored");

  // export PDF → a real download with the certificate's name
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Export PDF")?.click());
  const pdfPath = await downloaded(/^COA-ADD-E120-AVVS1124011\.pdf$/);
  assert("Export PDF downloads COA-ADD-E120-AVVS1124011.pdf", !!pdfPath && fsMod.readFileSync(pdfPath).subarray(0, 5).toString() === "%PDF-", fsMod.readdirSync(downloads));

  // finalize → final, read-only; duplicate as draft
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Finalize")?.click());
  assert("finalize → final, read-only", (await waitForText("Final since", 20000)) && (await page.$eval('input[data-key="batch_no"]', (e) => e.disabled)));
  assert("DB: final with a frozen PDF", !!(await prisma.certificate.findUnique({ where: { id: certId } })).finalPdfFileId);
  await shot("p5-final");
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.trim() === "Duplicate as draft")?.click());
  await page.waitForFunction((id) => /\/certificates\/[0-9a-f-]{36}$/.test(location.pathname) && !location.pathname.endsWith(id), { timeout: 15000 }, certId).catch(() => {});
  await page.waitForFunction(() => /draft/i.test(document.querySelector('[data-testid="editor-title"]')?.innerText || ""), { timeout: 15000 }).catch(() => {});
  const dupState = { url: page.url(), title: await page.$eval('[data-testid="editor-title"]', (e) => e.innerText).catch(() => null), disabled: await page.$eval('input[data-key="batch_no"]', (e) => e.disabled).catch(() => "none") };
  assert("duplicate opens a new editable draft", !dupState.url.endsWith(certId) && /draft/i.test(dupState.title || "") && dupState.disabled === false, dupState);

  // batch ZIP from the invoice page
  await page.goto(`${FRONT}/invoices/${ctx.state.invoice.id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="batch-view"]', { timeout: 15000 });
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.innerText.includes("Download all (ZIP)"))?.click());
  const zipPath = await downloaded(/^certificates-INV-UI-1A\.zip$/);
  assert("batch: Download all (ZIP)", !!zipPath && fsMod.statSync(zipPath).size > 1000, fsMod.readdirSync(downloads));
  page.off("dialog", onDialog);
  fsMod.rmSync(downloads, { recursive: true, force: true });
}

export default [
  [1, phase1],
  [2, phase2],
  [3, phase3],
  [4, phase4],
  [5, phase5],
];
