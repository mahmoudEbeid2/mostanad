import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/prisma.js";

const BASE_URL = "http://localhost:3000/api/v1";

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

let passed = 0;
let failed = 0;
let testProductId = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

const separator = () => log("─".repeat(62), "cyan");

function assert(label, condition, details = "") {
  if (condition) {
    log(`  ✅ PASS: ${label}`, "green");
    passed++;
  } else {
    log(`  ❌ FAIL: ${label}`, "red");
    if (details) log(`     → ${details}`, "yellow");
    failed++;
  }
}

// All requests go to /products/verify-label with bypass header
async function sendLabelRequest(formData) {
  const res = await fetch(`${BASE_URL}/products/verify-label`, {
    method: "POST",
    headers: { "x-test-bypass": "supersecretbypass" },
    body: formData,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  📁 MOSTANAD - AI MEDICINE LABEL VERIFICATION TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // ─────────────────────────────────────────────────────
  // TEST 1: Missing file
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /products/verify-label — Missing File", "bold");
  {
    const form = new FormData();
    form.append("country", "Saudi Arabia");
    const { status, data } = await sendLabelRequest(form);

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions file", data?.message?.toLowerCase().includes("file"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // TEST 2: Missing country
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /products/verify-label — Missing Country", "bold");
  {
    const form = new FormData();
    const mockPdf = Buffer.from("%PDF-1.4 mock label");
    form.append("label", new Blob([mockPdf], { type: "application/pdf" }), "mock.pdf");
    const { status, data } = await sendLabelRequest(form);

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions country", data?.message?.toLowerCase().includes("country"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // TEST 3: Full verification — product NOT in DB
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /products/verify-label — Compliance Check (Product NOT in DB)", "bold");

  // Resolve label PDF
  let labelPath = "C:/Users/ENG MAHMOUD/Downloads/10 - H-VIRAL_1L.pdf";
  if (!fs.existsSync(labelPath)) {
    const fallback1 = "D:/gemini_test/Addvet Feed Catalogue 2025.pdf";
    const fallback2 = "C:/Users/ENG MAHMOUD/Downloads/Addvet Feed Catalogue 2025.pdf";
    if (fs.existsSync(fallback1)) {
      labelPath = fallback1;
    } else if (fs.existsSync(fallback2)) {
      labelPath = fallback2;
    } else {
      // Write a minimal mock PDF
      labelPath = path.join(process.cwd(), "test_label_mock.pdf");
      fs.writeFileSync(
        labelPath,
        "%PDF-1.4\n1 0 obj\n<</Type /Catalog>>\nendobj\nProduct: H-VIRAL, Active: Olive Leaves 10%, Storage: Below 25C"
      );
    }
  }

  log(`  Using file: ${labelPath}`, "yellow");
  const labelBuffer = fs.readFileSync(labelPath);
  const labelBlob = new Blob([labelBuffer], { type: "application/pdf" });
  const labelName = path.basename(labelPath);

  log("⏳ Sending label to Gemini AI... (10-30 seconds)", "cyan");
  const t0 = Date.now();

  const form3 = new FormData();
  form3.append("label", labelBlob, labelName);
  form3.append("country", "Saudi Arabia");
  const { status: s3, data: d3 } = await sendLabelRequest(form3);

  log(`⏱️ Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`, "cyan");

  assert("Status is 200", s3 === 200, `Got ${s3}. Response: ${JSON.stringify(d3)}`);
  assert("Status is 'success'", d3?.status === "success", JSON.stringify(d3));
  assert("Has extractedDetails", !!d3?.data?.product?.extractedDetails?.name, JSON.stringify(d3?.data?.product));
  assert("existsInDb is boolean", typeof d3?.data?.product?.existsInDb === "boolean", "Expected boolean");
  assert("Has validation object", d3?.data?.validation?.results !== undefined, JSON.stringify(d3?.data?.validation));
  assert("Has results array", Array.isArray(d3?.data?.validation?.results), "Not an array");
  assert("checkedAgainstDb is boolean", typeof d3?.data?.validation?.checkedAgainstDb === "boolean", "Expected boolean");

  if (d3?.data?.validation?.results?.length > 0) {
    const r = d3.data.validation.results[0];
    assert("Result has 'issue'", !!r.issue, JSON.stringify(r));
    assert("Result has 'solution'", !!r.solution, JSON.stringify(r));
    assert("Result has 'category'", !!r.category, JSON.stringify(r));
  }

  const extractedName = d3?.data?.product?.extractedDetails?.name || "EXTRACTED_PRODUCT";
  log(`  Extracted Name: ${extractedName}`, "green");
  log(`  Compliant: ${d3?.data?.validation?.compliant}`, "green");
  log(`  Issues found: ${d3?.data?.validation?.results?.length}`, "green");

  // ─────────────────────────────────────────────────────
  // TEST 4: Full verification — product IS in DB
  //   Create the product then re-verify the same label
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /products/verify-label — Compliance Check (Product IN DB)", "bold");

  // Need a company to own the product (DB constraint)
  const ts = Date.now();
  const testCompany = await prisma.company.create({
    data: {
      name: `Label Test Co ${ts}`,
      username: `label_co_${ts}`,
      password: "hashed_test_password",
      email: `label_co_${ts}@test.com`,
    },
  });

  testProductId = (
    await prisma.product.create({
      data: {
        name: extractedName,
        companyId: testCompany.id,
        description: "Test product seeded for label verify test",
        activeIngredients: [
          { name: "Olive Leaves", concentration: "10%" },
          { name: "Sorbitol", concentration: "5%" },
        ],
        dosage: "1-2 ml per Litre of drinking water",
      },
    })
  ).id;

  log(`  Created test product in DB: ${testProductId}`, "green");
  log("⏳ Re-sending same label (DB match expected)...", "cyan");

  const t1 = Date.now();
  const form4 = new FormData();
  form4.append("label", labelBlob, labelName);
  form4.append("country", "Saudi Arabia");
  const { status: s4, data: d4 } = await sendLabelRequest(form4);
  log(`⏱️ Completed in ${((Date.now() - t1) / 1000).toFixed(1)}s`, "cyan");

  assert("Status is 200", s4 === 200, `Got ${s4}`);
  assert("existsInDb is true", d4?.data?.product?.existsInDb === true, "Expected true");
  assert("isExactMatch in product is true", d4?.data?.product?.isExactMatch === true, "Expected true");
  assert("isExactMatch in validation is true", d4?.data?.validation?.isExactMatch === true, "Expected true");
  assert("dbProduct returned", !!d4?.data?.product?.dbProduct, "dbProduct is null");
  assert("dbProduct.id matches", d4?.data?.product?.dbProduct?.id === testProductId, `Got ${d4?.data?.product?.dbProduct?.id}`);
  assert("checkedAgainstDb is true", d4?.data?.validation?.checkedAgainstDb === true, "Expected true");
  assert("dbProductName matches", d4?.data?.validation?.dbProductName === extractedName, `Got ${d4?.data?.validation?.dbProductName}`);
  assert("companyId NOT exposed", d4?.data?.product?.dbProduct?.companyId === undefined, "companyId should be stripped");
  assert("Results array present", Array.isArray(d4?.data?.validation?.results), "Not an array");

  log(`  DB match: "${d4?.data?.validation?.dbProductName}"`, "green");
  log(`  Issues found: ${d4?.data?.validation?.results?.length}`, "green");

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    if (testProductId) await prisma.product.delete({ where: { id: testProductId } });
    await prisma.company.delete({ where: { id: testCompany.id } });

    // Remove temp mock PDF if created
    const mockPath = path.join(process.cwd(), "test_label_mock.pdf");
    if (fs.existsSync(mockPath)) fs.unlinkSync(mockPath);

    log("  ✅ Cleanup completed.", "green");
  } catch (err) {
    log(`  ❌ Cleanup error: ${err.message}`, "red");
  }

  // SUMMARY
  log("\n" + "═".repeat(62), "cyan");
  log(
    `  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`,
    failed === 0 ? "green" : "red"
  );
  log("═".repeat(62) + "\n", "cyan");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  log(`Fatal Error: ${err.message}`, "red");
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
