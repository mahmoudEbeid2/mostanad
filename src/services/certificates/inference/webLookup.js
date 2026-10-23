import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { prisma } from "../../../lib/prisma.js";
import { runLogged, sha16, stableStringify } from "../ai/aiRunLog.js";
import { clampConfidence } from "../ai/aiSuggestions.js";
import { normalizeEvidence } from "../dataNeeds/evidenceVerifier.js";
import { PRODUCT_KNOWLEDGE_SOURCES } from "../../label/knowledge/authoritativeSources.js";
import { safeFetch } from "./safeFetch.js";
import { allowsWeb, isRegistrationField } from "./policy.js";

// Tier W (plan.md §14.3, A5): a product fact still missing after tiers 1/A2/I,
// looked up on the web with Google-Search grounding — ONE CERT_WEB_LOOKUP call
// per product (all its missing web-eligible fields at once), cached per company
// for 90 days. The model only points at pages; the SERVER fetches every cited
// page and accepts a value only when:
//   - the quote is on the page and the value inside the quote (normalised);
//   - the page names the product AND its manufacturer or brand (identity);
//   - the source ranks: official registry / manufacturer / allow-listed accepted,
//     distributor accepted with a warning, anything else rejected
//     (registration numbers: official registry only).
// Sent: product name, manufacturer, brand, origin, active ingredients, field
// labels. Never the invoice, the customer, prices or another tenant's data.

export const CACHE_KIND = "cert_product_fact";
export const CACHE_DAYS = 90;
const MAX_CITATIONS = 3;
const GENERIC = new Set(["company", "co", "ltd", "llc", "inc", "sa", "gmbh", "group", "the", "and", "feed", "pharma", "pharmaceutical", "pharmaceuticals", "veterinary", "vet", "animal", "health", "industries", "industry", "trading", "ticaret", "sti", "ltd.sti", "ic", "ve", "dis", "additives"]);
// official registries beyond the label engine's product-knowledge list
const EXTRA_REGISTRIES = ["medicines.health.europa.eu", "vmd.defra.gov.uk", "tarimorman.gov.tr", "dailymed.nlm.nih.gov"];

const INSTRUCTIONS = [
  "Find the requested facts about ONE veterinary / feed product on the web, using Google Search.",
  "Only use pages about THIS product (same name and the same manufacturer or brand). Prefer the manufacturer's own site and official registries.",
  "For each field return: found, value (exactly as written on the page), sourceType (manufacturer | official_registry | distributor | other),",
  "and citations: [{ url, title, quote }] where quote is an exact sentence from that page that contains the value.",
  "Never guess. If no page states it, found=false.",
  'Respond with ONLY raw JSON (no markdown): { "fields": [ { "label": "...", "found": true, "value": "...", "sourceType": "...", "citations": [ { "url": "...", "title": "...", "quote": "..." } ], "confidence": 0.0 } ] }',
].join("\n");
export const PROMPT_HASH = sha16(INSTRUCTIONS);

/** The real call: grounded search, JSON parsed from the text (search grounding can't use a response schema). */
async function defaultSearch({ contents }) {
  const res = await geminiClient.generateContentWithRetry({
    model: MODELS.CERT_WEB_LOOKUP.id,
    contents,
    config: { temperature: MODELS.CERT_WEB_LOOKUP.temperature, thinkingConfig: { thinkingBudget: MODELS.CERT_WEB_LOOKUP.thinkingBudget }, tools: [{ googleSearch: {} }] },
  });
  const text = String(res.text || "");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(`the web lookup answer was not JSON: ${text.slice(0, 200)}`);
  }
}

const alnum = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const tokens = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4 && !GENERIC.has(t));
const hostIn = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Does the page talk about THIS product? Its name, and its manufacturer or brand (§14.3 identity check). */
export function identityOk(pageText, product) {
  const page = alnum(pageText);
  const name = alnum(product.name);
  if (!name || !page.includes(name)) return false;
  const marks = [product.brand?.name, ...tokens(product.producer)].map(alnum).filter((x) => x.length >= 4);
  return marks.length > 0 && marks.some((m) => page.includes(m));
}

/** Source type, by the page's real host (code decides; the model's claim only counts for "distributor"). */
export function classifySource(host, product, claimed, allowList = []) {
  if (allowList.some((d) => hostIn(host, d))) return { type: "allow_listed", accepted: true };
  const registries = [...PRODUCT_KNOWLEDGE_SOURCES.flatMap((s) => s.domains), ...EXTRA_REGISTRIES];
  if (registries.some((d) => hostIn(host, d))) return { type: "official_registry", accepted: true };
  const h = alnum(host.replace(/\.(com|net|org|co|gov|edu)(\.[a-z]{2})?$|\.[a-z]{2,3}$/, ""));
  const marks = [product.brand?.name, ...tokens(product.producer)].map(alnum).filter((x) => x.length >= 4);
  if (marks.some((m) => h.includes(m))) return { type: "manufacturer", accepted: true };
  if (claimed === "distributor") return { type: "distributor", accepted: true, warning: "a distributor's page, not the manufacturer's — check it" };
  return { type: "other", accepted: false };
}

/**
 * Verifies one field's answer by fetching its citations. → { ok, value, citation, source } | { ok: false, reason, checks }
 * deps.fetchPage replaces safeFetch (tests).
 */
