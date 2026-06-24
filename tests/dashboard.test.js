const BASE_URL = "http://localhost:3000/api/v1";

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

let passed = 0;
let failed = 0;

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
  log("  📁 MOSTANAD - ADMIN DASHBOARD STATS TEST SUITE", "bold");
  log("═".repeat(62) + "\n", "cyan");

  log("⏳ Fetching dashboard stats...", "cyan");
  const { status, data } = await request("GET", "/dashboard/stats");

  assert("Status is 200 (OK)", status === 200, `Got ${status}. Response: ${JSON.stringify(data)}`);
  assert("Status field is 'success'", data?.status === "success", JSON.stringify(data));
  assert("Response contains data object", !!data?.data, JSON.stringify(data));

  const stats = data?.data?.stats;
  assert("stats exists", !!stats);
  assert("stats.products is a number", typeof stats?.products === "number");
  assert("stats.companies is a number", typeof stats?.companies === "number");
  assert("stats.users is a number", typeof stats?.users === "number");
  assert("stats.plans is a number", typeof stats?.plans === "number");
  assert("stats.activeSubscriptions is a number", typeof stats?.activeSubscriptions === "number");
  assert("stats.totalMonthlyRevenue is a number", typeof stats?.totalMonthlyRevenue === "number");

  const tasks = data?.data?.tasks;
  assert("tasks exists", !!tasks);
  assert("tasks.total is a number", typeof tasks?.total === "number");
  assert("tasks.byStatus is an object", typeof tasks?.byStatus === "object");
  assert("tasks.byType is an object", typeof tasks?.byType === "object");

  const recentActivity = data?.data?.recentActivity;
  assert("recentActivity exists", !!recentActivity);
  assert("recentActivity.companies is an array", Array.isArray(recentActivity?.companies));
  assert("recentActivity.tasks is an array", Array.isArray(recentActivity?.tasks));

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
