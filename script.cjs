const { prisma } = require("./src/lib/prisma.js");
async function run() {
  const latestLabel = await prisma.generatedLabel.findFirst({
    orderBy: { createdAt: "desc" },
    include: { validations: { orderBy: { createdAt: "desc" }, take: 1 } }
  });
  if (latestLabel && latestLabel.validations[0]) {
    const report = latestLabel.validations[0];
    console.log("Recent Validation Passed:", report.passed, "Errors:", report.errorCount);
    console.log("Recent Validation Verdicts:", JSON.stringify(report.verdicts.filter(v => v.status === "error" || v.status === "unverifiable"), null, 2));
  }
}
run().then(() => process.exit(0)).catch(e => console.error(e));

