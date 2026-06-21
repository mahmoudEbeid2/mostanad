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
let testCompanyId = null;
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

async function request(method, path, body = null) {
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  📁 MOSTANAD - AI MEDICINE LABEL VERIFICATION TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // Create test company
  const ts = Date.now();
  const companyUsername = `label_co_${ts}`;
  const companyEmail = `label_co_${ts}@example.com`;

  log("⚙️  Creating a test company...", "cyan");
  const createCompanyRes = await request("POST", "/companies", {
    name: "Label Test Company",
    username: companyUsername,
    password: "securepassword123",
    email: companyEmail,
  });

  if (createCompanyRes.status !== 201 || !createCompanyRes.data?.data?.company?.id) {
    log("  ❌ Failed to create test company. Exiting test.", "red");
    process.exit(1);
  }

  testCompanyId = createCompanyRes.data.data.company.id;
  log(`  Test Company Created: ${testCompanyId}`, "green");

  // ─────────────────────────────────────────────────────
  // 1. VERIFY LABEL - Validation: missing file
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /companies/:id/products/verify-label — Missing File", "bold");
  {
    const form = new FormData();
    form.append("country", "Saudi Arabia");

    const res = await fetch(`${BASE_URL}/companies/${testCompanyId}/products/verify-label`, {
      method: "POST",
      body: form,
    });
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions file", data?.message?.toLowerCase().includes("file"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 2. VERIFY LABEL - Validation: missing country
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /companies/:id/products/verify-label — Missing Country", "bold");
  {
    const form = new FormData();
    const mockPdf = Buffer.from("%PDF-1.4 ... mock pdf text label info here ...");
    const blob = new Blob([mockPdf], { type: "application/pdf" });
    form.append("label", blob, "mock_label.pdf");

    const res = await fetch(`${BASE_URL}/companies/${testCompanyId}/products/verify-label`, {
      method: "POST",
      body: form,
    });
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions country", data?.message?.toLowerCase().includes("country"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 3. VERIFY LABEL - Validation: nonexistent company
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /companies/:id/products/verify-label — Nonexistent Company", "bold");
  {
    const form = new FormData();
    const mockPdf = Buffer.from("%PDF-1.4 ... mock pdf label details ...");
    const blob = new Blob([mockPdf], { type: "application/pdf" });
    form.append("label", blob, "mock_label.pdf");
    form.append("country", "Saudi Arabia");

    const res = await fetch(`${BASE_URL}/companies/00000000-0000-0000-0000-000000000000/products/verify-label`, {
      method: "POST",
      body: form,
    });
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    assert("Status is 404", status === 404, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions company", data?.message?.toLowerCase().includes("company"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 4. VERIFY LABEL - Success path (Product not in DB)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /companies/:id/products/verify-label — Compliance Check (Product not in DB)", "bold");
  
  // Find a test PDF or image
  let labelPath = "C:/Users/ENG MAHMOUD/Downloads/10 - H-VIRAL_1L.pdf";
  let labelMime = "application/pdf";
  let labelName = "10 - H-VIRAL_1L.pdf";

  if (!fs.existsSync(labelPath)) {
    // Try fallback paths
    const fallbackPath1 = "D:/gemini_test/Addvet Feed Catalogue 2025.pdf";
    const fallbackPath2 = "C:/Users/ENG MAHMOUD/Downloads/Addvet Feed Catalogue 2025.pdf";
    if (fs.existsSync(fallbackPath1)) {
      labelPath = fallbackPath1;
      labelName = "Addvet Feed Catalogue 2025.pdf";
    } else if (fs.existsSync(fallbackPath2)) {
      labelPath = fallbackPath2;
      labelName = "Addvet Feed Catalogue 2025.pdf";
    } else {
      // Create a mock PDF
      labelPath = path.join(process.cwd(), "test_label_mock.pdf");
      fs.writeFileSync(labelPath, "%PDF-1.4\n%...\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n...\nText content: ADDVET L-LYSINE feed additive, storage below 25C, manufacturer Afaq Additives, Jordan.");
      labelName = "test_label_mock.pdf";
    }
  }

  log(`Using file: ${labelPath}`, "yellow");
  const labelBuffer = fs.readFileSync(labelPath);
  const fileBlob = new Blob([labelBuffer], { type: labelMime });

  log("⏳ Sending label to Gemini AI for verification... (takes 10-20 seconds)", "cyan");
  const startTime = Date.now();
  
  const form = new FormData();
  form.append("label", fileBlob, labelName);
  form.append("country", "Saudi Arabia");

  const verifyRes = await fetch(`${BASE_URL}/companies/${testCompanyId}/products/verify-label`, {
    method: "POST",
    body: form,
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const verifyStatus = verifyRes.status;
  let verifyData = null;
  try { verifyData = await verifyRes.json(); } catch (_) {}

  log(`⏱️ Request completed in ${duration} seconds.`, "cyan");

  assert("Status is 200", verifyStatus === 200, `Got ${verifyStatus}. Response: ${JSON.stringify(verifyData)}`);
  assert("Status is 'success'", verifyData?.status === "success", JSON.stringify(verifyData));
  
  let extractedProductName = "";
  if (verifyStatus === 200 && verifyData?.data) {
    const data = verifyData.data;
    assert("Contains product extracted details", !!data.product?.extractedDetails?.name, "Missing extractedDetails.name");
    assert("existsInDb is false", data.product?.existsInDb === false, "Expected existsInDb to be false");
    assert("dbProduct is null", data.product?.dbProduct === null, "Expected dbProduct to be null");
    assert("Contains validation", data.validation?.compliant !== undefined, "Missing validation.compliant");
    assert("Contains results list", Array.isArray(data.validation?.results), "Missing validation.results array");
    if (Array.isArray(data.validation?.results) && data.validation.results.length > 0) {
      assert("Result object contains issue", data.validation.results[0].issue !== undefined, "Missing result.issue");
      assert("Result object contains solution", data.validation.results[0].solution !== undefined, "Missing result.solution");
    }

    extractedProductName = data.product?.extractedDetails?.name || "EXTRACTED_PRODUCT";
    log(`  Extracted Product Name: ${extractedProductName}`, "green");
    log(`  Validation compliance: ${data.validation?.compliant}`, "green");
    log(`  Results count: ${data.validation?.results?.length}`, "green");

    // ─────────────────────────────────────────────────────
    // 5. VERIFY LABEL - Success path (Product in DB)
    // ─────────────────────────────────────────────────────
    separator();
    log("📋 TEST 5: POST /companies/:id/products/verify-label — Compliance Check (Product in DB)", "bold");
    
    // Create the product in DB under the company
    log(`⚙️ Creating product "${extractedProductName}" in database...`, "cyan");
    const createdProduct = await prisma.product.create({
      data: {
        name: extractedProductName,
        companyId: testCompanyId,
        description: "Pre-existing test product in DB",
        origin: "JORDAN",
      }
    });
    testProductId = createdProduct.id;
    log(`  Product created with ID: ${testProductId}`, "green");

    // Send the verify-label request again
    log("⏳ Sending label again to check DB product matching...", "cyan");
    const verifyRes2 = await fetch(`${BASE_URL}/companies/${testCompanyId}/products/verify-label`, {
      method: "POST",
      body: form,
    });
    const verifyStatus2 = verifyRes2.status;
    let verifyData2 = null;
    try { verifyData2 = await verifyRes2.json(); } catch (_) {}

    assert("Status is 200", verifyStatus2 === 200, `Got ${verifyStatus2}`);
    assert("existsInDb is true", verifyData2?.data?.product?.existsInDb === true, "Expected existsInDb to be true");
    assert("dbProduct matches database record", verifyData2?.data?.product?.dbProduct?.id === testProductId, `Expected ${testProductId}, got ${verifyData2?.data?.product?.dbProduct?.id}`);

    // ─────────────────────────────────────────────────────
    // 6. VERIFY LABEL - General endpoint (No companyId)
    // ─────────────────────────────────────────────────────
    separator();
    log("📋 TEST 6: POST /products/verify-label — General Endpoint (No companyId)", "bold");
    
    const formGeneral = new FormData();
    formGeneral.append("label", fileBlob, labelName);
    formGeneral.append("country", "Saudi Arabia");

    log("⏳ Sending label to general endpoint...", "cyan");
    const verifyRes3 = await fetch(`${BASE_URL}/products/verify-label`, {
      method: "POST",
      body: formGeneral,
    });
    const verifyStatus3 = verifyRes3.status;
    let verifyData3 = null;
    try { verifyData3 = await verifyRes3.json(); } catch (_) {}

    assert("Status is 200", verifyStatus3 === 200, `Got ${verifyStatus3}`);
    assert("existsInDb is true (global match)", verifyData3?.data?.product?.existsInDb === true, "Expected global match to be true");
    assert("dbProduct matches database record", verifyData3?.data?.product?.dbProduct?.id === testProductId, `Expected ${testProductId}`);
    assert("companyId is NOT present in dbProduct response", verifyData3?.data?.product?.dbProduct?.companyId === undefined, "companyId should be stripped for external route");

    // ─────────────────────────────────────────────────────
    // 7. VERIFY LABEL - General endpoint with companyId in body (should be stripped/ignored)
    // ─────────────────────────────────────────────────────
    separator();
    log("📋 TEST 7: POST /products/verify-label — General Endpoint with companyId in Body (Stripped)", "bold");
    
    const formGeneralWithCompany = new FormData();
    formGeneralWithCompany.append("label", fileBlob, labelName);
    formGeneralWithCompany.append("country", "Saudi Arabia");
    formGeneralWithCompany.append("companyId", testCompanyId);

    log("⏳ Sending label to general endpoint with companyId...", "cyan");
    const verifyRes4 = await fetch(`${BASE_URL}/products/verify-label`, {
      method: "POST",
      body: formGeneralWithCompany,
    });
    const verifyStatus4 = verifyRes4.status;
    let verifyData4 = null;
    try { verifyData4 = await verifyRes4.json(); } catch (_) {}

    assert("Status is 200", verifyStatus4 === 200, `Got ${verifyStatus4}`);
    assert("existsInDb is true", verifyData4?.data?.product?.existsInDb === true, "Expected existsInDb to be true");
    assert("dbProduct matches database record", verifyData4?.data?.product?.dbProduct?.id === testProductId, `Expected ${testProductId}`);
    assert("companyId is NOT present in dbProduct response (even if passed)", verifyData4?.data?.product?.dbProduct?.companyId === undefined, "companyId should be stripped");
  }

  // Cleanup temp files
  if (labelName === "test_label_mock.pdf" && fs.existsSync(labelPath)) {
    try { fs.unlinkSync(labelPath); } catch (_) {}
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP DATABASE
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    if (testProductId) {
      await prisma.product.delete({ where: { id: testProductId } });
    }
    await prisma.company.delete({ where: { id: testCompanyId } });
    log("  ✅ Cleanup completed successfully.", "green");
  } catch (err) {
    log(`  ❌ Error during cleanup: ${err.message}`, "red");
  }

  // SUMMARY
  log("\n" + "═".repeat(62), "cyan");
  log(`  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`, passed === passed + failed && failed === 0 ? "green" : "red");
  log("═".repeat(62) + "\n", "cyan");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  log(`Fatal Error in test suite: ${err.message}`, "red");
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
