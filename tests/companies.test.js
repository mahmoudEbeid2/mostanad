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
let createdCompanyId = null;

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

log("\n" + "═".repeat(62), "cyan");
log("  🏢 MOSTANAD - COMPANY ENDPOINTS TEST SUITE", "bold");
log("═".repeat(62) + "\n", "cyan");

// ─────────────────────────────────────────────────────
// 1. CREATE - Validation: empty body
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 1: POST /companies — Validation Error (empty body)", "bold");
{
  const { status, data } = await request("POST", "/companies", {});
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  assert("Message contains 'Validation error'", data?.message?.includes("Validation error"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 2. CREATE - Validation: bad email
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 2: POST /companies — Validation Error (bad email)", "bold");
{
  const { status, data } = await request("POST", "/companies", {
    name: "Test Co",
    username: "testco",
    password: "pass123",
    email: "not-an-email",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Message mentions email", data?.message?.toLowerCase().includes("email"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 3. CREATE - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 3: POST /companies — Create company (success)", "bold");
{
  const ts = Date.now();
  const { status, data } = await request("POST", "/companies", {
    name: "Addvet Egypt",
    username: `addvet_${ts}`,
    password: "securepass123",
    email: `addvet_${ts}@example.com`,
    phone: "0201234567",
    address: "Cairo, Egypt",
  });
  assert("Status is 201", status === 201, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Company object returned", !!data?.data?.company, JSON.stringify(data));
  assert("Password NOT in response", !data?.data?.company?.password, "Password was exposed!");
  assert("Company has id", !!data?.data?.company?.id, JSON.stringify(data?.data?.company));
  if (data?.data?.company?.id) {
    createdCompanyId = data.data.company.id;
    log(`  Created company ID: ${createdCompanyId}`, "cyan");
  }
  log(`  Response: ${JSON.stringify(data?.data?.company)}`, "white");
}

// ─────────────────────────────────────────────────────
// 4. CREATE - Duplicate username
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 4: POST /companies — Duplicate username", "bold");
{
  const username = `dupco_${Date.now()}`;
  await request("POST", "/companies", {
    name: "First Co",
    username,
    password: "pass123",
  });
  const { status, data } = await request("POST", "/companies", {
    name: "Second Co",
    username,
    password: "pass123",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Error about username", data?.message?.toLowerCase().includes("username"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 5. CREATE - Duplicate email
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 5: POST /companies — Duplicate email", "bold");
{
  const email = `dupemail_${Date.now()}@example.com`;
  await request("POST", "/companies", {
    name: "Co A",
    username: `coa_${Date.now()}`,
    password: "pass123",
    email,
  });
  const { status, data } = await request("POST", "/companies", {
    name: "Co B",
    username: `cob_${Date.now()}`,
    password: "pass123",
    email,
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Error about email", data?.message?.toLowerCase().includes("email"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 6. GET ALL - No filters
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 6: GET /companies — Get all companies", "bold");
{
  const { status, data } = await request("GET", "/companies");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Has meta object", !!data?.meta, JSON.stringify(data));
  assert("Has companies array", Array.isArray(data?.data?.companies), JSON.stringify(data));
  assert("meta has total", typeof data?.meta?.total === "number", JSON.stringify(data?.meta));
  assert("meta has totalPages", typeof data?.meta?.totalPages === "number", JSON.stringify(data?.meta));
  assert("No passwords in list", !data?.data?.companies?.some(c => c.password), "Password exposed in list!");
  log(`  Total companies: ${data?.meta?.total}`, "cyan");
}

// ─────────────────────────────────────────────────────
// 7. GET ALL - Pagination
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 7: GET /companies?page=1&limit=2 — Pagination", "bold");
{
  const { status, data } = await request("GET", "/companies?page=1&limit=2");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Max 2 companies returned", (data?.data?.companies?.length ?? 0) <= 2, `Got ${data?.data?.companies?.length}`);
  assert("Page is 1", data?.meta?.page === 1, JSON.stringify(data?.meta));
  assert("Limit is 2", data?.meta?.limit === 2, JSON.stringify(data?.meta));
  log(`  Returned ${data?.data?.companies?.length} company(s)`, "cyan");
}

// ─────────────────────────────────────────────────────
// 8. GET ALL - Search
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 8: GET /companies?search=addvet — Search", "bold");
{
  const { status, data } = await request("GET", "/companies?search=addvet");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Returns array", Array.isArray(data?.data?.companies), JSON.stringify(data));
  log(`  Search matched ${data?.data?.companies?.length} company(s)`, "cyan");
}

// ─────────────────────────────────────────────────────
// 9. GET BY ID - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 9: GET /companies/:id — Get by ID (success)", "bold");
if (createdCompanyId) {
  const { status, data } = await request("GET", `/companies/${createdCompanyId}`);
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Company ID matches", data?.data?.company?.id === createdCompanyId, JSON.stringify(data?.data?.company));
  assert("Password NOT in response", !data?.data?.company?.password, "Password exposed!");
  log(`  Company: ${JSON.stringify(data?.data?.company)}`, "white");
} else {
  log("  ⚠️  SKIPPED: No company was created in TEST 3", "yellow");
}

// ─────────────────────────────────────────────────────
// 10. GET BY ID - Not found
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 10: GET /companies/:id — Not found", "bold");
{
  const { status, data } = await request("GET", "/companies/00000000-0000-0000-0000-000000000000");
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  assert("Message is 'Company not found!'", data?.message === "Company not found!", data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 11. GET BY ID - Invalid UUID
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 11: GET /companies/:id — Invalid UUID", "bold");
{
  const { status, data } = await request("GET", "/companies/not-a-uuid");
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Validation error", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 12. UPDATE - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 12: PATCH /companies/:id — Update (success)", "bold");
if (createdCompanyId) {
  const { status, data } = await request("PATCH", `/companies/${createdCompanyId}`, {
    name: "Addvet Egypt Updated",
    isActive: false,
    address: "Alexandria, Egypt",
  });
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Name was updated", data?.data?.company?.name === "Addvet Egypt Updated", JSON.stringify(data?.data?.company));
  assert("isActive was updated", data?.data?.company?.isActive === false, JSON.stringify(data?.data?.company));
  assert("Address was updated", data?.data?.company?.address === "Alexandria, Egypt", JSON.stringify(data?.data?.company));
  assert("Password NOT in response", !data?.data?.company?.password, "Password exposed!");
  log(`  Updated: ${JSON.stringify(data?.data?.company)}`, "white");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// 13. UPDATE - Not found
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 13: PATCH /companies/:id — Not found", "bold");
{
  const { status, data } = await request("PATCH", "/companies/00000000-0000-0000-0000-000000000000", { name: "Updated Name" });
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 14. UPDATE - Invalid UUID
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 14: PATCH /companies/:id — Invalid UUID", "bold");
{
  const { status, data } = await request("PATCH", "/companies/bad-id", { name: "Valid Name" });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Validation error", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// 15. DELETE - Success
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 15: DELETE /companies/:id — Delete (success)", "bold");
if (createdCompanyId) {
  const { status } = await request("DELETE", `/companies/${createdCompanyId}`);
  assert("Status is 204", status === 204, `Got ${status}`);
  log(`  Company ${createdCompanyId} deleted`, "cyan");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// 16. GET after DELETE - Should be 404
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 16: GET /companies/:id after delete — Should be 404", "bold");
if (createdCompanyId) {
  const { status, data } = await request("GET", `/companies/${createdCompanyId}`);
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ─────────────────────────────────────────────────────
// 17. DELETE - Not found
// ─────────────────────────────────────────────────────
separator();
log("📋 TEST 17: DELETE /companies/:id — Not found", "bold");
{
  const { status, data } = await request("DELETE", "/companies/00000000-0000-0000-0000-000000000000");
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ─────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────
log("\n" + "═".repeat(62), "cyan");
log(`  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`, passed === passed + failed ? "green" : "yellow");
log("═".repeat(62) + "\n", "cyan");

if (failed > 0) process.exit(1);
