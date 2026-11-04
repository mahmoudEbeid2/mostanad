// The new product modal part of ui-smoke.invoiceTypes.mjs (mockup D2). AI is off on the test
// stack, so "Suggest with AI" runs against a stubbed answer: d2.newProduct.test.js proves the
// server side with a stand-in model.
import { form } from "./helpers.js";

export async function registerNewProductSmoke({ page, A, T, chip, text, until, sleep, shot, assert, api, prisma, company, openReview, lines, fixture }) {
  console.log("\n🆕 D2 — new product from a line");
  const fd = form({ extract: "false", certificateTypeIds: "null" }, { field: "invoice", buffer: fixture("outlined_text.pdf"), name: "inv.pdf", type: "application/pdf" });
  const id = (await api("POST", "/invoices", A, fd)).data.data.invoiceId;
  await lines(id, [{ data: { name: "VITAMINOLL", batchNo: "S1" } }, { data: { name: "MULTIVIT AD3E FORTE 1L x12", code: "MV-1", batchNo: "M1", quantity: "120" } }]);
  await api("POST", `/invoices/${id}/rematch`, A);

  let aiOn = false;
  let failCreate = false;
  let suggested = null;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const json = (status, body) => req.respond({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) });
    if (url.includes("/ai-status") && req.method() === "GET" && aiOn) return json(200, { status: "success", data: { available: true } });
    if (url.includes("/new-product-suggest") && req.method() === "POST") {
      suggested = JSON.parse(req.postData());
      return json(200, {
        status: "success",
        data: {
          suggestions: [
            { path: "storage", label: "Storage", input: "long", value: "NOT THIS, IT WAS TYPED", estimated: true, reasoning: "r", confidence: 0.7, suggestionId: "00000000-0000-4000-8000-000000000001" },
            { path: "appearance", label: "Appearance", input: "text", value: "Clear yellow liquid", estimated: true, reasoning: "Usual for oral solutions", confidence: 0.7, suggestionId: "00000000-0000-4000-8000-000000000002" },
            { path: "origin", label: "Country of origin", input: "text", value: "Egypt", estimated: true, reasoning: "r", confidence: 0.7, suggestionId: "00000000-0000-4000-8000-000000000003" },
          ],
        },
      });
    }
    if (url.includes("/create-product") && req.method() === "POST" && failCreate) return json(422, { status: "fail", message: "The server says no" });
    return req.continue();
  });

  const row = (n) => `tr[data-line="${n}"]`;
  const modal = T("new-product-modal");
  const open = async () => {
    await page.click(`${row(2)} ${T("new-product")}`);
    await page.waitForSelector(`${modal} ${T("mode-needed")}`);
  };
  const fieldPaths = () => page.$$eval(`${T("product-fields")} [data-field]`, (l) => l.map((e) => e.dataset.field));
  const type = async (path, value) => {
    await page.click(`[data-field="${path}"] input, [data-field="${path}"] textarea`);
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.type(value);
  };
  const shownCount = (n) => until((sel, want) => document.querySelectorAll(sel).length === want, `${T("product-fields")} [data-field]`, n);
  const value = (path) => page.$eval(`[data-field="${path}"] input, [data-field="${path}"] textarea`, (e) => e.value);

  await openReview(id);
  await page.waitForSelector(T("type-chips"));
  assert("needs match: a + New product button", !!(await page.$(`${row(1)} ${T("new-product")}`)) && !!(await page.$(`${row(2)} ${T("new-product")}`)));

  console.log("\n🆕 Similar on the line");
  assert("a similar product is offered on the line", (await text(`${row(1)} ${T("similar-product")}`)).includes("Similar: Vitaminol"), await page.$eval(row(1), (e) => e.innerText));
  assert("no such link when nothing is close", !(await page.$(`${row(2)} ${T("similar-product")}`)));
  const productsBefore = await prisma.product.count({ where: { companyId: company.id } });
  await page.click(`${row(1)} ${T("use-similar")}`);
  await page.waitForFunction((s) => !document.querySelector(s), { timeout: 8000 }, `${row(1)} ${T("new-product")}`);
  assert("use it: the line is matched, nothing created", (await text(`${row(1)} [data-testid="matched-product"]`)) === "Vitaminol" && (await prisma.product.count({ where: { companyId: company.id } })) === productsBefore);

  console.log("\n🆕 Open, close");
  await open();
  assert("the title names the line", (await text(`${modal} h2`)) === "New product from line 2");
  assert("the grey line: invoice text · company", (await text(`${modal} h2 + p`)).startsWith("MULTIVIT AD3E FORTE 1L x12 · uid1"));
  assert("focus lands on Name", (await page.evaluate(() => document.activeElement?.id)) === "new-product-name");
  assert("Name is prefilled, without the pack size", (await page.$eval("#new-product-name", (e) => e.value)) === "MULTIVIT AD3E FORTE");
  assert("a dialog, modal", (await page.$eval(modal, (e) => `${e.getAttribute("role")}|${e.getAttribute("aria-modal")}`)) === "dialog|true");
  for (let i = 0; i < 16; i++) await page.keyboard.press("Tab");
  assert("Tab stays inside", await page.evaluate((m) => document.querySelector(m).contains(document.activeElement), modal));
  await page.keyboard.press("Escape");
  await page.waitForFunction((m) => !document.querySelector(m), { timeout: 3000 }, modal);
  assert("Esc closes and returns to the button", await page.evaluate((s) => document.activeElement === document.querySelector(s), `${row(2)} ${T("new-product")}`));
  await open();
  await page.click(`${modal} button[aria-label="Close"]`);
  assert("× closes", !(await page.$(modal)));

  console.log("\n🆕 Needed mode");
  await open();
  await shownCount(4);
  assert("only the required template fields", (await fieldPaths()).sort().join() === "appearance,origin,producer,storage", await fieldPaths());
  assert("no invoice box, notes or optional fields", !(await text(modal)).includes("Read from the invoice") && !(await text(modal)).includes("Dosage") && !(await text(modal)).includes("Batch"));
  assert("radio card counts them", (await text(T("mode-needed"))).includes("4 required fields for COA + FSC"), await text(T("mode-needed")));
  assert("heading with progress", (await text(T("fields-heading"))) === "Required for COA + FSC · 0 of 4 filled", await text(T("fields-heading")));
  assert("each tagged with its type, marked *", (await text('[data-field="storage"]')).includes("Storage *") && (await text('[data-field="storage"]')).includes("COA") && (await text('[data-field="producer"]')).includes("FSC"));
  assert("the button says so", (await text(T("create-product"))) === "Create product and match line 2");
  assert("remember is on by default", await page.$eval(T("remember-name"), (e) => e.checked));
  assert("AI off: no Suggest button", !(await page.$(T("suggest-ai"))));
  await type("storage", "Below 25 C");
  await until((s) => document.querySelector(s)?.innerText.includes("1 of 4"), T("fields-heading"));
  await shot("d2-modal");

  console.log("\n🆕 The chips drive the fields");
  await page.click(chip("FSC"));
  await shownCount(2);
  assert("FSC off: its fields go", (await fieldPaths()).sort().join() === "appearance,storage");
  assert("… the heading follows, what was typed stays", (await text(T("fields-heading"))) === "Required for COA · 1 of 2 filled" && (await value("storage")) === "Below 25 C", await text(T("fields-heading")));
  await page.click(chip("FSC"));
  await shownCount(4);
  assert("FSC on again: back", (await text(T("fields-heading"))) === "Required for COA + FSC · 1 of 4 filled");

  console.log("\n🆕 Full mode");
  await page.click(T("mode-full"));
  await page.waitForSelector('[data-field="mixingInstructions"]');
  const full = await fieldPaths();
  assert("code first, then the needed fields, optional included", full[0] === "productCode" && full.slice(1, 6).includes("dosage") && full.slice(1, 6).includes("storage"), full.slice(0, 7));
  assert("every other product field", full.length === 25 && full.includes("activeIngredients") && full.includes("registrationNumber"), full.length);
  assert("code and packaging are prefilled", (await value("productCode")) === "MV-1" && (await value("packaging")) === "1L x12");
  assert("registration placeholder", (await page.$eval('[data-field="registrationNumber"] input', (e) => e.placeholder)) === "From the official registry only");
  assert("the grey line", (await text(modal)).includes("Batch, quantity and dates stay on the invoice line; lab results go in the results grid."));
  assert("the button changes", (await text(T("create-product"))) === "Create full product and match line 2");
  const rows = () => page.$$eval('[data-field="activeIngredients"] input', (l) => l.length / 2);
  await page.evaluate(() => [...document.querySelectorAll('[data-field="activeIngredients"] button')].find((b) => b.innerText.includes("Add a row")).click());
  assert("composition: add a row", (await rows()) === 2, await rows());
  await page.click('[data-field="activeIngredients"] button[aria-label^="Remove"]');
  assert("composition: remove a row", (await rows()) === 1, await rows());
  await shot("d2-full");
  await page.click(T("mode-needed"));
  await shownCount(4);
  assert("back to needed: the same four, the value kept", (await fieldPaths()).length === 4 && (await value("storage")) === "Below 25 C");

  console.log("\n🆕 Suggest with AI");
  await page.keyboard.press("Escape");
  aiOn = true;
  await openReview(id);
  await open();
  await shownCount(4);
  assert("AI on: the button shows", !!(await page.$(T("suggest-ai"))));
  await type("storage", "Below 25 C");
  await page.click(T("suggest-ai"));
  await until((s) => document.querySelectorAll(s).length === 2, T("estimated-badge"));
  assert("the request carries the mode and what was typed", suggested.mode === "needed" && suggested.values.storage === "Below 25 C", suggested);
  assert("fills empty fields only", (await value("storage")) === "Below 25 C" && (await value("appearance")) === "Clear yellow liquid" && (await value("origin")) === "Egypt");
  assert("each one marked estimated, not the typed one", !(await page.$('[data-field="storage"] [data-testid="estimated-badge"]')) && !!(await page.$('[data-field="origin"] [data-testid="estimated-badge"]')));
  assert("nothing created yet", (await prisma.product.count({ where: { companyId: company.id } })) === productsBefore);
  await page.click('[data-field="origin"] input');
  await page.keyboard.type("!");
  await until((s) => !document.querySelector(s), `[data-field="origin"] ${T("estimated-badge")}`);
  assert("editing removes the badge", (await value("origin")) === "Egypt!");
  await shot("d2-suggested");

  console.log("\n🆕 Create");
  await type("producer", "Acme Labs");
  failCreate = true;
  await page.click(T("create-product"));
  await page.waitForSelector(T("new-product-error"));
  assert("the server's real error, in the modal", (await text(T("new-product-error"))) === "The server says no");
  assert("the form stays", !!(await page.$(modal)) && (await value("producer")) === "Acme Labs");
  failCreate = false;
  await type("origin", "Egypt");
  const planRows = () => page.$$eval(`${T("plan-preview")} .text-gray-900`, (l) => l.map((e) => e.innerText).join("|"));
  const planBefore = await planRows();
  await page.click(T("create-product"));
  await page.waitForFunction((m) => !document.querySelector(m), { timeout: 10000 }, modal);
  await until((s) => document.querySelector(s)?.innerText.includes("new product"), row(2));
  assert("the line: the product and the ✓ new product pill", (await text(row(2))).includes("✓ new product") && (await text(`${row(2)} [data-testid="matched-product"]`)) === "MULTIVIT AD3E FORTE");
  assert("the toast", await page.evaluate(() => document.body.innerText.includes("Product created and matched")));
  const made = await prisma.product.findFirst({ where: { companyId: company.id, name: "MULTIVIT AD3E FORTE" } });
  assert("saved with what the invoice said", made?.productCode === "MV-1" && made.packaging === "1L x12" && made.storage === "Below 25 C" && made.producer === "Acme Labs" && made.origin === "Egypt", { storage: made?.storage, producer: made?.producer, origin: made?.origin, packaging: made?.packaging });
  assert("the alias was remembered", !!(await prisma.productAlias.findFirst({ where: { companyId: company.id, productId: made.id } })));
  await page.waitForFunction((before, s) => [...document.querySelectorAll(s)].map((e) => e.innerText).join("|") !== before, { timeout: 8000 }, planBefore, `${T("plan-preview")} .text-gray-900`);
  assert("the plan preview follows", (await planRows()) !== planBefore, await planRows());
  await sleep(300);
  await shot("d2-done");
  await page.setRequestInterception(false);
}
