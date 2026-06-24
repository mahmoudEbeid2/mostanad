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
  const options = { method, headers: { "Content-Type": "application/json", "x-test-bypass": "supersecretbypass" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  📁 MOSTANAD - PDF CATALOG IMPORT TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // Create test company
  const ts = Date.now();
  const companyUsername = `catalog_co_${ts}`;
  const companyEmail = `catalog_co_${ts}@example.com`;

  log("⚙️  Creating a test company...", "cyan");
  const createCompanyRes = await request("POST", "/companies", {
    name: "Catalog Test Company",
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
  // 1. UPLOAD CATALOG - Validation: no file
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /products/upload-catalog — Missing File", "bold");
  {
    const form = new FormData();
    const res = await fetch(`${BASE_URL}/products/upload-catalog?companyId=${testCompanyId}`, {
      method: "POST",
      headers: { "x-test-bypass": "supersecretbypass" },
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
  // 2. UPLOAD CATALOG - Validation: nonexistent company
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /products/upload-catalog — Nonexistent Company", "bold");
  {
    const testPdfPath = "D:/gemini_test/Addvet Feed Catalogue 2025.pdf";
    if (!fs.existsSync(testPdfPath)) {
      log(`  ⚠️ Skipped: Local test PDF not found at ${testPdfPath}`, "yellow");
    } else {
      const fileBuffer = fs.readFileSync(testPdfPath);
      const form = new FormData();
      const blob = new Blob([fileBuffer], { type: "application/pdf" });
      form.append("catalog", blob, "Addvet Feed Catalogue 2025.pdf");

      const res = await fetch(`${BASE_URL}/products/upload-catalog?companyId=00000000-0000-0000-0000-000000000000`, {
        method: "POST",
        headers: { "x-test-bypass": "supersecretbypass" },
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
  }

  // ─────────────────────────────────────────────────────
  // 3. UPLOAD CATALOG - Success (using Gemini 2.5 Flash)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /products/upload-catalog — Successful PDF Catalog Process", "bold");
  const testPdfPath = "D:/gemini_test/Addvet Feed Catalogue 2025.pdf";
  if (!fs.existsSync(testPdfPath)) {
    log(`  ⚠️ Cannot run integration upload test: Local PDF not found at ${testPdfPath}`, "red");
  } else {
    log("⏳ Sending PDF to Gemini 2.5 Flash via File API... (this may take up to 20-30 seconds)", "cyan");
    const fileBuffer = fs.readFileSync(testPdfPath);
    const form = new FormData();
    const blob = new Blob([fileBuffer], { type: "application/pdf" });
    form.append("catalog", blob, "Addvet Feed Catalogue 2025.pdf");

    const startTime = Date.now();
    const res = await fetch(`${BASE_URL}/products/upload-catalog?companyId=${testCompanyId}`, {
      method: "POST",
      headers: { "x-test-bypass": "supersecretbypass" },
      body: form,
    });
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const status = res.status;
    let data = null;
    try { data = await res.json(); } catch (_) {}

    log(`⏱️ Request completed in ${duration} seconds.`, "cyan");

    assert("Status is 202", status === 202, `Got ${status}. Response: ${JSON.stringify(data)}`);
    assert("Status is 'accepted'", data?.status === "accepted", JSON.stringify(data));
    assert("Contains jobId", !!data?.data?.jobId, JSON.stringify(data?.data));
    
    if (status === 202 && data?.data?.jobId) {
      const jobId = data.data.jobId;
      log(`⏳ Polling task status for job: ${jobId}`, "cyan");
      
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
      
      if (task?.status === "completed" && task.result) {
        const result = task.result;
        log(`  Extracted ${result.totalProductsExtracted} products!`, "green");
        log(`  Categories Created: ${result.categoriesCreated}`, "green");
        log(`  Categories Reused: ${result.categoriesReused}`, "green");

      // Verify records in DB
      const dbProducts = await prisma.product.findMany({
        where: { companyId: testCompanyId },
        include: { category: true }
      });

      assert("Products exist in database", dbProducts.length > 0, `Expected > 0, got ${dbProducts.length}`);
      
      if (dbProducts.length > 0) {
        log(`  Verified in database: Found ${dbProducts.length} products associated with company in DB!`, "green");
        
        // Print sample product info
        const sample = dbProducts[0];
        log(`  Sample product extracted:`, "bold");
        log(`    - Name: ${sample.name}`, "white");
        log(`    - Category: ${sample.category?.name || "None"}`, "white");
        log(`    - Physical Form: ${sample.physicalForm || "N/A"}`, "white");
        log(`    - Packaging: ${sample.packaging || "N/A"}`, "white");
        
        // Verify category uniqueness logic is active
        assert("Category resolved correctly", !!sample.categoryId, "Category ID was not linked");
      }
    }
  }
}


  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    // Delete test products
    await prisma.product.deleteMany({
      where: { companyId: testCompanyId },
    });
    // Delete test company
    await prisma.company.delete({
      where: { id: testCompanyId },
    });
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
