import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { runAgent } from "./agent/agentLoop.js";
import { geminiGenerate, ASSISTANT_MODEL } from "./agent/geminiTurn.js";
import { setAiCompany } from "../ai/aiContext.js";
import { runTool, getTool } from "./registry/index.js";
import { nextRows } from "./agent/blocks.js";
import { factsOf } from "./agent/grounding.js";
import { storeAttachments, attachmentView } from "./attachments.js";
import { proposeAction, actionView, refreshAction, actionEventText, cancelAction } from "./actions.js";
import { draftSession, openDraftsNote, conversationDrafts } from "./drafts/draftService.js";

// The assistant's conversations, messages, per-company switch and limits (C0).
// The actor is the signed-in caller (actorFrom in the controller): a company
// session or a system user. A conversation belongs to exactly one actor and is
// invisible to everyone else (another actor's id is a 404).

export const SYSTEM_SCOPE = "system";
export const DEFAULTS = {
  system: { enabled: true, messagesPerUserPerHour: Number(process.env.ASSISTANT_MESSAGES_PER_HOUR) || 30, modelCallsPerDay: Number(process.env.ASSISTANT_SYSTEM_CALLS_PER_DAY) || 300 },
  company: { enabled: false, messagesPerUserPerHour: Number(process.env.ASSISTANT_MESSAGES_PER_HOUR) || 30, modelCallsPerDay: Number(process.env.ASSISTANT_COMPANY_CALLS_PER_DAY) || 100 },
};
const PAGE_TYPES = ["product", "invoice", "certificate", "template", "label", "catalogue", "catalogue_version", "regulatory"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 4000;

const owner = (actor) => ({ ownerType: actor.kind, ownerId: actor.id });
/** Whose switch and limits apply: a company session → its company; a system user → "system". */
export const scopeKeyOf = (actor) => (actor.kind === "company" ? actor.companyId : SYSTEM_SCOPE);

// ── settings ────────────────────────────────────────────────────────────────
export async function settingsFor(scopeKey) {
  const row = await prisma.assistantSetting.findUnique({ where: { scopeKey } });
  const d = scopeKey === SYSTEM_SCOPE ? DEFAULTS.system : DEFAULTS.company;
  return {
    scopeKey,
    enabled: row ? row.enabled : d.enabled,
    messagesPerUserPerHour: row?.messagesPerUserPerHour ?? d.messagesPerUserPerHour,
    modelCallsPerDay: row?.modelCallsPerDay ?? d.modelCallsPerDay,
    isDefault: !row,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Admin: every company's switch (+ the system row). */
export async function listSettings() {
  const [companies, rows] = await Promise.all([prisma.company.findMany({ select: { id: true, name: true, isActive: true }, orderBy: { name: "asc" } }), prisma.assistantSetting.findMany()]);
  const byKey = new Map(rows.map((r) => [r.scopeKey, r]));
  const view = (scopeKey, d, extra) => {
    const r = byKey.get(scopeKey);
    return { scopeKey, ...extra, enabled: r ? r.enabled : d.enabled, messagesPerUserPerHour: r?.messagesPerUserPerHour ?? d.messagesPerUserPerHour, modelCallsPerDay: r?.modelCallsPerDay ?? d.modelCallsPerDay, isDefault: !r };
  };
  return { system: view(SYSTEM_SCOPE, DEFAULTS.system, { name: "System users" }), companies: companies.map((c) => view(c.id, DEFAULTS.company, { companyId: c.id, name: c.name, isActive: c.isActive })) };
}

export async function updateSettings(scopeKey, { enabled, messagesPerUserPerHour, modelCallsPerDay }, userId = null) {
  if (scopeKey !== SYSTEM_SCOPE && !(await prisma.company.findUnique({ where: { id: scopeKey }, select: { id: true } }))) throw new AppError("Company not found!", 404);
  const current = await settingsFor(scopeKey);
  const data = {
    enabled: enabled ?? current.enabled,
    ...(messagesPerUserPerHour !== undefined ? { messagesPerUserPerHour } : {}),
    ...(modelCallsPerDay !== undefined ? { modelCallsPerDay } : {}),
    updatedByUserId: userId,
  };
  await prisma.assistantSetting.upsert({ where: { scopeKey }, create: { scopeKey, ...data }, update: data });
  return settingsFor(scopeKey);
}

/** 403 when the assistant is switched off for this caller. */
export async function assertEnabled(actor) {
  const s = await settingsFor(scopeKeyOf(actor));
  if (!s.enabled) throw new AppError("The assistant is not switched on for your company. Ask a system administrator to enable it.", 403);
  return s;
}

const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** What this caller may still spend now. → { settings, messagesLastHour, modelCallsToday, remainingModelCalls } (throws 429 when over) */
export async function checkLimits(actor, now = new Date()) {
  const settings = await assertEnabled(actor);
  const scopeKey = scopeKeyOf(actor);
  const [messagesLastHour, calls] = await Promise.all([
    prisma.assistantMessage.count({ where: { role: "user", createdAt: { gte: new Date(now.getTime() - 3_600_000) }, conversation: owner(actor) } }),
    prisma.assistantMessage.aggregate({ where: { scopeKey, role: "assistant", createdAt: { gte: startOfUtcDay(now) } }, _sum: { modelCalls: true } }),
  ]);
  const modelCallsToday = calls._sum.modelCalls || 0;
  if (messagesLastHour >= settings.messagesPerUserPerHour) throw new AppError(`You've sent ${messagesLastHour} messages to the assistant in the last hour (limit ${settings.messagesPerUserPerHour}). Try again later.`, 429);
  if (modelCallsToday >= settings.modelCallsPerDay) throw new AppError(`The assistant has used today's ${settings.modelCallsPerDay} AI calls for ${scopeKey === SYSTEM_SCOPE ? "system users" : "your company"}. It resets at 00:00 UTC.`, 429);
  return { settings, messagesLastHour, modelCallsToday, remainingModelCalls: settings.modelCallsPerDay - modelCallsToday };
}

// ── conversations ───────────────────────────────────────────────────────────
async function companyName(id) {
  return id ? (await prisma.company.findUnique({ where: { id }, select: { name: true } }))?.name ?? null : null;
}

/** The scope a system user asked for: a company id that exists, or null (all companies). */
async function systemScope(companyId) {
  if (companyId === undefined || companyId === null || companyId === "all") return null;
  if (!UUID.test(String(companyId)) || !(await prisma.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new AppError("Company not found!", 404);
  return companyId;
}

const scopeFor = async (actor, requested) => (actor.kind === "company" ? actor.companyId : systemScope(requested));

const conversationView = async (c) => ({ id: c.id, title: c.title, companyId: c.companyId, companyName: await companyName(c.companyId), createdAt: c.createdAt, updatedAt: c.updatedAt });

export async function createConversation(actor, { companyId } = {}) {
  await assertEnabled(actor);
  const c = await prisma.assistantConversation.create({ data: { ...owner(actor), companyId: await scopeFor(actor, companyId) } });
  return conversationView(c);
}

export async function listConversations(actor, { page = 1, limit = 30 } = {}) {
  const take = Math.min(Number(limit) || 30, 100);
  const where = { ...owner(actor), deletedAt: null };
  const [total, rows] = await Promise.all([
    prisma.assistantConversation.count({ where }),
    prisma.assistantConversation.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (Math.max(Number(page) || 1, 1) - 1) * take, take }),
  ]);
  return { total, conversations: await Promise.all(rows.map(conversationView)) };
}

async function loadOwn(actor, id) {
  const c = UUID.test(String(id)) ? await prisma.assistantConversation.findUnique({ where: { id } }) : null;
  if (!c || c.deletedAt || c.ownerType !== actor.kind || c.ownerId !== actor.id) throw new AppError("Conversation not found!", 404);
  return c;
}

const messageView = (m, actions = []) => ({
  id: m.id, role: m.role, text: m.text, attachments: m.attachments || [], actions: actions.filter((a) => a.messageId === m.id).map(actionView), companyId: m.companyId, page: m.page, toolCalls: m.toolCalls, links: m.links, blocks: m.blocks || [], grounding: m.grounding || null, error: m.error, modelId: m.modelId,
  modelCalls: m.modelCalls, tokens: { input: m.inputTokens, cached: m.cachedTokens, output: m.outputTokens, thinking: m.thinkingTokens }, costUsd: m.costUsd === null ? null : Number(m.costUsd), createdAt: m.createdAt,
});

export async function getConversation(actor, id) {
  const c = await loadOwn(actor, id);
  const [messages, actions] = await Promise.all([
    prisma.assistantMessage.findMany({ where: { conversationId: id, supersededAt: null }, orderBy: { createdAt: "asc" } }),
    prisma.assistantAction.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" } }),
  ]);
  return { ...(await conversationView(c)), messages: messages.map((m) => messageView(m, actions)), drafts: await conversationDrafts(actor, id) };
}

export async function deleteConversation(actor, id) {
  await loadOwn(actor, id);
  await prisma.assistantConversation.update({ where: { id }, data: { deletedAt: new Date() } });
}

function pageOf(page) {
  if (!page || typeof page !== "object") return null;
  const route = typeof page.route === "string" ? page.route.slice(0, 200) : null;
  const ok = PAGE_TYPES.includes(page.entityType) && UUID.test(String(page.entityId || ""));
  return { route, ...(ok ? { entityType: page.entityType, entityId: page.entityId } : {}) };
}

/** The ledger's cost of one message (null when any of its calls is unpriced). */
async function messageCost(conversationId, messageId) {
  const rows = await prisma.aiCall.findMany({ where: { entityType: "assistant_conversation", entityId: conversationId, meta: { path: ["messageId"], equals: messageId } }, select: { costUsd: true } });
  if (!rows.length || rows.some((r) => r.costUsd === null)) return null;
  return rows.reduce((n, r) => n + Number(r.costUsd), 0);
}

/**
 * POST /assistant/conversations/:id/messages. onEvent streams progress; signal stops it.
 * deps.generate replaces the model (tests). → the stored assistant message
 */
/**
 * POST …/attachments: files for this conversation, stored in its company (a company
 * session: its own; a system user: the conversation's picked company — never "All").
 */
export async function uploadAttachments(actor, conversationId, files, { companyId } = {}) {
  await assertEnabled(actor);
  const conv = await loadOwn(actor, conversationId);
  let scope = actor.kind === "company" ? actor.companyId : companyId !== undefined ? await systemScope(companyId) : conv.companyId;
  if (actor.kind === "user" && scope !== conv.companyId) await prisma.assistantConversation.update({ where: { id: conversationId }, data: { companyId: scope } });
  return storeAttachments({ conversationId, companyId: scope, actor, files });
}

/**
 * editOf: a user message of this conversation to edit or resend — it and every message after it
 * are hidden (supersededAt) and this message takes their place. Its files and page are kept
 * unless the body gives others. Hidden messages still count against the limits.
 */
export async function sendMessage(actor, conversationId, { text, page, companyId, attachmentIds, editOf = null }, { onEvent = () => {}, signal = null, generate = null, eventFor = null } = {}) {
  const conv = await loadOwn(actor, conversationId);
  const body = String(text || "").trim();
  if (!body) throw new AppError("Type a message", 400);
  if (body.length > MAX_TEXT) throw new AppError(`A message can be at most ${MAX_TEXT} characters`, 400);
  const edited = editOf && UUID.test(String(editOf)) ? await prisma.assistantMessage.findFirst({ where: { id: editOf, conversationId, role: "user", supersededAt: null } }) : null;
  if (editOf && !edited) throw new AppError("Message not found!", 404);
  if (edited) {
    attachmentIds ??= (Array.isArray(edited.attachments) ? edited.attachments : []).map((a) => a.id).filter(Boolean);
    page ??= edited.page;
  }
  attachmentIds ??= [];
  const limits = await checkLimits(actor);

  // the scope: a company session → its company, always; a system user may switch it per message
  const scope = actor.kind === "company" ? actor.companyId : companyId !== undefined ? await systemScope(companyId) : conv.companyId;
  const scopeKey = scopeKeyOf(actor);
  const pg = pageOf(page);
  // files sent with this message: this conversation's, in this message's company
  const files = attachmentIds.length ? await prisma.assistantAttachment.findMany({ where: { id: { in: attachmentIds.filter((x) => UUID.test(String(x))) }, conversationId } }) : [];
  if (files.length !== new Set(attachmentIds).size) throw new AppError("Attachment not found!", 404);
  if (files.some((a) => a.companyId !== scope)) throw new AppError(scope ? "These files belong to another company than the one picked — attach them again." : "Pick a company first: files belong to one company, not \"All companies\".", 400);
  if (edited) await supersedeFrom(actor, edited);
  const history = await prisma.assistantMessage.findMany({ where: { conversationId, error: null, supersededAt: null }, orderBy: { createdAt: "desc" }, take: 10, select: { role: true, text: true, links: true, toolCalls: true } });
  // what later answers are checked against: every tool result of this conversation
  const earlierFacts = (await prisma.assistantMessage.findMany({ where: { conversationId, role: "assistant", facts: { not: null }, supersededAt: null }, select: { facts: true }, orderBy: { createdAt: "desc" }, take: 30 })).map((m) => m.facts);
  const userMsg = await prisma.assistantMessage.create({ data: { conversationId, role: eventFor ? "event" : "user", text: body, scopeKey, companyId: scope, page: pg ?? undefined, attachments: files.length ? files.map(attachmentView) : undefined } });
  // editing the first message renames the conversation, as sending it did
  const retitle = !eventFor && (!conv.title || (edited && !(await prisma.assistantMessage.count({ where: { conversationId, role: "user", supersededAt: null, id: { not: userMsg.id } } }))));
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { companyId: scope, ...(retitle ? { title: body.slice(0, 80) } : {}) } });
  // the person's own words: the only source (besides a supplier COA) for lab results and batch facts
  const userTexts = (await prisma.assistantMessage.findMany({ where: { conversationId, role: "user", supersededAt: null }, select: { text: true } })).map((m) => m.text);
  const proposed = [];

  setAiCompany(scope); // bill this message's calls to its scope; null = all companies (not body.companyId "all")
  const replyId = crypto.randomUUID();
  const ledger = { companyId: scope, userId: actor.kind === "user" ? actor.id : null, entityId: conversationId, meta: { messageId: replyId } };
  const ctx = {
    actor,
    scope: { companyId: scope, companyName: await companyName(scope) },
    drafts: null,
    page: pg,
    companyExists: async (id) => UUID.test(String(id)) && !!(await prisma.company.findUnique({ where: { id }, select: { id: true } })),
    knownRefs: history.flatMap((m) => (Array.isArray(m.links) ? m.links : [])),
    facts: earlierFacts,
    conversationId,
    userTexts,
    attachments: files.map(attachmentView),
    propose: async (p) => {
      const row = await proposeAction({ conversationId, messageId: replyId, actor, ...p });
      proposed.push(row);
      onEvent({ type: "action", action: actionView(row) });
      return row;
    },
    // operation drafts: the cards come from them; the UI's draft card updates live
    messageId: replyId,
    ledgerMeta: ledger.meta,
    onDraft: (draft) => onEvent({ type: "draft", draft }),
    openDrafts: await openDraftsNote(actor, conversationId),
    // an "[action …]" turn reports a finished card: saying it was done is true there
    isEvent: !!eventFor,
    proposedCount: () => proposed.length,
    // the modules this conversation was just using (last turns' tools, open drafts and cards)
    stickyModules: await stickyModules(actor, conversationId, history),
    audit: (e) => prisma.assistantToolCall.create({ data: { conversationId, messageId: replyId, ...owner(actor), tool: e.tool, args: e.args ?? undefined, companyId: e.companyId, status: e.status, error: e.error, durationMs: Math.round(e.durationMs) } }).catch((err) => console.error(`[assistant] audit row for ${e.tool} not written: ${err.message}`)),
  };
  ctx.drafts = draftSession(ctx);
  const result = await runAgent({
    text: body,
    history: history.reverse().map(({ role, text: t, toolCalls }) => ({ role, text: t, toolCalls })),
    ctx,
    generate: generate || geminiGenerate(ledger),
    onEvent,
    signal,
    limits: { maxModelCalls: Math.max(1, Math.min(Number(process.env.ASSISTANT_MAX_MODEL_CALLS) || 8, limits.remainingModelCalls)) },
  });

  const error = result.error ? result.error : result.stopped ? "Stopped." : null;
  const reply = await prisma.assistantMessage.create({
    data: {
      id: replyId,
      conversationId,
      role: "assistant",
      text: result.text || "",
      scopeKey,
      companyId: scope,
      toolCalls: result.toolCalls,
      links: result.refs,
      blocks: result.blocks?.length ? result.blocks : undefined,
      facts: result.facts || null,
      grounding: result.grounding || result.guard ? { ...(result.grounding || {}), ...(result.guard ? { guard: result.guard } : {}) } : undefined,
      error,
      modelId: ASSISTANT_MODEL.id,
      modelCalls: result.modelCalls,
      ...result.usage,
      costUsd: await messageCost(conversationId, replyId),
    },
  });
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { userMessageId: userMsg.id, message: messageView(reply, proposed) };
}

/** The read a finished card's outcome needs (a rebuilt label's fields to confirm), run as the person. → { tool, data } | null */
const FOLLOW_UP = {
  upload_label_and_resize: (r) => (r?.uploadId ? ["get_label_upload", { uploadId: r.uploadId }] : null),
  confirm_label_upload: (r) => (r?.labelLayout?.labelId ? ["get_label_layout", { labelId: r.labelLayout.labelId }] : null),
};
export async function followUpRead(actor, action) {
  const pick = action.status === "done" && FOLLOW_UP[action.tool]?.(action.result);
  if (!pick) return null;
  const [tool, args] = pick;
  const r = await runTool(tool, args, { actor, scope: { companyId: action.companyId }, companyExists: async () => true });
  return r.ok ? { tool, data: r.data } : null;
}

/** Modules of the tools the last 4 answers used, of the open drafts and of cards not yet done. */
export async function stickyModules(actor, conversationId, history = []) {
  const names = new Set();
  for (const m of history.filter((x) => x.role === "assistant").slice(0, 4)) for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) if (c?.name) names.add(c.name);
  const [drafts, cards] = await Promise.all([
    prisma.assistantDraft.findMany({ where: { conversationId, ownerType: actor.kind, ownerId: actor.id, status: { in: ["collecting", "ready"] } }, select: { tool: true }, take: 20 }),
    prisma.assistantAction.findMany({ where: { conversationId, status: { in: ["pending", "running"] } }, select: { tool: true }, take: 20 }),
  ]);
  for (const r of [...drafts, ...cards]) names.add(r.tool);
  return [...new Set([...names].map((n) => getTool(n)?.module).filter((m) => m && m !== "assistant"))];
}

