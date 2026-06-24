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
let createdUserId = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

const separator = () =>
  log("─".repeat(60), "cyan");

async function request(method, path, body = null) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-bypass": "supersecretbypass"
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

// ═══════════════════════════════════════════════
log("\n" + "═".repeat(60), "cyan");
log("  🚀 MOSTANAD - USER ENDPOINTS TEST SUITE", "bold");
log("═".repeat(60) + "\n", "cyan");

// ═══════════════════════════════════════════════
// 1. CREATE USER - Validation Error (empty body)
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 1: POST /users — Validation Error (empty body)", "bold");
{
  const { status, data } = await request("POST", "/users", {});
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  assert("Message contains 'Validation error'", data?.message?.includes("Validation error"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// 2. CREATE USER - Invalid email
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 2: POST /users — Validation Error (bad email)", "bold");
{
  const { status, data } = await request("POST", "/users", {
    name: "Test",
    email: "not-an-email",
    username: "test_user",
    password: "pass123",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Message mentions email", data?.message?.toLowerCase().includes("email"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// 3. CREATE USER - Success
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 3: POST /users — Create user (success)", "bold");
{
  const { status, data } = await request("POST", "/users", {
    name: "Mahmoud Ebeid",
    email: `test_${Date.now()}@mostanad.com`,
    username: `user_${Date.now()}`,
    password: "securepass123",
    phone: "01012345678",
  });
  assert("Status is 201", status === 201, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("User object returned", !!data?.data?.user, JSON.stringify(data));
  assert("Password NOT in response", !data?.data?.user?.password, "Password was exposed!");
  assert("User has id", !!data?.data?.user?.id, JSON.stringify(data?.data?.user));
  if (data?.data?.user?.id) {
    createdUserId = data.data.user.id;
    log(`  Created user ID: ${createdUserId}`, "cyan");
  }
  log(`  Response: ${JSON.stringify(data?.data?.user)}`, "white");
}

// ═══════════════════════════════════════════════
// 3b. CREATE USER - Success (Automatic Username and Password generation)
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 3b: POST /users — Create user with automatic username/password (success)", "bold");
{
  const emailPrefix = `autogen_${Date.now()}`;
  const email = `${emailPrefix}@mostanad.com`;
  const { status, data } = await request("POST", "/users", {
    name: "Autogen User",
    email,
    phone: "01099998888",
  });
  assert("Status is 201", status === 201, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("User object returned", !!data?.data?.user, JSON.stringify(data));
  assert("Username generated from email", data?.data?.user?.username === emailPrefix, `Expected ${emailPrefix}, got ${data?.data?.user?.username}`);
  assert("Password NOT in response", !data?.data?.user?.password, "Password was exposed!");
  
  // Clean up this generated user so it doesn't clutter DB
  if (data?.data?.user?.id) {
    await request("DELETE", `/users/${data.data.user.id}`);
  }
}

// ═══════════════════════════════════════════════
// 4. CREATE USER - Duplicate email
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 4: POST /users — Duplicate email", "bold");
{
  const email = `dup_${Date.now()}@mostanad.com`;
  await request("POST", "/users", {
    name: "First User",
    email,
    username: `first_${Date.now()}`,
    password: "pass123",
  });
  const { status, data } = await request("POST", "/users", {
    name: "Second User",
    email,
    username: `second_${Date.now()}`,
    password: "pass123",
  });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Error about email", data?.message?.toLowerCase().includes("email"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// 5. GET ALL USERS - No filters
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 5: GET /users — Get all users", "bold");
{
  const { status, data } = await request("GET", "/users");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Has meta object", !!data?.meta, JSON.stringify(data));
  assert("Has users array", Array.isArray(data?.data?.users), JSON.stringify(data));
  assert("meta has total", typeof data?.meta?.total === "number", JSON.stringify(data?.meta));
  assert("meta has page", typeof data?.meta?.page === "number", JSON.stringify(data?.meta));
  assert("meta has totalPages", typeof data?.meta?.totalPages === "number", JSON.stringify(data?.meta));
  assert("No passwords in list", !data?.data?.users?.some(u => u.password), "Password exposed in list!");
  log(`  Total users: ${data?.meta?.total}`, "cyan");
}

// ═══════════════════════════════════════════════
// 6. GET ALL USERS - With pagination
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 6: GET /users?page=1&limit=2 — Pagination", "bold");
{
  const { status, data } = await request("GET", "/users?page=1&limit=2");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Max 2 users returned", (data?.data?.users?.length ?? 0) <= 2, `Got ${data?.data?.users?.length}`);
  assert("Page is 1", data?.meta?.page === 1, JSON.stringify(data?.meta));
  assert("Limit is 2", data?.meta?.limit === 2, JSON.stringify(data?.meta));
  log(`  Returned ${data?.data?.users?.length} user(s)`, "cyan");
}

// ═══════════════════════════════════════════════
// 7. GET ALL USERS - With search
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 7: GET /users?search=mahmoud — Search", "bold");
{
  const { status, data } = await request("GET", "/users?search=mahmoud");
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Returns array", Array.isArray(data?.data?.users), JSON.stringify(data));
  log(`  Search matched ${data?.data?.users?.length} user(s)`, "cyan");
}

// ═══════════════════════════════════════════════
// 8. GET USER BY ID - Success
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 8: GET /users/:id — Get by ID (success)", "bold");
if (createdUserId) {
  const { status, data } = await request("GET", `/users/${createdUserId}`);
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("User ID matches", data?.data?.user?.id === createdUserId, JSON.stringify(data?.data?.user));
  assert("Password NOT in response", !data?.data?.user?.password, "Password was exposed!");
  log(`  User: ${JSON.stringify(data?.data?.user)}`, "white");
} else {
  log("  ⚠️  SKIPPED: No user was created in TEST 3", "yellow");
}

// ═══════════════════════════════════════════════
// 9. GET USER BY ID - Not found
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 9: GET /users/:id — Not found", "bold");
{
  const { status, data } = await request("GET", "/users/00000000-0000-0000-0000-000000000000");
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  assert("Message is 'User not found!'", data?.message === "User not found!", data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// 10. GET USER BY ID - Invalid UUID
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 10: GET /users/:id — Invalid UUID format", "bold");
{
  const { status, data } = await request("GET", "/users/not-a-valid-uuid");
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Message mentions UUID", data?.message?.toLowerCase().includes("uuid") || data?.message?.toLowerCase().includes("invalid"), data?.message);
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// 11. UPDATE USER - Success
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 11: PATCH /users/:id — Update user (success)", "bold");
if (createdUserId) {
  const { status, data } = await request("PATCH", `/users/${createdUserId}`, {
    name: "Mahmoud Updated",
    isActive: false,
  });
  assert("Status is 200", status === 200, `Got ${status}`);
  assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Name was updated", data?.data?.user?.name === "Mahmoud Updated", JSON.stringify(data?.data?.user));
  assert("isActive was updated", data?.data?.user?.isActive === false, JSON.stringify(data?.data?.user));
  assert("Password NOT in response", !data?.data?.user?.password, "Password exposed!");
  log(`  Updated user: ${JSON.stringify(data?.data?.user)}`, "white");
} else {
  log("  ⚠️  SKIPPED: No user was created in TEST 3", "yellow");
}

// ═══════════════════════════════════════════════
// 12. UPDATE USER - Invalid UUID
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 12: PATCH /users/:id — Invalid UUID", "bold");
{
  const { status, data } = await request("PATCH", "/users/bad-id", { name: "X" });
  assert("Status is 400", status === 400, `Got ${status}`);
  assert("Validation error returned", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// 13. DELETE USER - Success
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 13: DELETE /users/:id — Delete user (success)", "bold");
if (createdUserId) {
  const { status } = await request("DELETE", `/users/${createdUserId}`);
  assert("Status is 204", status === 204, `Got ${status}`);
  log(`  User ${createdUserId} deleted`, "cyan");
} else {
  log("  ⚠️  SKIPPED: No user was created in TEST 3", "yellow");
}

// ═══════════════════════════════════════════════
// 14. GET after DELETE - Should be 404
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 14: GET /users/:id after delete — Should be 404", "bold");
if (createdUserId) {
  const { status, data } = await request("GET", `/users/${createdUserId}`);
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
} else {
  log("  ⚠️  SKIPPED", "yellow");
}

// ═══════════════════════════════════════════════
// 15. DELETE - Not found
// ═══════════════════════════════════════════════
separator();
log("📋 TEST 15: DELETE /users/:id — Not found", "bold");
{
  const { status, data } = await request("DELETE", "/users/00000000-0000-0000-0000-000000000000");
  assert("Status is 404", status === 404, `Got ${status}`);
  assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
  log(`  Response: ${JSON.stringify(data)}`, "white");
}

// ═══════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════
log("\n" + "═".repeat(60), "cyan");
log(`  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`, passed === passed + failed ? "green" : "yellow");
log("═".repeat(60) + "\n", "cyan");

if (failed > 0) process.exit(1);
