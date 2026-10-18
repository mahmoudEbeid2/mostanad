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
      country,
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
  if (country) where.country = country;
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
