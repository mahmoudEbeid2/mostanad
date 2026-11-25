import { countryVariants, countryCode } from "../../assistant/countries.js";
import { assignAiContext } from "../../ai/aiContext.js";
import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import AppError from "../../../utils/appError.js";
import { compile } from "./ruleCompiler.js";
import { auditDocument, MINIMUM_COVERAGE_PERCENT_FOR_APPROVAL } from "./coverageAuditor.js";
import { AUTHORITIES } from "./officialSources.js";

export const sha256 = (text) => crypto.createHash("sha256").update(text || "", "utf8").digest("hex");

// Moved here from generatedLabelService.js (Phase 9) so replayService.js can
// reconstruct the exact same rule set generation/validation used, without
// duplicating the query.
//
// companyId (optional): tenant-scoped per §3's own rule for the schema
// composer, applied here too — a company-specific regulatory document must
// never leak its rules into another company's generation/validation. Omitted
// entirely (undefined), this returns every approved country-wide document's
// rules regardless of company, same as before this parameter existed —
// existing callers that don't pass it are unchanged, but every NEW call site
// should pass the label's companyId (see generatedLabelService.js).
//
// "active" replaces the old "approved" per-rule gate (decision: per-rule
// manual approval is removed) — any rule not explicitly "rejected" is usable.
// documentActivationMode is denormalized onto each returned rule so
// ruleValidator's severity ceiling (partial-coverage documents cap FAIL at
// NEEDS_REVIEW) doesn't need a second query per rule.
export async function getApprovedRulesForCountry(country, { companyId } = {}) {
  const documents = await prisma.regulatoryDocument.findMany({
    where: {
      // "SA", "Saudi Arabia" and "السعودية" are one country: documents and labels were saved with either
      country: { in: countryVariants(country) },
      status: "approved",
      ...(companyId !== undefined && { OR: [{ companyId }, { companyId: null }] }),
    },
    select: { id: true, activationMode: true },
  });
  if (documents.length === 0) return [];
  const activationModeByDoc = new Map(documents.map((d) => [d.id, d.activationMode]));
  const rules = await prisma.regulatoryRule.findMany({ where: { documentId: { in: documents.map((d) => d.id) }, status: { not: "rejected" } } });
  return rules.map((r) => ({ ...r, documentActivationMode: activationModeByDoc.get(r.documentId) || "full" }));
}

/**
 * Step 2 of the ingestion journey (§7.4) — called by edaRequirementWorker after
 * it extracts full text from the uploaded file. Refuses a duplicate hash rather
 * than silently re-ingesting the same document twice.
 */
export const createFromExtraction = async ({
  title = null,
  authority = null,
  country,
  productScope = [],
  sourceType = "official_upload",
  sourceUrl = null,
  documentVersion = null,
  effectiveDate = null,
  companyId = null,
  extractedText,
  extractedData = null,
  labelFieldSchema = null,
}) => {
  const documentHash = sha256(extractedText);

  const existing = await prisma.regulatoryDocument.findFirst({ where: { documentHash } });
  if (existing) {
    throw new AppError(`This document was already uploaded as regulatory document ${existing.id} (status: ${existing.status}).`, 409);
  }

  // §7.2: a fetch is only sourceIsOfficial if its host is in the allowlist for
  // this country's authority — a direct human upload is trusted by definition
  // (the human chose to upload it), everything else must earn the flag.
  const sourceIsOfficial = sourceType === "official_upload" || isOfficialUrl(sourceUrl, country);

  return prisma.regulatoryDocument.create({
    data: {
      title,
      authority,
      country,
      productScope,
      sourceType,
      sourceUrl,
      sourceIsOfficial,
      documentVersion,
      effectiveDate,
      retrievedAt: new Date(),
      documentHash,
      status: "extracted",
      companyId,
      extractedText,
      extractedData,
      labelFieldSchema,
    },
  });
};

