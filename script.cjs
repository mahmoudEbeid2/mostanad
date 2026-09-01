const fs = require("fs");
const path = "src/services/label/generatedLabelService.js";
let content = fs.readFileSync(path, "utf8");

content = content.replace(
  `const dryRun = dryRunPatch(label.labelData, report, patch, { rules });`,
  `const dryRun = await dryRunPatch(label.labelData, report, patch, { rules });`
);

fs.writeFileSync(path, content);
console.log("Patched generatedLabelService.js to await dryRunPatch");

