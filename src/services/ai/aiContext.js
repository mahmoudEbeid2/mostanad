import { AsyncLocalStorage } from "node:async_hooks";

// AI cost ledger: who and what a Gemini call is for — company, user, feature,
// entity — travels with the async context to geminiClient, the one place that
// writes the ledger row. Entry points set what they know (an HTTP request: the
// caller; a BullMQ job: its company/user; runLogged: the certificate
// operation), inner layers add to it, and a call site may still pass its own
// `ledger` values, which win. Same technique as generationMetrics.js.

const als = new AsyncLocalStorage();
const KEYS = ["companyId", "userId", "feature", "entityType", "entityId", "parentType", "parentId", "aiRunId", "meta"]; // meta: call-site detail (JSON), e.g. a catalogue call's pages

const pick = (o = {}) => Object.fromEntries(KEYS.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, o[k]]));

/** Runs fn with ctx layered over the current context (inner values win). */
export function withAiContext(ctx, fn) {
  return als.run({ ...(als.getStore() || {}), ...pick(ctx) }, fn);
}

/**
 * Express: one mutable context per request, opened before the routes, so
 * `setAiActor` (called by `protect` once it knows the caller) reaches every
 * call the request makes.
 */
export function aiRequestContext(req, res, next) {
  als.run({}, next);
}

/** Fills in the caller on the current request's context (no-op outside one). */
export function setAiActor({ companyId, userId } = {}) {
  const store = als.getStore();
  if (!store) return;
  if (companyId && !store.companyId) store.companyId = companyId;
  if (userId && !store.userId) store.userId = userId;
}

/**
 * Sets values on the current context once a service knows them (e.g. the
 * label it just loaded: its company and id). Unlike setAiActor these win over
 * what the request set. No-op outside a context.
 */
export function assignAiContext(ctx) {
  const store = als.getStore();
  if (store) Object.assign(store, pick(ctx));
}

/** The current context merged with a call site's own values. */
export function currentAiContext(overrides = {}) {
  return { ...(als.getStore() || {}), ...pick(overrides) };
}

/**
 * BullMQ: runs a job's processor with the company/user the job carries, and
 * its background task as the default entity (runLogged and call sites that
 * know the real entity — an invoice, a label — override it).
 */
export function withAiJobContext(job, fn) {
  const d = job?.data || {};
  return withAiContext(
    { companyId: d.companyId, userId: d.userId ?? d.createdByUserId ?? d.requestedByUserId, ...(d.taskId ? { entityType: "background_task", entityId: d.taskId } : {}) },
    fn
  );
}
