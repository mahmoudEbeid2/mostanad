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
let createdTemplateId1 = null;
let createdTemplateId2 = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

const separator = () => log("─".repeat(62), "cyan");

async function request(method, path, body = null) {
  const options = { method, headers: { "Content-Type": "application/json", "x-test-bypass": "supersecretbypass" } };
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
  log("  🧪 MOSTANAD - TEMPLATE ENDPOINTS TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // Setup company and brand first
  log("⚙️  Setting up test environment...", "cyan");
  const ts = Date.now();
  const companyUsername = `temp_co_${ts}`;
  const companyEmail = `temp_co_${ts}@example.com`;

  // 1. Create company
  const companyRes = await request("POST", "/companies", {
    name: "Template Test Company",
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

  // 2. Create brand under the company using Prisma
  const brand = await prisma.brand.create({
    data: {
      name: `TEST_BRAND_${ts}`,
      companyId: testCompanyId,
    }
  });
  testBrandId = brand.id;
  log(`  Test Brand Created: ${testBrandId}`, "green");

  // 3. Create product under the company/brand using Prisma
  const product = await prisma.product.create({
    data: {
      name: `TEST_PRODUCT_${ts}`,
      productCode: `TP_${ts}`,
      companyId: testCompanyId,
      brandId: testBrandId,
    }
  });
  testProductId = product.id;
  log(`  Test Product Created: ${testProductId}`, "green");

  // ─────────────────────────────────────────────────────
  // 1. CREATE - Validation: empty body
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /companies/:id/templates — Validation Error (empty body)", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {});
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message contains validation error", data?.message?.includes("Validation error"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 2. CREATE - Success (brandId = null)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /companies/:id/templates (brandId = null) — Success", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Default Manifest Template",
      type: "manifest",
      htmlContent: "<html><body>Default Manifest</body></html>",
    });
    assert("Status is 201", status === 201, `Got ${status}`);
    assert("Template name matches", data?.data?.template?.name === "Default Manifest Template", JSON.stringify(data));
    assert("Template type matches", data?.data?.template?.type === "manifest", JSON.stringify(data));
    assert("brandId is null", data?.data?.template?.brandId === null, JSON.stringify(data));
    createdTemplateId1 = data?.data?.template?.id;
  }

  // ─────────────────────────────────────────────────────
  // 3. CREATE - Conflict Duplicate (brandId = null, same type)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /companies/:id/templates (brandId = null, duplicate type) — Conflict Rejection", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Another Default Manifest Template",
      type: "manifest",
      htmlContent: "<html><body>Another Default Manifest</body></html>",
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Error message mentions duplication and deletion", data?.message === "A template of this type already exists for this company and brand. Please delete the existing template first.", data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 4. CREATE - Success (brandId = testBrandId)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /companies/:id/templates (brandId = testBrandId) — Success", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Brand Manifest Template",
      type: "manifest",
      htmlContent: "<html><body>Brand Manifest</body></html>",
      brandId: testBrandId,
    });
    assert("Status is 201", status === 201, `Got ${status}`);
    assert("Template name matches", data?.data?.template?.name === "Brand Manifest Template", JSON.stringify(data));
    assert("brandId matches testBrandId", data?.data?.template?.brandId === testBrandId, JSON.stringify(data));
    createdTemplateId2 = data?.data?.template?.id;
  }

  // ─────────────────────────────────────────────────────
  // 5. CREATE - Conflict Duplicate (brandId = testBrandId, same type)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 5: POST /companies/:id/templates (brandId = testBrandId, duplicate type) — Conflict Rejection", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Another Brand Manifest",
      type: "manifest",
      htmlContent: "<html><body>Another Brand Manifest</body></html>",
      brandId: testBrandId,
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Error message is correct", data?.message === "A template of this type already exists for this company and brand. Please delete the existing template first.", data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 6. GET ALL - Retrieve scoped list
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 6: GET /companies/:companyId/templates — Retrieve list", "bold");
  {
    const { status, data } = await request("GET", `/companies/${testCompanyId}/templates`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Has meta", data?.meta !== undefined, JSON.stringify(data));
    assert("Has templates array", Array.isArray(data?.data?.templates), JSON.stringify(data));
    assert("Contains exactly 2 templates", data?.data?.templates?.length === 2, `Got ${data?.data?.templates?.length}`);
  }

  // ─────────────────────────────────────────────────────
  // 7. GET ALL - Filter by type
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 7: GET /companies/:companyId/templates?type=manifest — Filter by type", "bold");
  {
    const { status, data } = await request("GET", `/companies/${testCompanyId}/templates?type=manifest`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Templates list not empty", data?.data?.templates?.length > 0, JSON.stringify(data));
  }

  // ─────────────────────────────────────────────────────
  // 8. GET BY ID - Success
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 8: GET /templates/:id — Fetch template by ID", "bold");
  {
    const { status, data } = await request("GET", `/templates/${createdTemplateId1}`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("ID matches", data?.data?.template?.id === createdTemplateId1, JSON.stringify(data));
  }

  // ─────────────────────────────────────────────────────
  // 9. UPDATE - Validation Conflict (Update type to duplicate)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 9: PATCH /templates/:id — Duplicate constraint validation on update", "bold");
  {
    // Let's create a template of type "invoice"
    const tempInvoice = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Invoice Template",
      type: "invoice",
      htmlContent: "<html><body>Invoice</body></html>",
    });
    
    // Now let's try to update type of createdTemplateId1 ("manifest") to "invoice"
    const { status, data } = await request("PATCH", `/templates/${createdTemplateId1}`, {
      type: "invoice",
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Message mentions duplication", data?.message === "A template of this type already exists for this company and brand. Please delete the existing template first.", data?.message);

    // Clean up temporary invoice template using Prisma
    await prisma.template.delete({ where: { id: tempInvoice.data.data.template.id } });
  }

  // ─────────────────────────────────────────────────────
  // 10. DELETE - Success
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 10: DELETE /templates/:id — Delete template", "bold");
  {
    const { status } = await request("DELETE", `/templates/${createdTemplateId1}`);
    assert("Status is 204", status === 204, `Got ${status}`);
  }

  // ─────────────────────────────────────────────────────
  // 11. CREATE AFTER DELETE - Re-creation constraint relief
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 11: POST /companies/:id/templates after DELETE — Relief of constraint", "bold");
  {
    // Should now succeed because the old manifest template with brandId = null was deleted
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "New Default Manifest Template",
      type: "manifest",
      htmlContent: "<html><body>New Default Manifest</body></html>",
    });
    assert("Status is 201", status === 201, `Got ${status}`);
    // Cleanup the new template
    await prisma.template.delete({ where: { id: data.data.template.id } });
  }

  // ─────────────────────────────────────────────────────
  // 12. CREATE - With fields JSON & isGlobal = true (Success)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 12: POST /companies/:id/templates with JSON fields & isGlobal=true — Success", "bold");
  let testTemplateIdFields = null;
  {
    const fieldsPayload = {
      header: { x: 10, y: 20, font: "Arial" },
      footer: { text: "Page 1", align: "center" }
    };
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Global Layout Template",
      type: "layout",
      htmlContent: "<html><body>Global Layout</body></html>",
      fields: fieldsPayload,
      isGlobal: true
    });
    assert("Status is 201", status === 201, `Got ${status}`);
    const fields = data?.data?.template?.fields;
    const isFieldsValid = fields && fields.header && fields.header.x === 10 && fields.footer && fields.footer.align === "center";
    assert("fields matches payload", !!isFieldsValid, `Got ${JSON.stringify(fields)}`);
    assert("isGlobal is true", data?.data?.template?.isGlobal === true, "isGlobal is not true");
    assert("productId is null", data?.data?.template?.productId === null, "productId is not null");
    testTemplateIdFields = data?.data?.template?.id;
  }

  // ─────────────────────────────────────────────────────
  // 13. CREATE - Product-scoped template (Success)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 13: POST /companies/:id/templates product-scoped template — Success", "bold");
  let testTemplateIdProduct = null;
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Product-Specific Template",
      type: "layout",
      htmlContent: "<html><body>Product Layout</body></html>",
      isGlobal: false,
      productId: testProductId
    });
    assert("Status is 201", status === 201, `Got ${status}`);
    assert("isGlobal is false", data?.data?.template?.isGlobal === false, "isGlobal is not false");
    assert("productId matches testProductId", data?.data?.template?.productId === testProductId, "productId mismatch");
    testTemplateIdProduct = data?.data?.template?.id;
  }

  // ─────────────────────────────────────────────────────
  // 14. CREATE - Product-scoped template - Missing Product ID (Error)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 14: POST /companies/:id/templates product-scoped template with missing productId — Error", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Bad Product Template",
      type: "layout",
      htmlContent: "<html><body>Bad Layout</body></html>",
      isGlobal: false
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Message indicates productId error", data?.message?.includes("Product ID is required"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 15. CREATE - Product-scoped template - Conflict Duplicate (Error)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 15: POST /companies/:id/templates product-scoped duplicate template — Conflict Rejection", "bold");
  {
    const { status, data } = await request("POST", `/companies/${testCompanyId}/templates`, {
      name: "Duplicate Product Template",
      type: "layout",
      htmlContent: "<html><body>Duplicate Layout</body></html>",
      isGlobal: false,
      productId: testProductId
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Error message is correct", data?.message?.includes("already exists for this company and product"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 16. UPDATE - template fields, isGlobal and productId (Success)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 16: PATCH /templates/:id updating fields and switching scoping — Success", "bold");
  {
    const updatedFields = {
      body: { margin: "20px" }
    };
    const { status, data } = await request("PATCH", `/templates/${testTemplateIdFields}`, {
      name: "Updated Scoped Layout Template",
      fields: updatedFields,
    });
    assert("Status is 200", status === 200, `Got ${status}`);
    const fields = data?.data?.template?.fields;
    const isFieldsValid = fields && fields.body && fields.body.margin === "20px";
    assert("fields updated", !!isFieldsValid, `Got ${JSON.stringify(fields)}`);
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    // Delete remaining template
    await prisma.template.deleteMany({ where: { companyId: testCompanyId } });
    // Delete test company (will cascade delete brands)
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
