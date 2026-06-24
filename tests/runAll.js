import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

const testDir = "./tests";
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js") && f !== "runAll.js");

async function runTests() {
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
      const { stdout, stderr } = await execAsync(`node ${filePath}`);
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