function isOfficialUrl(url, country) {
  if (!url) return false;
  const authorityEntry = Object.values(AUTHORITIES).find((a) => a.country === country);
  if (!authorityEntry) return false;
  try {
    const host = new URL(url).hostname;
    return authorityEntry.domains.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

export const getDocuments = async ({ country, authority, status, page = 1, limit = 20 } = {}) => {
  const where = {};
  if (country) where.country = { in: countryVariants(country) };
  if (authority) where.authority = authority;
  if (status) where.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const [documents, total] = await Promise.all([
    prisma.regulatoryDocument.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.regulatoryDocument.count({ where }),
  ]);
  return { documents, total };
};

export const getDocumentById = async (id) => {
  const document = await prisma.regulatoryDocument.findUnique({ where: { id }, include: { rules: true } });
  if (!document) throw new AppError("No regulatory document found with that ID", 404);
  return document;
};

/**
 * Step 3 (§7.4): compiles rules from the document's full text. Whole document,
 * one call, no chunking. Rejected candidates (bad citation/targetPath/kind) are
 * never persisted — only reported back.
 */
export const compileRulesFor = async (documentId) => {
  assignAiContext({ entityType: "regulatory_document", entityId: documentId }); // AI cost ledger
  const document = await prisma.regulatoryDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new AppError("No regulatory document found with that ID", 404);
  if (!document.extractedText) throw new AppError("This document has no extracted text yet.", 400);

  const { accepted, rejected } = await compile(document.extractedText, {
    title: document.title,
    authority: document.authority,
    country: document.country,
  });

  const created = [];
  for (const rule of accepted) {
    try {
      const row = await prisma.regulatoryRule.create({
        data: {
          documentId,
          ruleKey: rule.ruleKey,
          ruleType: rule.ruleType,
          severity: rule.severity,
          targetPath: rule.targetPath || null,
          appliesWhen: rule.appliesWhen || null,
          constraint: rule.constraint,
          description: rule.description,
          citation: rule.citation,
          confidence: rule.confidence,
          status: "active", // per-rule manual approval removed — see ruleValidator's severity ceiling for how confidence/coverage still gate FAIL vs NEEDS_REVIEW
        },
      });
      created.push(row);
    } catch (err) {
      // @@unique([documentId, ruleKey]) collision — the model proposed a duplicate
      // ruleKey in the same batch. Report it like any other rejection rather than
      // failing the whole compilation.
      rejected.push({ candidate: rule, reason: `Could not save (${err.message.split("\n")[0]}).` });
    }
  }

  return { created, rejected };
};

/**
 * Step 4 (§7.4/§7.5): the reverse-pass coverage audit. Persists the numbers
 * onto the document — does NOT gate anything itself; approveDocument reads
 * them to decide full vs partial activationMode (severity, never access).
 */
export const auditCoverageFor = async (documentId) => {
  assignAiContext({ entityType: "regulatory_document", entityId: documentId }); // AI cost ledger
  const document = await prisma.regulatoryDocument.findUnique({ where: { id: documentId }, include: { rules: true } });
  if (!document) throw new AppError("No regulatory document found with that ID", 404);

  const acceptedRules = document.rules.filter((r) => r.status !== "rejected");
  const coverage = await auditDocument(document.extractedText, acceptedRules);

  return prisma.regulatoryDocument.update({
    where: { id: documentId },
    data: {
      clauseTotal: coverage.clauseTotal,
      clauseCovered: coverage.clauseCovered,
      coveragePercent: coverage.coveragePercent,
      uncoveredClauses: coverage.uncoveredClauses,
      coverageAuditedAt: new Date(),
    },
  });
};

/**
 * Step 5/6 — activation (§0/§1 of the ingestion overhaul: automated, not a
 * human gate). Coverage no longer blocks access, only severity: full coverage
 * (or every uncovered clause cleared) activates the document at full
 * strength; anything below that still activates — a document is never left
 * unusable — but every rule it contributes is capped at NEEDS_REVIEW by
 * ruleValidator's severity ceiling until coverage improves or clauses are
 * cleared and it's re-activated. `userId` is null for the automatic chain
 * (ingestAutomatically) and set for a human re-running this endpoint by hand.
 */
export const approveDocument = async (documentId, userId = null) => {
  const document = await prisma.regulatoryDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new AppError("No regulatory document found with that ID", 404);

  if (document.coveragePercent === null || document.coveragePercent === undefined) {
    throw new AppError("This document has not been coverage-audited yet — POST /regulatory-documents/:id/audit-coverage first.", 400);
  }
  const remainingUncovered = Array.isArray(document.uncoveredClauses) ? document.uncoveredClauses.length : 0;
  const activationMode = document.coveragePercent >= MINIMUM_COVERAGE_PERCENT_FOR_APPROVAL || remainingUncovered === 0 ? "full" : "partial";

  return prisma.regulatoryDocument.update({
    where: { id: documentId },
    data: {
      status: "approved",
      activationMode,
      reviewedByUserId: userId,
      reviewedAt: new Date(),
      effectiveDate: document.effectiveDate || new Date(),
    },
  });
};

/**
 * §0/§2: the one automatic chain. Upload -> extract+catalog already happened
 * (edaRequirementWorker) by the time this runs. From here, no human action is
 * required: compile rules -> audit coverage -> activate (severity set by
 * coverage, never blocking). Each step's own Gemini call keeps its full
 * context budget (decision: do NOT fold rule compilation into extraction) —
 * this function just sequences three already-existing steps with no human in
 * between. A failure at any step propagates (no empty catch — Invariant #7):
 * the document stays at whatever status the last successful step left it at,
 * and the existing manual endpoints (compile-rules/audit-coverage/approve)
 * remain available to resume from there.
 */
export const ingestAutomatically = async (documentId) => {
  await compileRulesFor(documentId);
  await auditCoverageFor(documentId);
  return approveDocument(documentId, null);
};

/**
 * The "Add rules for <country>" path (label review): compile -> audit, then STOP —
 * the person looks at the rules found and approves (approveDocument with their id),
 * and the label is checked again. Uploads from the regulatory page keep the
 * automatic chain above.
 */
export const ingestForReview = async (documentId) => {
  await compileRulesFor(documentId);
  return auditCoverageFor(documentId);
};

/**
 * GET /regulatory-documents/coverage?country= — where a country's rules stand, for the
 * label review's "no rules for <country>" warning: the rules in force, each document
 * (with a stuck one — extracted, never compiled — resumable), and the countries
 * whose approved rules could be copied as a starting point.
 */
export async function rulesForCountry(country, { companyId } = {}) {
  const variants = countryVariants(country);
  const scope = companyId !== undefined ? { OR: [{ companyId }, { companyId: null }] } : {};
  const docs = await prisma.regulatoryDocument.findMany({
    where: { country: { in: variants }, status: { not: "rejected" }, ...scope },
    select: { id: true, title: true, authority: true, status: true, coveragePercent: true, coverageAuditedAt: true, createdAt: true, sourceType: true, _count: { select: { rules: { where: { status: { not: "rejected" } } } } } },
    orderBy: { createdAt: "desc" },
  });
  const approved = await prisma.regulatoryDocument.findMany({ where: { status: "approved", ...scope }, select: { country: true, _count: { select: { rules: { where: { status: { not: "rejected" } } } } } } });
  const byCountry = new Map();
  for (const d of approved) {
    const code = countryCode(d.country) || d.country;
    if (variants.includes(code) || variants.includes(d.country)) continue;
    byCountry.set(code, (byCountry.get(code) || 0) + d._count.rules);
  }
  return {
    country: countryCode(country) || country,
    rulesInForce: (await getApprovedRulesForCountry(country, { companyId })).length,
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title,
      authority: d.authority,
      status: d.status,
      rules: d._count.rules,
      coveragePercent: d.coveragePercent,
      copied: d.sourceType === "copied",
      // extracted with no rules or no audit: the automatic chain stopped — it can be resumed
      stuck: d.status !== "approved" && (d._count.rules === 0 || !d.coverageAuditedAt),
      awaitingApproval: d.status !== "approved" && d._count.rules > 0 && !!d.coverageAuditedAt,
      createdAt: d.createdAt,
    })),
    copyFrom: [...byCountry.entries()].filter(([, n]) => n > 0).map(([code, rules]) => ({ country: code, rules })),
  };
}

