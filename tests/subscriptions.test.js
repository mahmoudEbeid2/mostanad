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
  const options = { method, headers: { "Content-Type": "application/json", "x-test-bypass": "supersecretbypass" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, options);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

async function run() {
  log("\n" + "═".repeat(62), "cyan");
  log("  💳 MOSTANAD - SAAS SUBSCRIPTIONS TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  // Create test company and plans
  const ts = Date.now();
  let testCompanyId;
  let monthlyPlanId;
  let yearlyPlanId;

  log("⚙️  Setting up test company and plans...", "cyan");
  try {
    const company = await prisma.company.create({
      data: {
        name: `Sub Test Company ${ts}`,
        username: `sub_co_${ts}`,
        password: "securepassword123",
      },
    });
    testCompanyId = company.id;

    const mPlan = await prisma.plan.create({
      data: {
        name: `Sub Monthly Plan ${ts}`,
        price: 9.99,
        interval: "month",
        features: ["Feature A", "Feature B"],
      },
    });
    monthlyPlanId = mPlan.id;

    const yPlan = await prisma.plan.create({
      data: {
        name: `Sub Yearly Plan ${ts}`,
        price: 99.99,
        interval: "year",
        features: ["Feature All"],
      },
    });
    yearlyPlanId = yPlan.id;

    log(`  Setup completed. Company: ${testCompanyId}, Monthly Plan: ${monthlyPlanId}, Yearly Plan: ${yearlyPlanId}`, "green");
  } catch (err) {
    log(`  ❌ Setup failed: ${err.message}`, "red");
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────
  // 1. POST /subscriptions - Validation failures
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 1: POST /subscriptions — Validation Failures", "bold");
  {
    const res = await request("POST", "/subscriptions", {});
    assert("Should return 400 for empty body", res.status === 400, `Got status ${res.status}`);
    assert("Message mentions companyId", res.data?.message?.includes("companyId"), JSON.stringify(res.data));
    assert("Message mentions planId", res.data?.message?.includes("planId"), JSON.stringify(res.data));

    const res2 = await request("POST", "/subscriptions", {
      companyId: "invalid-uuid",
      planId: "invalid-uuid",
      status: "super-active",
    });
    assert("Should return 400 for bad UUID and status", res2.status === 400, `Got status ${res2.status}`);
    assert("Mentions company ID format", res2.data?.message?.includes("company ID"), JSON.stringify(res2.data));
    assert("Mentions status format", res2.data?.message?.includes("expected one of"), JSON.stringify(res2.data));
  }

  // ─────────────────────────────────────────────────────
  // 2. POST /subscriptions - Monthly auto end-date calculation
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 2: POST /subscriptions — Monthly Plan (Auto End-Date & Relations)", "bold");
  let sub1Id;
  {
    const res = await request("POST", "/subscriptions", {
      companyId: testCompanyId,
      planId: monthlyPlanId,
      status: "active",
    });

    assert("Status is 201", res.status === 201, `Got status ${res.status}. Error: ${JSON.stringify(res.data)}`);
    assert("Status is 'success'", res.data?.status === "success");
    
    const sub = res.data?.data?.subscription;
    assert("Subscription object returned", !!sub);
    assert("Subscription has ID", !!sub?.id);
    assert("Status is active", sub?.status === "active");
    sub1Id = sub?.id;

    if (sub) {
      const start = new Date(sub.startDate);
      const end = new Date(sub.endDate);
      const expectedEnd = new Date(start);
      expectedEnd.setMonth(expectedEnd.getMonth() + 1);

      // Compare ISO date strings without milliseconds
      const expectedStr = expectedEnd.toISOString().split(":")[0];
      const actualStr = end.toISOString().split(":")[0];
      assert("Auto end-date is roughly +1 month", actualStr === expectedStr, `Expected ${expectedStr}, got ${actualStr}`);

      assert("Includes company relation", sub.company?.name === `Sub Test Company ${ts}`);
      assert("Includes plan relation", sub.plan?.name === `Sub Monthly Plan ${ts}`);
    }
  }

  // ─────────────────────────────────────────────────────
  // 3. POST /subscriptions - Yearly auto end-date calculation
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 3: POST /subscriptions — Yearly Plan (Auto End-Date)", "bold");
  {
    const res = await request("POST", "/subscriptions", {
      companyId: testCompanyId,
      planId: yearlyPlanId,
      status: "expired", // create as expired so we don't trigger cancellation of sub1 yet
    });

    assert("Status is 201", res.status === 201, `Got status ${res.status}`);
    const sub = res.data?.data?.subscription;
    
    if (sub) {
      const start = new Date(sub.startDate);
      const end = new Date(sub.endDate);
      const expectedEnd = new Date(start);
      expectedEnd.setFullYear(expectedEnd.getFullYear() + 1);

      const expectedStr = expectedEnd.toISOString().split(":")[0];
      const actualStr = end.toISOString().split(":")[0];
      assert("Auto end-date is roughly +1 year", actualStr === expectedStr, `Expected ${expectedStr}, got ${actualStr}`);
      assert("Status is expired", sub.status === "expired");
    }
  }

  // ─────────────────────────────────────────────────────
  // 4. POST /subscriptions - Lifecycle tenant check (One Active Subscription)
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 4: POST /subscriptions — Active Tenant Constraint Check", "bold");
  let sub3Id;
  {
    // Currently, sub1 (ID sub1Id) is active. Let's create sub3 as active.
    const res = await request("POST", "/subscriptions", {
      companyId: testCompanyId,
      planId: yearlyPlanId,
      status: "active",
    });

    assert("Second active subscription status is 201", res.status === 201, `Got status ${res.status}`);
    sub3Id = res.data?.data?.subscription?.id;

    // Fetch sub1 from DB directly and check if it became cancelled
    const oldSub = await prisma.subscription.findUnique({ where: { id: sub1Id } });
    assert("Old active subscription automatically changed to cancelled", oldSub?.status === "cancelled", `Status is ${oldSub?.status}`);
  }

  // ─────────────────────────────────────────────────────
  // 5. GET /subscriptions - Get list & pagination
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 5: GET /subscriptions — Listing & Pagination & Filters", "bold");
  {
    const res = await request("GET", "/subscriptions");
    assert("Status is 200", res.status === 200, `Got status ${res.status}`);
    assert("Includes metadata", !!res.data?.meta);
    assert("Returns subscription list", Array.isArray(res.data?.data?.subscriptions));
    assert("Returned list size is correct", res.data?.data?.subscriptions?.length >= 3);

    // Test filtering by companyId
    const resFiltered = await request("GET", `/subscriptions?companyId=${testCompanyId}`);
    assert("Filtered size matches", resFiltered.data?.data?.subscriptions?.length === 3);

    // Test filtering by status
    const resStatus = await request("GET", `/subscriptions?companyId=${testCompanyId}&status=active`);
    assert("Active count matches", resStatus.data?.data?.subscriptions?.length === 1);
    assert("Active sub ID matches", resStatus.data?.data?.subscriptions?.[0]?.id === sub3Id);

    // Test pagination
    const resPaged = await request("GET", `/subscriptions?companyId=${testCompanyId}&page=1&limit=1`);
    assert("Paged list size is 1", resPaged.data?.data?.subscriptions?.length === 1);
    assert("Paged meta total is 3", resPaged.data?.meta?.total === 3);
    assert("Paged meta totalPages is 3", resPaged.data?.meta?.totalPages === 3);
  }

  // ─────────────────────────────────────────────────────
  // 6. GET /subscriptions/:id - Get by ID
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 6: GET /subscriptions/:id — Get by ID", "bold");
  {
    const res = await request("GET", `/subscriptions/${sub3Id}`);
    assert("Status is 200", res.status === 200, `Got status ${res.status}`);
    assert("ID matches", res.data?.data?.subscription?.id === sub3Id);
    assert("Includes company relation details", !!res.data?.data?.subscription?.company?.username);
    assert("Includes plan relation details", !!res.data?.data?.subscription?.plan?.name);

    const res404 = await request("GET", `/subscriptions/00000000-0000-0000-0000-000000000000`);
    assert("Should return 404 for nonexistent UUID", res404.status === 404, `Got status ${res404.status}`);
  }

  // ─────────────────────────────────────────────────────
  // 7. PATCH /subscriptions/:id - Update
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 7: PATCH /subscriptions/:id — Update Subscription", "bold");
  {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 90);
    const newEndDateStr = futureDate.toISOString();

    const res = await request("PATCH", `/subscriptions/${sub3Id}`, {
      endDate: newEndDateStr,
      status: "expired",
    });

    assert("Status is 200", res.status === 200, `Got status ${res.status}`);
    assert("Status updated to expired", res.data?.data?.subscription?.status === "expired");
    assert("End date updated", new Date(res.data?.data?.subscription?.endDate).toISOString() === newEndDateStr);

    // Check invalid end date (before start date)
    const resInvalidDate = await request("PATCH", `/subscriptions/${sub3Id}`, {
      endDate: new Date("2020-01-01").toISOString(),
    });
    assert("Should return 400 for end date before start date", resInvalidDate.status === 400, `Got status ${resInvalidDate.status}`);
  }

  // ─────────────────────────────────────────────────────
  // 8. DELETE /subscriptions/:id - Delete
  // ─────────────────────────────────────────────────────
  separator();
  log("📋 TEST 8: DELETE /subscriptions/:id — Hard Delete", "bold");
  {
    const res = await request("DELETE", `/subscriptions/${sub3Id}`);
    assert("Status is 204", res.status === 204, `Got status ${res.status}`);

    const resCheck = await request("GET", `/subscriptions/${sub3Id}`);
    assert("Should return 404 after deletion", resCheck.status === 404, `Got status ${resCheck.status}`);
  }

  // ─────────────────────────────────────────────────────
  // CLEAN UP
  // ─────────────────────────────────────────────────────
  separator();
  log("🧹 Cleaning up database records...", "cyan");
  try {
    // Delete subscriptions for company
    await prisma.subscription.deleteMany({
      where: { companyId: testCompanyId },
    });
    // Delete plans
    await prisma.plan.deleteMany({
      where: {
        id: { in: [monthlyPlanId, yearlyPlanId] },
      },
    });
    // Delete company
    await prisma.company.delete({
      where: { id: testCompanyId },
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
