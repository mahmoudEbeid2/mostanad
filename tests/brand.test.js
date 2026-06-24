import fs from "fs";
import path from "path";
import { prisma } from "../src/lib/prisma.js";

const BASE_URL = "http://localhost:3000/api/v1";
const STATIC_URL = "http://localhost:3000";

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
let uploadedLogoPath = null;

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
      "x-test-bypass": "supersecretbypass",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  📁 MOSTANAD - BRAND CRUD & LOGO UPLOAD TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // Create test company
  const ts = Date.now();
  log("⚙️ Creating a test company...", "cyan");
  const createCompanyRes = await request("POST", "/companies", {
    name: "Brand Test Company",
    username: `brand_co_${ts}`,
    password: "securepassword123",
    email: `brand_co_${ts}@example.com`,
  });

  if (createCompanyRes.status !== 201 || !createCompanyRes.data?.data?.company?.id) {
    log("  ❌ Failed to create test company. Exiting test.", "red");
    process.exit(1);
  }
  testCompanyId = createCompanyRes.data.data.company.id;
  log(`  Test Company Created: ${testCompanyId}`, "green");

  // 1. CREATE BRAND WITH LOGO
  separator();
  log("📋 TEST 1: POST /brands — Create Brand with Logo", "bold");
  {
    const mockLogoBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"); // 1x1 mock PNG
    const form = new FormData();
    form.append("name", "Araby Feed Brand");
    form.append("companyId", testCompanyId);
    form.append("logo", new Blob([mockLogoBuffer], { type: "image/png" }), "araby_logo.png");

    const res = await fetch(`${BASE_URL}/brands`, {
      method: "POST",
      headers: { "x-test-bypass": "supersecretbypass" },
      body: form,
    });

    const status = res.status;
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}

    assert("Status is 201", status === 201, `Got ${status}. Response: ${JSON.stringify(data)}`);
    assert("Status is success", data?.status === "success", JSON.stringify(data));
    assert("Brand has name", data?.data?.brand?.name === "Araby Feed Brand");
    assert("Brand has companyId", data?.data?.brand?.companyId === testCompanyId);
    assert("Brand has logoUrl", !!data?.data?.brand?.logoUrl, JSON.stringify(data?.data));

    if (data?.data?.brand) {
      testBrandId = data.data.brand.id;
      uploadedLogoPath = data.data.brand.logoUrl;
      log(`  Brand Created: ${testBrandId} with logo path: ${uploadedLogoPath}`, "green");
    }
  }

  // 2. GET ALL BRANDS
  separator();
  log("📋 TEST 2: GET /brands — List Brands", "bold");
  {
    const { status, data } = await request("GET", `/brands?companyId=${testCompanyId}`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Returns list of brands", Array.isArray(data?.data?.brands), JSON.stringify(data));
    assert("Includes created brand", data?.data?.brands?.some(b => b.id === testBrandId));
  }

  // 3. GET BRAND BY ID
  separator();
  log("📋 TEST 3: GET /brands/:id — Get Brand Details", "bold");
  {
    const { status, data } = await request("GET", `/brands/${testBrandId}`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Brand name matches", data?.data?.brand?.name === "Araby Feed Brand");
    assert("Includes company info", !!data?.data?.brand?.company?.name);
  }

  // 4. VERIFY LOGO STATIC HOSTING
  separator();
  log("📋 TEST 4: GET /uploads/brands/:filename — Verify Static Logo File Serving", "bold");
  if (uploadedLogoPath) {
    const staticRes = await fetch(`${STATIC_URL}/${uploadedLogoPath}`);
    assert("Logo file served successfully (Status 200)", staticRes.status === 200, `Got ${staticRes.status}`);
    assert("Content-Type is image/png", staticRes.headers.get("content-type") === "image/png", `Got ${staticRes.headers.get("content-type")}`);
  } else {
    log("  ⚠️ Skipped: No logo path to test", "yellow");
  }

  // 5. UPDATE BRAND (CHANGE LOGO)
  separator();
  log("📋 TEST 5: PATCH /brands/:id — Update Brand & Replace Logo", "bold");
  {
    const newLogoBuffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const form = new FormData();
    form.append("name", "Araby Feed Updated");
    form.append("logo", new Blob([newLogoBuffer], { type: "image/png" }), "araby_updated_logo.png");

    const res = await fetch(`${BASE_URL}/brands/${testBrandId}`, {
      method: "PATCH",
      headers: { "x-test-bypass": "supersecretbypass" },
      body: form,
    });

    const status = res.status;
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}

    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Name updated successfully", data?.data?.brand?.name === "Araby Feed Updated");
    assert("Logo path updated", data?.data?.brand?.logoUrl !== uploadedLogoPath);

    // Verify old file was deleted from disk
    if (uploadedLogoPath) {
      const oldFilePath = path.join(process.cwd(), uploadedLogoPath);
      assert("Old logo file deleted from disk", !fs.existsSync(oldFilePath), "Old logo still exists");
    }

    if (data?.data?.brand) {
      uploadedLogoPath = data.data.brand.logoUrl;
    }
  }

  // 6. DELETE BRAND
  separator();
  log("📋 TEST 6: DELETE /brands/:id — Delete Brand & Logo Clean Up", "bold");
  {
    const { status } = await request("DELETE", `/brands/${testBrandId}`);
    assert("Status is 204", status === 204, `Got ${status}`);

    // Verify file deleted
    if (uploadedLogoPath) {
      const filePath = path.join(process.cwd(), uploadedLogoPath);
      assert("Logo file deleted from disk on Brand deletion", !fs.existsSync(filePath), "Logo still exists");
    }
  }

  // CLEAN UP
  separator();
  log("🧹 Cleaning up database test records...", "cyan");
  try {
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
  else process.exit(0);
}

run().catch((err) => {
  log(`Fatal Error in test suite: ${err.message}`, "red");
  process.exit(1);
});
