import { prisma } from "../../lib/prisma.js";
import AppError from "../../utils/appError.js";
import { runAgent } from "./agent/agentLoop.js";
import { geminiGenerate, ASSISTANT_MODEL } from "./agent/geminiTurn.js";

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

const messageView = (m) => ({
  id: m.id, role: m.role, text: m.text, companyId: m.companyId, page: m.page, toolCalls: m.toolCalls, links: m.links, error: m.error, modelId: m.modelId,
  modelCalls: m.modelCalls, tokens: { input: m.inputTokens, cached: m.cachedTokens, output: m.outputTokens, thinking: m.thinkingTokens }, costUsd: m.costUsd === null ? null : Number(m.costUsd), createdAt: m.createdAt,
});

export async function getConversation(actor, id) {
  const c = await loadOwn(actor, id);
  const messages = await prisma.assistantMessage.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" } });
  return { ...(await conversationView(c)), messages: messages.map(messageView) };
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
export async function sendMessage(actor, conversationId, { text, page, companyId }, { onEvent = () => {}, signal = null, generate = null } = {}) {
  const conv = await loadOwn(actor, conversationId);
  const body = String(text || "").trim();
  if (!body) throw new AppError("Type a message", 400);
  if (body.length > MAX_TEXT) throw new AppError(`A message can be at most ${MAX_TEXT} characters`, 400);
  const limits = await checkLimits(actor);

  // the scope: a company session → its company, always; a system user may switch it per message
  const scope = actor.kind === "company" ? actor.companyId : companyId !== undefined ? await systemScope(companyId) : conv.companyId;
  const scopeKey = scopeKeyOf(actor);
  const pg = pageOf(page);
  const history = await prisma.assistantMessage.findMany({ where: { conversationId, error: null }, orderBy: { createdAt: "desc" }, take: 10, select: { role: true, text: true, links: true } });
  const userMsg = await prisma.assistantMessage.create({ data: { conversationId, role: "user", text: body, scopeKey, companyId: scope, page: pg ?? undefined } });
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { companyId: scope, ...(conv.title ? {} : { title: body.slice(0, 80) }) } });

  const replyId = crypto.randomUUID();
  const ledger = { companyId: scope, userId: actor.kind === "user" ? actor.id : null, entityId: conversationId, meta: { messageId: replyId } };
  const ctx = {
    actor,
    scope: { companyId: scope, companyName: await companyName(scope) },
    page: pg,
    companyExists: async (id) => UUID.test(String(id)) && !!(await prisma.company.findUnique({ where: { id }, select: { id: true } })),
    knownRefs: history.flatMap((m) => (Array.isArray(m.links) ? m.links : [])),
    audit: (e) => prisma.assistantToolCall.create({ data: { conversationId, messageId: replyId, ...owner(actor), tool: e.tool, args: e.args ?? undefined, companyId: e.companyId, status: e.status, error: e.error, durationMs: Math.round(e.durationMs) } }).catch((err) => console.error(`[assistant] audit row for ${e.tool} not written: ${err.message}`)),
  };
  const result = await runAgent({
    text: body,
    history: history.reverse().map(({ role, text: t }) => ({ role, text: t })),
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
      error,
      modelId: ASSISTANT_MODEL.id,
      modelCalls: result.modelCalls,
      ...result.usage,
      costUsd: await messageCost(conversationId, replyId),
    },
  });
  await prisma.assistantConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { userMessageId: userMsg.id, message: messageView(reply) };
}
