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
let createdRoleId = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

const separator = () => log("─".repeat(62), "cyan");

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
  log("  🧪 MOSTANAD - ROLE ENDPOINTS TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  const ts = Date.now();
  const testRoleName = `TEST_ROLE_${ts}`;

  // 1. CREATE ROLE - Validation Error (missing name)
  separator();
  log("📋 TEST 1: POST /roles — Validation Error (missing name)", "bold");
  {
    const { status, data } = await request("POST", "/roles", {});
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message contains validation error", data?.message?.includes("Validation error"), data?.message);
  }

  // 2. CREATE ROLE - Success
  separator();
  log("📋 TEST 2: POST /roles — Create role successfully", "bold");
  {
    const { status, data } = await request("POST", "/roles", {
      name: testRoleName,
      description: "Test role description",
      permissionSlugs: ["create_users", "read_users"],
    });

    assert("Status is 201", status === 201, `Got ${status}`);
    assert("Status is 'success'", data?.status === "success", JSON.stringify(data));
    assert("Role object returned", !!data?.data?.role, JSON.stringify(data));
    assert("Role has correct name", data?.data?.role?.name === testRoleName, JSON.stringify(data?.data?.role));
    assert("Permissions are linked", data?.data?.role?.permissions?.length === 2, JSON.stringify(data?.data?.role?.permissions));

    if (data?.data?.role?.id) {
      createdRoleId = data.data.role.id;
    }
  }

  // 3. CREATE ROLE - Duplicate Error
  separator();
  log("📋 TEST 3: POST /roles — Duplicate Name Error", "bold");
  {
    const { status, data } = await request("POST", "/roles", {
      name: testRoleName,
    });
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Message indicates duplicate name", data?.message === "Role with this name already exists!", data?.message);
  }

  // 4. GET ALL ROLES
  separator();
  log("📋 TEST 4: GET /roles — Get all roles", "bold");
  {
    const { status, data } = await request("GET", "/roles");
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Has meta", !!data?.meta, JSON.stringify(data));
    assert("Has roles array", Array.isArray(data?.data?.roles), JSON.stringify(data));
    assert("Roles contains created role", data?.data?.roles?.some(r => r.id === createdRoleId), JSON.stringify(data));
  }

  // 5. GET ROLE BY ID
  separator();
  log("📋 TEST 5: GET /roles/:id — Get role by ID", "bold");
  if (createdRoleId) {
    const { status, data } = await request("GET", `/roles/${createdRoleId}`);
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Role ID matches", data?.data?.role?.id === createdRoleId, JSON.stringify(data));
    assert("Role has permissions", data?.data?.role?.permissions?.length === 2, JSON.stringify(data));
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // 6. UPDATE ROLE - Success
  separator();
  log("📋 TEST 6: PATCH /roles/:id — Update role", "bold");
  if (createdRoleId) {
    const { status, data } = await request("PATCH", `/roles/${createdRoleId}`, {
      description: "Updated description",
      permissionSlugs: ["create_users"], // only 1 permission linked now
    });

    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Description was updated", data?.data?.role?.description === "Updated description", JSON.stringify(data));
    assert("Permissions were updated", data?.data?.role?.permissions?.length === 1, JSON.stringify(data));
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // 7. DELETE ROLE - Success
  separator();
  log("📋 TEST 7: DELETE /roles/:id — Delete role", "bold");
  if (createdRoleId) {
    const { status } = await request("DELETE", `/roles/${createdRoleId}`);
    assert("Status is 204", status === 204, `Got ${status}`);
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // 8. GET ROLE BY ID - Post Delete (404)
  separator();
  log("📋 TEST 8: GET /roles/:id after delete — Should be 404", "bold");
  if (createdRoleId) {
    const { status, data } = await request("GET", `/roles/${createdRoleId}`);
    assert("Status is 404", status === 404, `Got ${status}`);
  } else {
    log("  ⚠️  SKIPPED", "yellow");
  }

  // SUMMARY
  log("\n" + "═".repeat(62), "cyan");
  log(`  📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total`, passed === passed + failed && failed === 0 ? "green" : "red");
  log("═".repeat(62) + "\n", "cyan");

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  log(`Fatal Error in test suite: ${err.message}`, "red");
  process.exit(1);
});
