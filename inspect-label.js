import { prisma } from "./src/lib/prisma.js";

async function test() {
  const label = await prisma.generatedLabel.findFirst({ orderBy: { createdAt: "desc" } });
  if (!label) {
    console.log("No label");
    return;
  }
  console.log("Product Name:", JSON.stringify(label.labelData.productName, null, 2));
  console.log("Storage:", JSON.stringify(label.labelData.storage, null, 2));
}
test().finally(() => process.exit(0));

