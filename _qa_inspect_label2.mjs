import { prisma } from "./src/lib/prisma.js";
const label = await prisma.generatedLabel.findUnique({ where: { id: "a10fce30-8773-4b1d-9b07-da65d4a7d63e" } });
const d = label.labelData;
for (const k of ["manufacturer", "importer", "netWeight", "packaging", "registrationNumber", "batchNo"]) {
  console.log(k, "=>", JSON.stringify(d[k]));
}
process.exit(0);
