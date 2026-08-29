import { prisma } from "./src/lib/prisma.js";
const label = await prisma.generatedLabel.findUnique({ where: { id: "a10fce30-8773-4b1d-9b07-da65d4a7d63e" } });
console.log(JSON.stringify({ id: label.id, origin: label.origin, labelDataKeys: Object.keys(label.labelData || {}), extractionMeta: label.extractionMeta }, null, 2));
process.exit(0);
