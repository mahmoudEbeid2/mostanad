import { prisma } from "../../../lib/prisma.js";
import geminiClient from "../../ai/geminiClient.js";
import { MODELS } from "../../ai/modelRegistry.js";
import { isAllowedKnowledgeHost } from "./authoritativeSources.js";

const CACHE_TTL_DAYS = 90;

// §9.5's grounded-claim acceptance check: host must be on the allowlist, and
// the quoted span must be non-trivial (not a one-word coincidental match).
export function acceptGroundedClaim(annotation, fullText) {
  if (!annotation?.url) return null;
  if (!isAllowedKnowledgeHost(annotation.url)) return null;
  const quoted = fullText.slice(annotation.start_index ?? 0, annotation.end_index ?? 0);
  if (!quoted || quoted.length < 40) return null;
  return { url: annotation.url, quotedText: quoted };
}

async function defaultSearch(lookupKey, kind) {
  const prompt = `
Find authoritative, citable information for this veterinary/animal-feed product knowledge lookup.
Kind: ${kind}
Lookup key: ${lookupKey}

Search only reputable regulatory/pharmacopoeial sources (EMA, FDA/ANADA, EDA, SFDA, VICH, WHO/WOAH, USP/Ph.Eur).
Respond with ONLY a raw JSON object (no markdown):
{ "found": true|false, "summary": "plain-text summary, empty if found=false", "payload": {} }
Set found:false if you cannot locate a genuinely authoritative source — do not fabricate or guess.
  `.trim();

  const response = await geminiClient.generateContentWithRetry({
    ledger: { feature: "labels.knowledge" },
    model: MODELS.WEB_SEARCH.id,
    contents: prompt,
    config: { temperature: 0, tools: [{ googleSearch: {} }] },
  });

  const text = response.text || "";
  const annotations = response.candidates?.[0]?.groundingMetadata?.groundingSupports?.map((s) => s.segment) || [];
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
  } catch {
    return { found: false };
  }
  if (!parsed.found) return { found: false };

  const citations = annotations
    .map((a) => acceptGroundedClaim({ url: a.url, start_index: a.startIndex, end_index: a.endIndex }, text))
    .filter(Boolean);

  return { found: citations.length > 0, summary: parsed.summary, payload: parsed.payload, citations };
}

/**
 * Tier 5 (§8.2). Amended Invariant #5 ("every field is generated") opened this
 * to NEVER_GUESS_FIELDS paths too — a cited, allowlisted external source is a
 * real source, same as for any other field. The old hard refusal here is gone;
 * fieldLadder.js's REFERENCE_FIELD_SOURCES/FIELD_SEARCH_TOPIC entries for
 * withdrawalPeriod/strength/registrationNumber are what actually route those
 * fields through this function now.
 */
export const resolve = async (kind, lookupKey, { fieldPath, searchFn = defaultSearch } = {}) => {
  const cached = await prisma.externalKnowledgeCache.findUnique({ where: { kind_lookupKey: { kind, lookupKey } } });
  if (cached && cached.status !== "rejected" && (!cached.expiresAt || cached.expiresAt > new Date())) {
    return cached;
  }

  const result = await searchFn(lookupKey, kind);
  if (!result.found || !result.citations?.length) return null; // Tier 5 miss -> caller falls through to Tier 6 (null -> FAIL/UNVERIFIABLE)

  return prisma.externalKnowledgeCache.upsert({
    where: { kind_lookupKey: { kind, lookupKey } },
    update: {
      payload: result.payload || {},
      summary: result.summary || null,
      sourceUrls: result.citations.map((c) => c.url),
      citations: result.citations,
      confidence: "medium",
      retrievedAt: new Date(),
      expiresAt: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
    create: {
      kind,
      lookupKey,
      payload: result.payload || {},
      summary: result.summary || null,
      sourceType: "ai_web_search",
      sourceUrls: result.citations.map((c) => c.url),
      sourceIsAuthoritative: true, // every surviving citation already passed isAllowedKnowledgeHost
      citations: result.citations,
      confidence: "medium",
      status: "unreviewed",
      retrievedAt: new Date(),
      expiresAt: new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
};
