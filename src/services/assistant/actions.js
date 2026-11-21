import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { executeApproved } from "./registry/index.js";
import { presentError } from "../ai/aiErrorMessage.js";
import { draftForRun, markConfirmed, markExecuted, markFailed, draftCardCancelled } from "./drafts/draftService.js";

// Confirmation cards (C2). A card is made only from a ready draft (drafts/draftService.js): the exact
// args are stored with a hash; Run executes exactly those, as the person who
// pressed it, within 15 minutes; Cancel closes it. Every step is on the row (who
// asked, the card, who decided and when, the result) and in the tool-call audit.

export const ACTION_TTL_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** JSON with sorted keys: the same args always hash the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const argsHashOf = ({ tool, companyId, args }) => crypto.createHash("sha256").update(canonical({ tool, companyId, args })).digest("hex");

const owns = (actor, row) => row.ownerType === actor.kind && row.ownerId === actor.id;

export function actionView(row) {
  return {
    id: row.id,
    tool: row.tool,
    status: row.status,
    preview: row.preview,
    companyId: row.companyId,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedById ? (row.decidedById === row.ownerId ? "you" : row.decidedById) : null,
    taskId: row.taskId,
    result: row.result,
    error: row.error,
    messageId: row.messageId,
    draftId: row.draftId ?? null,
    createdAt: row.createdAt,
  };
}

/** A ready draft → a pending card. Called by the draft service (ctx.propose), never runs anything. */
export async function proposeAction({ conversationId, messageId, actor, tool, args, companyId, preview, draftId = null, now = new Date() }) {
  return prisma.assistantAction.create({
    data: { conversationId, messageId, draftId, ownerType: actor.kind, ownerId: actor.id, companyId, tool, args, argsHash: argsHashOf({ tool, companyId, args }), preview, status: "pending", expiresAt: new Date(now.getTime() + ACTION_TTL_MS) },
  });
}

async function loadOwnAction(actor, id) {
  const row = UUID.test(String(id)) ? await prisma.assistantAction.findUnique({ where: { id } }) : null;
  if (!row || !owns(actor, row)) throw new AppError("Action not found!", 404);
  const conv = await prisma.assistantConversation.findUnique({ where: { id: row.conversationId }, select: { deletedAt: true } });
  if (!conv || conv.deletedAt) throw new AppError("Action not found!", 404);
  return row;
}

const audit = (row, actor, status, { error = null, durationMs = 0 } = {}) =>
  prisma.assistantToolCall
    .create({ data: { conversationId: row.conversationId, messageId: row.messageId, ownerType: actor.kind, ownerId: actor.id, tool: row.tool, args: { actionId: row.id, ...row.args }, companyId: row.companyId, status, error, durationMs } })
    .catch((err) => console.error(`[assistant] audit row for action ${row.id} not written: ${err.message}`));

/**
 * Run: only the person who asked, only while pending and not expired, only with
 * args whose hash still matches what the card showed. → the card
 */
