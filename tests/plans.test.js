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
let createdPlanId = null;

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

log("\n" + "═".repeat(62), "cyan");
log("  💳 MOSTANAD - SAAS PLAN ENDPOINTS TEST SUITE", "bold");
log("═".repeat(62) + "\n", "cyan");

// ─────────────────────────────────────────────────────
// 1. CREATE - Validation: empty body
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 1: POST /plans — Validation Error (empty body)", "bold");
{
  const { status, data } = await request("POST", "/plans", {});
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  assert("Message contains 'Validation error'", data?.message?.includes("Validation error"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 2. CREATE - Validation: bad interval
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 2: POST /plans — Validation Error (bad interval)", "bold");
{
  const { status, data } = await request("POST", "/plans", {
    name: "Standard Plan",
    price: 19.99,
    interval: "hourly",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Message mentions interval", data?.message?.toLowerCase().includes("interval"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 3. CREATE - Validation: negative price
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 3: POST /plans — Validation Error (negative price)", "bold");
{
  const { status, data } = await request("POST", "/plans", {
    name: "Standard Plan",
    price: -10,
    interval: "month",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Message mentions price", data?.message?.toLowerCase().includes("price"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 4. CREATE - Success (price as number)
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 4: POST /plans — Create plan with price as number (success)", "bold");
{
  const ts = Date.now();
  const { status, data } = await request("POST", "/plans", {
    name: `Basic Plan ${ts}`,
    description: "Ideal for individual creators",
    price: 9.99,
    interval: "month",
    features: ["10 templates", "PDF export"],
  });
  assert("Status is 201", status === 201, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Plan object returned", !!data?.data?.plan, JSON.stringify(data));
  assert("Plan has id", !!data?.data?.plan?.id, JSON.stringify(data?.data?.plan));
  assert("Plan features has elements", data?.data?.plan?.features?.length === 2, JSON.stringify(data?.data?.plan?.features));
  
  if (data?.data?.plan?.id) {
    createdPlanId = data.data.plan.id;
    log(`  Created plan ID: ${createdPlanId}`, "cyan");
  }
  log(`  Response: ${JSON.stringify(data?.data?.plan)}`, "white");
}

// ─────────────────────────────────────────────────────
// 5. CREATE - Success (price as valid numeric string)
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 5: POST /plans — Create plan with price as string (success)", "bold");
{
  const ts = Date.now();
  const { status, data } = await request("POST", "/plans", {
    name: `Premium Plan ${ts}`,
    description: "Ideal for teams",
    price: "29.99",
    interval: "month",
    features: ["Unlimited templates", "Custom Domain"],
  });
  assert("Status is 201", status === 201, `Got ${status}`);
  assert("Plan has id", !!data?.data?.plan?.id, JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data?.data?.plan)}`, "white");
}

// ─────────────────────────────────────────────────────
// 6. CREATE - Duplicate plan name
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 6: POST /plans — Duplicate plan name", "bold");
{
  const name = `Unique Plan ${Date.now()}`;
  await request("POST", "/plans", {
    name,
    price: 49.99,
    interval: "year",
  });
  const { status, data } = await request("POST", "/plans", {
    name,
    price: 49.99,
    interval: "year",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Error about plan name", data?.message?.toLowerCase().includes("taken"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 7. GET ALL - No filters
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 7: GET /plans — Get all plans", "bold");
{
  const { status, data } = await request("GET", "/plans");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Has meta object", !!data?.meta, JSON.stringify(data));
  assert("Has plans array", Array.isArray(data?.data?.plans), JSON.stringify(data));
  assert("meta has total", typeof data?.meta?.total === "number", JSON.stringify(data?.meta));
  log(`  Total plans: ${data?.meta?.total}`, "cyan");
}

// ─────────────────────────────────────────────────────
// 8. GET ALL - Pagination
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 8: GET /plans?page=1&limit=1 — Pagination", "bold");
{
  const { status, data } = await request("GET", "/plans?page=1&limit=1");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Max 1 plan returned", (data?.data?.plans?.length ?? 0) <= 1, `Got ${data?.data?.plans?.length}`);
  assert("Page is 1", data?.meta?.page === 1, JSON.stringify(data?.meta));
  assert("Limit is 1", data?.meta?.limit === 1, JSON.stringify(data?.meta));
  log(`  Returned ${data?.data?.plans?.length} plan(s)`, "cyan");
}

// ─────────────────────────────────────────────────────
// 9. GET ALL - Search
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 9: GET /plans?search=Individual — Search description", "bold");
{
  const { status, data } = await request("GET", "/plans?search=Individual");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Returns array", Array.isArray(data?.data?.plans), JSON.stringify(data));
  log(`  Search matched ${data?.data?.plans?.length} plan(s)`, "cyan");
}

// ─────────────────────────────────────────────────────
// 10. GET BY ID - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 10: GET /plans/:id — Get by ID (success)", "bold");
if (createdPlanId) {
  const { status, data } = await request("GET", `/plans/${createdPlanId}`);
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Plan ID matches", data?.data?.plan?.id === createdPlanId, JSON.stringify(data?.data?.plan));
  log(`  Plan: ${JSON.stringify(data?.data?.plan)}`, "white");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// 11. GET BY ID - Not found
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 11: GET /plans/:id — Not found", "bold");
{
  const { status, data } = await request("GET", "/plans/00000000-0000-0000-0000-000000000000");
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  assert("Message is 'Plan not found!'", data?.message === "Plan not found!", data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 12. GET BY ID - Invalid UUID
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 12: GET /plans/:id — Invalid UUID", "bold");
{
  const { status, data } = await request("GET", "/plans/not-a-uuid");
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Validation error", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 13. UPDATE - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 13: PATCH /plans/:id — Update (success)", "bold");
if (createdPlanId) {
  const { status, data } = await request("PATCH", `/plans/${createdPlanId}`, {
    name: "Basic Plan Updated",
    price: 12.99,
    isActive: false,
    features: ["15 templates", "PDF export", "Custom domains"],
  });
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Name was updated", data?.data?.plan?.name === "Basic Plan Updated", JSON.stringify(data?.data?.plan));
  assert("isActive was updated", data?.data?.plan?.isActive === false, JSON.stringify(data?.data?.plan));
  assert("Features were updated", data?.data?.plan?.features?.length === 3, JSON.stringify(data?.data?.plan?.features));
  log(`  Updated: ${JSON.stringify(data?.data?.plan)}`, "white");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// 14. UPDATE - Not found
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 14: PATCH /plans/:id — Not found", "bold");
{
  const { status, data } = await request("PATCH", "/plans/00000000-0000-0000-0000-000000000000", { name: "Nonexistent Plan" });
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 15. DELETE - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 15: DELETE /plans/:id — Delete (success)", "bold");
if (createdPlanId) {
  const { status } = await request("DELETE", `/plans/${createdPlanId}`);
  assert("Status is 204", status === 204, `Got ${status}`);
  log(`  Plan ${createdPlanId} deleted`, "cyan");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// 16. GET after DELETE - Should be 404
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 16: GET /plans/:id after delete — Should be 404", "bold");
if (createdPlanId) {
  const { status, data } = await request("GET", `/plans/${createdPlanId}`);
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────
log("\n" + "═".repeat(62), "cyan");
log(`  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`, passed === passed + failed ? "green" : "yellow");
log("═".repeat(62) + "\n", "cyan");

if (failed > 0) process.exit(1);