/** Hides `from` and every later message of its conversation; their cards still waiting for Run are cancelled (audited as a Cancel). */
async function supersedeFrom(actor, from) {
  const later = await prisma.assistantMessage.findMany({ where: { conversationId: from.conversationId, supersededAt: null, createdAt: { gte: from.createdAt } }, select: { id: true } });
  const ids = later.map((m) => m.id);
  await prisma.assistantMessage.updateMany({ where: { id: { in: ids } }, data: { supersededAt: new Date() } });
  const pending = await prisma.assistantAction.findMany({ where: { conversationId: from.conversationId, messageId: { in: ids }, status: "pending" }, select: { id: true } });
  for (const a of pending) {
    try {
      await cancelAction(actor, a.id);
    } catch (err) {
      if (err.statusCode !== 409) throw err; // decided meanwhile (Run or Cancel won the race): leave it as decided
    }
  }
}

/**
 * POST …/actions/:actionId/continue: a card finished (done / failed) → an "event" turn
 * telling the model the result, so it can say so and offer the next step.
 */
export async function continueAfterAction(actor, conversationId, actionId, opts = {}) {
  const { action } = await refreshAction(actor, actionId);
  if (action.status === "running" || action.status === "pending") throw new AppError("The action hasn't finished yet.", 409);
  const row = await prisma.assistantAction.findUnique({ where: { id: actionId }, select: { conversationId: true } });
  if (row.conversationId !== conversationId) throw new AppError("Action not found!", 404);
  // what the person must see next is read here, in code, so the answer can show it (QA: "سأقوم الآن بالتحقق" and nothing)
  const followUp = await followUpRead(actor, action);
  return sendMessage(actor, conversationId, { text: actionEventText(action, followUp), page: null }, { ...opts, eventFor: actionId });
}

