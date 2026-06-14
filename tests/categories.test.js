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
  log("  📁 MOSTANAD - CATEGORY ENDPOINTS TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  const ts = Date.now();
  const catName1 = `TEST_CAT_1_${ts}`;
  const catName2 = `TEST_CAT_2_${ts}`;
  let categoryId1;
  let categoryId2;

  // ─────────────────────────────────────────────────────
  // 1. POST /categories - Validation Failures
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /categories — Validation Failures", "bold");
  {
    const resEmpty = await request("POST", "/categories", {});
    assert("Should return 400 for empty body", resEmpty.status === 400, `Got status ${resEmpty.status}`);
    assert("Mentions validation error", resEmpty.data?.message?.includes("Validation error"), JSON.stringify(resEmpty.data));
    assert("Mentions name is required", resEmpty.data?.message?.includes("expected string"), JSON.stringify(resEmpty.data));

    const resShort = await request("POST", "/categories", { name: "a" });
    assert("Should return 400 for name too short", resShort.status === 400, `Got status ${resShort.status}`);
    assert("Mentions min length error", resShort.data?.message?.includes("Name must be at least 2 characters"), JSON.stringify(resShort.data));
  }

  // ─────────────────────────────────────────────────────
  // 2. POST /categories - Create & Uniqueness
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /categories — Create & Uniqueness", "bold");
  {
    const res1 = await request("POST", "/categories", { name: catName1 });
    assert("Should create category successfully (201)", res1.status === 201, `Got status ${res1.status}. Error: ${JSON.stringify(res1.data)}`);
    assert("Status is success", res1.data?.status === "success");
    assert("Has category object", !!res1.data?.data?.category);
    assert("Category name is trimmed/saved correctly", res1.data?.data?.category?.name === catName1);
    
    categoryId1 = res1.data?.data?.category?.id;
    assert("Category has uuid", !!categoryId1);

    const resDuplicate = await request("POST", "/categories", { name: catName1 });
    assert("Should return 400 for duplicate name", resDuplicate.status === 400, `Got status ${resDuplicate.status}`);
    assert("Duplicate error message matches", resDuplicate.data?.message?.includes("already taken"), JSON.stringify(resDuplicate.data));

    // Create a second category for listing tests
    const res2 = await request("POST", "/categories", { name: catName2 });
    categoryId2 = res2.data?.data?.category?.id;
  }

  // ─────────────────────────────────────────────────────
  // 3. GET /categories - Listing, search & pagination
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: GET /categories — Listing & Filters", "bold");
  {
    const resAll = await request("GET", "/categories");
    assert("Should return 200", resAll.status === 200, `Got status ${resAll.status}`);
    assert("Includes meta object", !!resAll.data?.meta);
    assert("Returns categories list", Array.isArray(resAll.data?.data?.categories));
    assert("Total categories is correct", resAll.data?.meta?.total >= 2);

    // Search by name
    const resSearch = await request("GET", `/categories?search=${catName1}`);
    assert("Search status is 200", resSearch.status === 200, `Got status ${resSearch.status}`);
    assert("Search finds correct category", resSearch.data?.data?.categories?.length === 1);
    assert("Matched name", resSearch.data?.data?.categories?.[0]?.name === catName1);

    // Pagination
    const resPaged = await request("GET", `/categories?page=1&limit=1`);
    assert("Paged list size is 1", resPaged.data?.data?.categories?.length === 1);
    assert("Paged limit is 1", resPaged.data?.meta?.limit === 1);
  }

  // ─────────────────────────────────────────────────────
  // 4. GET /categories/:id - Get by ID
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: GET /categories/:id — Get by ID", "bold");
  {
    const res = await request("GET", `/categories/${categoryId1}`);
    assert("Should return 200", res.status === 200, `Got status ${res.status}`);
    assert("ID matches", res.data?.data?.category?.id === categoryId1);
    assert("Name matches", res.data?.data?.category?.name === catName1);

    const res404 = await request("GET", `/categories/00000000-0000-0000-0000-000000000000`);
    assert("Should return 404 for nonexistent UUID", res404.status === 404, `Got status ${res404.status}`);

    const res400 = await request("GET", `/categories/not-a-uuid`);
    assert("Should return 400 for invalid UUID", res400.status === 400, `Got status ${res400.status}`);
  }

  // ─────────────────────────────────────────────────────
  // 5. PATCH /categories/:id - Update name & uniqueness
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 5: PATCH /categories/:id — Update & Validation", "bold");
  {
    const updatedName = `${catName1}_UPDATED`;
    const res = await request("PATCH", `/categories/${categoryId1}`, { name: updatedName });
    assert("Should update name successfully (200)", res.status === 200, `Got status ${res.status}`);
    assert("Updated name matches", res.data?.data?.category?.name === updatedName);

    // Test unique constraint on update
    const resDuplicate = await request("PATCH", `/categories/${categoryId1}`, { name: catName2 });
    assert("Should fail with 400 when changing name to existing one", resDuplicate.status === 400, `Got status ${resDuplicate.status}`);
  }

  // ─────────────────────────────────────────────────────
  // 6. DELETE /categories/:id - Deletion checks & cascading
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 6: DELETE /categories/:id — Product association & deletion rules", "bold");
  let testCompanyId;
  let testProductId;
  try {
    // 1. Create a company to link the product to
    const company = await prisma.company.create({
      data: {
        name: `Category Test Co ${ts}`,
        username: `cat_test_co_${ts}`,
        password: "securepassword123",
      },
    });
    testCompanyId = company.id;

    // 2. Create a product associated with categoryId2
    const product = await prisma.product.create({
      data: {
        name: `Cat Test Product ${ts}`,
        companyId: testCompanyId,
        categoryId: categoryId2,
      },
    });
    testProductId = product.id;

    // 3. Try to delete categoryId2 -> should fail because it has associated products!
    const resDeleteFail = await request("DELETE", `/categories/${categoryId2}`);
    assert("Should block deleting category associated with active products (400)", resDeleteFail.status === 400, `Got status ${resDeleteFail.status}`);
    assert("Mentions active products in message", resDeleteFail.data?.message?.includes("associated with active products"), JSON.stringify(resDeleteFail.data));

    // 4. Clean up / delete the product first
    await prisma.product.delete({ where: { id: testProductId } });

    // 5. Try to delete categoryId2 again -> should succeed (204)
    const resDeleteSuccess = await request("DELETE", `/categories/${categoryId2}`);
    assert("Should delete category successfully when no products are associated (204)", resDeleteSuccess.status === 204, `Got status ${resDeleteSuccess.status}`);

    // 6. Check that GET returns 404
    const resCheck = await request("GET", `/categories/${categoryId2}`);
    assert("Should return 404 for deleted category", resCheck.status === 404, `Got status ${resCheck.status}`);

  } catch (err) {
    log(`  ❌ Test 6 execution failed: ${err.message}`, "red");
    failed++;
  } finally {
    // Clean up test company and products if any remaining
    if (testProductId) {
      try { await prisma.product.delete({ where: { id: testProductId } }); } catch (_) {}
    }
    if (testCompanyId) {
      try { await prisma.company.delete({ where: { id: testCompanyId } }); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    await prisma.category.deleteMany({
      where: {
        id: { in: [categoryId1, categoryId2] },
      },
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
