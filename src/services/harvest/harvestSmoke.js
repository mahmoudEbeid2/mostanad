import { PDFDocument, StandardFonts } from "pdf-lib";
import { readSmokePdf } from "./harvestAi.js";

// The harvest worker's self-test (28 Nov, run after every deploy): a one-page certificate made here — its
// bytes differ every time (the time is printed), so nothing comes from a cache — read end to end.
export async function runHarvestSmoke(_data = {}, ctx = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([420, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = ["CERTIFICATE OF COMPOSITION", "Trade Name: SMOKETEST 100mL", "Validity: 24 months", "Product Form: Liquid", `Issued for a deploy check: ${new Date().toISOString()}`];
  lines.forEach((t, i) => page.drawText(t, { x: 30, y: 250 - i * 30, size: 12, font }));
  ctx.progress?.(20, "reading the smoke PDF");
  const out = await readSmokePdf(Buffer.from(await doc.save()), "deploy-smoke.pdf");
  if (!out.values) throw new Error("the smoke PDF was read but no value came back");
  return out;
}
