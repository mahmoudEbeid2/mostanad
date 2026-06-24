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
let testBrandId = null;
let testProductId = null;
let mockInvoicePath = null;

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
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-bypass": "supersecretbypass"
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  🧪 MOSTANAD - CERTIFICATE AI GENERATION TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  const ts = Date.now();

  // 1. Setup Company
  log("⚙️  Creating test company...", "cyan");
  const companyRes = await request("POST", "/companies", {
    name: "Certificate Test Company",
    username: `cert_co_${ts}`,
    password: "securepassword123",
    email: `cert_co_${ts}@example.com`,
  });

  if (companyRes.status !== 201 || !companyRes.data?.data?.company?.id) {
    log("  ❌ Setup failed: Could not create test company.", "red");
    process.exit(1);
  }
  testCompanyId = companyRes.data.data.company.id;
  log(`  Test Company Created: ${testCompanyId}`, "green");

  // 2. Setup Brand
  const brand = await prisma.brand.create({
    data: {
      name: `TEST_BRAND_${ts}`,
      companyId: testCompanyId,
    }
  });
  testBrandId = brand.id;
  log(`  Test Brand Created: ${testBrandId}`, "green");

  // 3. Setup Product in database (to test database lookup/matching)
  const product = await prisma.product.create({
    data: {
      name: "H-VIRAL",
      productCode: "AVHHB18005",
      companyId: testCompanyId,
      brandId: testBrandId,
      activeIngredients: [
        { name: "Olive Leaves", concentration: "10%" },
        { name: "Sorbitol", concentration: "5%" }
      ],
      dosage: "1-2 ml per Litre"
    }
  });
  testProductId = product.id;
  log(`  Test DB Product 'H-VIRAL' Created: ${testProductId}`, "green");

  // 4. Setup Templates (one global, one product-scoped)
  const globalTemplate = await prisma.template.create({
    data: {
      name: "Global Shipping Certificate",
      type: "shipping",
      companyId: testCompanyId,
      brandId: testBrandId,
      isGlobal: true,
      htmlContent: "<html><body><h1>Shipping Certificate</h1><p>Invoice: {{invoiceNo}}</p><p>Date: {{invoiceDate}}</p><p>Sender: {{senderName}}</p></body></html>",
      fields: {
        invoiceNo: "Invoice Number",
        invoiceDate: "Invoice Date",
        senderName: "Sender Name"
      }
    }
  });
  log(`  Test Global Template Created: ${globalTemplate.id}`, "green");

  const productTemplate = await prisma.template.create({
    data: {
      name: "Product Analysis Certificate",
      type: "analysis",
      companyId: testCompanyId,
      brandId: testBrandId,
      isGlobal: false,
      htmlContent: "<html><body><h1>Analysis Report</h1><p>Product: {{productName}}</p><p>Ingredients: {{ingredients}}</p><p>Dosage: {{dosage}}</p><p>Expiry: {{expiry}}</p></body></html>",
      fields: {
        productName: "Product Name",
        ingredients: "Active Ingredients",
        dosage: "Standard Dosage",
        expiry: "Expiry Date"
      }
    }
  });
  log(`  Test Product-Scoped Template Created: ${productTemplate.id}`, "green");

  // 5. Copy Real PDF File for test
  mockInvoicePath = path.join(process.cwd(), `mock_invoice_${ts}.pdf`);
  const srcPdfPath = "C:/Users/ENG MAHMOUD/Downloads/10 - H-VIRAL_1L.pdf";
  fs.copyFileSync(srcPdfPath, mockInvoicePath);
  log(`  Copied real PDF document for testing to ${mockInvoicePath}`, "green");

  // ─────────────────────────────────────────────────────
  // 1. VALIDATION - Missing File
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /companies/:id/certificates/generate — Missing File", "bold");
  {
    const form = new FormData();
    form.append("transactionType", "shipping");

    const res = await fetch(`${BASE_URL}/companies/${testCompanyId}/certificates/generate`, {
      method: "POST",
      headers: {
        "x-test-bypass": "supersecretbypass"
      },
      body: form,
    });
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions file", data?.message?.includes("file"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 2. VALIDATION - Missing transactionType
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /companies/:id/certificates/generate — Missing transactionType", "bold");
  {
    const form = new FormData();
    const invoiceBuffer = fs.readFileSync(mockInvoicePath);
    const fileBlob = new Blob([invoiceBuffer], { type: "application/pdf" });
    form.append("invoice", fileBlob, "invoice.pdf");

    const res = await fetch(`${BASE_URL}/companies/${testCompanyId}/certificates/generate`, {
      method: "POST",
      headers: {
        "x-test-bypass": "supersecretbypass"
      },
      body: form,
    });
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message mentions validation error", data?.message?.includes("transactionType"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 3. SUCCESS PATH - Extract and Populate
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /companies/:id/certificates/generate — Success Path (Extraction & Population)", "bold");
  log("⏳ Sending mock invoice to Gemini AI... (takes 10-20 seconds)", "cyan");
  {
    const form = new FormData();
    const invoiceBuffer = fs.readFileSync(mockInvoicePath);
    const fileBlob = new Blob([invoiceBuffer], { type: "application/pdf" });
    form.append("invoice", fileBlob, "invoice.pdf");
    form.append("transactionType", "shipping");
    if (testBrandId) {
      form.append("brandId", testBrandId);
    }

    const res = await fetch(`${BASE_URL}/companies/${testCompanyId}/certificates/generate`, {
      method: "POST",
      headers: {
        "x-test-bypass": "supersecretbypass"
      },
      body: form,
    });
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    assert("Status is 202", status === 202, `Got ${status}`);
    assert("Status is 'accepted'", data?.status === "accepted", JSON.stringify(data));
    
    let results = null;
    if (status === 202 && data?.data?.jobId) {
      const jobId = data.data.jobId;
      log(`   [Test] Polling task status for job: ${jobId}`, "cyan");
      let task = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const checkRes = await fetch(`${BASE_URL}/background-tasks/${jobId}`, {
          headers: { "x-test-bypass": "supersecretbypass" }
        });
        const checkData = await checkRes.json();
        task = checkData?.data;
        if (task && (task.status === "completed" || task.status === "failed")) {
          break;
        }
      }
      assert("Task completed successfully", task?.status === "completed", `Status: ${task?.status}, Error: ${task?.error}`);
      results = task?.result;
    }

    assert("Has products array", Array.isArray(results?.products), JSON.stringify(results));
    assert("Extracted products contains H-VIRAL", results?.products?.some(p => p.name.toUpperCase().includes("H-VIRAL")), JSON.stringify(results?.products));
    assert("H-VIRAL exists in DB", results?.products?.find(p => p.name.toUpperCase().includes("H-VIRAL"))?.existsInDb === true, JSON.stringify(results?.products));

    assert("Has certificates array", Array.isArray(results?.certificates), JSON.stringify(results));
    
    // Check Global template population
    const globalCert = results?.certificates?.find(c => c.templateId === globalTemplate.id);
    assert("Global certificate populated", !!globalCert, "Global certificate not found");
    assert("Global certificate has invoiceNo filled/inferred", !!globalCert?.filledFields?.invoiceNo, JSON.stringify(globalCert?.filledFields));

    // Check Product-scoped template population
    const productCerts = results?.certificates?.filter(c => c.templateId === productTemplate.id);
    assert("Product certificates populated", productCerts?.length > 0, "No product certificates found");
    
    const hviralCert = productCerts?.find(c => c.productId === testProductId || c.productId?.toUpperCase() === "H-VIRAL");
    assert("H-VIRAL certificate generated", !!hviralCert, "H-VIRAL certificate not found");
    assert("H-VIRAL certificate has active ingredients from DB", JSON.stringify(hviralCert?.filledFields?.ingredients).toLowerCase().includes("olive"), JSON.stringify(hviralCert?.filledFields));
    assert("H-VIRAL certificate HTML contains H-VIRAL", hviralCert?.html?.includes("H-VIRAL"), hviralCert?.html);

    log(`  Response Details: ${JSON.stringify(results, null, 2)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database and test files...", "cyan");
  try {
    // Delete templates
    await prisma.template.deleteMany({ where: { companyId: testCompanyId } });
    // Delete product
    await prisma.product.deleteMany({ where: { companyId: testCompanyId } });
    // Delete company (cascades brand delete)
    await prisma.company.delete({ where: { id: testCompanyId } });
    
    if (fs.existsSync(mockInvoicePath)) {
      fs.unlinkSync(mockInvoicePath);
    }
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
  if (mockInvoicePath && fs.existsSync(mockInvoicePath)) {
    fs.unlinkSync(mockInvoicePath);
  }
  process.exit(1);
});
