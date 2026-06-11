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
let testCategoryId = null;
let createdProductId = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

const separator = () => log("─".repeat(62), "cyan");

async function request(method, path, body = null) {
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

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

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  🧪 MOSTANAD - PRODUCT ENDPOINTS TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // Setup company and category first
  log("⚙️  Setting up test environment...", "cyan");
  const ts = Date.now();
  const companyUsername = `prod_co_${ts}`;
  const companyEmail = `prod_co_${ts}@example.com`;

  // 1. Create company
  const companyRes = await request("POST", "/companies", {
    name: "Product Test Company",
    username: companyUsername,
    password: "securepassword123",
    email: companyEmail,
  });

  if (companyRes.status !== 201 || !companyRes.data?.data?.company?.id) {
    log("  ❌ Setup failed: Could not create test company.", "red");
    process.exit(1);
  }
  testCompanyId = companyRes.data.data.company.id;
  log(`  Test Company Created: ${testCompanyId}`, "green");

  // 2. Create category in DB using Prisma
  const category = await prisma.category.create({
    data: { name: `TEST_CAT_${ts}` }
  });
  testCategoryId = category.id;
  log(`  Test Category Created: ${testCategoryId}`, "green");

  // ─────────────────────────────────────────────────────
  // 1. CREATE - Validation: empty body
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /companies/:id/products — Validation Error (empty body)", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/products`, {});
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message contains 'Validation error'", data?.message?.includes("Validation error"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 2. CREATE - Validation: invalid activeIngredients array
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /companies/:id/products — Validation Error (bad active ingredients)", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/products`, {
      name: "Bad Product",
      activeIngredients: [{ name: "Ingredient Without Concentration" }]
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Message mentions concentration", data?.message?.toLowerCase().includes("concentration"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 3. CREATE - Validation: bad specifications structure
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /companies/:id/products — Validation Error (bad specifications)", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/products`, {
      name: "Bad Specifications Product",
      specifications: { type: "Specification" } // values field missing
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Message mentions values", data?.message?.toLowerCase().includes("values"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 4. CREATE - Success with full fields
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /companies/:id/products — Create product successfully", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/products`, {
      name: "BROILER STARTER CONCENTRATE 5%",
      productCode: "BSC-005",
      description: "Starter concentrate for broilers",
      indications: "Improves early growth rate",
      targetSpecies: ["Broilers", "Poultry"],
      physicalForm: "Powder",
      appearance: "Brownish powder",
      activeIngredients: [
        { name: "L-Lysine", concentration: "98.5%" },
        { name: "DL-Methionine", concentration: "99.0%" }
      ],
      dosage: "50 kg per ton of feed",
      mixingInstructions: "Mix thoroughly with feed ingredients",
      withdrawalPeriod: "5 days",
      contraindications: "None",
      userSafety: ["Wear dust mask", "Avoid contact with skin"],
      storage: "Store in cool dry place",
      packaging: "25KG Bag",
      registrationNumber: "REG-9876",
      origin: "Egypt",
      producer: "Addvet Egypt",
      specifications: {
        type: "Specification Matrix",
        values: { Moisture: "max 12%", Purity: "min 98%" }
      },
      categoryId: testCategoryId
    });

    assert("Status is 201", status === 201, `Got ${status}`);
    assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
    assert("Product object returned", !!data?.data?.product, JSON.stringify(data));
    assert("Product has id", !!data?.data?.product?.id, JSON.stringify(data?.data?.product));
    assert("Category details included", data?.data?.product?.category?.name?.includes("TEST_CAT"), JSON.stringify(data?.data?.product?.category));
    assert("Active ingredients size matches", data?.data?.product?.activeIngredients?.length === 2, JSON.stringify(data?.data?.product?.activeIngredients));

    if (data?.data?.product?.id) {
      createdProductId = data.data.product.id;
      log(`  Created Product ID: ${createdProductId}`, "cyan");
    }
    log(`  Response: ${JSON.stringify(data?.data?.product)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 5. GET ALL - Scoped to company
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 5: GET /companies/:companyId/products — Get all company products", "bold");
  {
    const { status, data } = await request("GET", `/companies/${testCompanyId}/products`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Has meta", !!data?.meta, JSON.stringify(data));
    assert("Has products array", Array.isArray(data?.data?.products), JSON.stringify(data));
    assert("Products array is not empty", data?.data?.products?.length === 1, JSON.stringify(data));
    assert("Product matches created ID", data?.data?.products[0]?.id === createdProductId, JSON.stringify(data));
    log(`  Total products: ${data?.meta?.total}`, "cyan");
  }

  // ─────────────────────────────────────────────────────
  // 6. GET ALL - Search query
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 6: GET /companies/:companyId/products?search=starter — Search products", "bold");
  {
    const { status, data } = await request("GET", `/companies/${testCompanyId}/products?search=starter`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Match found", data?.data?.products?.length === 1, JSON.stringify(data));
    log(`  Search matched ${data?.data?.products?.length} products`, "cyan");
  }

  // ─────────────────────────────────────────────────────
  // 7. GET BY ID - Success
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 7: GET /products/:id — Get product by ID (success)", "bold");
  if (createdProductId) {
    const { status, data } = await request("GET", `/products/${createdProductId}`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Product ID matches", data?.data?.product?.id === createdProductId, JSON.stringify(data?.data?.product));
    assert("Category relation included", !!data?.data?.product?.category, JSON.stringify(data));
    log(`  Product: ${JSON.stringify(data?.data?.product)}`, "white");
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // ─────────────────────────────────────────────────────
  // 8. GET BY ID - Not found
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 8: GET /products/:id — Not found", "bold");
  {
    const { status, data } = await request("GET", "/products/00000000-0000-0000-0000-000000000000");
    assert("Status is 404", status === 404, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message is 'Product not found!'", data?.message === "Product not found!", data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 9. UPDATE - Success
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 9: PATCH /products/:id — Update product (success)", "bold");
  if (createdProductId) {
    const { status, data } = await request("PATCH", `/products/${createdProductId}`, {
      name: "BSC 5% Premium",
      physicalForm: "Granules",
      packaging: "50KG Bag",
      specifications: {
        type: "Specification Updated",
        values: { Moisture: "max 10%" }
      }
    });

    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
    assert("Name was updated", data?.data?.product?.name === "BSC 5% Premium", JSON.stringify(data?.data?.product));
    assert("Physical form was updated", data?.data?.product?.physicalForm === "Granules", JSON.stringify(data?.data?.product));
    assert("Packaging was updated", data?.data?.product?.packaging === "50KG Bag", JSON.stringify(data?.data?.product));
    assert("Specifications type updated", data?.data?.product?.specifications?.type === "Specification Updated", JSON.stringify(data?.data?.product?.specifications));
    log(`  Updated: ${JSON.stringify(data?.data?.product)}`, "white");
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // ─────────────────────────────────────────────────────
  // 10. DELETE - Success
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 10: DELETE /products/:id — Delete product (success)", "bold");
  if (createdProductId) {
    const { status } = await request("DELETE", `/products/${createdProductId}`);
    assert("Status is 204", status === 204, `Got ${status}`);
    log(`  Product ${createdProductId} deleted`, "cyan");
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // ─────────────────────────────────────────────────────
  // 11. GET after DELETE - Should be 404
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 11: GET /products/:id after delete — Should be 404", "bold");
  if (createdProductId) {
    const { status, data } = await request("GET", `/products/${createdProductId}`);
    assert("Status is 404", status === 404, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    log(`  Response: ${JSON.stringify(data)}`, "white");
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    // Delete test category
    await prisma.category.delete({ where: { id: testCategoryId } });
    // Delete test company
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