/**
 * POST …/messages/:messageId/blocks/:blockId/more — the next page of a table block:
 * the same tool, the same arguments, page = the block's cursor, run as the caller.
 * No model call. The rows are kept on the message (and become facts later answers
 * may use). → { block }
 */
export const SHOW_ALL_MAX = 200;

export async function loadMore(actor, conversationId, messageId, blockId, { all = false } = {}) {
  await assertEnabled(actor);
  await loadOwn(actor, conversationId);
  const msg = UUID.test(String(messageId)) ? await prisma.assistantMessage.findFirst({ where: { id: messageId, conversationId, role: "assistant" } }) : null;
  const blocks = Array.isArray(msg?.blocks) ? msg.blocks : [];
  const block = blocks.find((b) => b.id === blockId);
  if (!block) throw new AppError("Table not found!", 404);
  if (!block.nextPage) return { block };
  const ctx = {
    actor,
    scope: { companyId: actor.kind === "company" ? actor.companyId : block.companyId },
    companyExists: async (id) => UUID.test(String(id)) && !!(await prisma.company.findUnique({ where: { id }, select: { id: true } })),
    audit: (e) => prisma.assistantToolCall.create({ data: { conversationId, messageId, ...owner(actor), tool: e.tool, args: e.args ?? undefined, companyId: e.companyId, status: e.status, error: e.error, durationMs: Math.round(e.durationMs) } }).catch((err) => console.error(`[assistant] audit row for ${e.tool} not written: ${err.message}`)),
  };
  if (all && (block.total ?? 0) > SHOW_ALL_MAX) throw new AppError(`Show all is for up to ${SHOW_ALL_MAX} rows (this list has ${block.total}) — use Load more`, 400);
  let updated = block;
  const newFacts = [];
  // "Show all": the same tool, page after page, until the cursor runs out (≤ SHOW_ALL_MAX rows)
  do {
    const result = await runTool(block.tool, { ...block.args, page: updated.nextPage }, ctx);
    if (!result.ok) throw new AppError(result.error || "Couldn't load more rows", result.status === "refused" ? 403 : 400);
    const next = nextRows(updated, result.data);
    updated = { ...updated, rows: [...updated.rows, ...next.rows], more: next.more, nextPage: next.nextPage, total: next.total };
    newFacts.push(...factsOf(result.data));
  } while (all && updated.nextPage && updated.rows.length < SHOW_ALL_MAX);
  const facts = [msg.facts || "", ...newFacts].join("\n").slice(0, 200_000);
  await prisma.assistantMessage.update({ where: { id: messageId }, data: { blocks: blocks.map((b) => (b.id === blockId ? updated : b)), facts } });
  return { block: updated, added: updated.rows.length - block.rows.length };
}
