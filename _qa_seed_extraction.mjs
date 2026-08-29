import { prisma } from "./src/lib/prisma.js";
const id = "a10fce30-8773-4b1d-9b07-da65d4a7d63e";
const extractionMeta = {
  netWeight: { confidence: 0.62, snippet: "Net Wt: 1 kg", bbox: null, ambiguous: false },
  manufacturer: { confidence: 0.55, snippet: "(unreadable stamp)", bbox: null, ambiguous: true },
};
await prisma.generatedLabel.update({
  where: { id },
  data: { origin: "scanned_document", sourceFileRef: "qa-test-scan.pdf", extractionMeta },
});
console.log("seeded");
process.exit(0);
