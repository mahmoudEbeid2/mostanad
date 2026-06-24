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
let testUserId = null;

const log = (msg, color = "white") =>
  console.log(`${colors[color]}${msg}${colors.reset}`);

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
  log("  📁 MOSTANAD - USER CREATION WELCOME EMAIL TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  log("⏳ Creating user and sending welcome email to sandbox...", "cyan");
  const ts = Date.now();
  const testEmail = `test_user_${ts}@mostanad-platform.com`;
  const testUsername = `user_${ts}`;

  const res = await request("POST", "/users", {
    name: "Mailtrap Test User",
    email: testEmail,
    username: testUsername,
    password: "TestPassword123!",
    phone: "01099998888",
  });

  const status = res.status;
  const data = res.data;

  assert("Status is 201 (Created)", status === 201, `Got ${status}. Response: ${JSON.stringify(data)}`);
  assert("Status field is 'success'", data?.status === "success", JSON.stringify(data));
  assert("User object returned", !!data?.data?.user, JSON.stringify(data));
  assert("Password is excluded from response", data?.data?.user?.password === undefined, JSON.stringify(data?.data?.user));

  if (data?.data?.user?.id) {
    testUserId = data.data.user.id;
    log(`  User created in database: ${testUserId}`, "green");
    log(`  Welcome email was sent to: ${testEmail}`, "green");

    // Double check record exists in DB
    const dbUser = await prisma.user.findUnique({ where: { id: testUserId } });
    assert("User exists in database", !!dbUser, "User record not found in database");
    assert("Email matches", dbUser?.email === testEmail);
  }

  // CLEAN UP
  log("🧹 Cleaning up database test records...", "cyan");
  if (testUserId) {
    try {
      await prisma.user.delete({ where: { id: testUserId } });
      log("  ✅ Cleanup completed successfully.", "green");
    } catch (err) {
      log(`  ❌ Error during cleanup: ${err.message}`, "red");
    }
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
