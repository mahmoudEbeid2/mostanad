const fs = require("fs");
let content = fs.readFileSync("src/workers/labelGeneratorWorker.js", "utf8");

const oldResult = `const result = { taskId, labelId: label.id, label: labelData, validation: { passed: report.passed, errorCount: report.errorCount, warningCount: report.warningCount }, riskScore: score, autonomyTier };`;
const newResult = `const result = { taskId, labelId: label.id, label: labelData, labelProvenance, validation: { passed: report.passed, errorCount: report.errorCount, warningCount: report.warningCount, verdicts: report.verdicts }, riskScore: score, autonomyTier };`;

if (content.includes(oldResult)) {
  content = content.replace(oldResult, newResult);
  fs.writeFileSync("src/workers/labelGeneratorWorker.js", content);
  console.log("Updated labelGeneratorWorker.js");
} else {
  console.log("Could not find the target string in labelGeneratorWorker.js");
}

