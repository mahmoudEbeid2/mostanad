import catchAsync from "../utils/catchAsync.js";
import { isBypassed } from "../middleware/testBypass.js";
import * as assistant from "../services/assistant/assistantService.js";

// In-app assistant (C0/C1). The actor is the signed-in caller; everything the
// assistant reads goes through the registry as that caller.

/** The caller as the assistant sees it. */
export function actorFrom(req) {
  if (req.company) return { kind: "company", id: req.company.id, name: req.company.name, companyId: req.company.id };
  return {
    kind: "user",
    id: req.user.id,
    name: req.user.name || req.user.username || null,
    // null = every permission: the test bypass, which restrictToPermission also waves through
    permissions: isBypassed(req) ? null : (req.user.role?.permissions || []).map((rp) => rp.permission?.slug).filter(Boolean),
  };
}

export const status = catchAsync(async (req, res) => {
  const actor = actorFrom(req);
  const s = await assistant.settingsFor(assistant.scopeKeyOf(actor));
  res.status(200).json({ status: "success", data: { enabled: s.enabled, isSystem: actor.kind === "user", company: actor.kind === "company" ? { id: actor.companyId, name: actor.name } : null, limits: { messagesPerUserPerHour: s.messagesPerUserPerHour, modelCallsPerDay: s.modelCallsPerDay } } });
});

export const createConversation = catchAsync(async (req, res) => {
  const conversation = await assistant.createConversation(actorFrom(req), req.body || {});
  res.status(201).json({ status: "success", data: { conversation } });
});

export const listConversations = catchAsync(async (req, res) => {
  const actor = actorFrom(req);
  await assistant.assertEnabled(actor);
  res.status(200).json({ status: "success", data: await assistant.listConversations(actor, req.query) });
});

export const getConversation = catchAsync(async (req, res) => {
  const actor = actorFrom(req);
  await assistant.assertEnabled(actor);
  res.status(200).json({ status: "success", data: { conversation: await assistant.getConversation(actor, req.params.id) } });
});

export const deleteConversation = catchAsync(async (req, res) => {
  const actor = actorFrom(req);
  await assistant.assertEnabled(actor);
  await assistant.deleteConversation(actor, req.params.id);
  res.status(204).send();
});

/**
 * Accept: text/event-stream → Server-Sent Events: `status`, `tool_start`, `tool_end`,
 * then `message` (the stored answer) or `error`; otherwise one JSON response.
 * Errors before the first event (limits, switch, validation) are ordinary JSON errors.
 * The client closing the connection is the stop button: the loop stops before its next step.
 */
export const postMessage = catchAsync(async (req, res) => {
  const actor = actorFrom(req);
  const wantsStream = String(req.headers.accept || "").includes("text/event-stream");
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const send = (event, data) => {
    if (!res.headersSent) {
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
    }
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const onEvent = wantsStream ? (e) => send(e.type, e) : () => {};

  try {
    const out = await assistant.sendMessage(actor, req.params.id, req.body, { onEvent, signal: ac.signal });
    if (!wantsStream) return res.status(200).json({ status: "success", data: out });
    send("message", out);
    res.end();
  } catch (err) {
    if (!wantsStream || !res.headersSent) throw err;
    send("error", { message: err.message, statusCode: err.statusCode || 500 });
    res.end();
  }
});

/** "Load more" on a table block: the next page from the same tool, no model call. */
export const loadMore = catchAsync(async (req, res) => {
  const data = await assistant.loadMore(actorFrom(req), req.params.id, req.params.messageId, req.params.blockId);
  res.status(200).json({ status: "success", data });
});

// ── system admin: the per-company switch and limits ─────────────────────────
export const listSettings = catchAsync(async (req, res) => {
  res.status(200).json({ status: "success", data: await assistant.listSettings() });
});

export const updateSettings = catchAsync(async (req, res) => {
  const setting = await assistant.updateSettings(req.params.scopeKey, req.body, req.user?.id || null);
  res.status(200).json({ status: "success", data: { setting } });
});
