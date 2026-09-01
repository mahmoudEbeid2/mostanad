const fs = require("fs");
const path = "src/middleware/errorMiddleware.js";
let content = fs.readFileSync(path, "utf8");

content = content.replace(
  `const message = \`Invalid database input data. Check your fields schema.\`;`,
  `const message = \`Invalid database input data. Check your fields schema. DETAILS: \${err.message}\`;`
);

fs.writeFileSync(path, content);
console.log("Patched errorMiddleware.js to include details in message");

