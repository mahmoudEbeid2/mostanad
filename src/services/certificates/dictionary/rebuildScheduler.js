import { prisma } from "../../../lib/prisma.js";
import { QUEUES, enqueueRaw } from "../jobs/queues.js";
import { buildDictionary } from "./dataDictionary.js";

// When a company's data dictionary is rebuilt (plan.md §3.2): lazily on first
// use (getDictionary), after product changes — at most one rebuild per
// company per 10 minutes — and nightly. Rebuilds run on the template worker.

export const REBUILD_WINDOW_MS = 10 * 60 * 1000;
const SOON_MS = 5000; // coalesces a burst of saves (a catalog upload) into one rebuild

/**
 * Schedules a rebuild after a product change. A rebuild already waiting in
 * the same 10-minute window absorbs this one (same jobId → BullMQ ignores the
 * add). Never fails the caller's product write: a scheduling error is logged
 * and the nightly rebuild catches up.
 */
export async function scheduleDictionaryRebuild(companyId) {
  if (!companyId) return;
  try {
    const row = await prisma.dataDictionary.findUnique({ where: { companyId }, select: { builtAt: true } });
    const earliest = row ? row.builtAt.getTime() + REBUILD_WINDOW_MS : 0;
    const runAt = Math.max(Date.now() + SOON_MS, earliest);
    const bucket = Math.floor(runAt / REBUILD_WINDOW_MS);
    await enqueueRaw(QUEUES.template, "rebuildDictionary", { companyId, entity: "data_dictionary", entityId: companyId }, {
      jobId: `dict-${companyId}-${bucket}`,
      delay: runAt - Date.now(),
      removeOnComplete: true,
      removeOnFail: 100,
    });
  } catch (err) {
    console.error(`[dataDictionary] could not schedule a rebuild for company ${companyId}: ${err.message}`);
  }
}

/** Nightly: every company that has products or a dictionary. */
export async function rebuildAllDictionaries() {
  const withProducts = await prisma.product.findMany({ distinct: ["companyId"], select: { companyId: true } });
  const withDictionary = await prisma.dataDictionary.findMany({ select: { companyId: true } });
  const ids = [...new Set([...withProducts, ...withDictionary].map((r) => r.companyId))];
  const failed = [];
  for (const id of ids) {
    try {
      await buildDictionary(id);
    } catch (err) {
      failed.push({ companyId: id, error: err.message });
      console.error(`[dataDictionary] nightly rebuild failed for company ${id}: ${err.message}`);
    }
  }
  return { companies: ids.length, failed };
}
