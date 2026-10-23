import "dotenv/config";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { Queue } from "bullmq";
import { getRedisConfig } from "../src/lib/redis.js";
import { readBypassSecret } from "./testBypass.js";

const execAsync = promisify(exec);

// Tests must never reach a paid API. Every test process inherits
// GEMINI_DISABLED=true (in-process service calls fail loudly at the guard),
// and the suite refuses to start unless every consumer of every Gemini-capable
// queue — dev:all workers, the API's in-process workers, Docker worker
// containers — registered as guarded (geminiWorkerName → ":gemini-off").
process.env.GEMINI_DISABLED = "true";

const GEMINI_QUEUES = [
  "catalogQueue",
  "labelQueue",
  "edaRequirementQueue",
  "referenceLabelQueue",
  "productAiQueue",
  "labelGeneratorQueue",
  // Certificates V2 — also required so the suites have their workers running
  "certificateTemplateQueue",
  "invoiceQueue", // the only Gemini caller in the certificate pipeline (§9.1)
  "certificateRenderQueue",
  "catalogueQueue", // product catalogues (plan.md §15, A6) — CATALOGUE_EXTRACT from A6.3
];

async function assertNoGeminiConsumers() {
  const unsafe = [];
  for (const name of GEMINI_QUEUES) {
    const queue = new Queue(name, { connection: getRedisConfig() });
    try {
      const workers = await queue.getWorkers();
      if (workers.length === 0) unsafe.push(`${name} ← no consumer at all (is \`npm run dev:test\` running?)`);
      for (const w of workers) {
        if (!String(w.rawname || "").endsWith(":gemini-off")) unsafe.push(`${name} ← ${w.rawname} (addr ${w.addr})`);
      }
    } finally {
      await queue.close();
    }
  }
  if (unsafe.length) {
    console.error(
      "\x1b[31m\x1b[1mRefusing to run: every Gemini-capable queue needs at least one consumer, and every consumer must run with GEMINI_DISABLED=true:\x1b[0m\n" +
        unsafe.map((u) => `  - ${u}`).join("\n") +
        "\n\nStop them (e.g. `npm run dev:all`, or the Docker worker containers) and start the stack with `npm run dev:test`.\n"
    );
    process.exit(1);
  }
}

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const testDir = "./tests";
// Top-level suites plus tests/certificates-v2/. tests/live/ (paid APIs, opt-in
// via GEMINI_LIVE=1) is never run by npm test.
const SUB_DIRS = ["certificates-v2"];
const files = [
  ...fs.readdirSync(testDir).filter((f) => f.endsWith(".test.js") && f !== "runAll.js"),
  ...SUB_DIRS.flatMap((d) =>
    fs.existsSync(path.join(testDir, d))
      ? fs.readdirSync(path.join(testDir, d)).filter((f) => f.endsWith(".test.js")).sort().map((f) => `${d}/${f}`)
      : []
  ),
];

// The suites authenticate with the test bypass, which only `npm run dev:test`
// switches on (opt-in, random secret per start — src/middleware/testBypass.js).
// Refuse to run against an API that doesn't honour it (e.g. `dev:all`).
async function assertTestBypass() {
  const secret = readBypassSecret();
  if (!secret) throw new Error("No test bypass secret (.test-bypass-secret). Start the guarded stack with `npm run dev:test`.");
  process.env.TEST_BYPASS_SECRET = secret; // inherited by every suite
  const url = "http://127.0.0.1:3000/api/v1/background-tasks/00000000-0000-0000-0000-000000000000";
  let status;
  try {
    status = (await fetch(url, { headers: { "x-test-bypass": secret } })).status;
  } catch (err) {
    throw new Error(`The API is not reachable at ${url} (${err.message}). Start \`npm run dev:test\`.`);
  }
  if (status !== 404) {
    throw new Error(`The API did not accept the test bypass (HTTP ${status}). It must be the \`npm run dev:test\` stack that wrote .test-bypass-secret.`);
  }
}

async function runTests() {
  await assertTestBypass();
  await assertNoGeminiConsumers();
  console.log(`${colors.cyan}${colors.bold}==================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}   🏃‍♂️ RUNNING ALL SYSTEM INTEGRATION TEST SUITES   ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}==================================================${colors.reset}\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  const reports = [];

  for (const file of files) {
    const filePath = path.join(testDir, file);
    console.log(`${colors.bold}Running ${file}...${colors.reset}`);
    try {
      const { stdout, stderr } = await execAsync(`node ${filePath}`, { maxBuffer: 32 * 1024 * 1024 });
      console.log(stdout);
      if (stderr) console.error(stderr);
      console.log(`${colors.green}✔ ${file} completed successfully!${colors.reset}\n`);
      reports.push({ file, success: true });
      totalPassed++;
    } catch (error) {
      console.log(error.stdout || "");
      console.error(`${colors.red}❌ ${file} failed!${colors.reset}`);
      console.error(error.stderr || error.message);
      console.log("\n");
      reports.push({ file, success: false, error: error.message });
      totalFailed++;
    }
  }

  console.log(`${colors.cyan}${colors.bold}==================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}               🏁 TEST SUITES SUMMARY             ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}==================================================${colors.reset}`);
  
  reports.forEach((r) => {
    if (r.success) {
      console.log(`  ${colors.green}✔ [PASSED]${colors.reset} ${r.file}`);
    } else {
      console.log(`  ${colors.red}❌ [FAILED]${colors.reset} ${r.file}`);
    }
  });

  console.log(`\n  Summary: ${colors.green}${totalPassed} passed${colors.reset} / ${colors.red}${totalFailed} failed${colors.reset} / ${totalPassed + totalFailed} total\n`);

  if (totalFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Fatal error running test suites:", err);
  process.exit(1);
});
