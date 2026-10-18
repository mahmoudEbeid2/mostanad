// The test auth bypass is opt-in and can never reach production
// (src/middleware/testBypass.js): ALLOW_TEST_BYPASS=true + TEST_BYPASS_SECRET
// (≥ 16 chars, never hardcoded); with NODE_ENV=production the app refuses to
// boot if ALLOW_TEST_BYPASS is set at all. Needs `npm run dev:test` running
// for the live checks.
import { spawn } from "child_process";
import { testBypassConfig } from "../src/middleware/testBypass.js";
import { BYPASS } from "./testBypass.js";

const BASE_URL = "http://127.0.0.1:3000/api/v1";
const SECRET = "x".repeat(32);

let passed = 0;
let failed = 0;
function assert(label, condition, details = "") {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}${details ? `\n     → ${details}` : ""}`);
    failed++;
  }
}

const throws = (env) => {
  try {
    testBypassConfig(env);
    return null;
  } catch (err) {
    return err.message;
  }
};

/** Boots src/server.js with `env` and resolves { code, output } once it exits (or is killed after `ms`). */
function boot(env, ms = 20_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), ms);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

async function run() {
  console.log("\n🧪 Test bypass configuration");
  assert("not set → disabled", testBypassConfig({}).enabled === false);
  assert("ALLOW_TEST_BYPASS=false → disabled", testBypassConfig({ ALLOW_TEST_BYPASS: "false", TEST_BYPASS_SECRET: SECRET }).enabled === false);
  assert("ALLOW_TEST_BYPASS=true + secret → enabled", testBypassConfig({ ALLOW_TEST_BYPASS: "true", TEST_BYPASS_SECRET: SECRET }).enabled === true);
  assert("enabled without a secret → refuses", /TEST_BYPASS_SECRET/.test(throws({ ALLOW_TEST_BYPASS: "true" }) || ""));
  assert("enabled with a short secret → refuses", /at least 16/.test(throws({ ALLOW_TEST_BYPASS: "true", TEST_BYPASS_SECRET: "short" }) || ""));
  assert("ALLOW_TEST_BYPASS=true + NODE_ENV=production → refuses", /refusing to start/.test(throws({ ALLOW_TEST_BYPASS: "true", TEST_BYPASS_SECRET: SECRET, NODE_ENV: "production" }) || ""));
  assert("ALLOW_TEST_BYPASS set to anything + production → refuses", /refusing to start/.test(throws({ ALLOW_TEST_BYPASS: "1", NODE_ENV: "production" }) || ""));
  assert("production without the flag → boots normally", testBypassConfig({ NODE_ENV: "production" }).enabled === false);

  console.log("\n🧪 The API process refuses to boot");
  const b = await boot({ NODE_ENV: "production", ALLOW_TEST_BYPASS: "true", TEST_BYPASS_SECRET: SECRET, PORT: "0" });
  assert("server exits with an error (never listens)", b.code !== 0 && b.code !== null && !/Server is running/.test(b.output), `code=${b.code} signal=${b.signal}`);
  assert("…and says why", /refusing to start/.test(b.output), b.output.slice(-300));

  console.log("\n🧪 The running test stack");
  assert("a bypass secret was issued by `npm run dev:test`", BYPASS.length >= 16);
  let r = await fetch(`${BASE_URL}/certificate-types?companyId=00000000-0000-0000-0000-000000000000`, { headers: { "x-test-bypass": "supersecretbypass" } });
  assert("the old hardcoded value no longer authenticates → 401", r.status === 401, r.status);
  r = await fetch(`${BASE_URL}/certificate-types?companyId=00000000-0000-0000-0000-000000000000`);
  assert("no header → 401", r.status === 401, r.status);
  r = await fetch(`${BASE_URL}/certificate-types?companyId=00000000-0000-0000-0000-000000000000`, { headers: { "x-test-bypass": BYPASS } });
  assert("the issued secret authenticates → 200", r.status === 200, r.status);
}

run()
  .catch((err) => {
    console.error("Fatal:", err);
    failed++;
  })
  .finally(() => {
    console.log(`\n📊 RESULTS: ${passed} passed / ${failed} failed / ${passed + failed} total\n`);
    // exitCode, not process.exit(): exiting while the spawned server's pipes and
    // fetch's keep-alive sockets are still closing trips a libuv assertion on
    // Windows (src\win\async.c) and turns a green run into a crash
    process.exitCode = failed > 0 ? 1 : 0;
  });
