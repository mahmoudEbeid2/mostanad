import { prisma } from "../../lib/prisma.js";
import { geminiDisabled } from "./geminiGuard.js";

// plan.md P8 — whether AI can answer right now, so the UI can say so up front
// (a banner, AI buttons disabled) instead of letting each action fail.
//
// The API process can't see the workers' in-memory state, so the shared
// signal is the ai_runs log: if the latest real attempt (any company — the
// key is shared) failed on the daily quota and nothing has succeeded since,
// AI is treated as unavailable until QUOTA_WINDOW_MS passes, then the next
// action probes again.
const QUOTA_WINDOW_MS = 6 * 60 * 60 * 1000;
const QUOTA_ERROR = /quota exhausted|RESOURCE_EXHAUSTED/i;

export const AI_STATUS_MESSAGES = {
  disabled: "AI is switched off on this server. Everything still works by hand.",
  no_key: "AI isn't set up on this server. Everything still works by hand.",
  quota: "AI has reached its daily limit. Everything still works by hand; AI comes back when the limit resets.",
};

const unavailable = (reason, since = null) => ({ available: false, reason, message: AI_STATUS_MESSAGES[reason], since });

/** → { available, reason: null|"disabled"|"no_key"|"quota", message, since } */
export async function getAiStatus({ now = Date.now() } = {}) {
  if (geminiDisabled()) return unavailable("disabled");
  if (!process.env.GEMINI_API_KEY) return unavailable("no_key");
  const last = await prisma.aiRun.findFirst({
    where: { outcome: { in: ["ok", "failed"] }, createdAt: { gte: new Date(now - QUOTA_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    select: { outcome: true, error: true, createdAt: true },
  });
  if (last?.outcome === "failed" && QUOTA_ERROR.test(last.error || "")) return unavailable("quota", last.createdAt.toISOString());
  return { available: true, reason: null, message: null, since: null };
}
