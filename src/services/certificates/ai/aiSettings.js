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

// A5 (plan.md §14.4, §12 Q6): inference from product data and web lookup are
// built but OFF until the owner enables them per company; webDomainAllowList
// lets a company accept extra source domains (§14.3, Q7).
//
// Fill automatically (owner, 2026-10-24, item 3): inference and web lookup are now ON
// by default, and a value proven by a verbatim quote — the product's own data, the
// invoice, the stored catalogue, the manufacturer's site or an official registry — is
// filled directly (fillVerifiedDirectly). Estimates (inference beyond a quote, a
// distributor's or allow-listed page) are filled and marked estimated: a person confirms
// them. Web cost limits: per check and per company per day.
export const AI_SETTINGS_DEFAULTS = Object.freeze({
  enabled: true,
  autoAccept: false,
  autoAcceptThreshold: 0.9,
  allowSynonyms: true,
  allowInvoiceGapFill: true,
  allowAiMatching: true,
  allowProductInference: true,
  allowWebLookup: true,
  fillVerifiedDirectly: true,
  rememberProductValues: true, // the per-product certificate profile (read before any AI step)
  webDomainAllowList: [],
  webLookupMaxProductsPerCheck: 10,
  webLookupDailyLimit: 30,
});

const BOOLEAN_KEYS = ["enabled", "autoAccept", "allowSynonyms", "allowInvoiceGapFill", "allowAiMatching", "allowProductInference", "allowWebLookup", "fillVerifiedDirectly", "rememberProductValues"];
const LIMIT_KEYS = { webLookupMaxProductsPerCheck: [0, 100], webLookupDailyLimit: [0, 1000] };
const MAX_ALLOWED_DOMAINS = 50;
/** "https://www.Example.com/x" / "example.com" → "example.com"; null when it isn't a host name. */
export function normalizeDomain(d) {
  const s = String(d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(s) ? s : null;
}

/** Stored JSON → complete settings (unknown keys dropped, bad values → defaults). */
export function withDefaults(stored) {
  const s = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  const out = { ...AI_SETTINGS_DEFAULTS };
  for (const k of BOOLEAN_KEYS) if (typeof s[k] === "boolean") out[k] = s[k];
  if (typeof s.autoAcceptThreshold === "number" && s.autoAcceptThreshold >= 0.5 && s.autoAcceptThreshold <= 1) out.autoAcceptThreshold = s.autoAcceptThreshold;
  for (const [k, [lo, hi]] of Object.entries(LIMIT_KEYS)) if (Number.isInteger(s[k]) && s[k] >= lo && s[k] <= hi) out[k] = s[k];
  if (Array.isArray(s.webDomainAllowList)) out.webDomainAllowList = [...new Set(s.webDomainAllowList.map(normalizeDomain).filter(Boolean))].slice(0, MAX_ALLOWED_DOMAINS);
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
    } else if (LIMIT_KEYS[k]) {
      const [lo, hi] = LIMIT_KEYS[k];
      if (!Number.isInteger(v) || v < lo || v > hi) problems.push(`${k} must be a whole number from ${lo} to ${hi}`);
    } else if (k === "webDomainAllowList") {
      if (!Array.isArray(v) || v.length > MAX_ALLOWED_DOMAINS) problems.push(`webDomainAllowList must be a list of at most ${MAX_ALLOWED_DOMAINS} domains`);
      else {
        const bad = v.filter((d) => !normalizeDomain(d));
        if (bad.length) problems.push(`not a domain: ${bad.slice(0, 5).join(", ")}`);
      }
    } else problems.push(`unknown setting "${k}"`);
  }
  if (problems.length) throw new CertError("INVALID_AI_SETTINGS", problems.join("; "), 400, { problems });
  const current = await getAiSettings(companyId);
  const next = withDefaults({ ...current, ...patch });
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
