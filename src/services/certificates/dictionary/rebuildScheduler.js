import { prisma } from "../../../lib/prisma.js";
import { QUEUES, enqueueRaw } from "../jobs/queues.js";
import { buildDictionary } from "./dataDictionary.js";

// When a company's data dictionary is rebuilt (plan.md §3.2): lazily on first
// use (getDictionary), after every product change, and nightly. Rebuilds run
// on the template worker; they read products only (no AI).
//
// After a product change the rebuild is debounced, not throttled: it runs
// DEBOUNCE_MS after the LAST save, so a burst (a catalogue apply) is one
// rebuild and a single edit shows up in the source picker within seconds.
// (It used to be at most one rebuild per 10 minutes — a product created right
// after the wizard opened stayed invisible for up to 10 minutes.)

export const DEBOUNCE_MS = 5000;

/**
 * Schedules a rebuild after a product change: one delayed job per company;
 * each further save replaces it and restarts the delay (BullMQ deduplication,
 * extend + replace). Never fails the caller's product write: a scheduling
 * error is logged and the nightly rebuild catches up.
 */
export async function scheduleDictionaryRebuild(companyId) {
  if (!companyId) return;
  try {
    await enqueueRaw(QUEUES.template, "rebuildDictionary", { companyId, entity: "data_dictionary", entityId: companyId }, {
      delay: DEBOUNCE_MS,
      deduplication: { id: `dict-${companyId}`, ttl: DEBOUNCE_MS, extend: true, replace: true },
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
