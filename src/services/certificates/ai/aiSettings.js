import { prisma } from "../../../lib/prisma.js";
import { CertError, notFound } from "../errors.js";

// Per-company settings for the certificate AI layers (plan.md §3.3), stored
// in Company.aiSettings (null = all defaults). Every AI path checks these
// before calling the model; with `enabled: false` everything still works by
// hand (P8).
//
// autoAccept: plan.md §12 Q1's default — every AI suggestion is confirmed by
// a person until the owner turns auto-accept on; from then on a suggestion at
// or above autoAcceptThreshold (and with verified evidence, P2/P4) is
// accepted without a click.

export const AI_SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  autoAccept: false,
  autoAcceptThreshold: 0.9,
  allowSynonyms: true,
  allowInvoiceGapFill: true,
  allowAiMatching: true,
});

const BOOLEAN_KEYS = ["enabled", "autoAccept", "allowSynonyms", "allowInvoiceGapFill", "allowAiMatching"];

/** Stored JSON → complete settings (unknown keys dropped, bad values → defaults). */
export function withDefaults(stored) {
  const s = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = { ...AI_SETTINGS_DEFAULTS };
  for (const k of BOOLEAN_KEYS) if (typeof s[k] === "boolean") out[k] = s[k];
  if (typeof s.autoAcceptThreshold === "number" && s.autoAcceptThreshold >= 0.5 && s.autoAcceptThreshold <= 1) out.autoAcceptThreshold = s.autoAcceptThreshold;
  return out;
}

export async function getAiSettings(companyId) {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { aiSettings: true } });
  if (!company) throw notFound("Company");
  return withDefaults(company.aiSettings);
}

/** PATCH semantics: only the given keys change. → the complete settings. */
export async function updateAiSettings(companyId, patch) {
  const problems = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (BOOLEAN_KEYS.includes(k)) {
      if (typeof v !== "boolean") problems.push(`${k} must be true or false`);
    } else if (k === "autoAcceptThreshold") {
      if (typeof v !== "number" || v < 0.5 || v > 1) problems.push("autoAcceptThreshold must be a number from 0.5 to 1");
    } else problems.push(`unknown setting "${k}"`);
  }
  if (problems.length) throw new CertError("INVALID_AI_SETTINGS", problems.join("; "), 400, { problems });
  const current = await getAiSettings(companyId);
  const next = { ...current, ...patch };
  await prisma.company.update({ where: { id: companyId }, data: { aiSettings: next } });
  return next;
}

/** Whether a layer may call the model: the master switch plus the layer's own flag. */
export function aiAllowed(settings, layer) {
  if (!settings.enabled) return false;
  return layer ? settings[layer] !== false : true;
}

/**
 * The status a fresh suggestion gets (plan.md P4): auto_accepted only when
 * auto-accept is on, confidence ≥ threshold and — when the suggestion carries
 * evidence — that evidence was verified by code.
 */
export function initialStatus(settings, { confidence, evidenceVerified = null }) {
  if (!settings.autoAccept) return "pending";
  if (evidenceVerified === false) return "pending";
  return confidence >= settings.autoAcceptThreshold ? "auto_accepted" : "pending";
}
