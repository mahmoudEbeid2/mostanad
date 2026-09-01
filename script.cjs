const fs = require("fs");
const path = "src/services/label/editing/patchApplier.js";
let content = fs.readFileSync(path, "utf8");

content = content.replace(
  `wouldViolate: newFailures.map((v) => ({ ruleKey: v.ruleKey, message: v.message, citation: v.citation, path: v.path })),`,
  `wouldViolate: newFailures.map((v) => ({ ruleKey: v.ruleKey || null, message: v.message || null, citation: v.citation || null, path: v.path || null })),`
);

fs.writeFileSync(path, content);
console.log("Fixed undefined in patchApplier.js");