/** compile (if it has no rules) + audit a document whose automatic chain stopped; it then awaits approval. */
export async function resumeDocument(documentId) {
  const doc = await prisma.regulatoryDocument.findUnique({ where: { id: documentId }, select: { id: true, status: true, _count: { select: { rules: true } } } });
  if (!doc) throw new AppError("No regulatory document found with that ID", 404);
  if (doc.status === "approved") throw new AppError("This document is already in force.", 409);
  if (!doc._count.rules) await compileRulesFor(documentId);
  return auditCoverageFor(documentId);
}

/**
 * POST /regulatory-documents/copy { fromCountry, toCountry } — another country's
 * approved rules as a STARTING POINT: each approved document is copied for the new
 * country (same text, so every citation still verifies verbatim against it), with
 * its rules, marked copied and NOT in force until a person approves it. Nothing
 * of the source country changes.
 */
export async function copyRulesToCountry({ fromCountry, toCountry, companyId = null }) {
  const to = countryCode(toCountry);
  if (!to) throw new AppError(`Unknown country: ${toCountry}`, 400);
  if (countryVariants(fromCountry).includes(to)) throw new AppError("Choose another country to copy from", 400);
  const sources = await prisma.regulatoryDocument.findMany({
    where: { country: { in: countryVariants(fromCountry) }, status: "approved", OR: [{ companyId }, { companyId: null }] },
    include: { rules: { where: { status: { not: "rejected" } } } },
  });
  if (!sources.length) throw new AppError(`${fromCountry} has no approved rules to copy`, 404);
  const created = [];
  for (const src of sources) {
    const doc = await prisma.$transaction(async (tx) => {
      const d = await tx.regulatoryDocument.create({
        data: {
          title: `${src.title || src.authority || "Rules"} (copied from ${countryCode(src.country) || src.country})`,
          authority: src.authority,
          country: to,
          productScope: src.productScope,
          sourceType: "copied",
          sourceUrl: src.sourceUrl,
          sourceIsOfficial: false, // another country's text is not an official source for this one
          documentVersion: src.documentVersion,
          retrievedAt: new Date(),
          documentHash: sha256(`${src.documentHash || src.id}|copied-to|${to}|${companyId || ""}`),
          status: "extracted",
          companyId,
          extractedText: src.extractedText,
          extractedData: src.extractedData ?? undefined,
          labelFieldSchema: src.labelFieldSchema ?? undefined,
          clauseTotal: src.clauseTotal,
          clauseCovered: src.clauseCovered,
          coveragePercent: src.coveragePercent,
          uncoveredClauses: src.uncoveredClauses ?? undefined,
          coverageAuditedAt: src.coverageAuditedAt,
        },
      });
      for (const r of src.rules) {
        await tx.regulatoryRule.create({ data: { documentId: d.id, ruleKey: r.ruleKey, ruleType: r.ruleType, severity: r.severity, targetPath: r.targetPath, appliesWhen: r.appliesWhen ?? undefined, constraint: r.constraint, description: r.description, citation: r.citation, confidence: r.confidence, status: "active", autoFixable: r.autoFixable } });
      }
      return d;
    });
    created.push({ id: doc.id, title: doc.title, rules: src.rules.length });
  }
  return { country: to, documents: created };
}