export async function verifyWebAnswer(answer, { product, field, allowList = [], fetchPage = safeFetch }) {
  const value = String(answer?.value ?? "").trim();
  if (!answer?.found || !value) return { ok: false, reason: "not found", checks: [] };
  const checks = [];
  for (const c of (Array.isArray(answer.citations) ? answer.citations : []).slice(0, MAX_CITATIONS)) {
    const quote = String(c?.quote || "").trim();
    if (!c?.url || !quote) {
      checks.push({ url: c?.url || null, ok: false, reason: "a citation needs a URL and a quote" });
      continue;
    }
    if (!normalizeEvidence(quote).includes(normalizeEvidence(value))) {
      checks.push({ url: c.url, ok: false, reason: "the value is not inside the quote" });
      continue;
    }
    const page = await fetchPage(c.url);
    if (!page.ok) {
      checks.push({ url: c.url, ok: false, reason: page.reason });
      continue;
    }
    if (!normalizeEvidence(page.text).includes(normalizeEvidence(quote))) {
      checks.push({ url: c.url, finalUrl: page.finalUrl, ok: false, reason: "the quote is not on the page" });
      continue;
    }
    if (!identityOk(page.text, product)) {
      checks.push({ url: c.url, finalUrl: page.finalUrl, ok: false, reason: "the page is not about this product (name and manufacturer/brand not both on it)" });
      continue;
    }
    const source = classifySource(page.host, product, answer.sourceType, allowList);
    if (!source.accepted) {
      checks.push({ url: c.url, finalUrl: page.finalUrl, ok: false, reason: `an untrusted source (${page.host}) — allow-list the domain to accept it` });
      continue;
    }
    if (isRegistrationField(field) && source.type !== "official_registry") {
      checks.push({ url: c.url, finalUrl: page.finalUrl, ok: false, reason: "registration numbers are only accepted from an official registry page" });
      continue;
    }
    const citation = { url: c.url, finalUrl: page.finalUrl, host: page.host, title: c.title ? String(c.title).slice(0, 200) : null, quote: quote.slice(0, 500), sourceType: source.type, ...(source.warning ? { warning: source.warning } : {}) };
    checks.push({ url: c.url, finalUrl: page.finalUrl, ok: true });
    return { ok: true, value, citation, source, checks };
  }
  return { ok: false, reason: checks.map((c) => c.reason).join("; ") || "no citation", checks };
}

export const cacheKey = (companyId, productId, labelNorm) => `${companyId}|${productId}|${labelNorm}`;

/** The cached answer for one product fact (unexpired, not rejected), or null. */
export async function cachedFact(companyId, productId, labelNorm) {
  const row = await prisma.externalKnowledgeCache.findUnique({ where: { kind_lookupKey: { kind: CACHE_KIND, lookupKey: cacheKey(companyId, productId, labelNorm) } } });
  if (!row || row.status === "rejected" || (row.expiresAt && row.expiresAt <= new Date())) return null;
  return row;
}

export async function storeFact(companyId, productId, labelNorm, { found, value = null, citation = null, label, reason = null }) {
  const data = {
    payload: { found, value, label, productId, ...(reason ? { reason } : {}) },
    summary: found ? `${label}: ${value}` : null,
    sourceType: citation?.sourceType || "none",
    sourceUrls: citation ? [citation.finalUrl || citation.url] : [],
    sourceIsAuthoritative: ["official_registry", "manufacturer"].includes(citation?.sourceType),
    citations: citation ? [citation] : [],
    confidence: found ? "medium" : "low",
    status: "unreviewed",
    retrievedAt: new Date(),
    expiresAt: new Date(Date.now() + CACHE_DAYS * 86_400_000),
  };
  const lookupKey = cacheKey(companyId, productId, labelNorm);
  return prisma.externalKnowledgeCache.upsert({ where: { kind_lookupKey: { kind: CACHE_KIND, lookupKey } }, create: { kind: CACHE_KIND, lookupKey, ...data }, update: { ...data, reviewedByUserId: null } });
}

/** The query sent for one product (§14.3 step 1) — product facts only. */
export function queryFor(product, fields) {
  const ingredients = Array.isArray(product.activeIngredients) ? product.activeIngredients.map((a) => a?.name ?? a?.Name).filter(Boolean).slice(0, 10) : [];
  return {
    product: { name: product.name, manufacturer: product.producer || null, brand: product.brand?.name || null, origin: product.origin || null, activeIngredients: ingredients },
    fields: fields.map((f) => ({ label: f.label, ...(f.dateFormat ? { format: f.dateFormat } : {}) })),
  };
}

/**
 * ONE web call for one product. fields: [{ label, labelNorm, field }]
 * → { results: Map(labelNorm → verdict + answer), run } — throws the model's error.
 */
export async function lookupProduct({ companyId, invoiceId, product, fields, allowList }, { search = defaultSearch, fetchPage = safeFetch } = {}) {
  const query = queryFor(product, fields);
  const contents = [INSTRUCTIONS, `Product and fields:\n${JSON.stringify(query)}`];
  const { result, run } = await runLogged(
    { companyId, kind: "CERT_WEB_LOOKUP", promptHash: PROMPT_HASH, inputHash: sha16(stableStringify(query)), entityType: "product", entityId: product.id, reason: `${fields.length} product fact(s) missing for invoice ${invoiceId}` },
    () => search({ contents, query })
  );
  const results = new Map();
  for (const f of fields) {
    const answer = (result?.fields || []).find((a) => alnum(a?.label) === alnum(f.label)) || null;
    const clean = answer ? { ...answer, confidence: clampConfidence(answer.confidence) } : null;
    const verdict = clean && allowsWeb(f.field) ? await verifyWebAnswer(clean, { product, field: f.field, allowList, fetchPage }) : { ok: false, reason: clean ? "this field may not be looked up on the web" : "the AI gave no answer", checks: [] };
    results.set(f.labelNorm, { answer: clean, verdict });
  }
  return { results, run, query };
}