export async function approveAction(actor, id, { now = new Date() } = {}) {
  const row = await loadOwnAction(actor, id);
  if (row.status !== "pending") throw new AppError(`This action is already ${row.status}.`, 409);
  if (row.expiresAt <= now) {
    await prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
    await audit(row, actor, "expired");
    throw new AppError("This confirmation expired (15 minutes). Ask again to get a new one.", 410);
  }
  if (argsHashOf(row) !== row.argsHash) {
    await audit(row, actor, "refused", { error: "args changed after the card was shown" });
    throw new AppError("The action's details changed after it was shown, so it won't run. Ask again.", 409);
  }
  // only a ready, unchanged draft's card runs (no draft → no write)
  let draft;
  try {
    draft = await draftForRun(actor, row);
  } catch (err) {
    await audit(row, actor, err.statusCode === 410 ? "expired" : "refused", { error: err.message });
    if (err.statusCode === 410) await prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status: "expired" } });
    throw err;
  }
  // claim it: two clicks never run it twice
  const claimed = await prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status: "running", decidedByType: actor.kind, decidedById: actor.id, decidedAt: now } });
  if (!claimed.count) throw new AppError("This action is already being run.", 409);
  await markConfirmed(draft);
  const userTexts = (await prisma.assistantMessage.findMany({ where: { conversationId: row.conversationId, role: "user" }, select: { text: true } })).map((m) => m.text);
  const started = Date.now();
  try {
    const result = await executeApproved(row.tool, row.args, { actor, companyId: row.companyId, conversationId: row.conversationId, userTexts });
    const taskId = result?.taskId || null;
    await audit(row, actor, "approved_ok", { durationMs: Date.now() - started });
    await markExecuted(draft, result);
    return actionView(await prisma.assistantAction.update({ where: { id }, data: { status: taskId ? "running" : "done", taskId, result } }));
  } catch (err) {
    await audit(row, actor, "approved_error", { error: String(err.message).slice(0, 1000), durationMs: Date.now() - started });
    // back to the draft: the field(s) the error is about are marked, nothing is retried with other values
    const fields = await markFailed(draft, err.message);
    return actionView(await prisma.assistantAction.update({ where: { id }, data: { status: "failed", error: String(err.message).slice(0, 2000), result: { draftId: draft.id, fields } } }));
  }
}

export async function cancelAction(actor, id, { now = new Date() } = {}) {
  const row = await loadOwnAction(actor, id);
  if (row.status !== "pending") throw new AppError(`This action is already ${row.status}.`, 409);
  const done = await prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status: "cancelled", decidedByType: actor.kind, decidedById: actor.id, decidedAt: now } });
  if (!done.count) throw new AppError("This action was just decided.", 409);
  await audit(row, actor, "cancelled");
  await draftCardCancelled(row);
  return actionView(await prisma.assistantAction.findUnique({ where: { id } }));
}

/** A pending card retired by its draft (changed, cancelled, expired) — not the person's Cancel. */
export async function cancelPending(actor, id, reason, { status = "cancelled", now = new Date() } = {}) {
  const row = await prisma.assistantAction.findUnique({ where: { id } });
  if (!row || row.status !== "pending") return;
  const done = await prisma.assistantAction.updateMany({ where: { id, status: "pending" }, data: { status, decidedByType: actor.kind, decidedById: actor.id, decidedAt: now } });
  if (done.count) await audit(row, actor, status, { error: reason });
}

/**
 * A running card's background task, read from the existing task row (progress, stage,
 * message): when it finishes the card becomes done / failed. → { action, task }
 */
export async function refreshAction(actor, id) {
  const row = await loadOwnAction(actor, id);
  if (row.status !== "running" || !row.taskId) return { action: actionView(row), task: null };
  const task = await prisma.backgroundTask.findUnique({ where: { id: row.taskId } });
  if (!task || (task.companyId && task.companyId !== row.companyId)) return { action: actionView(row), task: null };
  const view = presentError({ id: task.id, status: task.status, progress: task.progress, stage: task.stage, stages: task.stages, message: task.message, error: task.error, result: null });
  if (task.status === "completed" || task.status === "failed") {
    const summary = task.result && typeof task.result === "object" ? Object.fromEntries(Object.entries(task.result).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 20)) : null;
    const updated = await prisma.assistantAction.update({
      where: { id },
      data: task.status === "completed" ? { status: "done", result: { ...(row.result || {}), task: summary } } : { status: "failed", error: view.error || "The job failed" },
    });
    return { action: actionView(updated), task: view };
  }
  return { action: actionView(row), task: view };
}

/** What the model is told when a card finished, so it can continue (an "event" turn). */
export function actionEventText(view) {
  const title = view.preview?.title || view.tool;
  const outcome = view.status === "done" ? "finished" : view.status === "failed" ? `failed: ${view.error}` : view.status;
  return `[action ${outcome}] "${title}" (${view.tool}). Result: ${JSON.stringify(view.result ?? {}).slice(0, 1500)}. Tell the user the outcome in one or two sentences (with the link) and offer the next step if there is one — as a new card only if they want it.`;
}
