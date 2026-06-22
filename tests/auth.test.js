import dotenv from "dotenv";
dotenv.config();
import bcrypt from "bcryptjs";
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

async function request(method, path, body = null, headers = {}) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-force-auth": "true",
      ...headers
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  🧪 MOSTANAD - INTERNAL USER AUTHENTICATION TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  const ts = Date.now();
  const testUsername = `user_${ts}`;
  const testEmail = `user_${ts}@example.com`;
  const testPassword = "securepassword123";

  // 1. Setup Test User in database
  log("⚙️  Creating test user...", "cyan");
  const hashedPassword = await bcrypt.hash(testPassword, 12);
  const user = await prisma.user.create({
    data: {
      name: "Auth Test User",
      username: testUsername,
      email: testEmail,
      password: hashedPassword,
      isActive: true
    }
  });
  testUserId = user.id;
  log(`  Test User Created: ${testUsername} (${testUserId})`, "green");

  // ─────────────────────────────────────────────────────
  // 1. LOGIN - Validation: empty body
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /auth/login — Validation Error (empty body)", "bold");
  {
    const { status, data } = await request("POST", "/auth/login", {});
    assert("Status is 400", status === 400, `Got ${status}`);
    assert("Status is 'fail'", data?.status === "fail", JSON.stringify(data));
    assert("Message contains validation error", data?.message?.includes("Validation error"), data?.message);
    log(`  Response: ${JSON.stringify(data)}`, "white");
  }

  // ─────────────────────────────────────────────────────
  // 2. LOGIN - Nonexistent Username/Email
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /auth/login — Nonexistent Username/Email", "bold");
  {
    const { status, data } = await request("POST", "/auth/login", {
      username: `nonexistent_${ts}`,
      password: testPassword
    });
    assert("Status is 401", status === 401, `Got ${status}`);
    assert("Message contains incorrect credentials", data?.message === "Incorrect username/email or password!", data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 3. LOGIN - Incorrect Password
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /auth/login — Incorrect Password", "bold");
  {
    const { status, data } = await request("POST", "/auth/login", {
      username: testUsername,
      password: "wrongpassword123"
    });
    assert("Status is 401", status === 401, `Got ${status}`);
    assert("Message is incorrect credentials", data?.message === "Incorrect username/email or password!", data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 4. LOGIN - Success (using username)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /auth/login — Success (using username)", "bold");
  {
    const { status, data } = await request("POST", "/auth/login", {
      username: testUsername,
      password: testPassword
    });
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Token is returned", !!data?.data?.token, JSON.stringify(data));
    assert("User object returned", !!data?.data?.user, JSON.stringify(data));
    assert("Password is excluded", data?.data?.user?.password === undefined, JSON.stringify(data?.data?.user));
    assert("User ID matches", data?.data?.user?.id === testUserId, JSON.stringify(data));
  }

  // ─────────────────────────────────────────────────────
  // 5. LOGIN - Success (using email)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 5: POST /auth/login — Success (using email)", "bold");
  {
    const { status, data } = await request("POST", "/auth/login", {
      username: testEmail,
      password: testPassword
    });
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Token is returned", !!data?.data?.token, JSON.stringify(data));
    assert("User ID matches", data?.data?.user?.id === testUserId, JSON.stringify(data));
  }

  // ─────────────────────────────────────────────────────
  // 6. LOGIN - Failure (Inactive User)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 6: POST /auth/login — Inactive User Restriction", "bold");
  {
    // Deactivate user in DB
    await prisma.user.update({
      where: { id: testUserId },
      data: { isActive: false }
    });
    log("  Deactivated test user in database.", "yellow");

    const { status, data } = await request("POST", "/auth/login", {
      username: testUsername,
      password: testPassword
    });
    assert("Status is 403", status === 403, `Got ${status}`);
    assert("Message mentions inactive account", data?.message?.includes("inactive"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 7. PROTECT MIDDLEWARE - Access without token
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 7: GET /users (Protected) — Access without token", "bold");
  {
    const { status, data } = await request("GET", "/users");
    assert("Status is 401", status === 401, `Got ${status}`);
    assert("Message mentions not logged in", data?.message?.includes("logged in"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 8. PROTECT MIDDLEWARE - Access with bad token
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 8: GET /users (Protected) — Access with bad token", "bold");
  {
    const { status, data } = await request("GET", "/users", null, {
      "Authorization": "Bearer badtoken123"
    });
    assert("Status is 401", status === 401, `Got ${status}`);
    assert("Message mentions invalid token", data?.message?.includes("Invalid token") || data?.message?.includes("expired"), data?.message);
  }

  // ─────────────────────────────────────────────────────
  // 9. PROTECT MIDDLEWARE - Access with valid user token
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 9: GET /users (Protected) — Access with valid user token", "bold");
  {
    // Re-activate user
    await prisma.user.update({
      where: { id: testUserId },
      data: { isActive: true }
    });
    log("  Re-activated test user in database.", "yellow");

    // Login to get token
    const loginRes = await request("POST", "/auth/login", {
      username: testUsername,
      password: testPassword
    });
    const token = loginRes.data?.data?.token;

    const { status, data } = await request("GET", "/users", null, {
      "Authorization": `Bearer ${token}`
    });
    assert("Status is 200", status === 200, `Got ${status}`);
    assert("Returns users", !!data?.data?.users, JSON.stringify(data));
  }

  // ─────────────────────────────────────────────────────
  // 10. PROTECT MIDDLEWARE - Company Login & Token-Scoped Route
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 10: POST /companies/login & POST /certificates/generate — Company Auth", "bold");
  {
    // Create a temporary company
    const compUsername = `comp_auth_${Date.now()}`;
    const compPassword = "companypassword123";
    
    // Bypass create company auth to setup test data
    const createRes = await fetch(`${BASE_URL}/companies`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-test-bypass": "supersecretbypass"
      },
      body: JSON.stringify({
        name: "Auth Test Company",
        username: compUsername,
        password: compPassword
      })
    });
    const createData = await createRes.json();
    const createdCompId = createData?.data?.company?.id;
    assert("Company created successfully", !!createdCompId, JSON.stringify(createData));

    // Test company login
    const loginRes = await request("POST", "/companies/login", {
      username: compUsername,
      password: compPassword
    });
    assert("Company login status is 200", loginRes.status === 200, `Got ${loginRes.status}`);
    const compToken = loginRes.data?.data?.token;
    assert("Company token is returned", !!compToken, JSON.stringify(loginRes.data));

    // Test using company token to access token-scoped certificate generation
    const certRes = await request("POST", "/certificates/generate", { transactionType: "shipping" }, {
      "Authorization": `Bearer ${compToken}`
    });
    // Since we don't send a file, it should fail with 400 Bad Request (missing file),
    // but NOT 401 Unauthorized, proving authentication succeeded!
    assert("Status is 400 (Validation/file missing)", certRes.status === 400, `Got ${certRes.status}`);
    assert("Message mentions file", certRes.data?.message?.includes("file") || certRes.data?.message?.toLowerCase().includes("required"), certRes.data?.message);

    // Cleanup company
    await prisma.company.delete({ where: { id: createdCompId } });
    log("  Cleaned up temporary company.", "yellow");
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database...", "cyan");
  try {
    await prisma.user.delete({ where: { id: testUserId } });
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
  if (testUserId) {
    prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  }
  process.exit(1);
});