/**
 * A human reviewer clearing one previously-uncovered clause as "not actually a
 * requirement" (§7.5's "⚪ ليست شرطاً — مقبول"). Removes it from
 * uncoveredClauses without touching clauseTotal/coveragePercent — those numbers
 * are the audit's record; this is a human override layered on top of it.
 */
export const markClauseNonNormative = async (documentId, clauseReference) => {
  const document = await prisma.regulatoryDocument.findUnique({ where: { id: documentId } });
  if (!document) throw new AppError("No regulatory document found with that ID", 404);

  const remaining = (document.uncoveredClauses || []).filter((c) => c.reference !== clauseReference);
  return prisma.regulatoryDocument.update({ where: { id: documentId }, data: { uncoveredClauses: remaining } });
};

export const getRules = async ({ documentId, ruleType, severity, status, page = 1, limit = 50 } = {}) => {
  const where = {};
  if (documentId) where.documentId = documentId;
  if (ruleType) where.ruleType = ruleType;
  if (severity) where.severity = severity;
  if (status) where.status = status;

  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  const [rules, total] = await Promise.all([
    prisma.regulatoryRule.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.regulatoryRule.count({ where }),
  ]);
  return { rules, total };
};

export const updateRule = async (id, data) => {
  const rule = await prisma.regulatoryRule.findUnique({ where: { id } });
  if (!rule) throw new AppError("No regulatory rule found with that ID", 404);
  if (rule.status === "approved") throw new AppError("Cannot edit an already-approved rule — reject it and compile a replacement instead.", 400);

  return prisma.regulatoryRule.update({
    where: { id },
    data: {
      ...(data.constraint !== undefined && { constraint: data.constraint }),
      ...(data.severity !== undefined && { severity: data.severity }),
      ...(data.targetPath !== undefined && { targetPath: data.targetPath }),
    },
  });
};

export const approveRule = async (id) => {
  const rule = await prisma.regulatoryRule.findUnique({ where: { id } });
  if (!rule) throw new AppError("No regulatory rule found with that ID", 404);
  return prisma.regulatoryRule.update({ where: { id }, data: { status: "approved" } });
};

export const rejectRule = async (id) => {
  const rule = await prisma.regulatoryRule.findUnique({ where: { id } });
  if (!rule) throw new AppError("No regulatory rule found with that ID", 404);
  return prisma.regulatoryRule.update({ where: { id }, data: { status: "rejected" } });
};
